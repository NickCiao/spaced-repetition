import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "../src/db";
import { safeRedirect, sha256Hex } from "../src/routes/auth";
import { composeLoginEmail } from "../src/email";

/** A browser navigation: what Safari/Chrome send when following a link. */
const BROWSER = { headers: { Accept: "text/html,application/xhtml+xml" } };

async function configureMail(on: boolean): Promise<void> {
  await setSetting(env.DB, "email_to", on ? "me@example.com" : "");
  await setSetting(env.DB, "resend_api_key", on ? "re_test" : "");
  await setSetting(env.DB, "base_url", on ? "https://sr.example" : "");
}

async function insertCode(
  code: string, opts: { ttlMs?: number; redirect?: string } = {}
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO login_tokens (token_hash, created_at, expires_at, redirect) VALUES (?, ?, ?, ?)"
  ).bind(
    await sha256Hex(code),
    new Date(now).toISOString(),
    new Date(now + (opts.ttlMs ?? 900_000)).toISOString(),
    opts.redirect ?? "/"
  ).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM login_tokens").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login page", () => {
  it("browser navigations without a cookie get the sign-in screen, still 401", async () => {
    const res = await exports.default.fetch("http://sr/inbox", BROWSER);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Email me a sign-in link");
    expect(html).toContain('value="/inbox"'); // original destination survives the round trip
  });

  it("non-browser requests keep the bare 401", async () => {
    const res = await exports.default.fetch("http://sr/inbox");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });
});

describe("POST /auth/email", () => {
  const post = (redirect = "/") =>
    exports.default.fetch("http://sr/auth/email", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect })
    });

  it("without mail config: explains, stores nothing, sends nothing", async () => {
    await configureMail(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post();
    expect(await res.text()).toContain("Email sign-in isn&#39;t set up");
    expect(fetchSpy).not.toHaveBeenCalled();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("stores a hashed one-time code and emails a verify link (never SR_TOKEN)", async () => {
    await configureMail(true);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post("/inbox");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [mailUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(mailUrl).toBe("https://api.resend.com/emails");
    const sent = JSON.stringify(JSON.parse(init.body as string));
    const code = sent.match(/\/auth\/verify\?code=([A-Za-z0-9_-]+)/)?.[1];
    expect(code).toBeTruthy();
    expect(sent).not.toContain("test-token"); // the long-lived token stays out of email

    const row = await env.DB.prepare("SELECT token_hash, redirect FROM login_tokens")
      .first<{ token_hash: string; redirect: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(code!)); // hashed at rest, not the raw code
    expect(row?.redirect).toBe("/inbox");
  });

  it("throttles a second send within the cooldown", async () => {
    await configureMail(true);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect((await post()).status).toBe(200);
    const second = await post();
    expect(second.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("hostile redirect targets collapse to /", async () => {
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect("/browse?x=1")).toBe("/browse?x=1");
  });
});

describe("GET /auth/verify", () => {
  const verify = (code: string) =>
    exports.default.fetch(`http://sr/auth/verify?code=${code}`, { redirect: "manual" });

  it("valid code sets the session cookie and redirects to the stored destination", async () => {
    await insertCode("good-code", { redirect: "/inbox" });
    const res = await verify("good-code");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/inbox");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("sr=test-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("codes are single-use", async () => {
    await insertCode("once-code");
    expect((await verify("once-code")).status).toBe(302);
    const again = await verify("once-code");
    expect(again.status).toBe(401);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  it("expired codes are rejected", async () => {
    await insertCode("stale-code", { ttlMs: -1000 });
    const res = await verify("stale-code");
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("unknown and missing codes are rejected", async () => {
    expect((await verify("never-issued")).status).toBe(401);
    const res = await exports.default.fetch("http://sr/auth/verify", { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});

describe("composeLoginEmail", () => {
  it("carries the verify link in html and text", () => {
    const link = "https://sr.example/auth/verify?code=abc123";
    const { subject, html, text } = composeLoginEmail(link, "https://sr.example");
    expect(subject).toBe("Sign in to Resurface");
    expect(html).toContain(link);
    expect(text).toContain(link);
    expect(html).toContain("works once and expires in 15 minutes");
  });
});
