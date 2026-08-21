import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("GET /health responds ok without auth", async () => {
    const res = await SELF.fetch("http://sr/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth", () => {
  it("rejects unknown token and missing token", async () => {
    expect((await SELF.fetch("http://sr/anything")).status).toBe(401);
    expect((await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts bearer header (404 for unknown route, not 401)", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer test-token" } });
    expect(res.status).toBe(404);
  });

  it("?token= sets cookie and redirects to clean URL", async () => {
    const res = await SELF.fetch("http://sr/somewhere?a=1&token=test-token", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://sr/somewhere?a=1");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("sr=test-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("accepts the cookie", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Cookie: "sr=test-token" } });
    expect(res.status).toBe(404);
  });
});
