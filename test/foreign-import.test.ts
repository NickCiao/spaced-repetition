import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { AUTH_HEADERS as AUTH } from "./helpers";

const post = (path: string, body: BodyInit) =>
  exports.default.fetch(`http://sr${path}`, { method: "POST", headers: AUTH, body });

describe("foreign import", () => {
  it("rejects apkg-shaped zip with guidance", async () => {
    const zip = zipSync({
      "collection.anki2": strToU8("not really sqlite"),
      "meta": strToU8("{}")
    });
    const res = await post("/import/foreign?apply=0", zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors[0]).toContain("plain text");
  });

  it("rejects mochi csv zip with guidance", async () => {
    const zip = zipSync({ "cards.csv": strToU8('"Front";"Back"\n"a";"b"') });
    const res = await post("/import/foreign?apply=0", zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors[0]).toContain(".mochi");
  });

  it("dry-run anki tsv then apply creates prompts", async () => {
    const tsv = `#separator:tab
#html:true
Unique foreign import Q?	Unique foreign import A.`;
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();

    const dry = await post("/import/foreign?apply=0&topic=ForeignTest", tsv);
    expect(dry.status).toBe(200);
    const preview = await dry.json() as { preview: { created: number } };
    expect(preview.preview.created).toBe(1);

    const mid = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();
    expect(mid?.n).toBe(before?.n);

    const applied = await post("/import/foreign?apply=1&topic=ForeignTest", tsv);
    expect(applied.status).toBe(200);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();
    expect(after?.n).toBe((before?.n ?? 0) + 1);

    const row = await env.DB.prepare(
      "SELECT question, answer FROM prompts WHERE question = ?"
    ).bind("Unique foreign import Q?").first<{ question: string; answer: string }>();
    expect(row?.answer).toBe("Unique foreign import A.");
  });

  it("second apply of same file is all skips", async () => {
    const tsv = `#separator:tab
#html:true
Dedup foreign Q?	Dedup foreign A.`;
    await post("/import/foreign?apply=1&topic=ForeignDedup", tsv);
    const res = await post("/import/foreign?apply=1&topic=ForeignDedup", tsv);
    const body = await res.json() as { applied: { created: number; skipped: number } };
    expect(body.applied.created).toBe(0);
    expect(body.applied.skipped).toBe(1);
  });

  it("dry-run mochi zip import", async () => {
    const data = {
      "~:decks": [{
        "~:name": "Mochi Deck",
        "~:cards": { "~#list": [{ "~:name": "c", "~:content": "Mochi Q?\n---\nMochi A." }] }
      }]
    };
    const zip = zipSync({ "data.json": strToU8(JSON.stringify(data)) });
    const res = await post("/import/foreign?apply=0", zip);
    expect(res.status).toBe(200);
    const body = await res.json() as { preview: { created: number; topics: { name: string }[] } };
    expect(body.preview.created).toBe(1);
    expect(body.preview.topics[0].name).toBe("Mochi Deck");
  });
});
