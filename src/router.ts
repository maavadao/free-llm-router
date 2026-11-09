import type { Alias, Config, Provider, Route, Settings } from "./config.ts";
import { Cooldowns, Counter } from "./limits.ts";
import { Ledger, type Tally } from "./budget.ts";

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
const providerKey = (p: Provider) => `provider:${p.id}`;

/** Share of an allowance left (0 to 1), or undefined when there's no such limit. */
const left = (limit: number | undefined, used: number) => (limit ? Math.max(0, limit - used) / limit : undefined);

export class Router {
  readonly providers: Map<string, Provider>;
  readonly aliases: Map<string, Alias>;
  readonly usage = new Counter();
  readonly cooldowns = new Cooldowns();
  /** Requests and tokens served, per quota and per provider, for the budget meter and the token limits. */
  readonly ledger = new Ledger();
  /** Where each alias tier's round-robin turn has got to. */
  private turns = new Map<string, number>();
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

  /** Whether a route could take a request now (key present, not cooling down, under its limits and token allowance). */
  usable(route: Route, tokens = 0) {
    const { provider, limits } = route;
    const free = provider.freeTier;
    return (
      provider.enabled &&
      !this.retired.has(routeKey(route)) &&
      !this.cooldowns.active(provider.id) &&
      !this.cooldowns.active(routeKey(route)) &&
      tokens <= limits.context &&
      this.usage.allows(quotaKey(route), limits.rpm, limits.rpd) &&
      (!limits.tpd || this.ledger.today(quotaKey(route)).tokens + tokens <= limits.tpd) &&
      (!free?.tokensPerDay || this.ledger.today(providerKey(provider)).tokens + tokens <= free.tokensPerDay) &&
      (!free?.tokensPerMonth || this.ledger.month(providerKey(provider)).tokens + tokens <= free.tokensPerMonth)
    );
  }

  /**
   * How much of its free allowance a route has left right now, from 0 (none)
   * to 1 (all of it): the tightest of its minute, day and token limits and
   * its provider's allowance. A route with no published limits counts as 1.
   */
  headroom(route: Route) {
    const { provider, limits } = route;
    const q = quotaKey(route);
    const shares = [
      left(limits.rpm, this.usage.minuteCount(q)),
      left(limits.rpd, this.usage.dayCount(q)),
      left(limits.tpd, this.ledger.today(q).tokens),
      left(provider.freeTier?.tokensPerDay, this.ledger.today(providerKey(provider)).tokens),
      left(provider.freeTier?.tokensPerMonth, this.ledger.month(providerKey(provider)).tokens),
    ].filter((v) => v !== undefined);
    return shares.length ? Math.min(...shares) : 1;
  }

  /**
   * The order to try an alias's routes in: tier by tier, and within a tier by
   * the alias's strategy. Priority keeps the config's order; round-robin
   * starts each request one route further on; least-used puts the route with
   * the fewest requests today first; headroom puts the route with the most
   * free allowance left first. Ties keep the config's order.
   */
  order(alias: Alias): Route[] {
    const out: Route[] = [];
    alias.tiers.forEach((tier, i) => {
      if (tier.length < 2 || alias.strategy === "priority") return void out.push(...tier);
      if (alias.strategy === "round-robin") {
        const key = `${alias.id}#${i}`;
        const turn = this.turns.get(key) ?? 0;
        this.turns.set(key, (turn + 1) % tier.length);
        return void out.push(...tier.slice(turn), ...tier.slice(0, turn));
      }
      const score =
        alias.strategy === "least-used"
          ? (r: Route) => -this.usage.dayCount(quotaKey(r))
          : (r: Route) => this.headroom(r);
      const scored = tier.map((r, at) => ({ r, at, s: score(r) }));
      scored.sort((a, b) => b.s - a.s || a.at - b.at);
      out.push(...scored.map((x) => x.r));
    });
    return out;
  }

  /** Records the tokens a reply used, once it has finished. */
  record(route: Route, tokens: number) {
    this.ledger.add(quotaKey(route), 0, tokens);
    this.ledger.add(providerKey(route.provider), 0, tokens);
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
    for (const route of this.order(alias)) {
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
      if (response.ok) {
        this.ledger.add(quotaKey(route), 1, 0);
        this.ledger.add(providerKey(route.provider), 1, 0);
        return { ok: true, route, response, attempts };
      }

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
   * The free-tier budget meter: what every provider has served today and
   * this month against its free allowance, and how much headroom each model
   * has left. Token counts are the providers' own figures where they send
   * them, estimates otherwise. Never includes prompts or users.
   */
  budget() {
    const pct = (used: number, of?: number) => (of ? Math.round((used / of) * 1000) / 10 : null);
    const sum = (a: Tally, b: Tally): Tally => ({ requests: a.requests + b.requests, tokens: a.tokens + b.tokens });
    let today: Tally = { requests: 0, tokens: 0 };
    let month: Tally = { requests: 0, tokens: 0 };
    let allowance = 0;

    const providers = [...this.providers.values()].map((p) => {
      const t = this.ledger.today(providerKey(p));
      const m = this.ledger.month(providerKey(p));
      today = sum(today, t);
      month = sum(month, m);
      const free = p.freeTier ?? {};
      if (p.enabled) allowance += free.tokensPerMonth ?? (free.tokensPerDay ? free.tokensPerDay * 30 : 0);
      const status = !p.enabled
        ? (p.offReason ?? "off")
        : this.cooldowns.active(p.id)
          ? "cooling down"
          : "ready";
      return {
        id: p.id,
        name: p.name,
        status,
        keyless: !p.keyEnv,
        data_use: p.dataUse,
        terms: p.terms,
        today: t,
        month: m,
        allowance: { tokens_per_day: free.tokensPerDay ?? null, tokens_per_month: free.tokensPerMonth ?? null },
        used_percent: { day: pct(t.tokens, free.tokensPerDay), month: pct(m.tokens, free.tokensPerMonth) },
        note: free.note ?? null,
        source: free.source ?? null,
        models: Object.entries(p.models).map(([model, limits]) => {
          const route: Route = { provider: p, model, limits };
          const q = this.ledger.today(quotaKey(route));
          return {
            id: model,
            pool: limits.pool ?? null,
            limits: { rpm: limits.rpm ?? null, rpd: limits.rpd ?? null, tpd: limits.tpd ?? null, context: limits.context },
            today: q,
            headroom: p.enabled && !this.retired.has(routeKey(route)) ? Math.round(this.headroom(route) * 100) / 100 : 0,
            retired: this.retired.has(routeKey(route)),
            cooling_down: this.cooldowns.active(routeKey(route)),
          };
        }),
      };
    });

    return {
      object: "budget",
      period: this.ledger.period(),
      totals: {
        today,
        month,
        // Published free token allowances of the providers that are on, per month (providers
        // with only rate limits add requests, not a token figure, so they aren't in it).
        allowance_tokens_per_month: allowance,
        used_percent_month: pct(month.tokens, allowance),
      },
      providers,
    };
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
