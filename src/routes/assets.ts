import type { Env } from "../env.d";
import { nowIso } from "../db";

const MAX_BYTES = 5 * 1024 * 1024;

// image/svg+xml is deliberately excluded: an SVG can embed <script>, and served
// same-origin it would execute with access to this app's session — the raster
// formats below carry no such risk.
export const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export async function uploadAsset(request: Request, env: Env): Promise<Response> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!ALLOWED_TYPES.has(type)) return Response.json({ error: "unsupported image type" }, { status: 400 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return Response.json({ error: "empty" }, { status: 400 });
  if (buf.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });

  const digest = await crypto.subtle.digest("SHA-256", buf);
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  const existing = await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(id).first();
  if (!existing) {
    await env.BUCKET.put(id, buf, { httpMetadata: { contentType: type } });
    // ON CONFLICT: two concurrent uploads of the same bytes must both get {id},
    // not a constraint crash for the loser. R2 put is an idempotent overwrite.
    await env.DB.prepare("INSERT INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(id, type, buf.byteLength, nowIso()).run();
  }
  return Response.json({ id });
}

export async function serveAsset(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT content_type FROM assets WHERE id = ?")
    .bind(id).first<{ content_type: string }>();
  if (!row) return new Response("not found", { status: 404 });
  const obj = await env.BUCKET.get(id);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox"
    }
  });
}
