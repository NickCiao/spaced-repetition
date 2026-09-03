import type { Env } from "./env.d";

const PUBLIC = [/^\/health$/, /^\/sw\.js$/, /^\/favicon\.ico$/, /^\/static\//, /^\/auth\//];

/** The long-lived session cookie, set on `?token=` login and on magic-link verify. */
export function authCookie(token: string): string {
  return `sr=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

export function requireAuth(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (PUBLIC.some(re => re.test(url.pathname))) return null;

  const qp = url.searchParams.get("token");
  if (qp !== null) {
    if (qp !== env.SR_TOKEN) return new Response("unauthorized", { status: 401 });
    url.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: { Location: url.toString(), "Set-Cookie": authCookie(env.SR_TOKEN) }
    });
  }

  const header = request.headers.get("Authorization");
  if (header === `Bearer ${env.SR_TOKEN}`) return null;

  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)sr=([^;]+)/);
  if (match && match[1] === env.SR_TOKEN) return null;

  return new Response("unauthorized", { status: 401 });
}
