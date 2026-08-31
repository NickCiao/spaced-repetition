# Nocturne design system

**Status:** adopted for reminder email (2026-08-23); web UI migration planned.

Nocturne is the visual direction for this project: a quiet, compact dark interface on a near-neutral blue-grey ground, Inter at medium weight, soft 8px radii, and a blurple accent (`#9184d9`) used as a line and glow rather than a flood. Rules fade to transparent at their ends; primary actions are outlined, not solid-filled.

The canonical token sheet and component classes live in the external package the author maintains for Cursor (`nocturne-for-cursor`: `styles.css`, `theme.json`, `readme.md`). When retuning the look, edit tokens there first, then mirror any inlined values used in email HTML.

## Current adoption

| Surface | Status | Notes |
| --- | --- | --- |
| Reminder email | **Done** | `composeReminder` in `src/email.ts` inlines Nocturne hex values (email clients ignore linked CSS). Supporting line reflects the session-worthiness reason (`full-session`, `waited-too-long`, `forgetting-cost`, `no-better-session-soon`). |
| Review session | **Done** | `public/static/review.js` + `nocturne-app.css` on Nocturne tokens. Progress dots, End, Reveal/grade bar, inline flag panel, done/nothing-due close screens. App shell (rail + tab bar) always visible on desktop; mobile tab bar hides during active session (`body.in-session`). Review and Inbox nav badges (`rail-due` / `tab-due`) hide at zero; Review updates live as cards are graded. |
| Web app (other surfaces) | **Done** | Capture, inbox, refine, browse, settings on `nocturne-app.css` + shared shell in `src/html.ts`. Phosphor regular self-hosted under `public/static/phosphor/`. |
| App icon / favicon | **Done** | Goldfish "resurface" mark (2026-08-26): warm-orange fish (`#f59a49`) arcing over a blurple waterline to catch a memory spark, on the `#161826` ground. Master art + handoff spec in `assets/icon/`; served set (favicon SVG, 192/512 any + maskable PNGs, apple-touch-icon) in `public/static/` and wired via `manifest.webmanifest`. Mono blurple variant used for the rail brand and email kicker. |

## Email layout (reference)

- **Kicker:** fish mono mark + “RESURFACE” (uppercase, muted neutral).
- **Headline:** `{count} prompts · ~{mins} min` — count in text colour, duration muted.
- **Reason line:** one sentence keyed to `SessionReadyReason` (see `REMINDER_REASON_TEXT` in `src/email.ts`).
- **CTA:** outlined “Start review” → `${BASE_URL}/` (no token in the link; cookie auth).
- **Footer:** “This is the only email this system sends. It backs off if you're busy.”

Subject line matches the headline: `{count} prompts · ~{mins} min`.

## Principles to carry into the web UI

- Left-aligned, asymmetric layouts; hierarchy from size and space, not bold headings past 500 weight.
- Low chroma outside the accent; surfaces from `--color-neutral-*` ramps.
- Photographs through `.lighten` (`mix-blend-mode: lighten`) on dark grounds.
- Phosphor icons at interface sizes.
- Themed `:hover`, pressed states, and `:focus-visible` (2px accent ring) — never browser defaults.
