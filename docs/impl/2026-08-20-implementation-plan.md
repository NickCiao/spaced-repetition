# Spaced Repetition Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-worker spaced-repetition tool specified in `docs/design/2026-08-20-spaced-repetition-design.md`: review, capture, inbox/refine, browse, settings surfaces; FSRS scheduling; reminder email cron; zip export/import/restore.

**Architecture:** One Cloudflare Worker (TypeScript) owning a D1 database (canonical store) and an R2 bucket (image assets). Server-rendered HTML with small vanilla-JS files; a PWA capture page with an offline queue. All state changes append review events; scheduling state is always re-derivable by replay.

**Tech Stack:** TypeScript (strict), Cloudflare Workers + D1 + R2 + static assets, `ts-fsrs` (scheduling), `marked` (markdown), `katex` (server-side math), `fflate` (zip), Resend HTTP API (email), vitest + `@cloudflare/vitest-pool-workers` (tests run inside workerd).

## Global Constraints

- Runtime npm dependencies: exactly `ts-fsrs`, `marked`, `katex`, `fflate`. (`fflate` is an addition to the spec's dependency sentence — zips need it; flag in the final commit message body.)
- Node ≥ 20 locally. TypeScript `strict: true`. No web framework, no client framework.
- Every route requires the bearer token (header `Authorization: Bearer …`, cookie `sr`, or `?token=` which sets the cookie) EXCEPT: `GET /health`, `/sw.js`, and `/static/*`.
- No streaks, stats, or counters anywhere in UI or email. Only "what's due" and "when next".
- Binary grades only: `remembered` → FSRS `Good`, `forgot` → FSRS `Again`.
- Settings live in D1 (`session_cap` 20, `desired_retention` 0.9, `email_hour` 7, `timezone` America/Los_Angeles). Deploy-level config (BASE_URL, EMAIL_TO, EMAIL_FROM) lives in wrangler vars; secrets (SR_TOKEN, RESEND_API_KEY) in worker secrets.
- Commit messages: plain imperative, no co-author lines.
- All timestamps stored as ISO-8601 UTC strings (`new Date().toISOString()`).

## File Structure

```
spaced-repetition/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .gitignore
  migrations/0001_init.sql
  public/                     # served by Workers assets platform, public
    sw.js                     # served at /sw.js (root scope)
    static/app.css
    static/review.js
    static/capture.js
    static/refine.js
    static/manifest.webmanifest
    static/katex/             # copied from node_modules/katex/dist (css + fonts)
  src/
    index.ts                  # router: fetch + scheduled entry
    env.d.ts                  # Env interface
    auth.ts                   # requireAuth
    db.ts                     # row types, id/now helpers, settings access
    scheduler.ts              # FSRS wrapper (pure)
    markdown.ts               # prompt rendering: markdown + math + cloze (pure)
    session.ts                # due/ahead session builder
    format.ts                 # interchange format render/parse (pure)
    exporter.ts               # zip assembly
    importer.ts               # diff / apply / restore
    email.ts                  # cadence decision (pure) + compose + send
    html.ts                   # page shell + escapeHtml
    routes/review.ts  routes/capture.ts  routes/inbox.ts
    routes/browse.ts  routes/settings.ts routes/assets.ts
    routes/transfer.ts
  test/
    apply-migrations.ts  env.d.ts
    scheduler.test.ts  markdown.test.ts  session.test.ts  format.test.ts
    importer.test.ts   email.test.ts    routes.test.ts   assets.test.ts
```

Responsibilities: `scheduler`, `markdown`, `format`, `email.decideReminder` are pure modules (unit-testable without bindings). Route modules only parse requests, call pure modules + `db`, and render. `index.ts` only routes.

---

### Task 1: Scaffold, toolchain, health route

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `src/index.ts`, `src/env.d.ts`, `test/apply-migrations.ts`, `test/env.d.ts`, `test/routes.test.ts`, `migrations/.gitkeep`

**Interfaces:**
- Produces: `Env` interface (used by every later task); worker default export `{ fetch, scheduled }`; test harness pattern (`SELF` from `cloudflare:test`).

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "spaced-repetition",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "types": "wrangler types"
  },
  "dependencies": {
    "fflate": "^0.8.2",
    "katex": "^0.16.22",
    "marked": "^15.0.0",
    "ts-fsrs": "^5.0.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "typescript": "^5.6.0",
    "vitest": "~3.2.0",
    "wrangler": "^4.0.0"
  }
}
```
(If `npm install` reports a vitest peer-range mismatch from `@cloudflare/vitest-pool-workers`, change the `vitest` version to the range npm prints, reinstall, and note it in the commit body.)

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```
(`@cloudflare/workers-types` arrives transitively with wrangler; if `tsc`/editor can't find it, `npm i -D @cloudflare/workers-types`.)

`wrangler.jsonc`:
```jsonc
{
  "name": "spaced-repetition",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-06",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "d1_databases": [
    { "binding": "DB", "database_name": "sr", "database_id": "REPLACE-AT-DEPLOY", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "sr-assets" }],
  "triggers": { "crons": ["0 * * * *"] },
  "vars": {
    "BASE_URL": "http://localhost:8787",
    "EMAIL_TO": "you@example.com",
    "EMAIL_FROM": "sr@resend.dev"
  }
}
```

`vitest.config.ts`:
```ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Tests in this suite build on each other's rows within a file
          // (seed in one `it`, read in the next). Default per-test storage
          // rollback would break that, so isolation is off; singleWorker
          // keeps files sequential and deterministic.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SR_TOKEN: "test-token",
              RESEND_API_KEY: "test-key"
            }
          }
        }
      }
    }
  };
});
```

`.gitignore`:
```
node_modules/
.wrangler/
dist/
```

`src/env.d.ts`:
```ts
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SR_TOKEN: string;
  RESEND_API_KEY: string;
  BASE_URL: string;
  EMAIL_TO: string;
  EMAIL_FROM: string;
}
```

`test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/env.d.ts`:
```ts
import type { Env } from "../src/env.d";
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
  }
}
```

Also create empty `migrations/.gitkeep` (the migrations reader needs the directory).

- [ ] **Step 2: Install and write the failing test**

Run: `npm install` — Expected: completes; lockfile created.

`test/routes.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("GET /health responds ok without auth", async () => {
    const res = await SELF.fetch("http://sr/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/routes.test.ts`
Expected: FAIL (worker entry `src/index.ts` missing / fetch handler undefined).

- [ ] **Step 4: Write minimal worker**

`src/index.ts`:
```ts
import type { Env } from "./env.d";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 14
  }
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Scaffold worker, test harness, and health route"
```

---

### Task 2: Schema and db helpers

**Files:**
- Create: `migrations/0001_init.sql`, `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Produces (all later tasks consume):
  - Row types `SourceRow`, `PromptRow`, `CaptureRow`, `EventRow` (fields exactly as in the SQL below; D1 returns them snake_case).
  - `newId(): string` — 10-char lowercase base36 crypto-random id.
  - `nowIso(): string` — current UTC ISO string.
  - `getSetting(db: D1Database, key: string): Promise<string | null>`
  - `setSetting(db: D1Database, key: string, value: string): Promise<void>`
  - `getSettings(db: D1Database): Promise<{ session_cap: number; desired_retention: number; email_hour: number; timezone: string }>`

- [ ] **Step 1: Write the failing test**

`test/db.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSetting, getSettings, newId, setSetting } from "../src/db";

describe("db", () => {
  it("seeds default settings", async () => {
    const s = await getSettings(env.DB);
    expect(s).toEqual({
      session_cap: 20,
      desired_retention: 0.9,
      email_hour: 7,
      timezone: "America/Los_Angeles"
    });
  });

  it("set/get setting round-trips", async () => {
    await setSetting(env.DB, "session_cap", "30");
    expect(await getSetting(env.DB, "session_cap")).toBe("30");
    await setSetting(env.DB, "session_cap", "20"); // restore for other tests
  });

  it("newId is 10 chars, url-safe, unique-ish", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[a-z0-9]{10}$/);
    expect(a).not.toBe(b);
  });

  it("schema accepts a full prompt row", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, '{}', ?)`
    ).bind("src0000001", "Test Source", null, now).run();
    await env.DB.prepare(
      `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
        due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
       VALUES (?, ?, 'qa', 'Q?', 'A.', 0, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL)`
    ).bind("pmt0000001", "src0000001", now, now, now).run();
    const row = await env.DB.prepare(`SELECT * FROM prompts WHERE id = ?`).bind("pmt0000001").first();
    expect(row?.kind).toBe("qa");
    expect(row?.retired).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL (`no such table: settings` — migration missing; module `../src/db` missing).

- [ ] **Step 3: Write migration and db module**

`migrations/0001_init.sql`:
```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  kind TEXT NOT NULL CHECK (kind IN ('qa','cloze')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  flag_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days REAL NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  last_review TEXT
);
CREATE INDEX idx_prompts_due ON prompts (retired, due);
CREATE INDEX idx_prompts_source ON prompts (source_id, position);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  title TEXT,
  note TEXT,
  image_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('remembered','forgot','skip','flag','retire')),
  elapsed_days REAL,
  state_after TEXT
);
CREATE INDEX idx_events_prompt ON events (prompt_id, ts);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('session_cap', '20'),
  ('desired_retention', '0.9'),
  ('email_hour', '7'),
  ('timezone', 'America/Los_Angeles'),
  ('cadence', '{"unanswered":0,"mode":"daily","last_sent":null}');
