import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUTH_HEADERS as AUTH } from "./helpers";

const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);

describe("assets", () => {
  it("upload → serve round-trip, content-addressed", async () => {
    const up = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/png" }, body: bytes
    });
    expect(up.status).toBe(200);
    const { id } = await up.json() as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const again = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/png" }, body: bytes
    });
    expect((await again.json() as { id: string }).id).toBe(id); // dedupe

    const got = await exports.default.fetch(`http://sr/assets/${id}`, { headers: AUTH });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("404 on unknown id; 400 on non-image; 413 on oversize", async () => {
    expect((await exports.default.fetch("http://sr/assets/deadbeefdeadbeefdeadbeefdeadbeef", { headers: AUTH })).status).toBe(404);
    const bad = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "text/plain" }, body: "hi"
    });
    expect(bad.status).toBe(400);
    // Scripted SVG executes same-origin — excluded even though it's technically an image type.
    const svg = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/svg+xml" }, body: "<svg></svg>"
    });
    expect(svg.status).toBe(400);
    const big = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/jpeg" },
      body: new Uint8Array(5 * 1024 * 1024 + 1)
    });
    expect(big.status).toBe(413);

    const up = await exports.default.fetch("http://sr/api/assets", {
      method: "POST", headers: { ...AUTH, "Content-Type": "image/png" }, body: bytes
    });
    const { id } = await up.json() as { id: string };
    const served = await exports.default.fetch(`http://sr/assets/${id}`, { headers: AUTH });
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
