#!/usr/bin/env bash
# Deploys the router to Cloud Run with the token and whichever provider keys exist in
# Secret Manager, as one instance (limits are counted in memory). Then points the
# website (frontend-git) at it. Keyless providers work even with no keys stored.
set -euo pipefail
. "$(dirname "$0")/common.sh"

secret_exists free-llm-router-token || { echo "Run scripts/create-token.sh first." >&2; exit 1; }
runtime_sa="$("${GC[@]}" projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

secrets="ROUTER_TOKENS=free-llm-router-token:latest"
for p in "${PROVIDERS[@]}"; do
  s="$(secret_name "$p")"
  if secret_exists "$s"; then
    secrets+=",$(env_name "$p")=$s:latest"
    echo "  using $p key"
  fi
done
used=(free-llm-router-token $(for p in "${PROVIDERS[@]}"; do if secret_exists "$(secret_name "$p")"; then secret_name "$p"; fi; done))
if secret_exists "$CF_ACCOUNT_SECRET"; then
  secrets+=",CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT_SECRET:latest"
  used+=("$CF_ACCOUNT_SECRET")
fi
for s in "${used[@]}"; do
  "${GC[@]}" secrets add-iam-policy-binding "$s" --member="serviceAccount:$runtime_sa" --role=roles/secretmanager.secretAccessor >/dev/null
done

"${GC[@]}" run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" \
  --allow-unauthenticated --max-instances 1 --min-instances 0 --cpu 1 --memory 512Mi --timeout 600 \
  --set-secrets "$secrets" ${ROUTER_ENV:+--set-env-vars "$ROUTER_ENV"}

url="$("${GC[@]}" run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "Router: $url"
curl -fsS "$url/health" >/dev/null && echo "Health check passed."

if [[ "${SKIP_WEBSITE:-}" != 1 ]]; then
  "${GC[@]}" run services update frontend-git --region "$REGION" \
    --update-env-vars "LLM_ROUTER_URL=$url" --update-secrets "LLM_ROUTER_TOKEN=free-llm-router-token:latest"
  echo "The website now points at the router."
fi