```

`src/db.ts`:
```ts
export type SourceRow = {
  id: string; name: string; url: string | null; meta: string; created_at: string;
};
export type PromptRow = {
  id: string; source_id: string; kind: "qa" | "cloze"; question: string; answer: string;
  position: number; retired: number; flag_note: string | null;
  created_at: string; updated_at: string;
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; reps: number; lapses: number; state: number; last_review: string | null;
};
export type CaptureRow = {
  id: string; created_at: string; text: string; url: string | null; title: string | null;
  note: string | null; image_id: string | null; status: "pending" | "consumed";
};
export type EventRow = {
  id: number; ts: string; prompt_id: string;
  action: "remembered" | "forgot" | "skip" | "flag" | "retire";
  elapsed_days: number | null; state_after: string | null;
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

export async function getSettings(db: D1Database) {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(rows.results.map(r => [r.key, r.value]));
  return {
    session_cap: parseInt(map.get("session_cap") ?? "20", 10),
    desired_retention: parseFloat(map.get("desired_retention") ?? "0.9"),
    email_hour: parseInt(map.get("email_hour") ?? "7", 10),
    timezone: map.get("timezone") ?? "America/Los_Angeles"
  };
}
```

Also delete `migrations/.gitkeep` (a real migration now exists).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db.test.ts` — Expected: PASS (4 tests). Also run `npx vitest run` — the Task 1 test must still pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add D1 schema, seeded settings, and db helpers"
```

---

### Task 3: Auth

**Files:**
- Create: `src/auth.ts`
- Modify: `src/index.ts` (wrap routing with auth)
- Test: append to `test/routes.test.ts`

**Interfaces:**
- Produces: `requireAuth(request: Request, env: Env): Response | null` — returns `null` when authorized; a `Response` (401, or 302 cookie-setter) otherwise. `index.ts` calls it for every path except `/health`, `/sw.js`, `/static/*`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes.test.ts`:
```ts
describe("auth", () => {
  it("rejects unknown token and missing token", async () => {
    expect((await SELF.fetch("http://sr/anything")).status).toBe(401);
    expect((await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts bearer header (404 for unknown route, not 401)", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer test-token" } });
    expect(res.status).toBe(404);
  });

  it("?token= sets cookie and redirects to clean URL", async () => {
    const res = await SELF.fetch("http://sr/somewhere?a=1&token=test-token", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://sr/somewhere?a=1");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("sr=test-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("accepts the cookie", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Cookie: "sr=test-token" } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes.test.ts`
Expected: FAIL — `/anything` currently returns 404 where 401/302 is expected.

- [ ] **Step 3: Implement**

`src/auth.ts`:
```ts
import type { Env } from "./env.d";

const PUBLIC = [/^\/health$/, /^\/sw\.js$/, /^\/static\//];

export function requireAuth(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (PUBLIC.some(re => re.test(url.pathname))) return null;

  const qp = url.searchParams.get("token");
  if (qp !== null) {
    if (qp !== env.SR_TOKEN) return new Response("unauthorized", { status: 401 });
    url.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        "Set-Cookie": `sr=${env.SR_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
      }
    });
  }

  const header = request.headers.get("Authorization");
  if (header === `Bearer ${env.SR_TOKEN}`) return null;

  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)sr=([^;]+)/);
  if (match && match[1] === env.SR_TOKEN) return null;

  return new Response("unauthorized", { status: 401 });
}
```

In `src/index.ts`, replace the fetch body with:
```ts
import { requireAuth } from "./auth";
// inside fetch(), before any routing:
const denied = requireAuth(request, env);
if (denied) return denied;
const url = new URL(request.url);
if (url.pathname === "/health") return Response.json({ ok: true });
return new Response("not found", { status: 404 });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add bearer-token auth with query-param cookie flow"
```

---

### Task 4: FSRS scheduler wrapper

**Files:**
- Create: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Produces (consumed by session, review route, importer):
  - `type Grade = "remembered" | "forgot"`
  - `type SchedFields = { due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number; reps: number; lapses: number; state: number; last_review: string | null }`
  - `newCardFields(now: Date): SchedFields` — new card, due immediately (surfaces via FSRS after first grade).
  - `applyGrade(fields: SchedFields, grade: Grade, now: Date, desiredRetention: number): SchedFields`
  - `retrievability(fields: SchedFields, now: Date): number` — 0..1; new/never-reviewed → 0.

- [ ] **Step 1: Write the failing tests**

`test/scheduler.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { applyGrade, newCardFields, retrievability } from "../src/scheduler";

const R = 0.9;
const day = (n: number, from = new Date("2026-01-01T08:00:00Z")) =>
  new Date(from.getTime() + n * 86400_000);

describe("scheduler", () => {
  it("new card is due immediately with zero reps", () => {
    const f = newCardFields(day(0));
    expect(f.reps).toBe(0);
    expect(f.state).toBe(0);
    expect(new Date(f.due).getTime()).toBeLessThanOrEqual(day(0).getTime());
    expect(retrievability(f, day(0))).toBe(0);
  });

  it("intervals grow under consecutive remembered", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    const i1 = new Date(f.due).getTime() - day(0).getTime();
    expect(i1).toBeGreaterThan(0);
    const at2 = new Date(f.due);
    f = applyGrade(f, "remembered", at2, R);
    const i2 = new Date(f.due).getTime() - at2.getTime();
    expect(i2).toBeGreaterThan(i1);
    expect(f.reps).toBe(2);
  });

  it("forgot increments lapses and shortens the next interval", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    f = applyGrade(f, "remembered", new Date(f.due), R);
    const beforeStability = f.stability;
    const at = new Date(f.due);
    f = applyGrade(f, "forgot", at, R);
    expect(f.lapses).toBe(1);
    expect(f.stability).toBeLessThan(beforeStability);
    const next = new Date(f.due).getTime() - at.getTime();
    expect(next).toBeLessThanOrEqual(2 * 86400_000);
  });

  it("replay determinism: same grades + timestamps → identical state", () => {
    const run = () => {
      let f = newCardFields(day(0));
      f = applyGrade(f, "remembered", day(0), R);
      f = applyGrade(f, "forgot", day(3), R);
      f = applyGrade(f, "remembered", day(4), R);
      return f;
    };
    expect(run()).toEqual(run());
  });

  it("retrievability decays over time and orders weakest-first", () => {
    let f = newCardFields(day(0));
    f = applyGrade(f, "remembered", day(0), R);
    const early = retrievability(f, day(1));
    const late = retrievability(f, day(30));
    expect(early).toBeGreaterThan(late);
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/scheduler.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/scheduler.ts`:
```ts
import {
  createEmptyCard, fsrs, generatorParameters, Rating, State, type Card
} from "ts-fsrs";

export type Grade = "remembered" | "forgot";

export type SchedFields = {
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; reps: number; lapses: number; state: number;
  last_review: string | null;
};

function toCard(f: SchedFields): Card {
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsed_days: f.elapsed_days,
    scheduled_days: f.scheduled_days,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state as State,
    last_review: f.last_review ? new Date(f.last_review) : undefined
  } as Card;
}

function fromCard(c: Card): SchedFields {
  return {
    due: new Date(c.due).toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    last_review: c.last_review ? new Date(c.last_review).toISOString() : null
  };
}

export function newCardFields(now: Date): SchedFields {
  return fromCard(createEmptyCard(now));
}

export function applyGrade(
  fields: SchedFields, grade: Grade, now: Date, desiredRetention: number
): SchedFields {
  // enable_fuzz: false — determinism is required for replay/restore (§8 of the spec).
  // Load-spreading fuzz was a nice-to-have; determinism wins. Note this in the task commit.
  const f = fsrs(generatorParameters({ request_retention: desiredRetention, enable_fuzz: false }));
  const rating = grade === "remembered" ? Rating.Good : Rating.Again;
  const result = f.next(toCard(fields), now, rating);
  return fromCard(result.card);
}

export function retrievability(fields: SchedFields, now: Date): number {
  if (!fields.last_review || fields.reps === 0) return 0;
  const f = fsrs(generatorParameters());
  const r = f.get_retrievability(toCard(fields), now, false);
  return typeof r === "number" ? r : 0;
}
```
(If the installed ts-fsrs major has a different `get_retrievability` signature — e.g. it returns a string percentage by default — adapt inside this function only; the exported contract stays `number 0..1`. Same for `f.next`: if only `repeat()` exists, use `f.repeat(card, now)[rating].card`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/scheduler.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add FSRS scheduler wrapper (deterministic, binary grades)"
```

---

### Task 5: Prompt markdown rendering (math, cloze, escaping)

**Files:**
- Create: `src/markdown.ts`, `src/html.ts`
- Create: `public/static/katex/` (copied assets)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces:
  - `escapeHtml(s: string): string` (from `html.ts`)
  - `renderMarkdown(text: string): string` — markdown → HTML; raw HTML escaped; `$…$`/`$$…$$` rendered via KaTeX server-side; `assets/<id>` image refs pass through as `<img src="/assets/<id>">`.
  - `renderPromptQuestion(kind: "qa" | "cloze", question: string): string` — cloze spans masked as `<span class="cloze">[…]</span>`.
  - `renderPromptAnswer(kind: "qa" | "cloze", question: string, answer: string): string` — cloze spans revealed as `<span class="cloze-revealed">…</span>`.
  - `html.ts` also exports `page(title: string, body: string, opts?: { extraHead?: string; script?: string }): Response` — full HTML shell linking `/static/app.css` and `/static/katex/katex.min.css`.

- [ ] **Step 1: Copy KaTeX assets**

Run:
```bash
mkdir -p public/static/katex
cp node_modules/katex/dist/katex.min.css public/static/katex/
cp -R node_modules/katex/dist/fonts public/static/katex/fonts
```
Expected: `public/static/katex/katex.min.css` and `public/static/katex/fonts/*.woff2` exist.

- [ ] **Step 2: Write the failing tests**

`test/markdown.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown, renderPromptAnswer, renderPromptQuestion } from "../src/markdown";

describe("renderMarkdown", () => {
  it("renders code blocks and inline code", () => {
    const html = renderMarkdown("Use `foo()`\n\n```\nbar()\n```");
    expect(html).toContain("<code>foo()</code>");
    expect(html).toContain("<pre>");
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <b>bold?</b>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders inline and display math via KaTeX", () => {
    const html = renderMarkdown("Euler: $e^{i\\pi}+1=0$ and $$\\frac{a}{b}$$");
    expect(html).toContain("katex");
    expect(html).not.toContain("$e^");
  });

  it("keeps math out of markdown's reach", () => {
    const html = renderMarkdown("$a_i + a_j$"); // underscores must not become <em>
    expect(html).not.toContain("<em>");
  });

  it("rewrites relative asset refs to /assets/<id> (32-hex ids only)", () => {
    const id = "abc123def0abc123def0abc123def012";
    expect(renderMarkdown(`![diagram](assets/${id})`)).toContain(`src="/assets/${id}"`);
  });

  it("hostile hrefs cannot inject markup or scripts", () => {
    const img = renderMarkdown('![x](assets/a"onerror="alert(1))');
    expect(img).not.toContain("<img");
    expect(img).not.toContain('onerror="'); // escaped literal text may contain onerror=&quot; — inert
    const link = renderMarkdown("[click](javascript:alert(1))");
    expect(link).not.toContain("javascript:");
    expect(link).not.toContain("<a ");
  });
});

describe("cloze", () => {
  const text = "FSRS models memory with {{stability}} and {{difficulty}}.";
  it("question masks every span", () => {
    const q = renderPromptQuestion("cloze", text);
    expect(q).toContain('<span class="cloze">[…]</span>');
    expect(q).not.toContain("stability");
    expect(q).not.toContain("{{");
  });
  it("answer reveals spans with highlight", () => {
    const a = renderPromptAnswer("cloze", text, "");
    expect(a).toContain('<span class="cloze-revealed">stability</span>');
    expect(a).not.toContain("{{");
  });
  it("qa passthrough", () => {
    expect(renderPromptQuestion("qa", "What?")).toContain("What?");
    expect(renderPromptAnswer("qa", "What?", "This.")).toContain("This.");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/markdown.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

`src/html.ts`:
```ts
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function page(title: string, body: string, opts: { extraHead?: string; script?: string } = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="stylesheet" href="/static/katex/katex.min.css">
${opts.extraHead ?? ""}
</head>
<body>
<main>${body}</main>
${opts.script ? `<script src="${opts.script}"></script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
```

`src/markdown.ts`:
```ts
import { Marked } from "marked";
import katex from "katex";
import { escapeHtml } from "./html";

// Placeholder protocol: math and cloze fragments are pulled out before the
// markdown pass (so marked can't mangle them) and re-inserted afterwards.
const SLOT = (i: number) => `\u2063SR${i}\u2063`; // invisible separator, survives marked untouched

function renderWithSlots(text: string, slots: string[]): string {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      html(token: { text: string }) { return escapeHtml(token.text); },
      image(token: { href: string; text: string }) {
        const href = token.href.startsWith("assets/") ? `/${token.href}` : token.href;
        // Strict id charset — anything else renders as escaped literal text.
        // Interpolating an unvalidated href into src= is an attribute-injection XSS.
        if (!/^\/assets\/[0-9a-f]{32}$/.test(href)) return escapeHtml(`![${token.text}](${token.href})`);
        return `<img src="${href}" alt="${escapeHtml(token.text)}" loading="lazy">`;
      },
      link(token: { href: string; text: string }) {
        // http(s) only — javascript: etc. render as escaped plain text.
        if (!/^https?:\/\//i.test(token.href)) return escapeHtml(token.text);
        return `<a href="${escapeHtml(token.href)}" rel="noopener">${escapeHtml(token.text)}</a>`;
      }
    }
  });
  let html = marked.parse(text) as string;
  slots.forEach((frag, i) => { html = html.split(SLOT(i)).join(frag); });
  return html;
}

function extractMath(text: string, slots: string[]): string {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
      slots.push(katex.renderToString(tex, { displayMode: true, throwOnError: false }));
      return SLOT(slots.length - 1);
    })
    .replace(/\$([^$\n]+?)\$/g, (_, tex: string) => {
      slots.push(katex.renderToString(tex, { displayMode: false, throwOnError: false }));
      return SLOT(slots.length - 1);
    });
}

export function renderMarkdown(text: string): string {
  const slots: string[] = [];
  return renderWithSlots(extractMath(text, slots), slots);
}

function renderCloze(text: string, mode: "mask" | "reveal"): string {
  const slots: string[] = [];
  const substituted = text.replace(/\{\{([\s\S]+?)\}\}/g, (_, inner: string) => {
    slots.push(
      mode === "mask"
        ? `<span class="cloze">[…]</span>`
        : `<span class="cloze-revealed">${escapeHtml(inner)}</span>`
    );
    return SLOT(slots.length - 1);
  });
  return renderWithSlots(extractMath(substituted, slots), slots);
}

export function renderPromptQuestion(kind: "qa" | "cloze", question: string): string {
  return kind === "cloze" ? renderCloze(question, "mask") : renderMarkdown(question);
}

export function renderPromptAnswer(kind: "qa" | "cloze", question: string, answer: string): string {
  return kind === "cloze" ? renderCloze(question, "reveal") : renderMarkdown(answer);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/markdown.test.ts` — Expected: PASS (8 tests).
(If marked's renderer-override token shapes differ in the installed major, adjust the two overrides in `renderWithSlots` only — the exported contract is fixed by these tests.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add prompt markdown rendering: escaping, KaTeX math, cloze masking"
```

---

### Task 6: Session builder

**Files:**
- Create: `src/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `retrievability` (Task 4), `renderPromptQuestion/Answer` (Task 5), row types (Task 2).
- Produces:
  - `type SessionCard = { id: string; kind: "qa" | "cloze"; questionHtml: string; answerHtml: string; sourceName: string; sourceUrl: string | null }`
  - `type Session = { cards: SessionCard[]; dueRemaining: number; nextDue: string | null; ahead: boolean }`
  - `buildSession(db: D1Database, opts: { ahead: boolean; sourceId: string | null; cap: number }, now: Date): Promise<Session>`
    - Not-ahead: due prompts (`due <= now`, not retired, optional source filter), weakest retrievability first, capped; `dueRemaining` = due count beyond the cap; `nextDue` = earliest future due.
    - Ahead: not-yet-due prompts, soonest due first, capped; `dueRemaining` = 0.

- [ ] **Step 1: Write the failing tests**

`test/session.test.ts`:
```ts
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";
import { buildSession } from "../src/session";

async function seedPrompt(sourceId: string, opts: { due: string; stability?: number; lastReview?: string | null; question?: string }) {
  const id = newId();
  const lastReview = opts.lastReview === undefined ? nowIso() : opts.lastReview; // null = never reviewed
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'ans', 0, ?, ?, ?, ?, 5, 0, 0, ?, 0, 2, ?)`
  ).bind(id, sourceId, opts.question ?? "q?", nowIso(), nowIso(), opts.due,
         opts.stability ?? 10, lastReview ? 1 : 0, lastReview).run();
  return id;
}

describe("buildSession", () => {
  const now = new Date();
  const past = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
  const future = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString();
  let src: string;

  beforeAll(async () => {
    src = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Sess Src', 'https://x', '{}', ?)")
      .bind(src, nowIso()).run();
  });

  it("serves due cards weakest-first, reports nextDue, respects cap", async () => {
    const weak = await seedPrompt(src, { due: past(20), stability: 1, lastReview: past(30), question: "weak" });
    const strong = await seedPrompt(src, { due: past(1), stability: 200, lastReview: past(2), question: "strong" });
    await seedPrompt(src, { due: future(3), question: "future" });

    const s = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 20 }, now);
    expect(s.cards.length).toBe(2);
    expect(s.cards[0].id).toBe(weak);
    expect(s.cards[1].id).toBe(strong);
    expect(s.nextDue).not.toBeNull();
    expect(s.cards[0].sourceName).toBe("Sess Src");

    const capped = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 1 }, now);
    expect(capped.cards.length).toBe(1);
    expect(capped.dueRemaining).toBe(1);
  });

  it("ahead mode serves not-yet-due, soonest first", async () => {
    const s = await buildSession(env.DB, { ahead: true, sourceId: src, cap: 20 }, now);
    expect(s.cards.length).toBeGreaterThanOrEqual(1);
    expect(s.cards[0].questionHtml).toContain("future");
    expect(s.ahead).toBe(true);
  });

  it("excludes retired prompts", async () => {
    const r = await seedPrompt(src, { due: past(5), question: "retiredq" });
    await env.DB.prepare("UPDATE prompts SET retired = 1 WHERE id = ?").bind(r).run();
    const s = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 50 }, now);
    expect(s.cards.some(c => c.id === r)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/session.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/session.ts`:
```ts
import type { PromptRow } from "./db";
import { retrievability } from "./scheduler";
import { renderPromptAnswer, renderPromptQuestion } from "./markdown";

export type SessionCard = {
  id: string; kind: "qa" | "cloze"; questionHtml: string; answerHtml: string;
  sourceName: string; sourceUrl: string | null;
};
export type Session = { cards: SessionCard[]; dueRemaining: number; nextDue: string | null; ahead: boolean };

type Joined = PromptRow & { source_name: string; source_url: string | null };

export async function buildSession(
  db: D1Database,
  opts: { ahead: boolean; sourceId: string | null; cap: number },
  now: Date
): Promise<Session> {
  const nowIso = now.toISOString();
  const sourceCond = opts.sourceId ? "AND p.source_id = ?" : "";
  const bindings = opts.sourceId ? [nowIso, opts.sourceId] : [nowIso];

  const dueSql = `
    SELECT p.*, s.name AS source_name, s.url AS source_url
    FROM prompts p JOIN sources s ON s.id = p.source_id
    WHERE p.retired = 0 AND p.due <= ? ${sourceCond}`;
  const aheadSql = `
    SELECT p.*, s.name AS source_name, s.url AS source_url
    FROM prompts p JOIN sources s ON s.id = p.source_id
    WHERE p.retired = 0 AND p.due > ? ${sourceCond}
    ORDER BY p.due ASC LIMIT ?`;

  let rows: Joined[];
  let dueRemaining = 0;
  if (opts.ahead) {
    rows = (await db.prepare(aheadSql).bind(...bindings, opts.cap).all<Joined>()).results;
  } else {
    const all = (await db.prepare(dueSql).bind(...bindings).all<Joined>()).results;
    all.sort((a, b) => retrievability(a, now) - retrievability(b, now));
    rows = all.slice(0, opts.cap);
    dueRemaining = Math.max(0, all.length - opts.cap);
  }

  const next = await db.prepare(
    `SELECT MIN(due) AS next_due FROM prompts WHERE retired = 0 AND due > ?${opts.sourceId ? " AND source_id = ?" : ""}`
  ).bind(...bindings).first<{ next_due: string | null }>();

  return {
    ahead: opts.ahead,
    dueRemaining,
    nextDue: next?.next_due ?? null,
    cards: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      questionHtml: renderPromptQuestion(r.kind, r.question),
      answerHtml: renderPromptAnswer(r.kind, r.question, r.answer),
      sourceName: r.source_name,
      sourceUrl: r.source_url
    }))
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/session.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add session builder: due weakest-first, ahead soonest-first"
```

---

### Task 7: Review surface and grading API

**Files:**
- Create: `src/routes/review.ts`, `public/static/app.css`, `public/static/review.js`
- Modify: `src/index.ts` (routes `GET /`, `POST /api/grade`)
- Test: append to `test/routes.test.ts`

**Interfaces:**
- Consumes: `buildSession` (Task 6), `applyGrade`/`newCardFields` (Task 4), `getSettings` (Task 2), `page` (Task 5).
- Produces:
  - `GET /` → review page. Query: `ahead=1`, `source=<id>`. Embeds `<script type="application/json" id="session">{Session}</script>`.
  - `POST /api/grade` body `{ prompt_id: string, action: "remembered"|"forgot"|"skip"|"flag"|"retire", note?: string }` → `{ ok: true, due: string | null }`. Writes one `events` row per call; remembered/forgot also update FSRS fields; flag sets `flag_note`; retire sets `retired = 1`.
  - `AUTH = { headers: { Authorization: "Bearer test-token" } }` test helper other route tests reuse.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes.test.ts`:
```ts
import { env } from "cloudflare:test";
import { newId, nowIso } from "../src/db";

export const AUTH = { headers: { Authorization: "Bearer test-token" } };
const POST = (path: string, body: unknown) =>
  SELF.fetch(`http://sr${path}`, {
    method: "POST",
    headers: { ...AUTH.headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

async function seedReviewPrompt(question = "rev-q") {
  const sid = newId(), pid = newId();
  const past = new Date(Date.now() - 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Rev Src', NULL, '{}', ?)")
    .bind(sid, nowIso()).run();
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'rev-a', 0, ?, ?, ?, 3, 5, 0, 3, 1, 0, 2, ?)`
  ).bind(pid, sid, question, nowIso(), nowIso(), past, past).run();
  return pid;
}

describe("review", () => {
  it("GET / embeds a session containing a due card", async () => {
    const pid = await seedReviewPrompt("embedded-question");
    const res = await SELF.fetch("http://sr/", AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="session"');
    expect(html).toContain("embedded-question");
    expect(html).toContain(pid);
  });

  it("grading remembered pushes due forward and logs an event", async () => {
    const pid = await seedReviewPrompt();
    const res = await POST("/api/grade", { prompt_id: pid, action: "remembered" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; due: string };
    expect(new Date(body.due).getTime()).toBeGreaterThan(Date.now());
    const ev = await env.DB.prepare("SELECT * FROM events WHERE prompt_id = ?").bind(pid).all();
    expect(ev.results.length).toBe(1);
    expect(ev.results[0].action).toBe("remembered");
    expect(ev.results[0].state_after).toBeTruthy();
  });

  it("flag stores the note; retire excludes from sessions; skip logs only", async () => {
    const pid = await seedReviewPrompt();
    await POST("/api/grade", { prompt_id: pid, action: "flag", note: "ambiguous" });
    let row = await env.DB.prepare("SELECT flag_note, retired, due FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.flag_note).toBe("ambiguous");

    const dueBefore = row?.due;
    await POST("/api/grade", { prompt_id: pid, action: "skip" });
    row = await env.DB.prepare("SELECT due FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.due).toBe(dueBefore); // skip never reschedules

    await POST("/api/grade", { prompt_id: pid, action: "retire" });
    row = await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.retired).toBe(1);
  });

  it("rejects unknown prompt and bad action", async () => {
    expect((await POST("/api/grade", { prompt_id: "nope", action: "remembered" })).status).toBe(404);
    const pid = await seedReviewPrompt();
    expect((await POST("/api/grade", { prompt_id: pid, action: "sideways" })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes.test.ts` — Expected: FAIL (GET / is 404).

- [ ] **Step 3: Implement**

`src/routes/review.ts`:
```ts
import type { Env } from "../env.d";
import { getSettings, nowIso, type PromptRow } from "../db";
import { applyGrade } from "../scheduler";
import { buildSession } from "../session";
import { page } from "../html";

export async function reviewPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const settings = await getSettings(env.DB);
  const session = await buildSession(env.DB, {
    ahead: url.searchParams.get("ahead") === "1",
    sourceId: url.searchParams.get("source"),
    cap: settings.session_cap
  }, new Date());

  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<div id="review"></div>
<script type="application/json" id="session">${JSON.stringify(session).replace(/</g, "\\u003c")}</script>`;
  return page("Review", body, { script: "/static/review.js" });
}

export async function gradeApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ prompt_id?: string; action?: string; note?: string }>().catch(() => null);
  const actions = ["remembered", "forgot", "skip", "flag", "retire"];
  if (!b?.prompt_id || !b.action || !actions.includes(b.action)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(b.prompt_id).first<PromptRow>();
  if (!p) return Response.json({ error: "unknown prompt" }, { status: 404 });

  const now = new Date();
  const ts = nowIso();
  let stateAfter: string | null = null;
  let due: string | null = p.due;
  let elapsed: number | null = p.last_review
    ? (now.getTime() - new Date(p.last_review).getTime()) / 86400_000 : null;

  if (b.action === "remembered" || b.action === "forgot") {
    const settings = await getSettings(env.DB);
    const f = applyGrade(p, b.action, now, settings.desired_retention);
    stateAfter = JSON.stringify(f);
    due = f.due;
    await env.DB.prepare(
      `UPDATE prompts SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?,
        reps=?, lapses=?, state=?, last_review=?, updated_at=? WHERE id=?`
    ).bind(f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
           f.reps, f.lapses, f.state, f.last_review, ts, p.id).run();
  } else if (b.action === "flag") {
    await env.DB.prepare("UPDATE prompts SET flag_note=?, updated_at=? WHERE id=?")
      .bind((b.note ?? "").trim() || "flagged", ts, p.id).run();
  } else if (b.action === "retire") {
    await env.DB.prepare("UPDATE prompts SET retired=1, updated_at=? WHERE id=?").bind(ts, p.id).run();
  } // skip: event only

  await env.DB.prepare(
    "INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, ?, ?, ?)"
  ).bind(ts, p.id, b.action, elapsed, stateAfter).run();

  return Response.json({ ok: true, due });
}
```

In `src/index.ts`, extend routing (after the auth check):
```ts
import { gradeApi, reviewPage } from "./routes/review";
// …
if (url.pathname === "/" && request.method === "GET") return reviewPage(request, env);
if (url.pathname === "/api/grade" && request.method === "POST") return gradeApi(request, env);
```

`public/static/app.css`:
```css
:root { --fg:#1c1c1c; --muted:#666; --accent:#ad6a1e; --line:#ddd; --bg:#fff; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:17px/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; }
main { max-width:640px; margin:0 auto; padding:16px; }
nav { font-size:14px; margin-bottom:20px; }
nav a { color:var(--muted); text-decoration:none; margin-right:12px; }
nav a:hover { color:var(--fg); }
.card { border:1px solid var(--line); border-radius:10px; padding:20px; margin:12px 0; }
.card img { max-width:100%; }
.source { font-size:13px; color:var(--muted); margin-top:14px; }
.cloze { color:var(--accent); font-weight:600; }
.cloze-revealed { color:var(--accent); font-weight:600; }
.btnrow { display:flex; gap:10px; margin-top:16px; }
button, .btn { flex:1; padding:14px 8px; font-size:16px; border:1px solid var(--line);
  border-radius:10px; background:#fafafa; cursor:pointer; text-align:center;
  color:var(--fg); text-decoration:none; }
button.primary { background:#1c1c1c; color:#fff; border-color:#1c1c1c; }
.overflow { margin-top:10px; font-size:13px; text-align:right; }
.overflow a { color:var(--muted); margin-left:12px; cursor:pointer; }
.done { text-align:center; color:var(--muted); margin-top:48px; }
input[type=text], textarea, select { width:100%; padding:10px; font:inherit;
  border:1px solid var(--line); border-radius:8px; }
textarea { min-height:110px; }
label { display:block; font-size:13px; color:var(--muted); margin:14px 0 4px; }
.item { border-bottom:1px solid var(--line); padding:12px 0; }
.flash { color:#2c7a2c; font-size:14px; }
h1 { font-size:20px; } h2 { font-size:17px; }
```

`public/static/review.js`:
```js
(() => {
  const session = JSON.parse(document.getElementById("session").textContent);
  const el = document.getElementById("review");
  let i = 0, revealed = false;
  // sourceName/sourceUrl are raw DB strings — escape at the DOM boundary.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function finish() {
    let html = '<div class="done">';
    if (session.dueRemaining > 0) {
      html += `<p>${session.dueRemaining} more due — keep going?</p><p><a class="btn" href="/">Continue</a></p>`;
    } else {
      const next = session.nextDue ? new Date(session.nextDue).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "—";
      html += `<p>Done — next review ${next}.</p><p><a class="btn" href="/?ahead=1">Review ahead</a></p>`;
    }
    el.innerHTML = html + "</div>";
  }

  function nothingDue() {
    const next = session.nextDue ? new Date(session.nextDue).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "nothing scheduled";
    el.innerHTML = `<div class="done"><p>Nothing due. Next: ${next}.</p>
      <p><a class="btn" href="/?ahead=1">Review ahead</a></p></div>`;
  }

  async function grade(action, note) {
    const card = session.cards[i];
    try {
      const res = await fetch("/api/grade", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: card.id, action, note })
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      alert("Couldn't save that grade — check your connection and try again.");
      return; // stay on this card; nothing advanced, nothing lost silently
    }
    i += 1; revealed = false;
    i < session.cards.length ? render() : finish();
  }

  function render() {
    const c = session.cards[i];
    const src = c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl)
      ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.sourceName)}</a>`
      : esc(c.sourceName);
    el.innerHTML = `
      <div class="card">
        <div>${revealed && c.kind === "cloze" ? c.answerHtml : c.questionHtml}</div>
        ${revealed && c.kind !== "cloze" ? `<hr><div>${c.answerHtml}</div>` : ""}
        ${revealed ? `<div class="source">${src}</div>` : ""}
      </div>
      ${revealed
        ? `<div class="btnrow"><button id="forgot">Forgot</button><button id="remembered" class="primary">Remembered</button></div>
           <div class="overflow"><a id="skip">Skip</a><a id="flag">Flag</a><a id="retire">Retire</a><a href="/prompt/${c.id}">Edit</a></div>`
        : `<div class="btnrow"><button id="reveal" class="primary">Reveal</button></div>`}`;
    if (revealed) {
      document.getElementById("forgot").onclick = () => grade("forgot");
      document.getElementById("remembered").onclick = () => grade("remembered");
      document.getElementById("skip").onclick = () => grade("skip");
      document.getElementById("retire").onclick = () => { if (confirm("Retire this prompt?")) grade("retire"); };
      document.getElementById("flag").onclick = () => {
        const note = prompt("What's wrong with this prompt?");
        if (note !== null) grade("flag", note);
      };
    } else {
      document.getElementById("reveal").onclick = () => { revealed = true; render(); };
    }
  }

  document.addEventListener("keydown", (e) => {
    if (i >= session.cards.length) return;
    if (e.key === " " && !revealed) { e.preventDefault(); revealed = true; render(); }
    else if (revealed && e.key === "ArrowLeft") grade("forgot");
    else if (revealed && e.key === "ArrowRight") grade("remembered");
  });

  session.cards.length ? render() : nothingDue();
})();
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (9 tests).

- [ ] **Step 5: Manual smoke check**

Run: `npx wrangler dev` then open `http://localhost:8787/?token=<value of SR_TOKEN you set below>`.
First set local secrets: create `.dev.vars` with:
```
SR_TOKEN=devtoken
RESEND_API_KEY=unused-in-dev
```
(Add `.dev.vars` to `.gitignore`.) Apply migrations locally first: `npx wrangler d1 migrations apply sr --local`.
Expected: "Nothing due." page renders with nav; no console errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add review page and grading API with overflow actions"
```

---

### Task 8: Capture page, API, PWA offline queue

**Files:**
- Create: `src/routes/capture.ts`, `public/static/capture.js`, `public/static/manifest.webmanifest`, `public/sw.js`
- Modify: `src/index.ts` (routes), `src/html.ts` (no change needed — manifest link passed via `extraHead`)
- Test: append to `test/routes.test.ts`

**Interfaces:**
- Consumes: `newId`, `nowIso` (Task 2), `page` (Task 5), AUTH helper (Task 7).
- Produces:
  - `GET /capture` → capture page (PWA manifest linked with `crossorigin="use-credentials"`).
  - `POST /api/capture` JSON `{ text: string, url?: string, title?: string, note?: string, image_id?: string }` → `{ ok: true, id }`; 400 on empty text.
  - `GET /api/captures/today` → `{ items: [{ id, text, created_at }] }` (UTC-day filter is fine).
  - `GET /api/sources?q=` → `{ items: [{ id, name }] }` name-prefix + substring match, 10 max.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes.test.ts`:
```ts
describe("capture", () => {
  it("POST /api/capture stores a pending capture", async () => {
    const res = await POST("/api/capture", { text: "worth remembering", url: "https://ex.com/a", title: "Ex" });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first();
    expect(row?.status).toBe("pending");
    expect(row?.title).toBe("Ex");
  });

  it("rejects empty text", async () => {
    expect((await POST("/api/capture", { text: "  " })).status).toBe(400);
  });

  it("lists today's captures", async () => {
    await POST("/api/capture", { text: "today-item" });
    const res = await SELF.fetch("http://sr/api/captures/today", AUTH);
    const { items } = await res.json() as { items: { text: string }[] };
    expect(items.some(i => i.text === "today-item")).toBe(true);
  });

  it("source autocomplete matches by substring", async () => {
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Thinking in Bets', NULL, '{}', ?)")
      .bind(newId(), nowIso()).run();
    const res = await SELF.fetch("http://sr/api/sources?q=bets", AUTH);
    const { items } = await res.json() as { items: { name: string }[] };
    expect(items.some(i => i.name === "Thinking in Bets")).toBe(true);
  });

  it("serves capture page and sw.js (sw without auth)", async () => {
    expect((await SELF.fetch("http://sr/capture", AUTH)).status).toBe(200);
    const sw = await SELF.fetch("http://sr/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("Content-Type") ?? "").toContain("javascript");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes.test.ts` — Expected: FAIL (404s on capture routes).

- [ ] **Step 3: Implement**

`src/routes/capture.ts`:
```ts
import type { Env } from "../env.d";
import { newId, nowIso } from "../db";
import { page } from "../html";

export function capturePage(): Response {
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Capture</h1>
<form id="cap">
  <label for="text">What's worth keeping?</label>
  <textarea id="text" required></textarea>
  <label for="source">Source (optional)</label>
  <input type="text" id="source" list="source-list" autocomplete="off">
  <datalist id="source-list"></datalist>
  <label for="photo">Photo (optional)</label>
  <input type="file" id="photo" accept="image/*">
  <div class="btnrow"><button class="primary" type="submit">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<h2>Today</h2>
<div id="today"></div>`;
  return page("Capture", body, {
    extraHead: `<link rel="manifest" href="/static/manifest.webmanifest" crossorigin="use-credentials">`,
    script: "/static/capture.js"
  });
}

export async function captureApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ text?: string; url?: string; title?: string; note?: string; image_id?: string }>()
    .catch(() => null);
  const text = (b?.text ?? "").trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO captures (id, created_at, text, url, title, note, image_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, nowIso(), text, b?.url ?? null, b?.title ?? null, b?.note ?? null, b?.image_id ?? null).run();
  return Response.json({ ok: true, id });
}

export async function capturesToday(env: Env): Promise<Response> {
  const dayStart = new Date().toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    "SELECT id, text, created_at FROM captures WHERE status='pending' AND created_at >= ? ORDER BY created_at DESC"
  ).bind(dayStart).all();
  return Response.json({ items: rows.results });
}

export async function sourcesApi(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const rows = await env.DB.prepare(
    "SELECT id, name FROM sources WHERE name LIKE ? ORDER BY created_at DESC LIMIT 10"
  ).bind(`%${q}%`).all();
  return Response.json({ items: rows.results });
}
```

In `src/index.ts` add routes:
```ts
import { captureApi, capturePage, capturesToday, sourcesApi } from "./routes/capture";
// …
if (url.pathname === "/capture" && request.method === "GET") return capturePage();
if (url.pathname === "/api/capture" && request.method === "POST") return captureApi(request, env);
if (url.pathname === "/api/captures/today" && request.method === "GET") return capturesToday(env);
if (url.pathname === "/api/sources" && request.method === "GET") return sourcesApi(request, env);
```

`public/static/manifest.webmanifest`:
```json
{
  "name": "Capture",
  "short_name": "Capture",
  "start_url": "/capture",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff"
}
```

`public/sw.js`:
```js
const SHELL = "sr-shell-v1";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const cacheable = e.request.method === "GET" &&
    (url.pathname === "/capture" || url.pathname.startsWith("/static/"));
  if (!cacheable) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) { // never cache errors — a 401 must not poison the shell
        const copy = res.clone();
        e.waitUntil(caches.open(SHELL).then((c) => c.put(e.request, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      return new Response("offline", { status: 503 });
    }
  })());
});
```

`public/static/capture.js`:
```js
(() => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  const QKEY = "sr-capture-queue";
  const form = document.getElementById("cap");
  const flash = document.getElementById("flash");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const readQueue = () => JSON.parse(localStorage.getItem(QKEY) || "[]");
  const writeQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));

  async function post(item) {
    const res = await fetch("/api/capture", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item)
    });
    if (res.ok) return;
    const err = new Error("capture failed " + res.status);
    err.permanent = res.status === 400; // validation rejects never succeed on retry
    throw err;
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return; // reconnects can fire online twice — one flusher at a time
    flushing = true;
    try {
      const q = readQueue();
      let flushed = false;
      while (q.length) {
        try { await post(q[0]); q.shift(); writeQueue(q); flushed = true; }
        catch (err) {
          if (err && err.permanent) { q.shift(); writeQueue(q); continue; } // drop poison items, keep the rest
          break; // transient: retry on next reconnect
        }
      }
      if (flushed) refreshToday();
    } finally { flushing = false; }
  }

  async function refreshToday() {
    try {
      const res = await fetch("/api/captures/today");
      const { items } = await res.json();
      document.getElementById("today").innerHTML =
        items.map((i) => `<div class="item">${esc(i.text)}</div>`).join("") ||
        '<p class="source">Nothing yet.</p>';
    } catch { /* offline */ }
  }

  async function downscale(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = document.getElementById("text").value;
    if (!text.trim()) { flash.textContent = "Nothing to save."; return; }
    const item = { text };
    const src = document.getElementById("source").value.trim();
    if (src) item.title = src;
    const file = document.getElementById("photo").files[0];
    let photoFailed = false;
    if (file) {
      try {
        const blob = await downscale(file);
        const up = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
        if (!up.ok) throw new Error("upload failed");
        item.image_id = (await up.json()).id;
      } catch { photoFailed = true; } // photo needs a connection; text still saves honestly
    }
    try {
      await post(item);
      flash.textContent = photoFailed ? "Saved text ✓ — photo upload failed" : "Saved ✓";
      refreshToday();
    } catch {
      const q = readQueue(); q.push(item); writeQueue(q);
      flash.textContent = "Offline — queued, will sync.";
    }
    form.reset();
  };

  document.getElementById("source").oninput = async (e) => {
    try {
      const res = await fetch(`/api/sources?q=${encodeURIComponent(e.target.value)}`);
      const { items } = await res.json();
      document.getElementById("source-list").innerHTML =
        items.map((s) => `<option value="${esc(s.name)}">`).join("");
    } catch { /* offline */ }
  };

  window.addEventListener("online", flushQueue);
  flushQueue();
  refreshToday();
})();
```
(Note: a queued photo is not preserved offline — only text/source queue in localStorage. The photo input requires a connection; that matches the spec's "PWA queue" which is about text captures.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (14 tests).
(If the vitest workers pool in the installed version does not serve the static-assets directory, the `/sw.js` assertion will 404: in that case route `GET /sw.js` through the worker — `return env.ASSETS.fetch(new Request(new URL("/sw.js", request.url)))` — keeping it in the auth PUBLIC list, and re-run.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add capture page, capture API, source autocomplete, PWA offline queue"
```

