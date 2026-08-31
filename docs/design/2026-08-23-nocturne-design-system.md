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

- **Ground:** the email paints no page background — only the dark rounded card. Gmail's web reading pane stays white even in its dark theme and a body background only fills the content's own height, so a full-bleed dark ground rendered as a slab (dark-on-white-on-dark). The card now floats on whatever the client's pane is: white in Gmail, dark in Apple Mail dark mode.
- **Kicker:** fish mono mark + “RESURFACE” (uppercase, muted neutral). The mark is a PNG (`/static/icon-mono-56.png`, rendered from `assets/icon/icon-mono.svg`) referenced by absolute URL — Gmail strips inline `<svg>`, and `/static/*` is auth-exempt so image proxies can fetch it. Laid out with a presentation table, not flexbox (email-client support).
- **Headline:** `{count} prompts · ~{mins} min` — count in text colour, duration muted.
- **Reason line:** one sentence keyed to `SessionReadyReason` (see `REMINDER_REASON_TEXT` in `src/email.ts`).
- **CTA:** filled accent “Start review” (dark text on `#9184d9`) → `${BASE_URL}/` (no token in the link; cookie auth). Deliberate exception to the outlined-primary rule: in mail clients a filled block earns its ~44px tap target and survives colour mangling better than a 1px outline.
- **Divider:** still fades at the ends per the Nocturne rule, but via percentage gradient stops ending in the surface colour (no `calc()`, no `transparent` keyword), with a solid `#434550` fallback for clients that drop gradients.
- **Footer:** “This is the only email this system sends. It backs off if you're busy.”

Subject line matches the headline: `{count} prompts · ~{mins} min`. The Resend payload carries a plain-text part (subject, reason, link, footer) alongside the HTML.

## Principles to carry into the web UI

- Left-aligned, asymmetric layouts; hierarchy from size and space, not bold headings past 500 weight.
- Low chroma outside the accent; surfaces from `--color-neutral-*` ramps.
- Photographs through `.lighten` (`mix-blend-mode: lighten`) on dark grounds.
- Phosphor icons at interface sizes.
- Themed `:hover`, pressed states, and `:focus-visible` (2px accent ring) — never browser defaults.
