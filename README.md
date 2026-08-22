# spaced-repetition

People are _**surprisingly**_ bad at retaining what they read (here's a [really good article](https://andymatuschak.org/books/) on the topic by AndyM).

After searching high and low, there doesn't appear to be any existing flashcard or spaced-repetition app on the market that solves the following problems:

1. Make it low-effort to capture the raw context around something worth remembering (e.g. when reading physical/digital books, pdfs, webpages, conversations with an AI, podcasts, etc). 
2. Refining that raw context into a pedagogically correct memory prompt (e.g. a flashcard).
3. Notifying you when a review session is actually worth doing (basically, when the backlog or forgetting cost makes a review session worthwhile).

I tried [Mochi](https://mochi.cards/) & [Anki](https://apps.ankiweb.net/) (Mochi is Anki with better UI), but they both assume that you're primarily sitting down with the app open, with your focus entirely centered on creating flash cards or reviewing flash cards. These apps also don't notify you on a spaced-repetition schedule.

I've also looked at [Orbit](https://github.com/andymatuschak/orbit) (I'm a big fan of AndyM's work). Orbit targets writers building mnemonic-medium texts (like [Quantum Country](https://quantum.country/)). We borrow its session-worthiness scheduling idea, adapted with FSRS instead of a fixed decay heuristic. Orbit's Task maps to our **prompt**; its Scheduler decides when each prompt is due for review and when to notify you.

At a high level, this project is one Cloudflare Worker with a few companion surfaces that make memory augmentation an ambient layer over whatever you’re reading or thinking about. The software helps you capture ideas worth remembering from their source context with minimal interruption, refine those raw captures into effective retrieval prompts, and intelligently resurface them for review at the right time so that this becomes a practice that you can sustain for years.

# Design principles

- Capturing context should be nearly effortless. 
- Refinement of captured context into retrieval prompts should be meaningfully effortful.


## Ops

| Command | What |
|---------|------|
| `npm run dev` | Local dev server (`http://localhost:8787/?token=devtoken`) |
| `npm test` | Test suite |
| `npm run migrate:local` | Apply D1 migrations locally |
| `npm run migrate:remote` | Apply D1 migrations to production |
| `npm run deploy` | Deploy worker code (secrets unchanged) |
| `npm run deploy:safe` | `npm test` then deploy |
| `npm run db:wipe:local` | Wipe local D1/R2 state and re-migrate |
| `CONFIRM=yes npm run db:wipe:remote` | Wipe production D1 + R2 (see below). Optional: `WIPE_SETTINGS=yes` clears settings. |

## First-time production deploy

```bash
npm install
npx wrangler login

# Create backing stores. Enable R2 in the dashboard first if bucket create fails with code 10042.
npx wrangler d1 create sr             # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create sr-assets
# If Wrangler offers to edit wrangler.jsonc after either command, decline — bindings are already configured.

npm run migrate:remote

openssl rand -hex 32 | npx wrangler secret put SR_TOKEN
npx wrangler secret put RESEND_API_KEY   # from resend.com (free tier)
npx wrangler secret put EMAIL_TO
npx wrangler secret put BASE_URL         # https://<your-worker>.workers.dev (printed at end of deploy)

npm run deploy
curl https://<your-worker>/health        # {"ok":true}
```

`EMAIL_TO` and `BASE_URL` are secrets only (not in `wrangler.jsonc`), so redeploying won't overwrite them.
`EMAIL_FROM` defaults to `onboarding@resend.dev` in `wrangler.jsonc` — Resend's test sender, which only delivers to the address on your Resend account. For production, verify your own domain in Resend and `npx wrangler secret put EMAIL_FROM`.

Open `https://<your-worker>/?token=<SR_TOKEN>` once per browser; the cookie does the rest.
On the phone: open `/capture`, then Share → Add to Home Screen.

## Local dev

```bash
npm install
cp .dev.vars.example .dev.vars   # RESEND_API_KEY and EMAIL_TO required for real sends; SR_TOKEN and BASE_URL are preset
npm run migrate:local
npm run dev
npm test
```

`npm run db:wipe:local` resets local D1/R2 state. The dev server also exposes the reminder cron:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

The server log prints the decision, e.g. `{"reminder":"fuller-session-soon","ready":false,"due":2,"send":false}`. An email is only attempted at the hour set in Settings, and only sends with a real `RESEND_API_KEY` plus `EMAIL_TO` (and `EMAIL_FROM` from `wrangler.jsonc` unless overridden in `.dev.vars`).

## iOS share-sheet Shortcut

The share-sheet shortcut is the fast path for capturing a Safari highlight without opening the app. Setup is fiddly because Shortcuts hides variable wiring inside nested pickers — follow the steps below rather than trying to cram everything into one **Get Contents of URL** action.

**Prereqs:** your worker URL and `SR_TOKEN`. Sanity-check before opening Shortcuts:

```bash
curl -s -X POST "https://<your-worker>/api/capture" \
  -H "Authorization: Bearer <SR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"shortcut test"}'
# → {"ok":true,"id":"..."}
```

**Build the shortcut** (Shortcuts → + → name "Capture"):

1. **Ask for Input** — Text, prompt `Note (optional)`, allow empty.
2. **Get Text from Input** — input: **Shortcut Input** (the shared text or page).
3. **If** **Text** (step 2) **has any value** → **Otherwise**:
   - In Otherwise: **Ask for Input** — Text, prompt `What's worth keeping?`
   - Use **Provided Input** from this ask as capture text when testing from the Shortcuts app (Shortcut Input is empty when you tap-run).
4. **Get URLs from Input** — input: **Shortcut Input**.
5. **Get Item from List** — list: **URLs** (step 4), first item only.
6. **Get Name from Input** — input: **Shortcut Input** (page title when sharing a Safari web page; empty for plain text — fine).
7. **Get Contents of URL**:
   - URL: `https://<your-worker>/api/capture`
   - Method: POST
   - Header: `Authorization` → `Bearer <SR_TOKEN>` (literal token, include the `Bearer ` prefix)
   - Request Body: **JSON** with keys:
     - `text` → capture text from step 3 (**Text** from step 2, or **Provided Input** from the fallback ask)
     - `note` → **Provided Input** from step 1
     - `url` → **Item** from step 5
     - `title` → **Name** from step 6
8. (Optional) **Show Result** — confirms `{"ok":true,...}` on success.


## Refactor loop (export → edit → import)

```bash
curl -H "Authorization: Bearer $SR_TOKEN" -o export.zip https://<your-worker>/export.zip
# unzip, edit prompts/*.md (keep the <!-- id --> comments; delete one to mint a new card), re-zip
curl -H "Authorization: Bearer $SR_TOKEN" --data-binary @export.zip "https://<your-worker>/import?apply=0"   # dry-run diff
curl -H "Authorization: Bearer $SR_TOKEN" --data-binary @export.zip "https://<your-worker>/import?apply=1"   # apply
```

Restore onto a blank deploy: `.../import?apply=1&restore=1`.

The export zip includes `retired.jsonl` (retired prompts' content archive). To un-retire a prompt, re-add its block with its `<!-- id -->` comment into its source file during import.

## Backup

Manual by design: Settings → "Download everything" (or the curl above), whenever you think of it. D1 Time Travel adds an in-vendor safety net — point-in-time restore for 30 days on Workers Paid, 7 days on Free.

## Key References
https://augmentingcognition.com/ltm.html

https://gwern.net/spaced-repetition

https://withorbit.com/

https://github.com/andymatuschak/orbit