---

### Task 9: Image assets (R2 upload + serve)

**Files:**
- Create: `src/routes/assets.ts`
- Modify: `src/index.ts` (routes)
- Test: `test/assets.test.ts`

**Interfaces:**
- Consumes: `nowIso` (Task 2).
- Produces:
  - `POST /api/assets` — raw body ≤ 5 MB, `Content-Type: image/*` → `{ id }` where id = first 32 hex chars of SHA-256 of bytes (content-addressed; re-upload dedupes). Stores object at R2 key `id`, row in `assets`.
  - `GET /assets/:id` → bytes with stored content-type, `Cache-Control: private, max-age=31536000, immutable`; 404 unknown.
  - `listAssetIdsReferenced` is NOT here — exporter (Task 13) reads the `assets` table directly.

- [ ] **Step 1: Write the failing tests**

`test/assets.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const AUTH = { Authorization: "Bearer test-token" };
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);

describe("assets", () => {
  it("upload → serve round-trip, content-addressed", async () => {
    const up = await SELF.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/png" }, body: bytes
    });
    expect(up.status).toBe(200);
    const { id } = await up.json() as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const again = await SELF.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/png" }, body: bytes
    });
    expect((await again.json() as { id: string }).id).toBe(id); // dedupe

    const got = await SELF.fetch(`http://sr/assets/${id}`, { headers: AUTH });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("404 on unknown id; 400 on non-image; 413 on oversize", async () => {
    expect((await SELF.fetch("http://sr/assets/deadbeefdeadbeefdeadbeefdeadbeef", { headers: AUTH })).status).toBe(404);
    const bad = await SELF.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "text/plain" }, body: "hi"
    });
    expect(bad.status).toBe(400);
    const big = await SELF.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/jpeg" },
      body: new Uint8Array(5 * 1024 * 1024 + 1)
    });
    expect(big.status).toBe(413);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/assets.test.ts` — Expected: FAIL (404 routes).

- [ ] **Step 3: Implement**

`src/routes/assets.ts`:
```ts
import type { Env } from "../env.d";
import { nowIso } from "../db";

