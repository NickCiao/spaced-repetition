import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const AUTH = { Authorization: "Bearer test-token" };
const post = (path: string, body: BodyInit) =>
  SELF.fetch(`http://sr${path}`, { method: "POST", headers: AUTH, body });
const jpost = (path: string, body: unknown) =>
  SELF.fetch(`http://sr${path}`, {
    method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });

async function seedViaApi() {
  const cap = await jpost("/api/capture", { text: "seed", title: "Imp Source", url: "https://imp.example" });
  const { id } = await cap.json() as { id: string };
  const ref = await jpost("/api/refine", {
    capture_id: id, source: { name: "Imp Source", url: "https://imp.example" },
    prompts: [
      { kind: "qa", question: "IQ1?", answer: "IA1" },
      { kind: "qa", question: "IQ2?", answer: "IA2" }
    ]
  });
  const { prompt_ids } = await ref.json() as { prompt_ids: string[] };
  await jpost("/api/grade", { prompt_id: prompt_ids[0], action: "remembered" });
  return prompt_ids;
}

async function download(): Promise<Record<string, Uint8Array>> {
  const res = await SELF.fetch("http://sr/export.zip", { headers: AUTH });
  expect(res.status).toBe(200);
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}

describe("export / import / restore", () => {
  it("export contains prompts, log, settings; unchanged re-import diffs to zero", async () => {
    await seedViaApi();
    const files = await download();
    const names = Object.keys(files);
    expect(names.some(n => n.startsWith("prompts/") && n.endsWith(".md"))).toBe(true);
    expect(names).toContain("log/reviews.jsonl");
    expect(names).toContain("settings.json");

    const dry = await post("/import?apply=0", zipSync(files));
    expect(dry.status).toBe(200);
    const { diff } = await dry.json() as any;
    expect(diff.newPrompts.length).toBe(0);
    expect(diff.edited.length).toBe(0);
    expect(diff.retired.length).toBe(0);
  });

  it("edit + delete + add are detected and applied", async () => {
    const files = await download();
    const mdName = Object.keys(files).find(n => n.startsWith("prompts/") && strFromU8(files[n]).includes("IQ1?"))!;
    let text = strFromU8(files[mdName]);
    text = text.replace("IA1", "IA1-edited");                       // edit one
    const lines = text.split("\n");
    const q2 = lines.findIndex(l => l === "Q: IQ2?");               // delete the other (Q,A,id + blank)
    lines.splice(q2 - 1, 4);
    text = lines.join("\n") + "\nQ: brand new?\nA: yes.\n";         // add one without id
    files[mdName] = strToU8(text);

    const dry = await (await post("/import?apply=0", zipSync(files))).json() as any;
    expect(dry.diff.edited.length).toBe(1);
    expect(dry.diff.retired.length).toBe(1);
    expect(dry.diff.newPrompts.length).toBe(1);

    const applied = await (await post("/import?apply=1", zipSync(files))).json() as any;
    expect(applied.applied).toEqual({ new: 1, edited: 1, retired: 1 });

    const edited = await env.DB.prepare("SELECT answer FROM prompts WHERE question = 'IQ1?'").first();
    expect(edited?.answer).toBe("IA1-edited");
    const gone = await env.DB.prepare("SELECT retired FROM prompts WHERE question = 'IQ2?'").first();
    expect(gone?.retired).toBe(1);
  });

  it("unknown id rejects the whole import", async () => {
    const files = await download();
    const mdName = Object.keys(files).find(n => n.startsWith("prompts/"))!;
    files[mdName] = strToU8(strFromU8(files[mdName]).replace(/<!-- id: [a-z0-9]+ -->/, "<!-- id: zzzzzzzzzz -->"));
    const res = await post("/import?apply=1", zipSync(files));
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors.join(" ")).toContain("zzzzzzzzzz");
  });

  it("restore on non-empty DB is 409; on empty DB replays schedule state", async () => {
    const files = await download();
    expect((await post("/import?apply=1&restore=1", zipSync(files))).status).toBe(409);

    const before = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    // wipe (order matters for FK)
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM prompts").run();
    await env.DB.prepare("DELETE FROM sources").run();
    await env.DB.prepare("DELETE FROM captures").run();

    const res = await post("/import?apply=1&restore=1", zipSync(files));
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    expect(after?.id).toBe(before?.id);          // ids preserved
    expect(after?.reps).toBe(before?.reps);      // replayed
    expect(after?.stability).toBe(before?.stability);
    expect(after?.due).toBe(before?.due);
  });
});
