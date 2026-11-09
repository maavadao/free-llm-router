import type { Alias, Config, Provider, Route, Settings } from "./config.ts";
import { Cooldowns, Counter } from "./limits.ts";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The part of an OpenAI chat-completions request the router passes on. */
export type ChatRequest = {
  messages: ChatMessage[];
  stream: boolean;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
};

export type Attempt = { route: string; status: number | "error" | "timeout" };

export type Routed =
  | { ok: true; route: Route; response: Response; attempts: Attempt[] }
  | { ok: false; status: number; message: string; attempts: Attempt[] };

/** Rough token estimate (about 3.5 characters a token) to skip routes whose context is too small. */
export function estimateTokens(messages: ChatMessage[]) {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length + 8, 0) / 3.5);
}

const routeKey = (r: Route) => `${r.provider.id}/${r.model}`;
const quotaKey = (r: Route) => `${r.provider.id}/${r.limits.pool ?? r.model}`;

export class Router {
  readonly providers: Map<string, Provider>;
  readonly aliases: Map<string, Alias>;
  readonly usage = new Counter();
  readonly cooldowns = new Cooldowns();
  /** Models a provider's /models list no longer offers (refreshed by syncModels). */
  readonly retired = new Set<string>();
  private settings: Settings;
  private fetch: typeof fetch;

  constructor(config: Config, settings: Settings, fetchImpl: typeof fetch = fetch) {
    this.providers = config.providers;
    this.aliases = config.aliases;
    this.settings = settings;
    this.fetch = fetchImpl;
  }

  /** Whether a route could take a request now (key present, not cooling down, under its limits). */
  usable(route: Route, tokens = 0) {
    const { provider, limits } = route;
    return (
      provider.enabled &&
      !this.retired.has(routeKey(route)) &&
      !this.cooldowns.active(provider.id) &&
      !this.cooldowns.active(routeKey(route)) &&
      tokens <= limits.context &&
      this.usage.allows(quotaKey(route), limits.rpm, limits.rpd)
    );
  }

  /** Whether an alias has any route that's configured at all (for /v1/models). */
  configured(alias: Alias) {
    return alias.routes.some((r) => r.provider.enabled && !this.retired.has(routeKey(r)));
  }

  /**
   * Sends the request down the alias's routes in order until one provider
   * accepts it. A provider that answers 429, fails or times out before it
   * starts replying is set aside for a while and the next route is tried.
   * Once a reply has started it is passed through as it is.
   */
  async route(aliasId: string, request: ChatRequest, signal?: AbortSignal): Promise<Routed> {
    const alias = this.aliases.get(aliasId);
    const attempts: Attempt[] = [];
    if (!alias) return { ok: false, status: 404, message: `Unknown model "${aliasId}".`, attempts };
    if (!this.configured(alias)) {
      return { ok: false, status: 503, message: "This model isn't switched on yet. Try another one, or Auto.", attempts };
    }

    const tokens = estimateTokens(request.messages) + request.max_tokens;
    for (const route of alias.routes) {
      if (signal?.aborted) break;
      if (!this.usable(route, tokens)) continue;
      this.usage.hit(quotaKey(route));

      // The timeout covers waiting for the provider to start answering, not the whole reply:
      // a long answer (or long reasoning) can stream for minutes.
      const waiting = new AbortController();
      const timer = setTimeout(() => waiting.abort(), this.settings.upstreamTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
      let response: Response;
      try {
        response = await this.fetch(`${route.provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(route.provider.key ? { Authorization: `Bearer ${route.provider.key}` } : {}),
          },
          body: JSON.stringify({ ...request, model: route.model }),
          signal: combined,
        });
      } catch {
        clearTimeout(timer);
        if (signal?.aborted) break;
        attempts.push({ route: routeKey(route), status: waiting.signal.aborted ? "timeout" : "error" });
        this.cooldowns.set(route.provider.id, 30_000);
        continue;
      }

      clearTimeout(timer);
      if (response.ok) return { ok: true, route, response, attempts };

      attempts.push({ route: routeKey(route), status: response.status });
      await response.body?.cancel().catch(() => {});
      this.penalise(route, response);
    }

    if (signal?.aborted) return { ok: false, status: 499, message: "The request was cancelled.", attempts };
    return {
      ok: false,
      status: 503,
      message: "Every free model is busy or at its limit right now. Please try again in a minute.",
      attempts,
    };
  }

  /** Sets a route or provider aside after a failed answer. */
  private penalise(route: Route, response: Response) {
    const s = response.status;
    if (s === 429) {
      const retry = Number(response.headers.get("retry-after"));
      this.cooldowns.set(routeKey(route), Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) * 1000 : 60_000);
    } else if (s === 401 || s === 403) {
      // A missing, wrong or revoked key: stop using the provider for an hour.
      console.error(`router: ${route.provider.id} rejected its key (${s}); pausing it for an hour`);
      this.cooldowns.set(route.provider.id, 3_600_000);
    } else if (s === 404) {
      this.retired.add(routeKey(route));
    } else if (s >= 500) {
      this.cooldowns.set(route.provider.id, 30_000);
    } else {
      // Another 4xx is probably about this request (too long, a parameter the provider doesn't take).
      this.cooldowns.set(routeKey(route), 10_000);
    }
  }

  /**
   * Asks each enabled provider which models it serves and marks configured
   * models it no longer lists as retired, so free models that are shut down
   * drop out without a config change. Providers that don't answer are left
   * as they are.
   */
  async syncModels() {
    await Promise.all(
      [...this.providers.values()]
        .filter((p) => p.enabled)
        .map(async (p) => {
          try {
            const res = await this.fetch(`${p.baseUrl}/models`, {
              headers: p.key ? { Authorization: `Bearer ${p.key}` } : {},
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return;
            const body = (await res.json()) as { data?: { id: string }[] };
            if (!Array.isArray(body.data) || body.data.length === 0) return;
            const live = new Set(body.data.map((m) => m.id.replace(/^models\//, "")));
            for (const model of Object.keys(p.models)) {
              const key = `${p.id}/${model}`;
              if (live.has(model)) this.retired.delete(key);
              else {
                if (!this.retired.has(key)) console.warn(`router: ${key} is no longer listed by ${p.name}; skipping it`);
                this.retired.add(key);
              }
            }
          } catch {
            // Unreachable for now; try again on the next sync.
          }
        }),
    );
  }
}
