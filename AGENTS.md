# AGENTS.md

Single-user spaced-repetition app: capture → refine → review → export/import refactor.

**Docs** (table of contents):
- Design docs → `docs/design/YYYY-MM-DD-topic.md` — authoritative
- Implementation docs → `docs/impl/` — historical how-to; prefer design doc when they disagree
- Project Intent + core workflows + operator runbook → `README.md` — update it only when those change.
- When product behaviour changes, update the relevant design docs (or write a new one).
- Keep README and relevant design docs consistent when product behaviour changes.

**Stack:** Cloudflare Worker (TypeScript) + D1 + R2. Server-rendered HTML + vanilla JS. No web/client framework.

**Layout:** `src/index.ts` routes only. Pure logic in `scheduler`, `markdown`, `format`, `email` (decideReminder). HTTP in `src/routes/*`. Tests in `test/` via `@cloudflare/vitest-plugin`.

**Do not violate:**
- Binary grades only (`remembered`/`forgot`). No streaks, stats, or counters.
- FSRS: `enable_fuzz: false`, `enable_short_term: false` — restore replays the event log deterministically.
- Auth on all routes except `/health`, `/sw.js`, `/static/*`.
- Import: dry-run by default; reject whole zip on parse errors.
- Runtime deps: `ts-fsrs`, `marked`, `katex`, `fflate` only. Ask before adding anything.

**Dev:** `npx wrangler d1 migrations apply sr --local` · copy `.dev.vars.example` → `.dev.vars` · `npm run dev` · `/?token=devtoken`
**Test:** `npm test`. Route tests use `exports.default.fetch` + `AUTH` from `test/routes.test.ts`.

**When changing:** new routes → `src/routes/` + wire `index.ts` + test. Schema → new `migrations/` file. Use `escapeHtml()`, parameterized SQL, `nowIso()` for timestamps.
