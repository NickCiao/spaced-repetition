#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

D1_NAME="sr"
R2_BUCKET="sr-assets"

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Refusing to wipe production D1 and R2."
  echo "Usage: CONFIRM=yes npm run db:wipe:remote"
  echo "Optional: WIPE_SETTINGS=yes — also clear settings (app falls back to code defaults)"
  exit 1
fi

echo "Deleting R2 objects tracked in D1 ($R2_BUCKET)..."
ids="$(npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT id FROM assets" --json 2>/dev/null | node -e "
const rows = JSON.parse(require('fs').readFileSync(0, 'utf8'))[0]?.results ?? [];
for (const row of rows) if (row.id) process.stdout.write(row.id + '\n');
")"
if [[ -n "$ids" ]]; then
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    echo "  r2 object delete $R2_BUCKET/$id"
    npx wrangler r2 object delete "$R2_BUCKET/$id" 2>/dev/null || true
  done <<< "$ids"
else
  echo "  (no assets in D1)"
fi

echo "Wiping remote D1 ($D1_NAME)..."
for table in events prompts topics captures assets; do
  echo "  DELETE FROM $table"
  npx wrangler d1 execute "$D1_NAME" --remote --command "DELETE FROM $table;"
done

if [[ "${WIPE_SETTINGS:-}" == "yes" ]]; then
  echo "  DELETE FROM settings"
  npx wrangler d1 execute "$D1_NAME" --remote --command "DELETE FROM settings;"
fi

echo "Deleting R2 bucket $R2_BUCKET (removes any orphaned objects)..."
if npx wrangler r2 bucket delete "$R2_BUCKET"; then
  echo "Recreating R2 bucket $R2_BUCKET..."
  npx wrangler r2 bucket create "$R2_BUCKET"
else
  echo "Warning: bucket delete failed (objects may remain). Empty sr-assets in the Cloudflare dashboard."
fi

echo "Done. Secrets and worker code unchanged. Restore from export.zip with import?apply=1&restore=1 if needed."
