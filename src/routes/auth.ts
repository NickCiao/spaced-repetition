import type { Env } from "../env.d";
import { authCookie } from "../auth";
import { nowIso } from "../db";
import { composeLoginEmail, resolveMailConfig, sendMail } from "../email";
import { escapeHtml, FISH_MARK, page } from "../html";

/** Sign-in links work once and die quickly; a stolen old email is worthless. */
const CODE_TTL_MS = 15 * 60_000;
/** /auth/email is unauthenticated, so throttle sends: at most one per minute. */
const SEND_COOLDOWN_MS = 60_000;

/** Only same-app relative paths survive; anything else lands on the review page. */
export function safeRedirect(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Unauthenticated sign-in screen, also used for the "check your email" and
 * error states. Shown for browser navigations that fail auth; API callers
 * keep the bare 401.
 */
export function loginPage(opts: {
  redirect?: string;
  status?: number;
  error?: string;
  notice?: string;
} = {}): Response {
  const redirect = safeRedirect(opts.redirect);
  // A GET form drops the query in its action, so the token fallback targets the path only.
  const tokenAction = redirect.split("?")[0] || "/";
  const message = opts.error
    ? `<p class="login-note login-error">${escapeHtml(opts.error)}</p>`
    : opts.notice
      ? `<p class="login-note login-notice">${escapeHtml(opts.notice)}</p>`
      : `<p class="login-note">This device isn't signed in yet.</p>`;
  const body = `<main class="login">
  <div class="login-brand">${FISH_MARK} Resurface</div>
  <h1 class="login-title">Sign in</h1>
  ${message}
  <form method="post" action="/auth/email" class="login-form">
    <input type="hidden" name="redirect" value="${escapeHtml(redirect)}">
    <button type="submit" class="btn btn-primary">Email me a sign-in link</button>
  </form>
  <details class="login-alt">
    <summary>Use access token instead</summary>
    <form method="get" action="${escapeHtml(tokenAction)}" class="login-form">
      <input class="input" type="password" name="token" placeholder="Access token" autocomplete="current-password" aria-label="Access token">
      <button type="submit" class="btn btn-secondary">Sign in</button>
    </form>
  </details>
</main>`;
  return page("Sign in", body, { bodyClass: "login-body", status: opts.status ?? 401 });
}

/** POST /auth/email — mail a one-time sign-in link to the configured owner address. */
export async function emailLoginLink(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const redirect = safeRedirect(form?.get("redirect"));

  const mail = await resolveMailConfig(env);
  if (!mail.emailTo || !mail.resendKey || !mail.baseUrl) {
    return loginPage({
      redirect,
      status: 200,
      error: "Email sign-in isn't set up (Settings needs an email and Resend key). Use the access token instead."
    });
  }

  const now = Date.now();
  const latest = await env.DB.prepare("SELECT MAX(created_at) AS t FROM login_tokens")
    .first<{ t: string | null }>();
  if (latest?.t && now - new Date(latest.t).getTime() < SEND_COOLDOWN_MS) {
    return loginPage({
      redirect,
      status: 429,
      notice: "A sign-in link was sent moments ago — check your email, or try again in a minute."
    });
  }

  const code = generateCode();
  await env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?")
    .bind(new Date(now).toISOString()).run();
  await env.DB.prepare(
    "INSERT INTO login_tokens (token_hash, created_at, expires_at, redirect) VALUES (?, ?, ?, ?)"
  ).bind(
    await sha256Hex(code),
    new Date(now).toISOString(),
    new Date(now + CODE_TTL_MS).toISOString(),
    redirect
  ).run();

  const link = `${mail.baseUrl.replace(/\/$/, "")}/auth/verify?code=${code}`;
  const { subject, html, text } = composeLoginEmail(link, mail.baseUrl);
  await sendMail(mail, subject, html, text);

  return loginPage({
    redirect,
    status: 200,
    notice: "Check your email — the link signs this device in and expires in 15 minutes."
  });
}

/** GET /auth/verify?code=… — consume a one-time code and set the session cookie. */
export async function verifyLogin(request: Request, env: Env): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const now = nowIso();
  const row = code
    ? await env.DB.prepare(
        "SELECT redirect FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"
      ).bind(await sha256Hex(code), now).first<{ redirect: string }>()
    : null;
  if (!row) {
    return loginPage({
      status: 401,
      error: "That sign-in link is invalid, expired, or already used. Request a new one."
    });
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?")
      .bind(now, await sha256Hex(code)),
    env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(now)
  ]);
  return new Response(null, {
    status: 302,
    headers: { Location: safeRedirect(row.redirect), "Set-Cookie": authCookie(env.SR_TOKEN) }
  });
}
