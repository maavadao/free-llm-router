import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSettings } from "../src/config.ts";
import { Router, type ChatRequest } from "../src/router.ts";
import { Ledger, UsageTap } from "../src/budget.ts";
import { createApp } from "../src/server.ts";

const config = {
  providers: {
    x: { name: "X", baseUrl: "https://x.test/v1", models: { m: { context: 100000, rpm: 10 } } },
    y: { name: "Y", baseUrl: "https://y.test/v1", models: { m: { context: 100000, rpm: 2 } } },
    z: {
      name: "Z",
      baseUrl: "https://z.test/accounts/${Z_ACCOUNT}/v1",
      keyEnv: "Z_KEY",
      terms: "ok",
      freeTier: { tokensPerDay: 1000, note: "1,000 tokens a day." },
      models: { m: { context: 100000, tpd: 500 } },
    },
  },
  aliases: {
    auto: { label: "Auto", description: "", strategy: "headroom", routes: [["x/m", "y/m"], "z/m"] },
    rr: { label: "RR", description: "", strategy: "round-robin", routes: [["x/m", "y/m"]] },
    least: { label: "Least", description: "", strategy: "least-used", routes: [["x/m", "y/m"]] },
    tiered: { label: "Tiered", description: "", routes: ["z/m", ["x/m", "y/m"]] },
  },
};

const dir = mkdtempSync(join(tmpdir(), "router-budget-"));
const path = join(dir, "providers.json");
writeFileSync(path, JSON.stringify(config));

const request = (content = "hi"): ChatRequest => ({ messages: [{ role: "user", content }], stream: false, max_tokens: 10 });
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));

function makeRouter(extra: Record<string, string> = {}) {
  const env = { ROUTER_CONFIG: path, Z_KEY: "kz", Z_ACCOUNT: "acc", ...extra };
  const settings = loadSettings(env);
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return ok();
  }) as typeof fetch;
  return { router: new Router(loadConfig(env, settings), settings, impl), calls, settings };
}

const host = (url: string) => new URL(url).host;

test("config: nested lists are tiers, and ${VAR} fills the base URL", () => {
  const { router } = makeRouter();
  const auto = router.aliases.get("auto")!;
  assert.deepEqual(
    auto.tiers.map((t) => t.map((r) => r.provider.id)),
    [["x", "y"], ["z"]],
  );
  assert.equal(router.providers.get("z")!.baseUrl, "https://z.test/accounts/acc/v1");
  assert.equal(router.aliases.get("tiered")!.strategy, "priority", "defaults to ROUTER_STRATEGY, which defaults to priority");
});

test("config: a provider is off until every variable in its URL is set", () => {
  const { router } = makeRouter({ Z_ACCOUNT: "" });
  assert.equal(router.providers.get("z")!.enabled, false);
  assert.equal(router.providers.get("z")!.offReason, "no key");
});

test("config: rejects an unknown strategy", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...config, aliases: { auto: { label: "A", description: "", strategy: "fastest", routes: ["x/m"] } } }));
  assert.throws(() => loadConfig({ ROUTER_CONFIG: bad }), /unknown strategy/);
});

test("round-robin starts each request one route further on", async () => {
  const { router, calls } = makeRouter();
  for (let i = 0; i < 4; i++) await router.route("rr", request());
  assert.deepEqual(calls.map(host), ["x.test", "y.test", "x.test", "y.test"]);
});

test("least-used sends the next request to the route used least today", async () => {
  const { router, calls } = makeRouter();
  for (let i = 0; i < 3; i++) await router.route("least", request());
  assert.deepEqual(calls.map(host), ["x.test", "y.test", "x.test"]);
});

test("headroom prefers the route with most of its allowance left, within a tier", async () => {
  const { router, calls } = makeRouter();
  // x allows 10 a minute and y 2: after one each, x has 9/10 left and y 1/2.
  for (let i = 0; i < 4; i++) await router.route("auto", request());
  assert.deepEqual(calls.map(host), ["x.test", "y.test", "x.test", "x.test"]);
});

