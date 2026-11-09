# free-llm-router

One OpenAI-compatible endpoint over free-tier LLM providers. It powers **maava AI**, the free chat that maavaDao offers its community and students at [maavadao.com/chat](https://maavadao.com/chat).

You ask for a model by a friendly name (`auto`, `gpt-oss-120b`, `qwen`…). The router sends the request to the first provider in that name's list that has a key, isn't cooling down, is under its free-tier limits and has a large enough context. If a provider says no (429, an outage, a timeout) before it starts answering, the router sets it aside and tries the next one. The reply streams straight through.

- **No runtime dependencies.** Node 24 runs the TypeScript sources directly (type stripping), so there's no build step.
- **Limits:** per-model requests per minute and per day, shared pools (OpenRouter's `:free` models share one quota), `retry-after` cooldowns, and per-member limits by `X-Router-User`.
- **Model churn:** once an hour the router reads each provider's `/models` list and skips configured models that have been retired, so a shut-down free model drops out without a config change.
- **Privacy:** prompts and replies are never logged, only which route answered. Each provider is tagged with its data use, and `ROUTER_NO_TRAINING=1` leaves out the ones whose free tier may train on prompts.

## API

| Endpoint | What it does |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions, streaming or not. `model` is an alias from `config/providers.json` (default `auto`). Only `messages`, `stream`, `max_tokens`, `temperature` and `top_p` are passed on. The response carries `X-Router-Provider`, `X-Router-Model` and `X-Router-May-Train` headers. |
| `GET /v1/models` | The aliases, with a label, a description, whether any of their providers is set up, which providers serve them and whether any of those may train on prompts. |
| `GET /health` | Liveness, no token needed. |

Every `/v1` call needs `Authorization: Bearer <one of ROUTER_TOKENS>`. Send `X-Router-User: <member id>` to apply per-member limits.

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

Everything lives in [`config/providers.json`](config/providers.json): each provider's OpenAI-compatible base URL, the variable holding its key, its data use, and per-model context and limits; then the aliases, each an ordered list of `provider/model` routes. A provider is used only when its key is set.

| Provider | Key | Data use on the free tier | Notes |
| --- | --- | --- | --- |
| Groq | `GROQ_API_KEY` | not stated | Very fast. About 30 requests a minute and 1,000 a day per model. |
| Cerebras | `CEREBRAS_API_KEY` | not stated | Fast; free tier caps context at about 8K tokens. |
| NVIDIA NIM | `NVIDIA_API_KEY` | may train | Developer Program access, 40 requests a minute. NVIDIA calls it trial use and logs usage to improve its products. |
| Mistral | `MISTRAL_API_KEY` | may train (opt-out available in the console) | Free mode, low request rate, large token allowance. |
| OpenRouter | `OPENROUTER_API_KEY` | may train | `:free` models share 20 a minute and 50 a day (1,000 a day after a one-off $10 top-up). |
| Google Gemini | `GEMINI_API_KEY` | may train | **Off by default.** Google's terms require Paid Services when an app is offered to users in the EEA, Switzerland or the UK. |

Free tiers, model names and terms change often. The list was checked on 2026-11-09 against [mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis); check each provider's own pages before relying on a number.

## Before serving the public

- **Terms.** Free tiers are per account, and some providers' terms limit sharing a key or offering it to others through an app. Read each provider's terms for a community service like this one, and prefer education or non-profit programmes and credits where they exist.
- **Children and personal data.** Many maava AI users are students, some of them young. Turning on `ROUTER_NO_TRAINING=1` keeps prompts away from providers that may train on them; the chat page also asks people not to share personal information.
- **One instance.** Limits are counted in memory, so run a single instance (Cloud Run `--max-instances=1`) so the counts match what each provider sees.

## Deploy

GitHub Actions builds the image through maavaDao's shared workflow and, on `main`, pushes `europe-west1-docker.pkg.dev/mawadao/mawadao/free-llm-router`. To run it on Cloud Run:

1. Put `ROUTER_TOKENS` and the provider keys in Secret Manager.
2. Create the service with those secrets mounted as variables and `--max-instances=1`. Keep it private to the website if you can: the website is its only client.
3. Add `service: free-llm-router` to `.github/workflows/deploy.yml` so `main` deploys it.
4. Give the website `LLM_ROUTER_URL` and one of the tokens as `LLM_ROUTER_TOKEN`.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
