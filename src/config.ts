import { readFileSync } from "node:fs";

export type DataUse = "no-training" | "may-train" | "unknown";

export type ModelLimits = {
  /** Context window in tokens (prompt plus reply). */
  context: number;
  /** Requests per minute allowed by the provider's free tier. */
  rpm?: number;
  /** Requests per day (UTC) allowed by the provider's free tier. */
  rpd?: number;
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
  enabled: boolean;
  models: Record<string, ModelLimits>;
};

export type Route = { provider: Provider; model: string; limits: ModelLimits };

export type Alias = { id: string; label: string; description: string; routes: Route[] };

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
};

type RawConfig = {
  providers: Record<
    string,
    { name: string; baseUrl: string; keyEnv?: string; dataUse?: DataUse; enabled?: boolean; models: Record<string, ModelLimits> }
  >;
  aliases: Record<string, { label: string; description: string; routes: string[] }>;
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
  };
}

/**
 * Reads the provider and alias config (config/providers.json, or the file named
 * by ROUTER_CONFIG). Providers without a key, switched off, or (with
 * ROUTER_NO_TRAINING) whose free tier may train on prompts are left out of
 * every route.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings = loadSettings(env)) {
  const path = env.ROUTER_CONFIG ?? new URL("../config/providers.json", import.meta.url);
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;

  const providers = new Map<string, Provider>();
  for (const [id, p] of Object.entries(raw.providers)) {
    const key = p.keyEnv ? env[p.keyEnv] : undefined;
    const dataUse = p.dataUse ?? "unknown";
    const enabled =
      (p.enabled ?? true) && (!p.keyEnv || !!key) && !(settings.noTraining && dataUse === "may-train");
    providers.set(id, { id, name: p.name, baseUrl: p.baseUrl.replace(/\/$/, ""), keyEnv: p.keyEnv, key, dataUse, enabled, models: p.models });
  }

  const aliases = new Map<string, Alias>();
  for (const [id, a] of Object.entries(raw.aliases)) {
    const routes: Route[] = [];
    for (const ref of a.routes) {
      const slash = ref.indexOf("/");
      const provider = providers.get(ref.slice(0, slash));
      const model = ref.slice(slash + 1);
      const limits = provider?.models[model];
      if (!provider || !limits) throw new Error(`Alias "${id}" names an unknown route "${ref}".`);
      routes.push({ provider, model, limits });
    }
    aliases.set(id, { id, label: a.label, description: a.description, routes });
  }
  if (!aliases.has("auto")) throw new Error('The config needs an "auto" alias.');

  return { providers, aliases };
}

export type Config = ReturnType<typeof loadConfig>;
