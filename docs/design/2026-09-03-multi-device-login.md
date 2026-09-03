# Multi-device login via email magic link

**Status**: Accepted · 2026-09-03

## Problem

Auth is a single static token: visiting `/?token=<SR_TOKEN>` once sets a year-long
`sr` cookie in that browser, and everything else rides on the cookie. A new device
has no cookie, so any navigation returned a bare plain-text `401 unauthorized`.
The only recovery was remembering the token and hand-typing the `?token=` URL —
in practice, the refinement flow silently failed on any second computer.

## Design

The cookie model is unchanged. Two additions:

1. **Sign-in screen.** Browser navigations (`GET` with `Accept: text/html`) that
   fail auth get a styled 401 page instead of plain text. Primary action: *Email
   me a sign-in link*. Fallback (collapsed behind a disclosure): paste the access
   token, which submits the existing `?token=` flow. API callers — the refine
   screen's `fetch` calls, curl, iOS Shortcuts — keep the bare `401 unauthorized`.

2. **Magic link.** `POST /auth/email` mails a one-time link to the owner's
   configured address; `GET /auth/verify?code=…` consumes it and sets the same
   `sr` cookie the `?token=` flow sets, then redirects to the originally
   requested path.

```
new device                     worker                          inbox
GET /inbox (no cookie)  ─────▶ 401 sign-in screen
POST /auth/email        ─────▶ store SHA-256(code), 15 min ──▶ link email
GET /auth/verify?code=… ─────▶ single-use check, mark used
                        ◀───── 302 /inbox + Set-Cookie sr=…
```

## Mechanics

- Codes are 32 random bytes (`crypto.getRandomValues`), base64url-encoded in the
  link. Only the SHA-256 hex digest is stored (`login_tokens` table,
  `migrations/0003_login_tokens.sql`), so a leaked database row cannot be replayed.
- Codes are **single-use** (`used_at`) and expire after **15 minutes**
  (`expires_at`). Expired rows are pruned opportunistically on send and verify.
- The stored `redirect` is restricted to same-app relative paths (must start with
  `/`, must not start with `//`); anything else collapses to `/`.
- Sending reuses the reminder mail path: `resolveMailConfig` (D1 settings with
  legacy secret fallbacks) and the Resend API via `sendMail`. If mail isn't
  configured, the sign-in screen says so and points at the token fallback.
- `/auth/*` is auth-exempt by necessity. Both routes are handled **before**
  `rememberBaseUrl`, so an unauthenticated request can never seed the app's
  public origin.

## Threat model

The endpoint is unauthenticated, so the exposures are email bombing and link
theft:

- **Email bombing**: sends are throttled to one per minute (checked against the
  newest `login_tokens.created_at`). Recipient is always the owner's configured
  `email_to`; the requester cannot choose the address.
- **Link theft**: a stolen email yields a code that is single-use, dead after
  15 minutes, and worthless once used. `SR_TOKEN` itself never appears in any
  email (reminder emails already deliberately link to `/` with no token).
- **DB leak**: hashes only; the raw code is unrecoverable.

## Non-goals

- Sessions, logout, or token rotation — the year-long `sr` cookie and Bearer
  auth are unchanged.
- Multi-user, passkeys, rate limiting beyond the single-owner throttle.
