#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Removing local wrangler state (.wrangler/state/)..."
rm -rf .wrangler/state
echo "Reapplying local D1 migrations..."
npm run migrate:local
echo "Done. Local dev state wiped."