const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadAsset(request: Request, env: Env): Promise<Response> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("image/")) return Response.json({ error: "image/* only" }, { status: 400 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return Response.json({ error: "empty" }, { status: 400 });
  if (buf.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });

  const digest = await crypto.subtle.digest("SHA-256", buf);
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  const existing = await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(id).first();
  if (!existing) {
    await env.BUCKET.put(id, buf, { httpMetadata: { contentType: type } });
    // ON CONFLICT: two concurrent uploads of the same bytes must both get {id},
    // not a constraint crash for the loser. R2 put is an idempotent overwrite.
    await env.DB.prepare(
      "INSERT INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(id, type, buf.byteLength, nowIso()).run();
  }
  return Response.json({ id });
}

export async function serveAsset(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT content_type FROM assets WHERE id = ?")
    .bind(id).first<{ content_type: string }>();
  if (!row) return new Response("not found", { status: 404 });
  const obj = await env.BUCKET.get(id);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "private, max-age=31536000, immutable"
    }
  });
}
```

In `src/index.ts`:
```ts
import { serveAsset, uploadAsset } from "./routes/assets";
// …
if (url.pathname === "/api/assets" && request.method === "POST") return uploadAsset(request, env);
const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f]{32})$/);
if (assetMatch && request.method === "GET") return serveAsset(assetMatch[1], env);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/assets.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add content-addressed image upload and R2-backed serving"
```

---

### Task 10: Inbox and refine

**Files:**
- Create: `src/routes/inbox.ts`, `public/static/refine.js`
- Modify: `src/index.ts` (routes)
- Test: append to `test/routes.test.ts`

**Interfaces:**
- Consumes: `newCardFields` (Task 4), `renderPromptQuestion/Answer` (Task 5, for the preview endpoint), `newId`/`nowIso` (Task 2), `page`/`escapeHtml` (Task 5).
- Produces:
  - `GET /inbox` → list: pending captures (text, source hint, link to `/refine/:id`, delete button) + flagged prompts (question, flag note, link to `/prompt/:id`).
  - `GET /refine/:captureId` → editor page.
  - `POST /api/refine` JSON `{ capture_id: string, source: { id?: string; name?: string; url?: string }, prompts: [{ kind: "qa"|"cloze", question: string, answer: string }] }` → creates source if no id (name required), inserts prompts as new cards, marks capture consumed → `{ ok: true, prompt_ids: string[] }`. 400 on zero prompts, missing question, cloze without `{{`, or qa without answer. 404 unknown capture; 409 already-consumed.
  - `POST /api/capture/:id/delete` → removes a pending capture (triage).
  - `POST /api/preview` JSON `{ kind, question, answer }` → `{ questionHtml, answerHtml }` (used by the editor's preview toggle).

- [ ] **Step 1: Write the failing tests**

Append to `test/routes.test.ts`:
```ts
describe("inbox and refine", () => {
  async function seedCapture(text = "cap-text") {
    const res = await POST("/api/capture", { text, url: "https://src.example/x", title: "Cap Title" });
    return (await res.json() as { id: string }).id;
  }

  it("inbox lists pending captures and flagged prompts", async () => {
    const cid = await seedCapture("inbox-cap");
    const pid = await seedReviewPrompt("flagged-question");
    await POST("/api/grade", { prompt_id: pid, action: "flag", note: "unclear" });
    const html = await (await SELF.fetch("http://sr/inbox", AUTH)).text();
    expect(html).toContain("inbox-cap");
    expect(html).toContain(`/refine/${cid}`);
    expect(html).toContain("flagged-question");
    expect(html).toContain("unclear");
  });

  it("refine creates prompts as new cards and consumes the capture", async () => {
    const cid = await seedCapture();
    const res = await POST("/api/refine", {
      capture_id: cid,
      source: { name: "Refine Book", url: "https://src.example/x" },
      prompts: [
        { kind: "qa", question: "RQ1?", answer: "RA1" },
        { kind: "cloze", question: "The {{answer}} is here.", answer: "" }
      ]
    });
    expect(res.status).toBe(200);
    const { prompt_ids } = await res.json() as { prompt_ids: string[] };
    expect(prompt_ids.length).toBe(2);
    const p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(prompt_ids[0]).first();
    expect(p?.reps).toBe(0);
    expect(p?.state).toBe(0);
    const cap = await env.DB.prepare("SELECT status FROM captures WHERE id = ?").bind(cid).first();
    expect(cap?.status).toBe("consumed");
    const again = await POST("/api/refine", { capture_id: cid, source: { name: "X" }, prompts: [{ kind: "qa", question: "q", answer: "a" }] });
    expect(again.status).toBe(409);
  });

  it("refine validation: no prompts, cloze without spans, qa without answer", async () => {
    const cid = await seedCapture();
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [{ kind: "cloze", question: "no spans", answer: "" }] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [{ kind: "qa", question: "q?", answer: "" }] })).status).toBe(400);
  });

  it("capture delete removes pending capture", async () => {
    const cid = await seedCapture("to-delete");
    const res = await SELF.fetch(`http://sr/api/capture/${cid}/delete`, { method: "POST", ...AUTH });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM captures WHERE id = ?").bind(cid).first();
    expect(row).toBeNull();
  });

  it("preview renders both sides", async () => {
    const res = await POST("/api/preview", { kind: "cloze", question: "Hide {{this}}.", answer: "" });
    const body = await res.json() as { questionHtml: string; answerHtml: string };
    expect(body.questionHtml).toContain("[…]");
    expect(body.answerHtml).toContain("this");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes.test.ts` — Expected: FAIL (inbox routes 404).

- [ ] **Step 3: Implement**

`src/routes/inbox.ts`:
```ts
import type { Env } from "../env.d";
import { newId, nowIso, type CaptureRow, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { renderPromptAnswer, renderPromptQuestion } from "../markdown";
import { escapeHtml, page } from "../html";

export async function inboxPage(env: Env): Promise<Response> {
  const caps = (await env.DB.prepare(
    "SELECT * FROM captures WHERE status = 'pending' ORDER BY created_at DESC"
  ).all<CaptureRow>()).results;
  const flagged = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE flag_note IS NOT NULL AND retired = 0 ORDER BY updated_at DESC"
  ).all<PromptRow>()).results;

  const capHtml = caps.map(c => `
    <div class="item">
      <div>${escapeHtml(c.text)}</div>
      ${c.image_id && /^[0-9a-f]{32}$/.test(c.image_id) ? `<img src="/assets/${c.image_id}" style="max-height:120px">` : ""}
      <div class="source">${escapeHtml(c.title ?? c.url ?? "")} · ${c.created_at.slice(0, 10)}</div>
      <div class="overflow"><a href="/refine/${c.id}">Refine</a>
      <a onclick="fetch('/api/capture/${c.id}/delete',{method:'POST'}).then(()=>location.reload())">Delete</a></div>
    </div>`).join("") || "<p class='source'>No captures waiting.</p>";

  const flagHtml = flagged.map(p => `
    <div class="item">
      <div>${escapeHtml(p.question)}</div>
      <div class="source">flag: ${escapeHtml(p.flag_note ?? "")}</div>
      <div class="overflow"><a href="/prompt/${p.id}">Edit</a></div>
    </div>`).join("") || "<p class='source'>No flagged prompts.</p>";

  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Inbox</h1>
<h2>Captures</h2>${capHtml}
<h2>Flagged prompts</h2>${flagHtml}`;
  return page("Inbox", body);
}

export async function refinePage(captureId: string, env: Env): Promise<Response> {
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ? AND status = 'pending'")
    .bind(captureId).first<CaptureRow>();
  if (!cap) return new Response("not found", { status: 404 });
  const sourceGuess = cap.title ?? "";
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Refine</h1>
<div class="card"><div>${escapeHtml(cap.text)}</div>
${cap.image_id && /^[0-9a-f]{32}$/.test(cap.image_id) ? `<img src="/assets/${cap.image_id}">` : ""}
<div class="source">${escapeHtml(cap.title ?? "")} ${cap.url && /^https?:\/\//i.test(cap.url) ? `· <a href="${escapeHtml(cap.url)}">${escapeHtml(cap.url)}</a>` : ""}</div></div>
<div id="refine"
  data-capture="${cap.id}"
  data-source-name="${escapeHtml(sourceGuess)}"
  data-source-url="${escapeHtml(cap.url ?? "")}"></div>`;
  return page("Refine", body, { script: "/static/refine.js" });
}

type RefineBody = {
  capture_id?: string;
  source?: { id?: string; name?: string; url?: string };
  prompts?: { kind: "qa" | "cloze"; question: string; answer: string }[];
};

export async function refineApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<RefineBody>().catch(() => null);
  if (!b?.capture_id || !b.source || !b.prompts?.length) {
    return Response.json({ error: "capture_id, source, prompts required" }, { status: 400 });
  }
  for (const p of b.prompts) {
    if (p.kind !== "qa" && p.kind !== "cloze") return Response.json({ error: "bad kind" }, { status: 400 });
    if (!p.question?.trim()) return Response.json({ error: "question required" }, { status: 400 });
    if (p.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(p.question))
      return Response.json({ error: "cloze needs at least one {{span}}" }, { status: 400 });
    if (p.kind === "qa" && !p.answer?.trim())
      return Response.json({ error: "answer required for qa" }, { status: 400 });
  }
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(b.capture_id).first<CaptureRow>();
  if (!cap) return Response.json({ error: "unknown capture" }, { status: 404 });
  if (cap.status !== "pending") return Response.json({ error: "already consumed" }, { status: 409 });

  const ts = nowIso();
  let sourceId = b.source.id ?? null;
  if (!sourceId) {
    if (!b.source.name?.trim()) return Response.json({ error: "source name required" }, { status: 400 });
    const existing = await env.DB.prepare("SELECT id FROM sources WHERE name = ?")
      .bind(b.source.name.trim()).first<SourceRow>();
    if (existing) sourceId = existing.id;
    else {
      sourceId = newId();
      await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, '{}', ?)")
        .bind(sourceId, b.source.name.trim(), b.source.url || null, ts).run();
    }
  }

  const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM prompts WHERE source_id = ?")
    .bind(sourceId).first<{ p: number }>();
  let pos = (posRow?.p ?? -1) + 1;

  const ids: string[] = [];
  for (const p of b.prompts) {
    const id = newId();
    const f = newCardFields(new Date());
    await env.DB.prepare(
      `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
        due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, sourceId, p.kind, p.question, p.answer ?? "", pos++, ts, ts,
           f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
           f.reps, f.lapses, f.state, f.last_review).run();
    ids.push(id);
  }
  await env.DB.prepare("UPDATE captures SET status = 'consumed' WHERE id = ?").bind(cap.id).run();
  return Response.json({ ok: true, prompt_ids: ids });
}

export async function deleteCapture(id: string, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM captures WHERE id = ? AND status = 'pending'").bind(id).run();
  return Response.json({ ok: true });
}

export async function previewApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ kind: "qa" | "cloze"; question: string; answer: string }>().catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  return Response.json({
    questionHtml: renderPromptQuestion(b.kind, b.question ?? ""),
    answerHtml: renderPromptAnswer(b.kind, b.question ?? "", b.answer ?? "")
  });
}
```

In `src/index.ts`:
```ts
import { deleteCapture, inboxPage, previewApi, refineApi, refinePage } from "./routes/inbox";
// …
if (url.pathname === "/inbox" && request.method === "GET") return inboxPage(env);
const refineMatch = url.pathname.match(/^\/refine\/([a-z0-9]{10})$/);
if (refineMatch && request.method === "GET") return refinePage(refineMatch[1], env);
if (url.pathname === "/api/refine" && request.method === "POST") return refineApi(request, env);
const delMatch = url.pathname.match(/^\/api\/capture\/([a-z0-9]{10})\/delete$/);
if (delMatch && request.method === "POST") return deleteCapture(delMatch[1], env);
if (url.pathname === "/api/preview" && request.method === "POST") return previewApi(request, env);
```

`public/static/refine.js`:
```js
(() => {
  const root = document.getElementById("refine");
  const prompts = [];

  function promptForm() {
    return `
<div class="card" data-i="${prompts.length}">
  <label>Kind</label>
  <select class="kind"><option value="qa">Q / A</option><option value="cloze">Cloze</option></select>
  <label>Question (cloze: use {{spans}})</label>
  <textarea class="q"></textarea>
  <label class="a-label">Answer</label>
  <textarea class="a"></textarea>
  <div class="overflow"><a class="preview-toggle">Preview</a></div>
  <div class="preview"></div>
</div>`;
  }

  function render() {
    root.innerHTML = `
<label>Source</label>
<input type="text" id="src-name" list="source-list" value="${root.dataset.sourceName}">
<datalist id="source-list"></datalist>
<div id="forms">${promptForm()}</div>
<div class="btnrow"><button id="add">+ prompt</button><button id="save" class="primary">Save prompts</button></div>
<p class="flash" id="flash"></p>`;

    document.getElementById("src-name").oninput = async (e) => {
      const res = await fetch(`/api/sources?q=${encodeURIComponent(e.target.value)}`);
      const { items } = await res.json();
      document.getElementById("source-list").innerHTML =
        items.map((s) => `<option value="${s.name.replace(/"/g, "&quot;")}">`).join("");
    };
    document.getElementById("add").onclick = () =>
      document.getElementById("forms").insertAdjacentHTML("beforeend", promptForm());
    document.getElementById("save").onclick = save;
    root.addEventListener("click", async (e) => {
      if (!e.target.classList.contains("preview-toggle")) return;
      const card = e.target.closest(".card");
      const body = collect(card);
      const res = await fetch("/api/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const { questionHtml, answerHtml } = await res.json();
      card.querySelector(".preview").innerHTML = `<hr>${questionHtml}<hr>${answerHtml}`;
    });
    root.addEventListener("change", (e) => {
      if (!e.target.classList.contains("kind")) return;
      const card = e.target.closest(".card");
      const isCloze = e.target.value === "cloze";
      card.querySelector(".a-label").style.display = isCloze ? "none" : "";
      card.querySelector(".a").style.display = isCloze ? "none" : "";
    });
  }

  const collect = (card) => ({
    kind: card.querySelector(".kind").value,
    question: card.querySelector(".q").value,
    answer: card.querySelector(".a").value
  });

  async function save() {
    const cards = [...document.querySelectorAll("#forms .card")].map(collect)
      .filter((p) => p.question.trim());
    const res = await fetch("/api/refine", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capture_id: root.dataset.capture,
        source: { name: document.getElementById("src-name").value, url: root.dataset.sourceUrl || undefined },
        prompts: cards
      })
    });
    if (res.ok) location.href = "/inbox";
    else document.getElementById("flash").textContent = (await res.json()).error;
  }

  render();
})();
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add inbox and refine flow: captures to prompts, flags surfaced"
```

---

### Task 11: Browse, prompt edit, settings

**Files:**
- Create: `src/routes/browse.ts`, `src/routes/settings.ts`
- Modify: `src/index.ts` (routes)
- Test: append to `test/routes.test.ts`

**Interfaces:**
- Consumes: everything already defined; `newCardFields` for direct prompt creation.
- Produces:
  - `GET /browse` → sources with prompt counts; each links `/browse/:sourceId`.
  - `GET /browse/:sourceId` → that source's prompts (question text, retired marker), "Review this source now" → `/?source=<id>` and "Review ahead" → `/?source=<id>&ahead=1`, "+ prompt" → `/prompt/new?source=<id>`.
  - `GET /prompt/new?source=<id>` and `GET /prompt/:id` → edit form (kind, question, answer, retire/unretire, clear-flag).
  - `POST /api/prompt` `{ id?: string, source_id: string, kind, question, answer, retired?: boolean, clear_flag?: boolean }` → upsert. Editing NEVER touches FSRS fields (`due` unchanged) → `{ ok: true, id }`. Same validation rules as refine.
  - `GET /settings` → form with the 4 settings + export link + import form (import wired in Task 13; the form posts to `/import`).
  - `POST /api/settings` `{ session_cap, desired_retention, email_hour, timezone }` → validates (cap 1–100 int; retention 0.7–0.97; hour 0–23 int; timezone accepted by `Intl.DateTimeFormat`) → 400 with message on violation.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes.test.ts`:
