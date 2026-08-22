# spaced-repetition

People are _**surprisingly**_ bad at retaining what they read (here's a [really good article](https://andymatuschak.org/books/) on the topic by AndyM).

After searching high and low, there doesn't appear to be any existing flashcard or spaced-repetition app on the market that solves the following problems:

1. Make it low-effort to capture the raw context around something worth remembering (e.g. when reading physical/digital books, pdfs, webpages, conversations with an AI, podcasts, etc). 
2. Refining that raw context into a pedagogically correct memory prompt (e.g. a flashcard).
3. Notifying you on when you should **review** your memory prompts (and which ones) based on spaced-repetition schedule.

I tried [Mochi](https://mochi.cards/) & [Anki](https://apps.ankiweb.net/) (Mochi is Anki with better UI), but they both assume that you're primarily sitting down with the app open, with your focus entirely centered on creating flash cards or reviewing flash cards. These apps also don't notify you on a spaced-repetition schedule.

I've also looked at [Orbit](https://github.com/andymatuschak/orbit) (I'm a big fan of AndyM's work), but it's primarily a research project. It also primarily targets writers, giving them a tool to create content in the style of [Quantum Country](https://quantum.country/). Orbit does introduce two really useful abstractions that we borrow for this project: a Task (e.g. a thing that you want to remember), and a Scheduler (which decides when each Task is due for review, and when to notify you).

At a high level, this project consists of a few companion pieces of software that make memory augmentation an ambient layer over whatever you’re reading or thinking about. The software helps you capture ideas worth remembering from their source context with minimal interruption, refine those raw captures into effective retrieval prompts, and intelligently resurface them for review at the right time (maximizing long-term retention while minimizing practice time).

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
#   EMAIL_FROM must be a verified domain sender, or onboarding@resend.dev — Resend's
#   shared domain only permits sending from that one address.
npx wrangler deploy
```

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

Local state (D1, R2, the asset cache) lives under `.wrangler/state/` and survives restarts; delete that directory to start clean. The dev server also exposes the reminder cron, so you can fire it by hand:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

The server log prints the decision, e.g. `{"reminder":"fuller-session-soon","ready":false,"due":2,"send":false}`. An email is only attempted at the hour set in Settings, and only reaches anyone with a real `RESEND_API_KEY` plus `EMAIL_TO`/`EMAIL_FROM` — put those in `.dev.vars` if you want to watch the actual message arrive.

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

The export zip includes `retired.jsonl` (retired prompts' content archive). To un-retire a prompt, re-add its block with its `<!-- id -->` comment into its source file during import.

## Backup

Manual by design: Settings → "Download everything" (or the curl above), whenever you think of it. D1 Time Travel adds an in-vendor safety net — point-in-time restore for 30 days on Workers Paid, 7 days on Free.

## Key References
https://augmentingcognition.com/ltm.html

https://gwern.net/spaced-repetition

https://withorbit.com/

https://github.com/andymatuschak/orbit



