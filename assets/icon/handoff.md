# Icon handoff — derpy goldfish "resurface" mark

New app icon replacing the synapse favicon. Concept: a goldfish (the three-second-memory animal, fixed) arcing out of the water to catch a returning memory spark. Fish is warm orange; the spark, waterline and underwater tint are Nocturne blurple, bridging icon ↔ app accent.

## Files (all in `assets/`)

| File | Use |
| --- | --- |
| `icon.svg` / `icon-1024.png`, `icon-512.png`, `icon-192.png` | Master full-bleed square icon (iOS/App Store: use `icon-1024.png` in the Xcode asset catalog — Apple applies the corner mask) |
| `apple-touch-icon.png` | 180×180 for the PWA/home-screen on iOS |
| `icon-maskable.svg` / `icon-maskable-512.png`, `icon-maskable-192.png` | PWA `purpose: "maskable"` (art inset to the 80% safe zone) |
| `favicon.svg`, `favicon-32.png`, `favicon-16.png` | Browser tab; `favicon.svg` is a drop-in replacement for `public/static/favicon.svg` (same 32-viewBox, rx-7 dark ground as today) |
| `icon-mono.svg` | Single-color glyph (`#9184d9`, eye knocked out) for notifications, tinted contexts, rail brand |
| `icon-foreground.svg`/`-432.png`, `icon-background.svg`/`-432.png` | Android adaptive icon layers (fg art sits in the 66/108dp safe zone; bg is the radial ground) |

## Repo integration

1. **Favicon:** replace `public/static/favicon.svg` with `assets/favicon.svg`. `src/index.ts` already serves `/favicon.ico` from it; no route change.
2. **Static PNGs:** copy `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png`, `apple-touch-icon.png` into `public/static/`.
3. **`public/static/manifest.webmanifest`** — update `icons` (and the name once chosen; Resurface vs Recall still open):

```json
"icons": [
  { "src": "/static/favicon.svg", "type": "image/svg+xml", "sizes": "any", "purpose": "any" },
  { "src": "/static/icon-192.png", "type": "image/png", "sizes": "192x192", "purpose": "any" },
  { "src": "/static/icon-512.png", "type": "image/png", "sizes": "512x512", "purpose": "any" },
  { "src": "/static/icon-maskable-192.png", "type": "image/png", "sizes": "192x192", "purpose": "maskable" },
  { "src": "/static/icon-maskable-512.png", "type": "image/png", "sizes": "512x512", "purpose": "maskable" }
]
```

`background_color`/`theme_color` stay `#161826`.

4. **`src/html.ts`** — in `page()`'s head, after the favicon links add:

```html
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
```

5. **Optional — rail brand mark:** swap the `SYNAPSE` const in `src/html.ts` for the fish mono mark (uses the accent token like today):

```html
<svg width="16" height="16" viewBox="0 0 64 64" aria-hidden="true"><path d="M6 41 H58" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round"/><g transform="rotate(22 30 33)" fill="var(--color-accent)"><path d="M40 32 Q51 20 56 22.5 Q58.5 25 50.5 32.5 Q58.5 40 56 42.5 Q51 45 40 33.5 Z"/><ellipse cx="28" cy="33" rx="14" ry="11.5"/><circle cx="21" cy="29.5" r="3.2" fill="#161826"/></g><path d="M11 6.5 l2 4.9 4.9 2 -4.9 2 -2 4.9 -2 -4.9 -4.9 -2 4.9 -2 z" fill="var(--color-accent)"/></svg>
```

(The standalone `icon-mono.svg` uses a mask for a true transparent eye; this inline version fakes the knockout with the bg color for simplicity.)

## Color spec

Fish: body `#f59a49`, fins/tail `#f9b970`, belly `#ffd9a6`, lips `#ef8b3e`, lip seam `#7c431d`, eye `#f6f0e4`, pupil `#201a2e`, blush `#ffcf9e`.
App-bridge (Nocturne): ground `#161826` (radial from `#292b31`), waterline `#b5abfc` (accent-400, fades at ends), spark `#e7e5fe` (accent-200), spark dot `#b5abfc`, underwater tint `#2b2741` @ 40% (accent-900), bubbles `#d2cefd` @ 50% (accent-300).

## Design rules

- The waterline always fades to transparent at its ends (Nocturne rule); at ≤48px use a straight line, and drop to fish + line + spark only.
- Everything below the waterline dims (accent-900 tint) — memory sits underwater until it resurfaces.
- Face at small sizes: keep the big eye; drop pupil below 24px. Never scale the full-detail face below 48px.
- Fish color never floods UI surfaces — orange belongs to the mascot; UI stays on Nocturne tokens.
