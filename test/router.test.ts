import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSettings } from "../src/config.ts";
import { Router, type ChatRequest } from "../src/router.ts";
import { Counter } from "../src/limits.ts";
import { createApp } from "../src/server.ts";

const config = {
  providers: {
    a: { name: "A", baseUrl: "https://a.test/v1", keyEnv: "A_KEY", dataUse: "unknown", models: { m1: { context: 1000, rpm: 2 } } },
    b: { name: "B", baseUrl: "https://b.test/v1", keyEnv: "B_KEY", dataUse: "may-train", models: { m2: { context: 100000 } } },
    c: { name: "C", baseUrl: "https://c.test/v1", keyEnv: "C_KEY", models: { m3: { context: 100000 } } },
  },
  aliases: {
    auto: { label: "Auto", description: "", routes: ["a/m1", "b/m2", "c/m3"] },
    only_b: { label: "B", description: "", routes: ["b/m2"] },
  },
};

const dir = mkdtempSync(join(tmpdir(), "router-"));
const path = join(dir, "providers.json");
writeFileSync(path, JSON.stringify(config));

const env = (extra: Record<string, string> = {}) => ({ ROUTER_CONFIG: path, A_KEY: "ka", B_KEY: "kb", C_KEY: "kc", ...extra });
const request = (content = "hi"): ChatRequest => ({ messages: [{ role: "user", content }], stream: false, max_tokens: 10 });

/** A fake fetch that answers per host from a script, and records which hosts were called. */
function fakeFetch(script: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.host);
    const answer = script[url.host];
    if (!answer) throw new TypeError("fetch failed");
    return answer();
  }) as typeof fetch;
  return { impl, calls };
}

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });

function makeRouter(script: Record<string, () => Response>, extra: Record<string, string> = {}) {
  const e = env(extra);
  const settings = loadSettings(e);
  const { impl, calls } = fakeFetch(script);
  return { router: new Router(loadConfig(e, settings), settings, impl), calls };
}

test("uses the first route that answers", async () => {
  const { router, calls } = makeRouter({ "a.test": ok });
  const r = await router.route("auto", request());
  assert.ok(r.ok);
  assert.equal(r.route.provider.id, "a");
  assert.deepEqual(calls, ["a.test"]);
});

test("fails over on 429 and sets the route aside", async () => {
  const { router, calls } = makeRouter({
    "a.test": () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    "b.test": ok,
  });
  const first = await router.route("auto", request());
  assert.ok(first.ok);
  assert.equal(first.route.provider.id, "b");
  assert.deepEqual(first.attempts, [{ route: "a/m1", status: 429 }]);
  await router.route("auto", request());
  assert.deepEqual(calls, ["a.test", "b.test", "b.test"], "a is skipped while cooling down");
});

test("fails over on network errors and server errors", async () => {
  const { router } = makeRouter({ "b.test": () => new Response("down", { status: 502 }), "c.test": ok });
  const r = await router.route("auto", request());
  assert.ok(r.ok);
  assert.equal(r.route.provider.id, "c");
  assert.deepEqual(
    r.attempts.map((a) => a.status),
    ["error", 502],
  );
});

test("keeps under a model's requests-per-minute limit", async () => {
  const { router, calls } = makeRouter({ "a.test": ok, "b.test": ok });
  for (let i = 0; i < 3; i++) await router.route("auto", request());
  assert.deepEqual(calls, ["a.test", "a.test", "b.test"]);
});

test("skips routes whose context is too small", async () => {
  const { router, calls } = makeRouter({ "a.test": ok, "b.test": ok });
  const r = await router.route("auto", request("x".repeat(5000)));
  assert.ok(r.ok);
  assert.equal(r.route.provider.id, "b");
  assert.deepEqual(calls, ["b.test"]);
});

test("leaves out providers without a key, and may-train providers when asked", async () => {
  const { router } = makeRouter({ "c.test": ok }, { A_KEY: "", ROUTER_NO_TRAINING: "1" });
  const r = await router.route("auto", request());
  assert.ok(r.ok);
  assert.equal(r.route.provider.id, "c");
  const none = await router.route("only_b", request());
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.status, 503);
});

test("rejects unknown models", async () => {
  const { router } = makeRouter({});
  const r = await router.route("nope", request());
  assert.equal(!r.ok && r.status, 404);
});

test("syncModels retires models a provider no longer lists", async () => {
  const { router, calls } = makeRouter({
    "a.test": () => new Response(JSON.stringify({ data: [{ id: "something-else" }] })),
    "b.test": () => new Response(JSON.stringify({ data: [{ id: "m2" }] })),
  });
  await router.syncModels();
  assert.ok(router.retired.has("a/m1"));
  assert.ok(!router.retired.has("b/m2"));
  calls.length = 0;
  // c has no /models answer here, so its model stays; the chat goes to b.
  const { impl } = fakeFetch({ "b.test": ok });
  Object.assign(router, { fetch: impl });
  const r = await router.route("auto", request());
  assert.ok(r.ok);
  assert.equal(r.route.provider.id, "b");
});

test("Counter resets each UTC day", () => {
  let now = Date.UTC(2026, 10, 9, 23, 59);
  const c = new Counter(() => now);
  c.hit("k");
  assert.equal(c.allows("k", undefined, 1), false);
  now += 2 * 60_000;
  assert.equal(c.allows("k", undefined, 1), true);
});

test("HTTP: needs the token, lists models and streams the upstream reply through", async () => {
  const e = env({ ROUTER_TOKENS: "secret" });
  const settings = loadSettings(e);
  const upstream = () =>
    new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  const { impl } = fakeFetch({ "a.test": upstream });
  const server = createApp(new Router(loadConfig(e, settings), settings, impl), settings).listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    const models = (await (await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer secret" } })).json()) as {
      data: { id: string }[];
    };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ["auto", "only_b"],
    );
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "X-Router-Token": "secret", "Content-Type": "application/json", "X-Router-User": "u1" },
      body: JSON.stringify({ model: "auto", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-router-provider"), "A");
    assert.match(await res.text(), /"content":"hi"/);
    const bad = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test("the upstream timeout covers the wait for headers, not a long reply", async () => {
  const e = env({ ROUTER_UPSTREAM_TIMEOUT_MS: "50" });
  const settings = loadSettings(e);
  const slowBody = () =>
    new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("part one "));
          await new Promise((r) => setTimeout(r, 150));
          c.enqueue(new TextEncoder().encode("part two"));
          c.close();
        },
      }),
    );
  const router = new Router(loadConfig(e, settings), settings, (async (_url: unknown, init?: RequestInit) => {
    const res = slowBody();
    // Behave like fetch: an abort on the signal errors the body that's still streaming.
    init?.signal?.addEventListener("abort", () => void res.body?.cancel());
    return res;
  }) as typeof fetch);
  const r = await router.route("auto", request());
  assert.ok(r.ok);
  assert.equal(await r.response.text(), "part one part two");
});
