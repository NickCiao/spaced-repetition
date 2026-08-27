import type { Env } from "../env.d";
import { nowIso } from "../db";
import { ALLOWED_TYPES, storeAsset } from "../assets";

const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadAsset(request: Request, env: Env): Promise<Response> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!ALLOWED_TYPES.has(type)) return Response.json({ error: "unsupported image type" }, { status: 400 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return Response.json({ error: "empty" }, { status: 400 });
  if (buf.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  const id = await storeAsset(env, buf, type, nowIso());
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
