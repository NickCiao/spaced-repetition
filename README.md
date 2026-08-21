# spaced-repetition

A single-Worker personal spaced-repetition system. Design: `docs/design/2026-08-20-spaced-repetition-design.md`. No personal data lives in this repo.

## Deploy (once)

```bash
npm install
npx wrangler login
npx wrangler d1 create sr             # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create sr-assets
npx wrangler d1 migrations apply sr --remote
openssl rand -hex 32 | npx wrangler secret put SR_TOKEN
npx wrangler secret put RESEND_API_KEY   # from resend.com (free tier)
# edit wrangler.jsonc vars: BASE_URL (your workers.dev URL), EMAIL_TO, EMAIL_FROM
npx wrangler deploy
```

The export zip includes `retired.jsonl` (retired prompts' content archive). To un-retire a prompt, re-add its block with its `<!-- id -->` comment into its source file during import.

Open `https://<your-worker>/?token=<SR_TOKEN>` once per browser; the cookie does the rest.
On the phone: open `/capture`, then Share → Add to Home Screen.

## Local dev

```bash
npx wrangler d1 migrations apply sr --local
echo 'SR_TOKEN=devtoken' > .dev.vars
echo 'RESEND_API_KEY=unused' >> .dev.vars
npm run dev      # http://localhost:8787/?token=devtoken
npm test
```

## iOS share-sheet Shortcut

1. Shortcuts → + → name "Capture".
2. Add action **Ask for Input** (Text, prompt "Note (optional)", allow empty).
3. Add action **Get Contents of URL**:
   - URL: `https://<your-worker>/api/capture`
   - Method POST, Header `Authorization: Bearer <SR_TOKEN>`,
   - Request Body JSON: `text` = Shortcut Input (as text), `note` = Provided Input,
     `url` = Shortcut Input → URLs (first), `title` = Shortcut Input → name if available.
4. In the shortcut's settings, enable **Show in Share Sheet**, accept Text / Safari web pages.
5. Test: select text in Safari → Share → Capture. Offline it fails visibly — use the home-screen Capture app instead; it queues.

## Refactor loop (export → edit → import)

```bash
curl -H "Authorization: Bearer $SR_TOKEN" -o export.zip https://<your-worker>/export.zip
# unzip, edit prompts/*.md (keep the <!-- id --> comments; delete one to mint a new card), re-zip
curl -H "Authorization: Bearer $SR_TOKEN" --data-binary @export.zip "https://<your-worker>/import?apply=0"   # dry-run diff
curl -H "Authorization: Bearer $SR_TOKEN" --data-binary @export.zip "https://<your-worker>/import?apply=1"   # apply
```

Restore onto a blank deploy: `.../import?apply=1&restore=1`.

## Backup

Manual by design: Settings → "Download everything" (or the curl above), whenever you think of it. D1 Time Travel covers the last 30 days.