```ts
describe("browse, prompt edit, settings", () => {
  it("editing a prompt preserves its schedule", async () => {
    const pid = await seedReviewPrompt("before-edit");
    const before = await env.DB.prepare("SELECT due, source_id FROM prompts WHERE id = ?").bind(pid).first();
    const res = await POST("/api/prompt", {
      id: pid, source_id: before!.source_id, kind: "qa",
      question: "after-edit?", answer: "new answer", clear_flag: true
    });
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT question, due, flag_note FROM prompts WHERE id = ?").bind(pid).first();
    expect(after?.question).toBe("after-edit?");
    expect(after?.due).toBe(before?.due);
    expect(after?.flag_note).toBeNull();
  });

  it("creates a prompt directly under a source (new card)", async () => {
    const sid = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Direct Src', NULL, '{}', ?)")
      .bind(sid, nowIso()).run();
    const res = await POST("/api/prompt", { source_id: sid, kind: "qa", question: "direct?", answer: "yes" });
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT reps, state FROM prompts WHERE id = ?").bind(id).first();
    expect(row?.reps).toBe(0);
    const html = await (await SELF.fetch(`http://sr/browse/${sid}`, AUTH)).text();
    expect(html).toContain("direct?");
    expect(html).toContain(`/?source=${sid}`);
  });

  it("browse index lists sources with counts", async () => {
    const html = await (await SELF.fetch("http://sr/browse", AUTH)).text();
    expect(html).toContain("Direct Src");
  });

  it("settings round-trip and validation", async () => {
    const ok = await POST("/api/settings", { session_cap: 25, desired_retention: 0.85, email_hour: 8, timezone: "America/New_York" });
    expect(ok.status).toBe(200);
    const html = await (await SELF.fetch("http://sr/settings", AUTH)).text();
    expect(html).toContain("25");
    expect((await POST("/api/settings", { session_cap: 0, desired_retention: 0.9, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.5, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "Not/AZone" })).status).toBe(400);
    // restore defaults for other tests
    await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/routes.test.ts` — Expected: FAIL (404s).

- [ ] **Step 3: Implement**

`src/routes/browse.ts`:
```ts
import type { Env } from "../env.d";
import { newId, nowIso, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { escapeHtml, page } from "../html";

const NAV = `<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>`;

export async function browseIndex(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(`
    SELECT s.id, s.name, COUNT(p.id) AS n
    FROM sources s LEFT JOIN prompts p ON p.source_id = s.id AND p.retired = 0
    GROUP BY s.id ORDER BY s.created_at DESC`).all<{ id: string; name: string; n: number }>()).results;
  const body = `${NAV}<h1>Browse</h1>` + (rows.map(r =>
    `<div class="item"><a href="/browse/${r.id}">${escapeHtml(r.name)}</a> <span class="source">${r.n} prompts</span></div>`
  ).join("") || "<p class='source'>No sources yet.</p>");
  return page("Browse", body);
}

export async function browseSource(sourceId: string, env: Env): Promise<Response> {
  const src = await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(sourceId).first<SourceRow>();
  if (!src) return new Response("not found", { status: 404 });
  const prompts = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE source_id = ? ORDER BY position").bind(sourceId).all<PromptRow>()).results;
  const list = prompts.map(p => `
    <div class="item">
      <a href="/prompt/${p.id}">${escapeHtml(p.question.slice(0, 120))}</a>
      ${p.retired ? '<span class="source">retired</span>' : ""}
      ${p.flag_note ? '<span class="source">flagged</span>' : ""}
    </div>`).join("") || "<p class='source'>No prompts.</p>";
  const body = `${NAV}
<h1>${escapeHtml(src.name)}</h1>
${src.url ? `<p class="source"><a href="${escapeHtml(src.url)}">${escapeHtml(src.url)}</a></p>` : ""}
<div class="btnrow">
  <a class="btn" href="/?source=${src.id}">Review this source now</a>
  <a class="btn" href="/?source=${src.id}&ahead=1">Review ahead</a>
  <a class="btn" href="/prompt/new?source=${src.id}">+ prompt</a>
</div>
${list}`;
  return page(src.name, body);
}

export async function promptForm(idOrNew: string, request: Request, env: Env): Promise<Response> {
  let p: PromptRow | null = null;
  let sourceId = new URL(request.url).searchParams.get("source") ?? "";
  if (idOrNew !== "new") {
    p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(idOrNew).first<PromptRow>();
    if (!p) return new Response("not found", { status: 404 });
    sourceId = p.source_id;
  }
  const body = `${NAV}
<h1>${p ? "Edit prompt" : "New prompt"}</h1>
${p?.flag_note ? `<p class="source">flag: ${escapeHtml(p.flag_note)}</p>` : ""}
<form method="post" action="/api/prompt" onsubmit="return submitPrompt(event)">
  <input type="hidden" id="pid" value="${p?.id ?? ""}">
  <input type="hidden" id="sid" value="${sourceId}">
  <label>Kind</label>
  <select id="kind"><option value="qa"${p?.kind !== "cloze" ? " selected" : ""}>Q / A</option>
  <option value="cloze"${p?.kind === "cloze" ? " selected" : ""}>Cloze</option></select>
  <label>Question</label><textarea id="q">${escapeHtml(p?.question ?? "")}</textarea>
  <label>Answer</label><textarea id="a">${escapeHtml(p?.answer ?? "")}</textarea>
  <label><input type="checkbox" id="retired"${p?.retired ? " checked" : ""}> retired</label>
  <div class="btnrow"><button class="primary">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<script>
async function submitPrompt(e) {
  e.preventDefault();
  const body = {
    id: document.getElementById("pid").value || undefined,
    source_id: document.getElementById("sid").value,
    kind: document.getElementById("kind").value,
    question: document.getElementById("q").value,
    answer: document.getElementById("a").value,
    retired: document.getElementById("retired").checked,
    clear_flag: true
  };
  const res = await fetch("/api/prompt", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) location.href = "/browse/" + body.source_id;
  else document.getElementById("flash").textContent = (await res.json()).error;
  return false;
}
</script>`;
  return page(p ? "Edit prompt" : "New prompt", body);
}

type PromptBody = {
  id?: string; source_id?: string; kind?: "qa" | "cloze"; question?: string;
  answer?: string; retired?: boolean; clear_flag?: boolean;
};

export async function promptApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<PromptBody>().catch(() => null);
  if (!b?.source_id || (b.kind !== "qa" && b.kind !== "cloze") || !b.question?.trim()) {
    return Response.json({ error: "source_id, kind, question required" }, { status: 400 });
  }
  if (b.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(b.question))
    return Response.json({ error: "cloze needs at least one {{span}}" }, { status: 400 });
  if (b.kind === "qa" && !b.answer?.trim())
    return Response.json({ error: "answer required for qa" }, { status: 400 });

  const ts = nowIso();
  if (b.id) {
    const existing = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(b.id).first();
    if (!existing) return Response.json({ error: "unknown prompt" }, { status: 404 });
    await env.DB.prepare(
      `UPDATE prompts SET kind=?, question=?, answer=?, retired=?, updated_at=?
        ${b.clear_flag ? ", flag_note=NULL" : ""} WHERE id=?`
    ).bind(b.kind, b.question, b.answer ?? "", b.retired ? 1 : 0, ts, b.id).run();
    return Response.json({ ok: true, id: b.id });
  }
  const id = newId();
  const f = newCardFields(new Date());
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, ?, ?, ?,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM prompts WHERE source_id = ?), ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, b.source_id, b.kind, b.question, b.answer ?? "", b.source_id, ts, ts,
         f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
         f.reps, f.lapses, f.state, f.last_review).run();
  return Response.json({ ok: true, id });
}
```

`src/routes/settings.ts`:
```ts
import type { Env } from "../env.d";
import { getSettings, setSetting } from "../db";
import { page } from "../html";

