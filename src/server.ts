import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { loadConfig, loadSettings, type Settings } from "./config.ts";
import { Counter } from "./limits.ts";
import { Router, estimateTokens, type ChatMessage, type ChatRequest } from "./router.ts";
import { UsageTap } from "./budget.ts";

const MAX_BODY = 1_000_000;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const error = (res: ServerResponse, status: number, message: string, type = "invalid_request_error") =>
  send(res, status, { error: { message, type } });

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RangeError("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorised(req: IncomingMessage, settings: Settings) {
  if (settings.tokens.length === 0) return settings.dev;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  return settings.tokens.some((t) => {
    const want = Buffer.from(t);
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

/** Checks and trims an OpenAI-style request to the fields the router passes on. */
function parseRequest(body: unknown, settings: Settings): { model: string; user?: string; request: ChatRequest } | string {
  if (!body || typeof body !== "object") return "Send a JSON body.";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return "`messages` must be a non-empty array.";
  const messages: ChatMessage[] = [];
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || !["system", "user", "assistant"].includes(m.role as string) || typeof m.content !== "string") {
      return "Each message needs a role (system, user or assistant) and text content.";
    }
    messages.push({ role: m.role as ChatMessage["role"], content: m.content });
  }
  const maxTokens = typeof b.max_tokens === "number" && b.max_tokens > 0 ? Math.min(b.max_tokens, settings.maxTokens) : settings.maxTokens;
  const request: ChatRequest = { messages, stream: b.stream === true, max_tokens: maxTokens };
  if (typeof b.temperature === "number") request.temperature = b.temperature;
  if (typeof b.top_p === "number") request.top_p = b.top_p;
  return { model: typeof b.model === "string" && b.model ? b.model : "auto", user: typeof b.user === "string" ? b.user : undefined, request };
}

export function createApp(router: Router, settings: Settings) {
  const users = new Counter();
  setInterval(() => {
    users.sweep();
    router.usage.sweep();
    router.ledger.sweep();
  }, 10 * 60_000).unref();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return send(res, 200, { ok: true });
      }
      if (!url.pathname.startsWith("/v1/")) return error(res, 404, "Not found.");
      if (!authorised(req, settings)) return error(res, 401, "Missing or wrong token.", "authentication_error");

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const data = [...router.aliases.values()].map((a) => ({
          id: a.id,
          object: "model",
          owned_by: "maava",
          label: a.label,
          description: a.description,
          available: router.configured(a),
          providers: [...new Set(a.routes.filter((r) => r.provider.enabled).map((r) => r.provider.name))],
          may_train: a.routes.some((r) => r.provider.enabled && r.provider.dataUse === "may-train"),
          strategy: a.strategy,
        }));
        return send(res, 200, { object: "list", data });
      }

      if (req.method === "GET" && url.pathname === "/v1/budget") {
        return send(res, 200, router.budget(), { "Cache-Control": "no-store" });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (e) {
          return e instanceof RangeError ? error(res, 413, "The request is too large.") : error(res, 400, "The body isn't valid JSON.");
        }
        const parsed = parseRequest(body, settings);
        if (typeof parsed === "string") return error(res, 400, parsed);

        const user = (req.headers["x-router-user"] as string | undefined) ?? parsed.user;
        if (user) {
          if (!users.allows(user, settings.userRpm, settings.userRpd)) {
            return error(res, 429, "You're sending messages too quickly. Please wait a moment.", "rate_limit_error");
          }
          users.hit(user);
        }

        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) abort.abort();
        });
        const routed = await router.route(parsed.model, parsed.request, abort.signal);
        const tried = routed.attempts.map((a) => `${a.route}=${a.status}`).join(" ");
        if (!routed.ok) {
          console.log(`chat model=${parsed.model} failed status=${routed.status} tried=[${tried}]`);
          return error(res, routed.status, routed.message, routed.status === 503 ? "overloaded_error" : "invalid_request_error");
        }

        const { route, response } = routed;
        console.log(`chat model=${parsed.model} route=${route.provider.id}/${route.model} tried=[${tried}]`);
        res.writeHead(200, {
          "Content-Type": response.headers.get("content-type") ?? (parsed.request.stream ? "text/event-stream" : "application/json"),
          "Cache-Control": "no-store",
          "X-Router-Provider": route.provider.name,
          "X-Router-Model": route.model,
          "X-Router-May-Train": String(route.provider.dataUse === "may-train"),
        });
        const promptTokens = estimateTokens(parsed.request.messages);
        if (!response.body) {
          router.record(route, promptTokens);
          return res.end();
        }
        const upstream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
        // Count the reply's tokens for the budget meter as it passes through (the text itself isn't kept).
        const tap = new UsageTap(parsed.request.stream);
        upstream.on("data", (chunk: Uint8Array) => tap.push(chunk));
        upstream.once("close", () => router.record(route, tap.finish(promptTokens).tokens));
        upstream.on("error", () => res.destroy());
        upstream.pipe(res);
        return;
      }

      return error(res, 404, "Not found.");
    } catch (e) {
      console.error("router: request failed", e);
      if (!res.headersSent) error(res, 500, "Something went wrong.", "api_error");
      else res.destroy();
    }
  });
}

if (import.meta.main) {
  const settings = loadSettings();
  if (settings.tokens.length === 0 && !settings.dev) {
    console.error("Set ROUTER_TOKENS (comma-separated bearer tokens), or ROUTER_DEV=1 for local development without one.");
    process.exit(1);
  }
  const router = new Router(loadConfig(process.env, settings), settings);
  const enabled = [...router.providers.values()].filter((p) => p.enabled).map((p) => p.id);
  console.log(`router: providers enabled: ${enabled.join(", ") || "none (set provider keys)"}`);
  await router.syncModels();
  setInterval(() => void router.syncModels(), 60 * 60_000).unref();
  createApp(router, settings).listen(settings.port, () => console.log(`router: listening on :${settings.port}`));
}
