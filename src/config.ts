import { readFileSync } from "node:fs";

export type DataUse = "no-training" | "may-train" | "unknown";

/** Whether the provider's terms plainly allow serving a community through it ("ok"), or need care ("caution"). */
export type Terms = "ok" | "caution";

/** How an alias picks among routes of equal standing (routes in the same tier). */
export type Strategy = "priority" | "round-robin" | "least-used" | "headroom";
export const STRATEGIES: Strategy[] = ["priority", "round-robin", "least-used", "headroom"];

/** A provider's published free allowance, for the budget meter. */
export type FreeTier = {
  tokensPerDay?: number;
  tokensPerMonth?: number;
  /** What the allowance is, in a sentence (shown on /v1/budget). */
  note?: string;
  /** Where the figure comes from (the provider's own page). */
  source?: string;
};

export type ModelLimits = {
  /** Context window in tokens (prompt plus reply). */
  context: number;
  /** Requests per minute allowed by the provider's free tier. */
  rpm?: number;
  /** Requests per day (UTC) allowed by the provider's free tier. */
  rpd?: number;
  /** Tokens per day (UTC, prompt plus reply) allowed by the provider's free tier. */
  tpd?: number;
  /** Models sharing one quota (OpenRouter's :free models) name the same pool. */
  pool?: string;
};

export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv?: string;
  key?: string;
  dataUse: DataUse;
  terms: Terms;
  freeTier?: FreeTier;
  enabled: boolean;
  /** Why a provider is off: "switched off", "no key" or "may train". */
  offReason?: string;
  models: Record<string, ModelLimits>;
};

export type Route = { provider: Provider; model: string; limits: ModelLimits };

/**
 * A model as members choose it. Its routes come in tiers, tried in order; the
 * alias's strategy decides the order within a tier (routes of equal standing,
 * such as the same model at different providers).
 */
export type Alias = { id: string; label: string; description: string; strategy: Strategy; tiers: Route[][]; routes: Route[] };

export type Settings = {
  port: number;
  /** Bearer tokens accepted from clients (the website). Empty only in dev mode. */
  tokens: string[];
  dev: boolean;
  /** Leave out providers whose free tier may train on prompts. */
  noTraining: boolean;
  /** Cap on max_tokens for any reply. */
  maxTokens: number;
  /** Per-user limits, keyed by the X-Router-User header or the body's `user`. */
  userRpm: number;
  userRpd: number;
  /** How long to wait for a provider to start answering before trying the next. */
  upstreamTimeoutMs: number;
  /** Strategy for aliases that don't name one. */
  strategy: Strategy;
};

type RawConfig = {
  providers: Record<
    string,
    {
      name: string;
      baseUrl: string;
      keyEnv?: string;
      dataUse?: DataUse;
      terms?: Terms;
      freeTier?: FreeTier;
      enabled?: boolean;
      models: Record<string, ModelLimits>;
    }
  >;
  aliases: Record<string, { label: string; description: string; strategy?: Strategy; routes: (string | string[])[] }>;
};

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);
const flag = (v: string | undefined) => v === "1" || v === "true";

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    port: num(env.PORT, 8080),
    tokens: (env.ROUTER_TOKENS ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    dev: flag(env.ROUTER_DEV),
    noTraining: flag(env.ROUTER_NO_TRAINING),
    maxTokens: num(env.ROUTER_MAX_TOKENS, 4096),
    userRpm: num(env.ROUTER_USER_RPM, 10),
    userRpd: num(env.ROUTER_USER_RPD, 200),
    upstreamTimeoutMs: num(env.ROUTER_UPSTREAM_TIMEOUT_MS, 30_000),
    strategy: STRATEGIES.includes(env.ROUTER_STRATEGY as Strategy) ? (env.ROUTER_STRATEGY as Strategy) : "priority",
  };
}

/**
 * Reads the provider and alias config (config/providers.json, or the file named
 * by ROUTER_CONFIG). Providers without a key, switched off, or (with
 * ROUTER_NO_TRAINING) whose free tier may train on prompts are left out of
 * every route. A base URL can name environment variables as ${NAME} (Cloudflare
 * puts the account id in the URL); the provider is off until they're all set.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings = loadSettings(env)) {
  const path = env.ROUTER_CONFIG ?? new URL("../config/providers.json", import.meta.url);
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;

  const providers = new Map<string, Provider>();
  for (const [id, p] of Object.entries(raw.providers)) {
    const key = p.keyEnv ? env[p.keyEnv] : undefined;
    const dataUse = p.dataUse ?? "unknown";
    let missingVar = false;
    const baseUrl = p.baseUrl.replace(/\/$/, "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = env[name];
      if (!v) missingVar = true;
      return encodeURIComponent(v ?? "");
    });
    const offReason =
      p.enabled === false
        ? "switched off"
        : (p.keyEnv && !key) || missingVar
          ? "no key"
          : settings.noTraining && dataUse === "may-train"
            ? "may train"
            : undefined;
    providers.set(id, {
      id,
      name: p.name,
      baseUrl,
      keyEnv: p.keyEnv,
      key,
      dataUse,
      terms: p.terms ?? "caution",
      freeTier: p.freeTier,
      enabled: !offReason,
      offReason,
      models: p.models,
    });
  }

  const aliases = new Map<string, Alias>();
  for (const [id, a] of Object.entries(raw.aliases)) {
    if (a.strategy !== undefined && !STRATEGIES.includes(a.strategy)) {
      throw new Error(`Alias "${id}" has an unknown strategy "${a.strategy}" (use ${STRATEGIES.join(", ")}).`);
    }
    const tiers: Route[][] = [];
    for (const entry of a.routes) {
      const tier: Route[] = [];
      for (const ref of Array.isArray(entry) ? entry : [entry]) {
        const slash = ref.indexOf("/");
        const provider = providers.get(ref.slice(0, slash));
        const model = ref.slice(slash + 1);
        const limits = provider?.models[model];
        if (!provider || !limits) throw new Error(`Alias "${id}" names an unknown route "${ref}".`);
        tier.push({ provider, model, limits });
      }
      if (tier.length) tiers.push(tier);
    }
    const strategy = a.strategy ?? settings.strategy;
    aliases.set(id, { id, label: a.label, description: a.description, strategy, tiers, routes: tiers.flat() });
  }
  if (!aliases.has("auto")) throw new Error('The config needs an "auto" alias.');

  return { providers, aliases };
}

export type Config = ReturnType<typeof loadConfig>;