export async function settingsPage(env: Env): Promise<Response> {
  const s = await getSettings(env.DB);
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Settings</h1>
<form onsubmit="return saveSettings(event)">
  <label>Session cap</label><input type="text" id="session_cap" value="${s.session_cap}">
  <label>Desired retention (0.7–0.97)</label><input type="text" id="desired_retention" value="${s.desired_retention}">
  <label>Reminder hour (0–23, local)</label><input type="text" id="email_hour" value="${s.email_hour}">
  <label>Timezone</label><input type="text" id="timezone" value="${s.timezone}">
  <div class="btnrow"><button class="primary">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<h2>Data</h2>
<p><a href="/export.zip">Download everything</a></p>
<form method="post" action="/import?apply=0" onsubmit="return doImport(event)">
  <label>Import zip (dry-run first)</label>
  <input type="file" id="zipfile" accept=".zip">
  <div class="btnrow"><button id="dry">Dry-run</button><button id="apply" class="primary">Apply</button></div>
  <pre id="importout"></pre>
</form>
<script>
async function saveSettings(e) {
  e.preventDefault();
  const body = {
    session_cap: parseInt(document.getElementById("session_cap").value, 10),
    desired_retention: parseFloat(document.getElementById("desired_retention").value),
    email_hour: parseInt(document.getElementById("email_hour").value, 10),
    timezone: document.getElementById("timezone").value.trim()
  };
  const res = await fetch("/api/settings", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  document.getElementById("flash").textContent = res.ok ? "Saved ✓" : (await res.json()).error;
  return false;
}
async function doImport(e) {
  e.preventDefault();
  const f = document.getElementById("zipfile").files[0];
  if (!f) return false;
  const apply = e.submitter && e.submitter.id === "apply" ? 1 : 0;
  const res = await fetch("/import?apply=" + apply, { method: "POST", body: f });
  document.getElementById("importout").textContent = JSON.stringify(await res.json(), null, 2);
  return false;
}
</script>`;
  return page("Settings", body);
}

export async function settingsApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ session_cap?: number; desired_retention?: number; email_hour?: number; timezone?: string }>()
    .catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  if (!Number.isInteger(b.session_cap) || b.session_cap! < 1 || b.session_cap! > 100)
    return Response.json({ error: "session_cap must be an integer 1–100" }, { status: 400 });
  if (typeof b.desired_retention !== "number" || b.desired_retention < 0.7 || b.desired_retention > 0.97)
    return Response.json({ error: "desired_retention must be 0.7–0.97" }, { status: 400 });
  if (!Number.isInteger(b.email_hour) || b.email_hour! < 0 || b.email_hour! > 23)
    return Response.json({ error: "email_hour must be 0–23" }, { status: 400 });
  try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); }
  catch { return Response.json({ error: "unknown timezone" }, { status: 400 }); }

  await setSetting(env.DB, "session_cap", String(b.session_cap));
  await setSetting(env.DB, "desired_retention", String(b.desired_retention));
  await setSetting(env.DB, "email_hour", String(b.email_hour));
  await setSetting(env.DB, "timezone", b.timezone!);
  return Response.json({ ok: true });
}
```

In `src/index.ts`:
```ts
import { browseIndex, browseSource, promptApi, promptForm } from "./routes/browse";
import { settingsApi, settingsPage } from "./routes/settings";
// …
if (url.pathname === "/browse" && request.method === "GET") return browseIndex(env);
const srcMatch = url.pathname.match(/^\/browse\/([a-z0-9]{10})$/);
if (srcMatch && request.method === "GET") return browseSource(srcMatch[1], env);
const pMatch = url.pathname.match(/^\/prompt\/(new|[a-z0-9]{10})$/);
if (pMatch && request.method === "GET") return promptForm(pMatch[1], request, env);
if (url.pathname === "/api/prompt" && request.method === "POST") return promptApi(request, env);
if (url.pathname === "/settings" && request.method === "GET") return settingsPage(env);
if (url.pathname === "/api/settings" && request.method === "POST") return settingsApi(request, env);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/routes.test.ts` — Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add browse, prompt editing (schedule-preserving), and settings"
```

---

### Task 12: Interchange format (pure)

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; `SourceRow`/`PromptRow` types only).
- Produces (consumed by exporter/importer):
  - `type ParsedPrompt = { id: string | null; kind: "qa" | "cloze"; question: string; answer: string }`
  - `type ParsedFile = { name: string; url: string | null; meta: Record<string, string>; prompts: ParsedPrompt[] }`
  - `class FormatError extends Error { path: string; line: number }`
  - `renderSourceFile(source: { name: string; url: string | null; meta: string }, prompts: { id: string; kind: "qa" | "cloze"; question: string; answer: string }[]): string`
  - `parseSourceFile(text: string, path: string): ParsedFile` — throws `FormatError` with path + 1-based line.
  - `sourceFileName(name: string, id: string): string` → `prompts/<slug>-<id>.md` (slug: lowercase, alphanumerics and hyphens, max 40 chars).
- Format contract (documented constraint, enforced by render-side validation): prompt text lines must not themselves start with `Q: `, `A: `, `C: `, `<!-- id:`, or be `---`. `renderSourceFile` throws `FormatError` if they would.

- [ ] **Step 1: Write the failing tests**

`test/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FormatError, parseSourceFile, renderSourceFile, sourceFileName } from "../src/format";

const src = { name: "Why We Think", url: "https://ex.com/think", meta: '{"x-author":"Weng"}' };
const prompts = [
  { id: "aaaaaaaaaa", kind: "qa" as const, question: "Multi\nline Q?", answer: "Para one.\n\nPara two." },
  { id: "bbbbbbbbbb", kind: "cloze" as const, question: "Hide {{this}} and {{that}}.", answer: "" }
];

describe("interchange format", () => {
  it("renders the documented shape", () => {
    const text = renderSourceFile(src, prompts);
    expect(text).toContain("---\nsource: Why We Think\nurl: https://ex.com/think\nx-author: Weng\n---");
    expect(text).toContain("Q: Multi\nline Q?");
    expect(text).toContain("A: Para one.\n\nPara two."); // blank lines inside a block are content
    expect(text).toContain("<!-- id: aaaaaaaaaa -->");
    expect(text).toContain("C: Hide {{this}} and {{that}}.");
  });

  it("round-trips: parse(render(x)) == x", () => {
    const parsed = parseSourceFile(renderSourceFile(src, prompts), "prompts/why.md");
    expect(parsed.name).toBe(src.name);
    expect(parsed.url).toBe(src.url);
    expect(parsed.meta).toEqual({ "x-author": "Weng" });
    expect(parsed.prompts).toEqual(prompts.map(p => ({ ...p })));
  });

  it("round-trips 50 random files", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const word = () => "w" + Math.floor(rnd() * 1e6).toString(36);
    for (let f = 0; f < 50; f++) {
      const ps = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => {
        const cloze = rnd() < 0.4;
        return {
          id: (i + 10).toString(36).repeat(5).slice(0, 10),
          kind: (cloze ? "cloze" : "qa") as "qa" | "cloze",
          question: cloze ? `${word()} {{${word()}}} ${word()}\n${word()}` : `${word()}\n${word()} ?`,
          answer: cloze ? "" : `${word()} $x_${f}$\n${word()}`
        };
      });
      const s = { name: `Src ${word()}`, url: rnd() < 0.5 ? `https://e.com/${word()}` : null, meta: "{}" };
      const parsed = parseSourceFile(renderSourceFile(s, ps), "prompts/r.md");
      expect(parsed.prompts).toEqual(ps);
      expect(parsed.name).toBe(s.name);
    }
  });

  it("parses prompts without ids as id: null", () => {
    const text = `---\nsource: S\n---\n\nQ: q?\nA: a.\n`;
    const parsed = parseSourceFile(text, "prompts/s.md");
    expect(parsed.prompts).toEqual([{ id: null, kind: "qa", question: "q?", answer: "a." }]);
  });

  it("errors carry path and line", () => {
    const bad = `---\nsource: S\n---\n\nA: answer with no question\n`;
    try {
      parseSourceFile(bad, "prompts/bad.md");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FormatError);
      expect((e as FormatError).path).toBe("prompts/bad.md");
      expect((e as FormatError).line).toBe(5);
    }
    expect(() => parseSourceFile("no frontmatter", "p.md")).toThrow(FormatError);
    expect(() => parseSourceFile(`---\nsource: S\n---\n\nC: no spans here\n`, "p.md")).toThrow(FormatError);
    expect(() => parseSourceFile(`---\nsource: S\n---\n\nQ: q?\nA: a.\n<!-- id: aa -->\n\nQ: q2?\nA: a2.\n<!-- id: aa -->\n`, "p.md"))
      .toThrow(/duplicate id/i);
  });

  it("render refuses unrepresentable text", () => {
    expect(() => renderSourceFile(src, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "A: looks like a marker" }]))
      .toThrow(FormatError);
  });

  it("sourceFileName slugs safely", () => {
    expect(sourceFileName("Why We Think — Lilian Weng!", "abc123def0"))
      .toBe("prompts/why-we-think-lilian-weng-abc123def0.md");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/format.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/format.ts`:
```ts
export type ParsedPrompt = { id: string | null; kind: "qa" | "cloze"; question: string; answer: string };
export type ParsedFile = { name: string; url: string | null; meta: Record<string, string>; prompts: ParsedPrompt[] };

export class FormatError extends Error {
  constructor(public path: string, public line: number, message: string) {
    super(`${path}:${line}: ${message}`);
  }
}

const MARKER = /^(Q: |A: |C: |<!-- id:)|^---$/;

function checkRepresentable(path: string, text: string, kind: string): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // The first line of a block legitimately starts with its own marker prefix
    // only in rendered output (we add the prefix); the raw text must not contain marker lines.
    if (MARKER.test(lines[i])) throw new FormatError(path, i + 1, `${kind} contains a line that collides with the file format ("${lines[i].slice(0, 20)}…")`);
  }
}

export function renderSourceFile(
  source: { name: string; url: string | null; meta: string },
  prompts: { id: string; kind: "qa" | "cloze"; question: string; answer: string }[]
): string {
  const meta = JSON.parse(source.meta || "{}") as Record<string, string>;
  let out = `---\nsource: ${source.name}\n`;
  if (source.url) out += `url: ${source.url}\n`;
  for (const k of Object.keys(meta).sort()) out += `${k}: ${meta[k]}\n`;
  out += "---\n";
  for (const p of prompts) {
    checkRepresentable("(render)", p.question, "question");
    checkRepresentable("(render)", p.answer, "answer");
    out += "\n";
    if (p.kind === "qa") out += `Q: ${p.question}\nA: ${p.answer}\n`;
    else out += `C: ${p.question}\n`;
    out += `<!-- id: ${p.id} -->\n`;
  }
  return out;
}

export function parseSourceFile(text: string, path: string): ParsedFile {
  const lines = text.split("\n");
  let i = 0;
  const fail = (line: number, msg: string): never => { throw new FormatError(path, line, msg); };

  if (lines[i] !== "---") fail(1, "missing frontmatter");
  i++;
  const front: Record<string, string> = {};
  while (i < lines.length && lines[i] !== "---") {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!m) fail(i + 1, "bad frontmatter line");
    front[m![1]] = m![2];
    i++;
  }
  if (i >= lines.length) fail(i, "unterminated frontmatter");
  i++;
  const name = front["source"];
  if (!name) fail(1, "frontmatter missing 'source'");
  const url = front["url"] ?? null;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(front)) if (k !== "source" && k !== "url") meta[k] = v;

  const prompts: ParsedPrompt[] = [];
  let cur: { kind: "qa" | "cloze"; q: string[]; a: string[]; mode: "q" | "a"; line: number } | null = null;

  // Blank lines INSIDE a block are content (multi-paragraph markdown answers);
  // a block ends only at an id comment, the next Q:/C:/A: marker, or EOF.
  // Trailing blank lines are trimmed at finish so render ∘ parse stays exact.
  const trimTail = (arr: string[]) => {
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
    return arr;
  };

  const finish = (id: string | null, atLine: number) => {
    if (!cur) return;
    const question = trimTail(cur.q).join("\n");
    const answer = trimTail(cur.a).join("\n");
    if (cur.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(question))
      fail(cur.line, "cloze block has no {{span}}");
    if (cur.kind === "qa" && cur.mode === "q") fail(cur.line, "Q block without A:");
    if (id && prompts.some(p => p.id === id)) fail(atLine, `duplicate id ${id}`);
    prompts.push({ id, kind: cur.kind, question, answer });
    cur = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/^<!-- id: ([A-Za-z0-9]+) -->$/);
    if (idMatch) { if (!cur) fail(i + 1, "id comment without a prompt block"); finish(idMatch[1], i + 1); continue; }
    if (line.startsWith("Q: ") || line === "Q:") {
      finish(null, i + 1);
      cur = { kind: "qa", q: [line.slice(3)], a: [], mode: "q", line: i + 1 };
    } else if (line.startsWith("C: ") || line === "C:") {
      finish(null, i + 1);
      cur = { kind: "cloze", q: [line.slice(3)], a: [], mode: "q", line: i + 1 };
    } else if (line.startsWith("A: ") || line === "A:") {
      if (!cur || cur.kind !== "qa" || cur.mode === "a") fail(i + 1, "A: without a Q block");
      cur!.mode = "a";
      cur!.a.push(line.slice(3));
    } else if (line.trim() === "") {
      if (cur) (cur.mode === "q" ? cur.q : cur.a).push(line); // content; trimmed at finish if trailing
    } else {
      if (!cur) fail(i + 1, `unexpected content outside a prompt block: "${line.slice(0, 30)}"`);
      (cur!.mode === "q" ? cur!.q : cur!.a).push(line);
    }
  }
  finish(null, lines.length);
  return { name: name!, url, meta, prompts };
}

