# Topics and per-prompt sources

Supersedes the **Source** concept in `2026-08-20-spaced-repetition-design.md` (§5 Content model, the review source line in §7 Surfaces, and the one-file-per-source interchange format in §4/§8). One entity was doing two jobs: `sources` grouped prompts (Browse, scoped review, one export file per source) *and* claimed provenance (review rendered "from {name}" under every answer). In practice the grouping is thematic — prompts in one group come from different places — so the attribution was often false and the field label ("Source — book, article, podcast…") asked the wrong question at capture time.

## Concepts

- **Topic** — the grouping, renamed from Source everywhere (schema, routes, UI, interchange format). A prompt belongs to exactly one topic. Topics keep their optional `url` and passthrough `meta`.
- **Source** — optional per-prompt attribution: **one line of markdown** stored on the prompt (`prompts.source`, nullable), e.g. `[Attention Is All You Need](https://arxiv.org/abs/1706.03762)` or `Chat with Sarah, 2026-08`. One field covers name + URL without a second input; inline markdown (links, emphasis, code, math) renders through the same sanitizing pipeline as prompt bodies.

Review shows attribution honestly: "from {source}" only when the prompt has one, plus a quiet topic-name kicker for context. No more implied provenance from the group name.

## Schema (migration `0002_topics_and_sources.sql`)

- `sources` → `topics`; `prompts.source_id` → `prompts.topic_id`; index `idx_prompts_topic`.
- `prompts.source TEXT` — nullable single-line markdown, trimmed on write, `NULL` when blank.
- `captures.topic TEXT` — the topic *name* typed at capture (free text; resolved to a topic row at refine, case-insensitively). This un-overloads `captures.title`, which returns to meaning the shared page title.

## Interchange format

Frontmatter key is `topic:`; the parser also accepts the legacy `source:` key as the topic name (both present → error), so **pre-rename zips restore unchanged**. `topic`, `source`, and `url` are reserved frontmatter keys; anything else passes through as topic meta.

Per-prompt attribution is an `S:` line — written only when set, at most one per block, after the block body, before the id comment:

```
---
topic: Distributed systems
---

Q: What does Raft use to detect a stale leader?
A: Heartbeat timeouts trigger a new election term.
S: [Raft paper](https://raft.github.io/raft.pdf)
<!-- id: abc123def0 -->

C: A {{quorum}} is any majority of the cluster.
<!-- id: def456abc0 -->
```

`S:` joined the marker set (`Q:`/`A:`/`C:`/`S:`/id comments/`---`), so prompt content containing a line that starts with `S: ` can no longer round-trip; export fails loudly rather than drifting (same rule as the other markers). Parse rules: `S:` requires a completed block body (`S:` before `A:` is an error), duplicates and empty values are errors, and only blank lines may follow it before the id comment.

`retired.jsonl` lines carry `topic_name` (legacy `source_name` accepted on restore) and include `source` when the prompt has one. Pending captures export their `topic:` in `inbox/<id>.md` frontmatter.

Restore is upgrade-on-restore: a legacy zip imports cleanly and the next export writes the renamed keys.

## Topic picker (replaces the datalist)

`GET /api/topics` returns every topic ordered by most-recently-used (`COALESCE(MAX(prompts.updated_at), topics.created_at)` descending) with prompt counts. The picker (`public/static/topic-picker.js`, shared by Capture and Refine) fetches once and filters client-side:

- opens on focus showing the MRU list — existing topics are visible before typing
- case-insensitive substring filter; arrow keys + Enter, Escape, tap; ARIA combobox
- explicit `New topic: "text"` row when the text matches nothing exactly
- picking an existing topic submits its id; free text submits a name (server dedupes case-insensitively, as before)
- offline (capture is a PWA surface): the fetch fails silently and the field degrades to plain text

## Flow changes

- **Capture** — "Topic (optional)" picker → `captures.topic` as plain text (works offline/queued; no topic row is created until refine).
- **Refine** — topic picker preselected from `cap.topic` (legacy captures fall back to `cap.title`, which used to hold the typed grouping); a single "Source (optional)" input prefilled as `[title](url)` when the capture has a URL. Every prompt saved from one refine shares that source — one capture, one provenance.
- **Prompt editor** — same optional Source input; blank clears it.
- **Migrate in** (Anki/Mochi) — decks map to topics; the headerless-Anki fallback param is `?topic=` (see `2026-08-22-anki-mochi-import.md`).

## API surface (renames)

`/api/topics` (GET, picker list) · `/api/topic` (POST, create/dedupe) · refine body `{ topic: {id} | {name}, source?, prompts }` · `/api/prompt` takes `topic_id` + `source` · review scope `/?topic=<id>` · foreign import `?topic=`. Session cards carry `topicName` and server-rendered `sourceHtml`.
