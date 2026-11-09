#!/usr/bin/env bash
# Stores a provider's API key in Secret Manager. The key is read from a hidden prompt,
# never echoed or saved to disk. Usage: scripts/add-key.sh groq
set -euo pipefail
. "$(dirname "$0")/common.sh"
provider="${1:-}"
if [[ ! " ${PROVIDERS[*]} " == *" $provider "* ]]; then
  echo "Usage: $0 <${PROVIDERS[*]// /|}>" >&2
  exit 1
fi
secret="$(secret_name "$provider")"
read -rsp "Paste the ${provider} API key (hidden): " key
echo
[[ -n "$key" ]] || { echo "No key given." >&2; exit 1; }
ensure_secret "$secret"
printf %s "$key" | "${GC[@]}" secrets versions add "$secret" --data-file=- >/dev/null
unset key
echo "Saved as ${secret}. Run scripts/deploy.sh to start using it."