export function sourceFileName(name: string, id: string): string {
  const slug = name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `prompts/${slug || "source"}-${id}.md`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/format.test.ts` — Expected: PASS (7 tests). If the multiline round-trip fails on trailing blank lines, fix in `parseSourceFile`/`renderSourceFile` (not the tests) until parse ∘ render is exact.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add interchange format: render, parse with line errors, round-trip tested"
```

---

### Task 13: Export, import, restore

**Files:**
- Create: `src/exporter.ts`, `src/importer.ts`, `src/routes/transfer.ts`
- Modify: `src/index.ts` (routes)
- Test: `test/importer.test.ts`

**Interfaces:**
- Consumes: `format.ts` (Task 12), `scheduler.ts` (Task 4: `newCardFields`, `applyGrade`), db types, R2 (Task 9's `assets` table conventions).
- Produces:
  - `buildExportZip(env: Env): Promise<Uint8Array>` — zip containing `prompts/<slug>-<id>.md` (every source), `assets/<id>` + `assets/index.json` (`{ [id]: content_type }`), `log/reviews.jsonl` (one JSON per event, fields `ts, prompt_id, action, elapsed_days, state_after`), `inbox/<id>.md` (pending captures: frontmatter `captured`, `url`, `title` + body text), `settings.json`.
  - `GET /export.zip` → that zip, `Content-Type: application/zip`.
  - `computeImportDiff(env, files: Map<string, Uint8Array>): Promise<Diff>` where `type Diff = { newPrompts: { file: string; question: string }[]; edited: string[]; retired: string[]; newSources: string[]; errors: string[] }` — errors non-empty ⇒ nothing may be applied. Unknown embedded id ⇒ error. Duplicate id across upload ⇒ error (FormatError inside one file already covers within-file).
  - `applyImport(env, files, now): Promise<{ new: number; edited: number; retired: number }>` — new prompts get server ids + `newCardFields(now)`; edits update kind/question/answer/source; absent prompts `retired = 1`.
  - `restoreFromZip(env, zipEntries, now)` — requires empty prompts table (else throws `RestoreNotEmptyError`); inserts sources/prompts preserving embedded ids as new cards at each prompt's first-event time or `now`; replays `log/reviews.jsonl` remembered/forgot through `applyGrade` at recorded timestamps (desired retention from the zip's `settings.json`), applies `retire` events, re-inserts pending captures, writes settings, puts assets back to R2.
  - `POST /import?apply=0|1&restore=0|1` (body: zip bytes) → dry-run: `{ diff }`; apply: `{ applied: { new, edited, retired } }`; restore: `{ restored: { sources, prompts, events } }`; 400 with `{ errors }` on any error; 409 restore-on-nonempty.

- [ ] **Step 1: Write the failing tests**

`test/importer.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const AUTH = { Authorization: "Bearer test-token" };
const post = (path: string, body: BodyInit) =>
  SELF.fetch(`http://sr${path}`, { method: "POST", headers: AUTH, body });
const jpost = (path: string, body: unknown) =>
  SELF.fetch(`http://sr${path}`, {
    method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });

async function seedViaApi() {
  const cap = await jpost("/api/capture", { text: "seed", title: "Imp Source", url: "https://imp.example" });
  const { id } = await cap.json() as { id: string };
  const ref = await jpost("/api/refine", {
    capture_id: id, source: { name: "Imp Source", url: "https://imp.example" },
    prompts: [
      { kind: "qa", question: "IQ1?", answer: "IA1" },
      { kind: "qa", question: "IQ2?", answer: "IA2" }
    ]
  });
  const { prompt_ids } = await ref.json() as { prompt_ids: string[] };
  await jpost("/api/grade", { prompt_id: prompt_ids[0], action: "remembered" });
  return prompt_ids;
}

async function download(): Promise<Record<string, Uint8Array>> {
  const res = await SELF.fetch("http://sr/export.zip", { headers: AUTH });
  expect(res.status).toBe(200);
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}

describe("export / import / restore", () => {
  it("export contains prompts, log, settings; unchanged re-import diffs to zero", async () => {
    await seedViaApi();
    const files = await download();
    const names = Object.keys(files);
    expect(names.some(n => n.startsWith("prompts/") && n.endsWith(".md"))).toBe(true);
    expect(names).toContain("log/reviews.jsonl");
    expect(names).toContain("settings.json");

    const dry = await post("/import?apply=0", zipSync(files));
    expect(dry.status).toBe(200);
    const { diff } = await dry.json() as any;
    expect(diff.newPrompts.length).toBe(0);
    expect(diff.edited.length).toBe(0);
    expect(diff.retired.length).toBe(0);
  });

  it("edit + delete + add are detected and applied", async () => {
    const files = await download();
    const mdName = Object.keys(files).find(n => n.startsWith("prompts/") && strFromU8(files[n]).includes("IQ1?"))!;
    let text = strFromU8(files[mdName]);
    text = text.replace("IA1", "IA1-edited");                       // edit one
    const lines = text.split("\n");
    const q2 = lines.findIndex(l => l === "Q: IQ2?");               // delete the other (Q,A,id + blank)
    lines.splice(q2 - 1, 4);
    text = lines.join("\n") + "\nQ: brand new?\nA: yes.\n";         // add one without id
    files[mdName] = strToU8(text);

    const dry = await (await post("/import?apply=0", zipSync(files))).json() as any;
    expect(dry.diff.edited.length).toBe(1);
    expect(dry.diff.retired.length).toBe(1);
    expect(dry.diff.newPrompts.length).toBe(1);

    const applied = await (await post("/import?apply=1", zipSync(files))).json() as any;
    expect(applied.applied).toEqual({ new: 1, edited: 1, retired: 1 });

    const edited = await env.DB.prepare("SELECT answer FROM prompts WHERE question = 'IQ1?'").first();
    expect(edited?.answer).toBe("IA1-edited");
    const gone = await env.DB.prepare("SELECT retired FROM prompts WHERE question = 'IQ2?'").first();
    expect(gone?.retired).toBe(1);
  });

  it("unknown id rejects the whole import", async () => {
    const files = await download();
    const mdName = Object.keys(files).find(n => n.startsWith("prompts/"))!;
    files[mdName] = strToU8(strFromU8(files[mdName]).replace(/<!-- id: [a-z0-9]+ -->/, "<!-- id: zzzzzzzzzz -->"));
    const res = await post("/import?apply=1", zipSync(files));
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors.join(" ")).toContain("zzzzzzzzzz");
  });

  it("restore on non-empty DB is 409; on empty DB replays schedule state", async () => {
    const files = await download();
    expect((await post("/import?apply=1&restore=1", zipSync(files))).status).toBe(409);

    const before = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    // wipe (order matters for FK)
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM prompts").run();
    await env.DB.prepare("DELETE FROM sources").run();
    await env.DB.prepare("DELETE FROM captures").run();

    const res = await post("/import?apply=1&restore=1", zipSync(files));
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    expect(after?.id).toBe(before?.id);          // ids preserved
    expect(after?.reps).toBe(before?.reps);      // replayed
    expect(after?.stability).toBe(before?.stability);
    expect(after?.due).toBe(before?.due);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/importer.test.ts` — Expected: FAIL (routes missing).

- [ ] **Step 3: Implement**

`src/exporter.ts`:
```ts
import { zipSync, strToU8 } from "fflate";
import type { Env } from "./env.d";
import type { CaptureRow, EventRow, PromptRow, SourceRow } from "./db";
import { renderSourceFile, sourceFileName } from "./format";
import { getSettings } from "./db";

export async function buildExportZip(env: Env): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  const sources = (await env.DB.prepare("SELECT * FROM sources ORDER BY created_at").all<SourceRow>()).results;
  for (const s of sources) {
    const prompts = (await env.DB.prepare(
      "SELECT * FROM prompts WHERE source_id = ? AND retired = 0 ORDER BY position"
    ).bind(s.id).all<PromptRow>()).results;
    files[sourceFileName(s.name, s.id)] = strToU8(renderSourceFile(s, prompts));
  }

  const events = (await env.DB.prepare("SELECT * FROM events ORDER BY id").all<EventRow>()).results;
  files["log/reviews.jsonl"] = strToU8(events.map(e => JSON.stringify({
    ts: e.ts, prompt_id: e.prompt_id, action: e.action,
    elapsed_days: e.elapsed_days, state_after: e.state_after ? JSON.parse(e.state_after) : null
  })).join("\n") + (events.length ? "\n" : ""));

  const caps = (await env.DB.prepare("SELECT * FROM captures WHERE status = 'pending'").all<CaptureRow>()).results;
  for (const c of caps) {
    let front = `---\ncaptured: ${c.created_at}\n`;
    if (c.url) front += `url: ${c.url}\n`;
    if (c.title) front += `title: ${c.title}\n`;
    if (c.image_id) front += `image: ${c.image_id}\n`;
    files[`inbox/${c.id}.md`] = strToU8(front + "---\n\n" + c.text + "\n");
  }

  const assets = (await env.DB.prepare("SELECT * FROM assets").all<{ id: string; content_type: string }>()).results;
  const index: Record<string, string> = {};
  for (const a of assets) {
    const obj = await env.BUCKET.get(a.id);
    if (obj) {
      files[`assets/${a.id}`] = new Uint8Array(await obj.arrayBuffer());
      index[a.id] = a.content_type;
    }
  }
  files["assets/index.json"] = strToU8(JSON.stringify(index, null, 2));

  files["settings.json"] = strToU8(JSON.stringify(await getSettings(env.DB), null, 2));
  return zipSync(files);
}
```

`src/importer.ts`:
```ts
import { strFromU8, unzipSync } from "fflate";
import type { Env } from "./env.d";
import { newId, type CaptureRow, type PromptRow, type SourceRow } from "./db";
import { FormatError, parseSourceFile, type ParsedFile, type ParsedPrompt } from "./format";
import { applyGrade, newCardFields } from "./scheduler";

export class RestoreNotEmptyError extends Error {}

export type Diff = {
  newPrompts: { file: string; question: string }[];
  edited: string[];
  retired: string[];
  newSources: string[];
  errors: string[];
};

type Parsed = { path: string; file: ParsedFile }[];

function parseAll(files: Record<string, Uint8Array>): { parsed: Parsed; errors: string[] } {
  const parsed: Parsed = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("prompts/") || !path.endsWith(".md")) continue;
    try {
      const file = parseSourceFile(strFromU8(bytes), path);
      for (const p of file.prompts) {
        if (p.id) {
          if (seenIds.has(p.id)) errors.push(`${path}: duplicate id ${p.id} across files`);
          else seenIds.add(p.id);
        }
      }
      parsed.push({ path, file });
    } catch (e) {
      errors.push(e instanceof FormatError ? e.message : `${path}: ${String(e)}`);
    }
  }
  return { parsed, errors };
}

export async function computeImportDiff(env: Env, files: Record<string, Uint8Array>): Promise<Diff> {
  const { parsed, errors } = parseAll(files);
  const diff: Diff = { newPrompts: [], edited: [], retired: [], newSources: [], errors };

  const existing = (await env.DB.prepare("SELECT * FROM prompts WHERE retired = 0").all<PromptRow>()).results;
  const byId = new Map(existing.map(p => [p.id, p]));
  const sources = (await env.DB.prepare("SELECT * FROM sources").all<SourceRow>()).results;
  const sourceByName = new Map(sources.map(s => [s.name, s]));
  const seen = new Set<string>();

  for (const { path, file } of parsed) {
    if (!sourceByName.has(file.name)) diff.newSources.push(file.name);
    for (const p of file.prompts) {
      if (!p.id) { diff.newPrompts.push({ file: path, question: p.question.slice(0, 60) }); continue; }
      const cur = byId.get(p.id);
      if (!cur) { diff.errors.push(`${path}: unknown id ${p.id} (not in this database)`); continue; }
      seen.add(p.id);
      const curSourceName = sources.find(s => s.id === cur.source_id)?.name;
      if (cur.kind !== p.kind || cur.question !== p.question || cur.answer !== p.answer || curSourceName !== file.name) {
        diff.edited.push(p.id);
      }
    }
  }
  for (const p of existing) if (!seen.has(p.id)) diff.retired.push(p.id);
  return diff;
}

export async function applyImport(
  env: Env, files: Record<string, Uint8Array>, now: Date
): Promise<{ new: number; edited: number; retired: number }> {
  const diff = await computeImportDiff(env, files);
  if (diff.errors.length) throw new Error(diff.errors.join("; "));
  const { parsed } = parseAll(files);
  const ts = now.toISOString();
  let created = 0, edited = 0;

  for (const { file } of parsed) {
    let source = await env.DB.prepare("SELECT * FROM sources WHERE name = ?").bind(file.name).first<SourceRow>();
    if (!source) {
      const sid = newId();
      await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(sid, file.name, file.url, JSON.stringify(file.meta), ts).run();
      source = { id: sid, name: file.name, url: file.url, meta: JSON.stringify(file.meta), created_at: ts };
    } else {
      await env.DB.prepare("UPDATE sources SET url = ?, meta = ? WHERE id = ?")
        .bind(file.url, JSON.stringify(file.meta), source.id).run();
    }
    let pos = 0;
    for (const p of file.prompts) {
      if (p.id) {
        await env.DB.prepare(
          "UPDATE prompts SET source_id=?, kind=?, question=?, answer=?, position=?, updated_at=? WHERE id=?"
        ).bind(source.id, p.kind, p.question, p.answer, pos++, ts, p.id).run();
        if (diff.edited.includes(p.id)) edited++;
      } else {
        const f = newCardFields(now);
        await env.DB.prepare(
          `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
            due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(newId(), source.id, p.kind, p.question, p.answer, pos++, ts, ts,
               f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
               f.reps, f.lapses, f.state, f.last_review).run();
        created++;
      }
    }
  }
  for (const id of diff.retired) {
    await env.DB.prepare("UPDATE prompts SET retired = 1, updated_at = ? WHERE id = ?").bind(ts, id).run();
  }
  return { new: created, edited, retired: diff.retired.length };
}

type LogLine = { ts: string; prompt_id: string; action: string; elapsed_days: number | null; state_after: unknown };

export async function restoreFromZip(
  env: Env, files: Record<string, Uint8Array>, now: Date
): Promise<{ sources: number; prompts: number; events: number }> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new RestoreNotEmptyError("database is not empty");

  const { parsed, errors } = parseAll(files);
  for (const { path, file } of parsed) {
    for (const p of file.prompts) if (!p.id) errors.push(`${path}: restore requires every prompt to carry an id`);
  }
  if (errors.length) throw new Error(errors.join("; "));

  const settings = files["settings.json"]
    ? JSON.parse(strFromU8(files["settings.json"])) as { desired_retention?: number } : {};
  const retention = settings.desired_retention ?? 0.9;

  const log: LogLine[] = files["log/reviews.jsonl"]
    ? strFromU8(files["log/reviews.jsonl"]).trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];
  const eventsByPrompt = new Map<string, LogLine[]>();
  for (const e of log) {
    if (!eventsByPrompt.has(e.prompt_id)) eventsByPrompt.set(e.prompt_id, []);
    eventsByPrompt.get(e.prompt_id)!.push(e);
  }

  let nSources = 0, nPrompts = 0;
  for (const { file } of parsed) {
    const sid = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sid, file.name, file.url, JSON.stringify(file.meta), now.toISOString()).run();
    nSources++;
    let pos = 0;
    for (const p of file.prompts as (ParsedPrompt & { id: string })[]) {
      const evs = (eventsByPrompt.get(p.id) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      const birth = evs.length ? new Date(evs[0].ts) : now;
      let f = newCardFields(birth);
      let retired = 0;
      for (const e of evs) {
        if (e.action === "remembered" || e.action === "forgot") f = applyGrade(f, e.action, new Date(e.ts), retention);
        if (e.action === "retire") retired = 1;
      }
      await env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, retired, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(p.id, sid, p.kind, p.question, p.answer, pos++, retired,
             birth.toISOString(), now.toISOString(),
             f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
             f.reps, f.lapses, f.state, f.last_review).run();
      nPrompts++;
    }
  }

  for (const e of log) {
    await env.DB.prepare(
      "INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, ?, ?, ?)"
    ).bind(e.ts, e.prompt_id, e.action, e.elapsed_days,
           e.state_after ? JSON.stringify(e.state_after) : null).run();
  }

  for (const [path, bytes] of Object.entries(files)) {
    const m = path.match(/^inbox\/([a-z0-9]{10})\.md$/);
    if (!m) continue;
    const text = strFromU8(bytes);
    const fm = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    const fields: Record<string, string> = {};
    if (fm) for (const line of fm[1].split("\n")) {
      const kv = line.match(/^([a-z]+): (.*)$/);
      if (kv) fields[kv[1]] = kv[2];
    }
    await env.DB.prepare(
      "INSERT INTO captures (id, created_at, text, url, title, note, image_id) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind(m[1], fields["captured"] ?? now.toISOString(), (fm ? fm[2] : text).trim(),
           fields["url"] ?? null, fields["title"] ?? null, fields["image"] ?? null).run();
  }

  const index = files["assets/index.json"]
    ? JSON.parse(strFromU8(files["assets/index.json"])) as Record<string, string> : {};
  for (const [id, contentType] of Object.entries(index)) {
    const bytes = files[`assets/${id}`];
    if (!bytes) continue;
    await env.BUCKET.put(id, bytes, { httpMetadata: { contentType } });
    await env.DB.prepare(
      "INSERT OR IGNORE INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)"
    ).bind(id, contentType, bytes.byteLength, now.toISOString()).run();
  }

  if (files["settings.json"]) {
    const s = JSON.parse(strFromU8(files["settings.json"])) as Record<string, unknown>;
    for (const k of ["session_cap", "desired_retention", "email_hour", "timezone"]) {
      if (s[k] !== undefined) {
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(k, String(s[k])).run();
      }
    }
  }
  return { sources: nSources, prompts: nPrompts, events: log.length };
}
```

`src/routes/transfer.ts`:
```ts
import { unzipSync } from "fflate";
import type { Env } from "../env.d";
import { buildExportZip } from "../exporter";
import { applyImport, computeImportDiff, restoreFromZip, RestoreNotEmptyError } from "../importer";

export async function exportZip(env: Env): Promise<Response> {
  const zip = await buildExportZip(env);
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="sr-export-${new Date().toISOString().slice(0, 10)}.zip"`
    }
  });
}

export async function importZip(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "1";
  const restore = url.searchParams.get("restore") === "1";
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await request.arrayBuffer()));
  } catch {
    return Response.json({ errors: ["not a readable zip"] }, { status: 400 });
  }
  try {
    if (restore) {
      if (!apply) return Response.json({ errors: ["restore requires apply=1"] }, { status: 400 });
      const restored = await restoreFromZip(env, files, new Date());
      return Response.json({ restored });
    }
    if (!apply) {
      const diff = await computeImportDiff(env, files);
      return diff.errors.length
        ? Response.json({ errors: diff.errors }, { status: 400 })
        : Response.json({ diff });
    }
    const applied = await applyImport(env, files, new Date());
    return Response.json({ applied });
  } catch (e) {
    if (e instanceof RestoreNotEmptyError) return Response.json({ errors: [e.message] }, { status: 409 });
    return Response.json({ errors: [String(e instanceof Error ? e.message : e)] }, { status: 400 });
  }
}
```

In `src/index.ts`:
```ts
import { exportZip, importZip } from "./routes/transfer";
// …
if (url.pathname === "/export.zip" && request.method === "GET") return exportZip(env);
if (url.pathname === "/import" && request.method === "POST") return importZip(request, env);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/importer.test.ts` — Expected: PASS (4 tests). Then `npx vitest run` — full suite green.
(The restore test's due/stability equality holds because the scheduler is deterministic — `enable_fuzz: false`, Task 4.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add export zip, dry-run import with diff, and event-replay restore"
```