test("tiers are tried in order whatever the strategy", async () => {
  const { router, calls } = makeRouter();
  await router.route("tiered", request());
  assert.deepEqual(calls.map(host), ["z.test"]);
});

test("keeps under a model's tokens-per-day limit", async () => {
  const { router, calls } = makeRouter();
  const first = await router.route("tiered", request());
  assert.ok(first.ok);
  router.record(first.route, 495);
  // The next request (about 13 tokens with its reply) no longer fits z's 500 a day.
  const second = await router.route("tiered", request());
  assert.ok(second.ok);
  assert.notEqual(second.route.provider.id, "z");
  assert.deepEqual(calls.map(host).slice(0, 1), ["z.test"]);
});

test("budget reports requests and tokens against each provider's allowance", async () => {
  const { router } = makeRouter();
  const r = await router.route("tiered", request());
  assert.ok(r.ok);
  router.record(r.route, 250);
  const b = router.budget();
  const z = b.providers.find((p) => p.id === "z")!;
  assert.deepEqual(z.today, { requests: 1, tokens: 250 });
  assert.equal(z.used_percent.day, 25);
  assert.equal(z.terms, "ok");
  assert.equal(z.keyless, false);
  assert.equal(z.models[0].today.tokens, 250);
  assert.equal(z.models[0].headroom, 0.5, "250 of the model's 500 a day left");
  assert.equal(b.totals.allowance_tokens_per_month, 30_000);
  assert.deepEqual(b.totals.month, { requests: 1, tokens: 250 });
});

test("Ledger starts a new day and month", () => {
  let now = Date.UTC(2026, 10, 30, 23, 59);
  const l = new Ledger(() => now);
  l.add("k", 1, 100);
  assert.deepEqual(l.today("k"), { requests: 1, tokens: 100 });
  now += 2 * 60_000;
  assert.deepEqual(l.today("k"), { requests: 0, tokens: 0 });
  assert.deepEqual(l.month("k"), { requests: 0, tokens: 0 });
});

test("UsageTap uses the provider's usage figure when there is one", () => {
  const tap = new UsageTap(true);
  const enc = new TextEncoder();
  tap.push(enc.encode('data: {"choices":[{"delta":{"content":"hel'));
  tap.push(enc.encode('lo"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":42}}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(tap.finish(10), { tokens: 42, reported: true });
});

test("UsageTap estimates from the text when there's no usage", () => {
  const stream = new UsageTap(true);
  stream.push(new TextEncoder().encode(`data: {"choices":[{"delta":{"reasoning_content":"${"a".repeat(35)}","content":"${"b".repeat(35)}"}}]}\n`));
  assert.deepEqual(stream.finish(10), { tokens: 30, reported: false });
  const whole = new UsageTap(false);
  whole.push(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "x".repeat(70) } }] })));
  assert.deepEqual(whole.finish(5), { tokens: 25, reported: false });
});

test("HTTP: /v1/budget counts a streamed reply's tokens and needs the token", async () => {
  const env = { ROUTER_CONFIG: path, Z_KEY: "kz", Z_ACCOUNT: "acc", ROUTER_TOKENS: "secret" };
  const settings = loadSettings(env);
  const impl = (async () =>
    new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":77}}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  const router = new Router(loadConfig(env, settings), settings, impl);
  const server = createApp(router, settings).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { Authorization: "Bearer secret" };
  try {
    assert.equal((await fetch(`${base}/v1/budget`)).status, 401);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tiered", stream: true, max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    const b = (await (await fetch(`${base}/v1/budget`, { headers: auth })).json()) as ReturnType<Router["budget"]>;
    const z = b.providers.find((p) => p.id === "z")!;
    assert.deepEqual(z.today, { requests: 1, tokens: 77 });
    assert.equal(b.totals.today.tokens, 77);
  } finally {
    server.close();
  }
});
