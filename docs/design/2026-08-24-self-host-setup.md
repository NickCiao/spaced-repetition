# Self-host setup

**Status**: Accepted · 2026-08-24

## Goal

A stranger should be able to stand up their own private instance with minimal Cloudflare ceremony. Review and capture must work before any third-party email account exists.

## Deploy paths

1. **Deploy to Cloudflare button** (README) — clones the public repo into the user’s GitHub/GitLab, provisions D1 + R2 from `wrangler.jsonc`, runs the `deploy` script (migrations via D1 binding `DB`, then `wrangler deploy`), and prompts for the only required secret: `SR_TOKEN` (described in `package.json` → `cloudflare.bindings`).
2. **`npm run setup`** — interactive terminal wizard: login, create/reuse D1 `sr` (writes `database_id` into `wrangler.jsonc`), create/reuse R2 `sr-assets`, apply remote migrations, set `SR_TOKEN`, deploy, print the one-time `/?token=…` URL.

Both paths leave reminder email unset. The app is fully usable without it.

## Configuration after deploy

| Value | Where | Notes |
|---|---|---|
| `SR_TOKEN` | Worker secret | Only deploy-time secret. Open `/?token=…` once per browser. |
| App URL (`base_url`) | D1 settings | Learned from the first authenticated request origin; editable in Settings (custom domains). |
| Email to / Resend API key | D1 settings | Settings → Reminder. Empty ⇒ cron decides “send” but skips the provider call. |
| `EMAIL_FROM` | Wrangler var / optional secret | Defaults to `Resurface <onboarding@resend.dev>` (Resend test sender, “Resurface” display name); override with a verified domain for production, keeping the `Name <address>` format. |

Legacy Worker secrets `EMAIL_TO`, `RESEND_API_KEY`, and `BASE_URL` remain as fallbacks so existing deploys keep working until Settings is filled in. Export zip includes scheduler settings and optional `email_to`; it never includes the Resend API key or `base_url`.

## Non-goals

- Minting or rotating `SR_TOKEN` from the web UI (left as a Worker secret for now).
- Multi-tenant / accounts.
- Requiring Resend (or any mail provider) at deploy time.
