import type { Env } from "./env.d";

// image/svg+xml is deliberately excluded: an SVG can embed <script>, and served
// same-origin it would execute with access to this app's session — the raster
// formats below carry no such risk.
export const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/**
 * Content-addressed store: SHA-256 → 32-hex id, bytes in R2, row in D1.
 * Idempotent — re-storing the same bytes returns the same id.
 */
export async function storeAsset(
  env: Env, bytes: ArrayBuffer | Uint8Array, type: string, ts: string
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const existing = await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(id).first();
  if (!existing) {
    await env.BUCKET.put(id, bytes, { httpMetadata: { contentType: type } });
    // ON CONFLICT: two concurrent uploads of the same bytes must both get {id},
    // not a constraint crash for the loser. R2 put is an idempotent overwrite.
    await env.DB.prepare("INSERT INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(id, type, bytes.byteLength, ts).run();
  }
  return id;
}
