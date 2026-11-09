#!/usr/bin/env bash
# Creates the token the website uses to call the router (secret free-llm-router-token).
# It's random and never printed. Run again to rotate it, then redeploy both services.
set -euo pipefail
. "$(dirname "$0")/common.sh"
ensure_secret free-llm-router-token
openssl rand -hex 32 | tr -d "\n" | "${GC[@]}" secrets versions add free-llm-router-token --data-file=- >/dev/null
echo "Saved a new router token in Secret Manager (free-llm-router-token)."
