# Anki and Mochi import

Additive import path for migrating flashcards from Anki and Mochi. Separate from the desired-state `/import` refactor loop.

## Supported formats

| Format | How to export |
|--------|----------------|
| Anki plain-text TSV | File → Export → **Notes in plain text** or **Cards in plain text** |
| Mochi `.mochi` | Mochi → deck → Export → **Mochi format** |

Rejected with guidance:

- Anki `.apkg` / `.colpkg` — no SQLite dependency; re-export as plain text
- Mochi CSV — re-export as `.mochi`

## Semantics

- **Additive only** — creates sources and prompts; never edits or retires existing prompts
- **Dedup** — skip if the target source already has a prompt with identical `(kind, question, answer)` (including retired)
- **Fresh FSRS state** — all imported cards start as new (due now, empty event log)
- **Dry-run by default** — `POST /import/foreign?apply=0` previews counts; `apply=1` writes

## Mapping rules

**Anki headered export** (Notes in plain text): deck column → source name; notetype drives shape:

- `Basic` → one Q/A prompt
- `Basic (and reversed card)` → two Q/A prompts (both directions)
- `Cloze` → cloze prompt (`{{cN::text}}` → `{{text}}`)
- Unknown notetype → first two fields as Q/A with a warning

**Anki headerless export** (Cards in plain text): every row is one Q/A; source name from UI param (default `Anki import`).

**Mochi**: deck name → source; card `content` or template-resolved content split on first `---` line into question/answer. Trashed and empty cards skipped with warnings.

When `#html:true`, fields are converted to markdown (entities, `<b>`, `<br>`, etc.). Content is sanitized so lines cannot collide with the interchange format markers.

## Images

Referenced `![alt](@media/file)` links in Mochi content are uploaded to R2 (content-hash id) and rewritten to `assets/<id>`. Unreferenced attachments in the zip are ignored.

## UI

Settings → **Import from Anki / Mochi** — file upload, optional source name for headerless Anki export, dry-run + apply.

## API

`POST /import/foreign?apply=0|1&source=<name>`

Body: raw TSV text or Mochi zip bytes.

Response: `{ preview: { created, skipped, sources, warnings } }` or `{ applied: … }`.
