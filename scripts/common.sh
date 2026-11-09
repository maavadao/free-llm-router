# Shared settings for the Cloud Run scripts. Override with environment variables.
PROJECT="${PROJECT:-mawadao}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-free-llm-router}"
IMAGE="${IMAGE:-europe-west1-docker.pkg.dev/mawadao/mawadao/free-llm-router:main}"
ACCOUNT="${ACCOUNT:-raj@ulejra.ai}"
GC=(gcloud --project "$PROJECT" --account "$ACCOUNT" --quiet)

# Provider id -> environment variable -> Secret Manager secret.
PROVIDERS=(groq cerebras nvidia mistral openrouter glm sealion cloudflare gemini)
env_name() {
  case "$1" in
    glm) echo ZAI_API_KEY ;;
    cloudflare) echo CLOUDFLARE_API_TOKEN ;;
    *) echo "$(echo "$1" | tr '[:lower:]' '[:upper:]')_API_KEY" ;;
  esac
}
secret_name() { echo "llm-$1-api-key"; }
# Cloudflare also needs the account id, which goes in its URL (not a secret, but kept alongside the token).
CF_ACCOUNT_SECRET=llm-cloudflare-account-id

secret_exists() { "${GC[@]}" secrets describe "$1" >/dev/null 2>&1; }
ensure_secret() { secret_exists "$1" || "${GC[@]}" secrets create "$1" --replication-policy=automatic >/dev/null; }