---

### Task 14: Reminder email cron

**Files:**
- Create: `src/email.ts`
- Modify: `src/index.ts` (`scheduled` handler)
- Test: `test/email.test.ts`

**Interfaces:**
- Consumes: `getSettings`/`getSetting`/`setSetting` (Task 2).
- Produces:
  - `type CadenceState = { unanswered: number; mode: "daily" | "weekly"; last_sent: string | null }`
  - `localHour(now: Date, timeZone: string): number`
  - `decideReminder(a: { now: Date; tz: string; hour: number; dueCount: number; cadence: CadenceState; lastReviewAt: string | null }): { send: boolean; cadence: CadenceState }` — pure. Rules:
    - Only send when `localHour(now, tz) === hour` and no send yet today (local date of `last_sent` ≠ local date of `now`).
    - `dueCount === 0` → never send; cadence unchanged.
    - A review since `last_sent` resets `unanswered = 0`, `mode = "daily"`.
    - When a send happens with no review since the previous send, `unanswered` increments; at `unanswered >= 4`, `mode = "weekly"`.
    - In weekly mode, send only if 7+ days since `last_sent`.
  - `composeReminder(count: number, baseUrl: string): { subject: string; html: string }` — subject `"Reminder: N prompts due · ~M min"` (M = `Math.max(1, Math.ceil(count * 20 / 60))`); body links `${baseUrl}/` (no token in email links — the recipient's browser already holds the cookie; if not, the login is pasting the token once. Rationale: don't put the long-lived secret in mail storage. This is a deliberate deviation from the spec's "email links carry it" — flag it in the commit body and revisit if tapping the email ever lands on a 401 in practice).
  - `sendReminder(env, subject, html): Promise<void>` — POST `https://api.resend.com/emails` with `{ from: env.EMAIL_FROM, to: env.EMAIL_TO, subject, html }`, header `Authorization: Bearer ${env.RESEND_API_KEY}`.
  - `runReminderCron(env, now): Promise<void>` — loads settings + cadence + due count + last review ts, calls `decideReminder`, sends if told to, persists new cadence.

- [ ] **Step 1: Write the failing tests**

`test/email.test.ts`:
```ts
import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeReminder, decideReminder, localHour, type CadenceState } from "../src/email";
import { setSetting } from "../src/db";
import worker from "../src/index";

const base: CadenceState = { unanswered: 0, mode: "daily", last_sent: null };
const at = (iso: string) => new Date(iso);

describe("decideReminder (pure)", () => {
  const tz = "America/Los_Angeles";
  const seven = at("2026-08-20T14:00:00Z"); // 07:00 PDT

  it("sends at the configured local hour when prompts are due", () => {
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 6, cadence: base, lastReviewAt: null });
    expect(d.send).toBe(true);
    expect(d.cadence.unanswered).toBe(1);
  });

  it("does not send off-hour, when zero due, or twice in a day", () => {
    expect(decideReminder({ now: at("2026-08-20T15:00:00Z"), tz, hour: 7, dueCount: 6, cadence: base, lastReviewAt: null }).send).toBe(false);
    expect(decideReminder({ now: seven, tz, hour: 7, dueCount: 0, cadence: base, lastReviewAt: null }).send).toBe(false);
    const already = { ...base, last_sent: "2026-08-20T14:00:00Z" };
    expect(decideReminder({ now: at("2026-08-20T14:59:00Z"), tz, hour: 7, dueCount: 6, cadence: already, lastReviewAt: null }).send).toBe(false);
  });

  it("4 unanswered dailies decay to weekly; weekly waits 7 days", () => {
    let c: CadenceState = { unanswered: 3, mode: "daily", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 3, cadence: c, lastReviewAt: "2026-08-10T00:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("weekly");
    expect(d.cadence.unanswered).toBe(4);

    const tooSoon = decideReminder({
      now: at("2026-08-22T14:00:00Z"), tz, hour: 7, dueCount: 3,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(tooSoon.send).toBe(false);

    const weekLater = decideReminder({
      now: at("2026-08-27T14:00:00Z"), tz, hour: 7, dueCount: 3,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(weekLater.send).toBe(true);
  });

  it("a review since last send resets to daily", () => {
    const c: CadenceState = { unanswered: 4, mode: "weekly", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 2, cadence: c, lastReviewAt: "2026-08-19T20:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("daily");
    expect(d.cadence.unanswered).toBe(1);
  });

  it("localHour respects timezones; compose has no streaks and no token", () => {
    expect(localHour(at("2026-08-20T14:00:00Z"), "America/Los_Angeles")).toBe(7);
    expect(localHour(at("2026-08-20T14:00:00Z"), "UTC")).toBe(14);
    const { subject, html } = composeReminder(6, "https://sr.example");
    expect(subject).toBe("Reminder: 6 prompts due · ~2 min");
    expect(html).toContain("https://sr.example/");
    expect(html.toLowerCase()).not.toContain("streak");
    expect(html).not.toContain("token=");
  });
});

describe("scheduled handler", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("sends one Resend email when due at the configured hour", async () => {
    await setSetting(env.DB, "timezone", "UTC");
    await setSetting(env.DB, "email_hour", "9");
    await setSetting(env.DB, "cadence", JSON.stringify(base));
    // seed one due prompt
    const now = "2026-08-21T09:05:00Z";
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES ('cronsrc001', 'Cron', NULL, '{}', ?)")
      .bind(now).run();
    await env.DB.prepare(
      `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
        due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
       VALUES ('cronpmt001', 'cronsrc001', 'qa', 'q', 'a', 0, ?, ?, '2026-08-20T00:00:00Z', 1, 5, 0, 1, 1, 0, 2, '2026-08-19T00:00:00Z')`
    ).bind(now, now).run();

    fetchMock.get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply(200, { id: "email_1" });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: new Date(now).getTime(), cron: "0 * * * *", noRetry() {} } as ScheduledController,
      env, ctx
    );
    await waitOnExecutionContext(ctx);
    // assertNoPendingInterceptors in afterEach proves the send happened exactly once
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/email.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/email.ts`:
```ts
import type { Env } from "./env.d";
import { getSetting, getSettings, setSetting } from "./db";

export type CadenceState = { unanswered: number; mode: "daily" | "weekly"; last_sent: string | null };

export function localHour(now: Date, timeZone: string): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now), 10) % 24;
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now); // YYYY-MM-DD
}

export function decideReminder(a: {
  now: Date; tz: string; hour: number; dueCount: number;
  cadence: CadenceState; lastReviewAt: string | null;
}): { send: boolean; cadence: CadenceState } {
  let c = { ...a.cadence };

  const reviewedSinceLastSend =
    c.last_sent !== null && a.lastReviewAt !== null && a.lastReviewAt > c.last_sent;
  if (reviewedSinceLastSend) c = { ...c, unanswered: 0, mode: "daily" };

  if (a.dueCount === 0) return { send: false, cadence: c };
  if (localHour(a.now, a.tz) !== a.hour) return { send: false, cadence: c };
  if (c.last_sent && localDate(new Date(c.last_sent), a.tz) === localDate(a.now, a.tz))
    return { send: false, cadence: c };
  if (c.mode === "weekly" && c.last_sent &&
      a.now.getTime() - new Date(c.last_sent).getTime() < 7 * 86400_000)
    return { send: false, cadence: c };

  const unanswered = c.unanswered + 1;
  return {
    send: true,
    cadence: {
      unanswered,
      mode: unanswered >= 4 ? "weekly" : c.mode,
      last_sent: a.now.toISOString()
    }
  };
}

export function composeReminder(count: number, baseUrl: string): { subject: string; html: string } {
  const mins = Math.max(1, Math.ceil((count * 20) / 60));
  const subject = `Reminder: ${count} prompt${count === 1 ? "" : "s"} due · ~${mins} min`;
  const html = `
<p>Take a minute to reinforce ${count} detail${count === 1 ? "" : "s"} you wanted to keep.</p>
<p><a href="${baseUrl}/">Start review</a> (~${mins} min)</p>
<p style="color:#888;font-size:13px">This is the only email this system sends. It backs off if you're busy.</p>`;
  return { subject, html };
}

async function sendReminder(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: env.EMAIL_TO, subject, html })
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

export async function runReminderCron(env: Env, now: Date): Promise<void> {
  const s = await getSettings(env.DB);
  const cadence = JSON.parse((await getSetting(env.DB, "cadence")) ?? '{"unanswered":0,"mode":"daily","last_sent":null}') as CadenceState;
  const due = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE retired = 0 AND due <= ?")
    .bind(now.toISOString()).first<{ n: number }>();
  const lastReview = await env.DB.prepare(
    "SELECT MAX(ts) AS t FROM events WHERE action IN ('remembered','forgot')"
  ).first<{ t: string | null }>();

  const d = decideReminder({
    now, tz: s.timezone, hour: s.email_hour, dueCount: due?.n ?? 0,
    cadence, lastReviewAt: lastReview?.t ?? null
  });
  if (d.send) {
    const { subject, html } = composeReminder(due!.n, env.BASE_URL);
    await sendReminder(env, subject, html);
  }
  await setSetting(env.DB, "cadence", JSON.stringify(d.cadence));
}
```

In `src/index.ts`, replace the `scheduled` stub:
```ts
import { runReminderCron } from "./email";
// …
async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runReminderCron(env, new Date(controller.scheduledTime)));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/email.test.ts` — Expected: PASS (6 tests). Then `npx vitest run` — whole suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add reminder cron: hour-gated, zero-due silent, decays to weekly

Deliberate deviation from spec: reminder links carry no token; the
browser cookie (set on first token visit) authenticates instead, so the
long-lived secret never sits in mail storage."
```

---

### Task 15: README and deploy runbook

**Files:**
- Create: `README.md`
- Modify: `docs/design/2026-08-20-spaced-repetition-design.md` is NOT modified by this plan (spec changes go through Nick).

**Interfaces:** none (documentation).

- [ ] **Step 1: Write README.md**

````markdown
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
````

- [ ] **Step 2: Verify commands against reality**

Run: `npm test` (full suite green) and `npx tsc --noEmit` (clean). Fix anything that fails before committing.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Add README with deploy runbook, Shortcut setup, refactor loop"
```

---

## Plan Self-Review Notes (kept for the record)

- **Spec coverage:** review incl. ahead + source-scoped + overflow actions (T6/T7/T11), capture incl. photo + autocomplete + offline queue (T8/T9), share-sheet (T15 docs), inbox/refine incl. preview + triage delete (T10), browse/edit schedule-preserving (T11), settings + export link + import form (T11/T13), interchange format + errors with line numbers (T12), export/import/restore incl. assets + captures + settings (T13), email cadence incl. decay + zero-due silence + no-metrics copy (T14), auth (T3), FSRS binary grades + replay determinism (T4), cloze/math/images rendering (T5/T9).
- **Two deliberate deviations, both flagged in commit messages for Nick's review:** (1) `enable_fuzz: false` — replay determinism beats load-spreading; (2) reminder emails omit the token — cookie auth instead, secret stays out of mail storage. If either is unwanted, they are one-line changes (T4/T14).
- **Known format constraint (by design, enforced):** prompt text lines may not begin with `Q: `, `A: `, `C: `, `<!-- id:`, or be exactly `---`; render refuses with a clear error rather than corrupting the file (T12).
- **Type consistency spot-checks:** `SchedFields` field names match the `prompts` table columns used in every INSERT/UPDATE (T2/T7/T10/T11/T13); `SessionCard`/`Session` shapes match `review.js` usage (T6/T7); `Diff` keys match the settings-page import output and importer tests (T11/T13); `CadenceState` shape matches the seeded settings row (T2/T14).
````
