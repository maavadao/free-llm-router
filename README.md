# free-llm-router

One OpenAI-compatible endpoint over free-tier LLM providers. It powers **maava AI**, the free chat that maavaDao offers its community and students at [maavadao.com/chat](https://maavadao.com/chat).

**It works with no keys at all.** Out of the box it uses three free public endpoints that need no account: OVHcloud AI Endpoints (EU-hosted GPT-OSS, Qwen, Llama and Mistral), Kilo Code's free pool and LLM7. Provider keys only add capacity on top.

You ask for a model by a friendly name (`auto`, `gpt-oss-120b`, `qwen`…). The router tries that name's routes until one answers, skipping any that has no key, is cooling down, is over its free-tier limits or has too small a context. If a provider says no (429, an outage, a timeout) before it starts answering, the router sets it aside and tries the next one. The reply streams straight through.

- **Smarter routing.** An alias's routes come in tiers, tried in order (best models first). Within a tier, where the routes are of equal standing (often the same model at different providers), the alias's strategy decides who goes first: `headroom` (the route with most of its free allowance left, so load spreads before anyone hits a limit), `least-used` (fewest requests today), `round-robin`, or `priority` (the listed order). `ROUTER_STRATEGY` sets the default for aliases that don't name one.
- **Free-tier budget meter.** `GET /v1/budget` shows what each provider has served today and this month (requests and tokens) against its published free allowance, each model's headroom, and which providers are off and why. Token counts are the provider's own `usage` figure when it sends one, an estimate from the text otherwise. Token limits (`tpd` per model, `tokensPerDay` or `tokensPerMonth` per provider) are enforced too, so the router moves on before a provider cuts it off.

- **No runtime dependencies.** Node 24 runs the TypeScript sources directly (type stripping), so there's no build step.
- **Limits:** per-model requests per minute and per day, shared pools (OpenRouter's `:free` models share one quota), `retry-after` cooldowns, and per-member limits by `X-Router-User`.
- **Model churn:** once an hour the router reads each provider's `/models` list and skips configured models that have been retired, so a shut-down free model drops out without a config change.
- **Privacy:** prompts and replies are never logged, only which route answered. Each provider is tagged with its data use, and `ROUTER_NO_TRAINING=1` leaves out the ones whose free tier may train on prompts.

## API

| Endpoint | What it does |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions, streaming or not. `model` is an alias from `config/providers.json` (default `auto`). Only `messages`, `stream`, `max_tokens`, `temperature` and `top_p` are passed on. The response carries `X-Router-Provider`, `X-Router-Model` and `X-Router-May-Train` headers. |
| `GET /v1/models` | The aliases, with a label, a description, whether any of their providers is set up, which providers serve them, whether any of those may train on prompts, and the routing strategy. |
| `GET /v1/budget` | The free-tier budget meter: per provider, its status (`ready`, `cooling down`, `no key`, `switched off`, `may train`), keyless or not, data use, terms rating, requests and tokens today and this month, its free allowance and the share used, and per model its limits, today's use and headroom (0 to 1). Totals across providers, with the published monthly token allowance of the ones that are on. No prompts or users. |
| `GET /health` | Liveness, no token needed. |

Every `/v1` call needs one of `ROUTER_TOKENS`, as `X-Router-Token: <token>` or `Authorization: Bearer <token>`. On Cloud Run use `X-Router-Token`: Cloud Run reads a Bearer token as a Google identity token and refuses the request before it reaches the router. Send `X-Router-User: <member id>` to apply per-member limits.

## Run it

```sh
cp .env.example .env    # add ROUTER_TOKENS and whichever provider keys you have
node --env-file=.env src/server.ts
# or, with no token while developing:
npm run dev
```

```sh
curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Explain photosynthesis simply"}]}'
```

`npm test` runs the tests and `npm run typecheck` checks types.

## Providers and models

Everything lives in [`config/providers.json`](config/providers.json): each provider's OpenAI-compatible base URL (which can name environment variables as `${NAME}`), the variable holding its key, its data use, a terms rating, its published free allowance, and per-model context and limits (`rpm`, `rpd`, `tpd`, and a shared `pool`); then the aliases, each a list of `provider/model` routes where a nested list is one tier, with a `strategy`. A provider is used only when its key (and any variable in its URL) is set.

The terms rating is `ok` when the provider's terms plainly allow serving people through it, `caution` when they need reading first; the ratings follow [OmniRoute](https://github.com/diegosouzapw/OmniRoute)'s ToS table.

| Provider | Key | Data use on the free tier | Notes |
| --- | --- | --- | --- |
| OVHcloud AI Endpoints | none | not stated | Keyless anonymous tier, hosted in the EU: 2 requests a minute per IP, per model. GPT-OSS 120B and 20B, Qwen 3.5 397B, Qwen 3.8 27B, Llama 3.3 70B, Mistral Small. |
| Kilo Code | none | may train | Keyless free pool, 200 requests an hour per IP across its `:free` models. Kilo says the pool may route to providers that log prompts. |
| LLM7.io | none | not stated | Keyless "turbo" models (GPT-OSS 20B, Llama 4 Maverick, Mistral Small). Anonymous limits aren't published; the router stays at 4 a minute per model. Its terms describe it as for experimentation, development and research. |
| Groq | `GROQ_API_KEY` | not stated | Very fast. About 30 requests a minute and 1,000 a day per model. |
| Cerebras | `CEREBRAS_API_KEY` | not stated | Fast; free tier caps context at about 8K tokens. |
| NVIDIA NIM | `NVIDIA_API_KEY` | may train | Developer Program access, 40 requests a minute. NVIDIA calls it trial use and logs usage to improve its products. |
| Mistral | `MISTRAL_API_KEY` | may train (opt-out available in the console) | Free mode, low request rate, large token allowance. |
| OpenRouter | `OPENROUTER_API_KEY` | may train | `:free` models share 20 a minute and 50 a day (1,000 a day after a one-off $10 top-up). |
| Z.AI (GLM Flash) | `ZAI_API_KEY` | not stated | GLM-4.7-Flash and GLM-4.5-Flash are free with no token cap; Z.AI limits how many run at once. Terms rated ok. |
| SEA-LION (AI Singapore) | `SEALION_API_KEY` | not stated | Free key with no card, 10 requests a minute. Models tuned for South-East Asian languages (Gemma, Qwen and Llama SEA-LION). Terms rated ok. |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | not used for training | 10,000 Neurons a day across models (roughly 1M tokens, or about 150 replies from Llama 3.3 70B). GPT-OSS 120B, Llama 3.3 70B, Gemma 4 26B, GLM-4.7-Flash. |
| Google Gemini | `GEMINI_API_KEY` | may train | **Off by default.** Google's terms require Paid Services when an app is offered to users in the EEA, Switzerland or the UK. |

Free tiers, model names and terms change often. The list was checked on 2026-11-09 against [mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis); check each provider's own pages before relying on a number.

## How much can it serve?

Keyless limits are per IP address, and a deployed router has one, so every member shares them: roughly 15–20 replies a minute across the keyless providers. Each provider key adds that provider's own free allowance on top. That's how aggregators such as [OmniRoute](https://github.com/diegosouzapw/OmniRoute) reach "~1.6B free tokens a month": it's the sum of one account's free tier at each of dozens of providers (Mistral's free plan alone is about 1B), not a grant anyone hands out. For maavaDao it means one shared budget for everyone, sized by the keys we add, not 1B tokens per member.

Left out on purpose: SambaNova (its terms forbid making the service available to third parties), Cohere (trial keys can't be used in production), ModelScope (needs mainland-China identity verification), and resellers that pass on other companies' paid models for free. Pollinations' keyless text API also answers, but it isn't included: anonymous requests carry a hidden prompt and it has injected promotions into anonymous replies, which isn't right for a service used by children. Web-chat scrapers (DuckDuckGo, Cloudflare Playground and the like) are never used: their terms forbid it.

## Before serving the public

- **Terms.** Free tiers are per account, and some providers' terms limit sharing a key or offering it to others through an app. Read each provider's terms for a community service like this one, and prefer education or non-profit programmes and credits where they exist.
- **Children and personal data.** Many maava AI users are students, some of them young. Turning on `ROUTER_NO_TRAINING=1` keeps prompts away from providers that may train on them; the chat page also asks people not to share personal information.
- **One instance.** Limits and the budget meter are counted in memory, so run a single instance (Cloud Run `--max-instances=1`) so the counts match what each provider sees. A restart (or Cloud Run scaling to zero) starts the counts again; providers still say no at their real limit and the router fails over.

## Deploy

GitHub Actions builds the image through maavaDao's shared workflow and, on `main`, pushes `europe-west1-docker.pkg.dev/mawadao/mawadao/free-llm-router:main`. Three scripts run it on Cloud Run (project `mawadao`, as `raj@ulejra.ai`; set `PROJECT`, `REGION` or `ACCOUNT` to change):

```sh
scripts/create-token.sh        # a random token for the website, straight into Secret Manager; never printed
scripts/add-key.sh groq        # optional, per provider: paste the key at a hidden prompt (cloudflare also asks for the account id)
scripts/deploy.sh              # deploys the router (one instance) and points the website at it
```

`deploy.sh` mounts the token and every provider key that exists in Secret Manager (`llm-<provider>-api-key`), so adding a key later is `add-key.sh` then `deploy.sh` again. Pass router settings with `ROUTER_ENV`, for example `ROUTER_ENV=ROUTER_NO_TRAINING=1 scripts/deploy.sh`. With no provider keys at all, the router serves the keyless providers.

The service accepts requests from anywhere but answers only with the token. Once it exists, adding `service: free-llm-router` to `.github/workflows/deploy.yml` makes every push to `main` redeploy it.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
