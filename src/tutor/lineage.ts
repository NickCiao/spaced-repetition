import { LINEAGE_KEY, type Lineage, type LineageEdge } from "./types";

/**
 * Lineage ledger: a JSON array of edges in one `settings` row (no migration on this
 * branch). Appends go through SQLite's json_insert so concurrent accepts never
 * clobber each other. Read only by the tutor's read_prompt tool.
 */
export const lineage: Lineage = {
  async append(db, edge) {
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, '[]') ON CONFLICT(key) DO NOTHING"
    ).bind(LINEAGE_KEY).run();
    await db.prepare(
      "UPDATE settings SET value = json_insert(value, '$[#]', json(?)) WHERE key = ?"
    ).bind(JSON.stringify(edge), LINEAGE_KEY).run();
  },

  async forPrompt(db, promptId) {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(LINEAGE_KEY).first<{ value: string }>();
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (err) {
      throw new Error(`lineage ledger (settings.${LINEAGE_KEY}) is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`lineage ledger (settings.${LINEAGE_KEY}) is not a JSON array`);
    }
    return (parsed as LineageEdge[]).filter(e => e && (e.child === promptId || e.parent === promptId));
  }
};
