# AGENTS.md

Single-user spaced-repetition app: capture → refine → review → export/import refactor.

**Docs** (table of contents):
- Design docs → `docs/design/YYYY-MM-DD-topic.md` — authoritative (self-host: `2026-08-24-self-host-setup.md`)
- Implementation docs → `docs/impl/` — historical how-to; prefer design doc when they disagree
- Project Intent + core workflows + operator runbook → `README.md` — update it only when those change.
- When product behaviour changes, update the relevant design docs (or write a new one).
- Keep README and relevant design docs consistent when product behaviour changes.

**Stack:** Cloudflare Worker (TypeScript) + D1 + R2. Server-rendered HTML + vanilla JS. No web/client framework.

**Layout:** `src/index.ts` routes only. Pure logic in `scheduler`, `markdown`, `format`, `email` (decideReminder). HTTP in `src/routes/*`. HTML shell + helpers in `html.ts`. Tests in `test/` via `@cloudflare/vitest-plugin`.

**Static UI:** `public/static/nocturne.css` (tokens), `nocturne-app.css` (shell + screens), self-hosted Phosphor + KaTeX under `public/static/`. Run `npm run vendor:static` after `npm install` (also runs on postinstall) to copy KaTeX and Phosphor from `node_modules`.

**Do not violate:**
- Binary grades only (`remembered`/`forgot`). No streaks, stats, or counters.
- FSRS: `enable_fuzz: false`, `enable_short_term: false` — restore replays the event log deterministically.
- Auth on all routes except `/health`, `/sw.js`, `/static/*`.
- Import: dry-run by default; reject whole zip on parse errors.
- Runtime deps: `ts-fsrs`, `marked`, `katex`, `fflate` only. Ask before adding anything.

**Dev:** `npm run migrate:local` · copy `.dev.vars.example` → `.dev.vars` · `npm run dev` · `/?token=devtoken` · first-time prod: `npm run setup` or Deploy to Cloudflare button · ops in README
**Test:** `npm test`. Route tests use `exports.default.fetch` + auth/wipe helpers from `test/helpers.ts`.

**When changing:** new routes → `src/routes/` + wire `index.ts` + test. Schema → new `migrations/` file. Use `escapeHtml()`, parameterized SQL, `nowIso()` for timestamps. Deploy script must keep remote migrations on the D1 **binding** name (`DB`) so the Deploy to Cloudflare button works when users rename the database.
