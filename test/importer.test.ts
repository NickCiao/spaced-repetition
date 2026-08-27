import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { AUTH_HEADERS as AUTH, wipeData } from "./helpers";

const post = (path: string, body: BodyInit) =>
  exports.default.fetch(`http://sr${path}`, { method: "POST", headers: AUTH, body });
const jpost = (path: string, body: unknown) =>
  exports.default.fetch(`http://sr${path}`, {
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
  const res = await exports.default.fetch("http://sr/export.zip", { headers: AUTH });
  expect(res.status).toBe(200);
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}

// Each test seeds its own data from a clean slate so any one of them can run
// (and fail) in isolation. Settings persist across the wipe.
describe("export / import / restore", () => {
  beforeEach(wipeData);

  it("export contains prompts, log, settings; unchanged re-import diffs to zero", async () => {
    await seedViaApi();
    const files = await download();
    const names = Object.keys(files);
    expect(names.some(n => n.startsWith("prompts/") && n.endsWith(".md"))).toBe(true);
    expect(names).toContain("log/reviews.jsonl");
    expect(names).toContain("settings.json");
    const settings = JSON.parse(strFromU8(files["settings.json"]));
    expect(settings).not.toHaveProperty("resend_api_key");
    expect(settings).not.toHaveProperty("base_url");
    expect(settings).not.toHaveProperty("resend_key_set");

    const dry = await post("/import?apply=0", zipSync(files));
    expect(dry.status).toBe(200);
    const { diff } = await dry.json() as any;
    expect(diff.newPrompts.length).toBe(0);
    expect(diff.edited.length).toBe(0);
    expect(diff.retired.length).toBe(0);
  });

  it("a prompt saved with trailing whitespace is not a phantom edit on re-import", async () => {
    // The write-side normalization in /api/prompt exists to keep export → dry-run
    // diffs at zero (parse trims trailing blank lines); this locks that in for the
    // prompt-form path, which seedViaApi (refine) does not cover.
    const src = await jpost("/api/source", { name: "Trailing Src" });
    const { id: sid } = await src.json() as { id: string };
    const res = await jpost("/api/prompt", { source_id: sid, kind: "qa", question: "TQ?  ", answer: "TA.\n\n" });
    expect(res.status).toBe(200);

    const dry = await post("/import?apply=0", zipSync(await download()));
    expect(dry.status).toBe(200);
    const { diff } = await dry.json() as any;
    expect(diff.edited).toEqual([]);
    expect(diff.newPrompts).toEqual([]);
    expect(diff.retired).toEqual([]);
  });

  it("edit + delete + add are detected and applied", async () => {
    await seedViaApi();
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
    await seedViaApi();
    const files = await download();
    const mdName = Object.keys(files).find(n => n.startsWith("prompts/"))!;
    files[mdName] = strToU8(strFromU8(files[mdName]).replace(/<!-- id: [a-z0-9]+ -->/, "<!-- id: zzzzzzzzzz -->"));
    const res = await post("/import?apply=1", zipSync(files));
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors.join(" ")).toContain("zzzzzzzzzz");
  });

  it("restore on non-empty DB is 409; on empty DB replays schedule state", async () => {
    await seedViaApi();
    const files = await download();
    expect((await post("/import?apply=1&restore=1", zipSync(files))).status).toBe(409);

    const before = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    await wipeData();

    const res = await post("/import?apply=1&restore=1", zipSync(files));
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT id, due, stability, reps FROM prompts WHERE question = 'IQ1?'").first();
    expect(after?.id).toBe(before?.id);          // ids preserved
    expect(after?.reps).toBe(before?.reps);      // replayed
    expect(after?.stability).toBe(before?.stability);
    expect(after?.due).toBe(before?.due);
  });

  it("retired prompts survive export/restore; un-retired prompts stay active", async () => {
    const cap = await jpost("/api/capture", { text: "seed3", title: "Archive Source", url: "https://arc.example" });
    const { id: capId } = await cap.json() as { id: string };
    const ref = await jpost("/api/refine", {
      capture_id: capId, source: { name: "Archive Source", url: "https://arc.example" },
      prompts: [
        { kind: "qa", question: "AQ-stays-retired?", answer: "AA1" },
        { kind: "qa", question: "AQ-comes-back?", answer: "AA2" }
      ]
    });
    const { prompt_ids } = await ref.json() as { prompt_ids: string[] };
    const [stayRetired, comesBack] = prompt_ids;

    // stays retired: retire it and leave it alone (retire logs an event)
    await jpost("/api/grade", { prompt_id: stayRetired, action: "retire" });
    // comes back: retire it too (so it has a historical retire event), then un-retire
    // it via the edit form — that path flips the field directly and logs no event.
    await jpost("/api/grade", { prompt_id: comesBack, action: "retire" });
    const row = await env.DB.prepare("SELECT source_id FROM prompts WHERE id = ?").bind(comesBack).first();
    await jpost("/api/prompt", {
      id: comesBack, source_id: row!.source_id, kind: "qa", question: "AQ-comes-back?", answer: "AA2", retired: false
    });
    expect((await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(stayRetired).first())?.retired).toBe(1);
    expect((await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(comesBack).first())?.retired).toBe(0);

    const files = await download();
    expect(Object.keys(files)).toContain("retired.jsonl");

    await wipeData();

    const res = await post("/import?apply=1&restore=1", zipSync(files));
    expect(res.status).toBe(200);

    const after1 = await env.DB.prepare(
      "SELECT retired, question, answer, kind FROM prompts WHERE id = ?"
    ).bind(stayRetired).first();
    expect(after1?.retired).toBe(1);
    expect(after1?.question).toBe("AQ-stays-retired?");
    expect(after1?.answer).toBe("AA1");
    expect(after1?.kind).toBe("qa");

    const after2 = await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(comesBack).first();
    expect(after2?.retired).toBe(0);
  });

  it("re-adding a retired prompt's block un-retires it on import", async () => {
    const cap = await jpost("/api/capture", { text: "seed4", title: "Unretire Source" });
    const { id: capId } = await cap.json() as { id: string };
    const ref = await jpost("/api/refine", {
      capture_id: capId, source: { name: "Unretire Source" },
      prompts: [{ kind: "qa", question: "UQ?", answer: "UA." }]
    });
    const { prompt_ids: [rid] } = await ref.json() as { prompt_ids: string[] };
    await jpost("/api/grade", { prompt_id: rid, action: "retire" });

    // The retired prompt is only in retired.jsonl; write its block back into the
    // source's (now empty-bodied) authoring file, as a user restoring it would.
    const files = await download();
    const mdName = Object.keys(files).find(n =>
      n.startsWith("prompts/") && strFromU8(files[n]).includes("source: Unretire Source"))!;
    files[mdName] = strToU8(strFromU8(files[mdName]) + `\nQ: UQ?\nA: UA.\n<!-- id: ${rid} -->\n`);

    const dry = await (await post("/import?apply=0", zipSync(files))).json() as any;
    expect(dry.diff.errors).toEqual([]);          // re-adding a retired id is not an unknown-id error
    expect(dry.diff.edited).toContain(rid);

    const applied = await (await post("/import?apply=1", zipSync(files))).json() as any;
    expect(applied.applied).toEqual({ new: 0, edited: 1, retired: 0 });

    const after = await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(rid).first();
    expect(after?.retired).toBe(0);
  });

  it("a failed restore wipes inserted rows and unblocks retry", async () => {
    // Valid prompts/ file: the active-file loop inserts this source + prompt before
    // restoreFromZip ever looks at retired.jsonl.
    const validFile = "---\nsource: Wipe Test Src\n---\n\nQ: wipe-q?\nA: wipe-a.\n<!-- id: wwwwwwwwww -->\n";
    // Malformed retired.jsonl: JSON.parse throws while building the archive list, which
    // runs after the active-file loop's inserts — so the failure lands mid-restore,
    // with a source and a prompt already committed, not before any writes happen.
    const badZip = zipSync({
      "prompts/wipe-test.md": strToU8(validFile),
      "retired.jsonl": strToU8("not valid json\n"),
      "settings.json": strToU8("{}")
    });

    const res1 = await post("/import?apply=1&restore=1", badZip);
    expect(res1.status).toBe(400);

    const promptCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first();
    expect(promptCount?.n).toBe(0);
    const sourceCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first();
    expect(sourceCount?.n).toBe(0);

    // Retry with a good zip must succeed — not blocked by a stale non-empty-DB 409.
    const res2 = await post("/import?apply=1&restore=1", zipSync({ "settings.json": strToU8("{}") }));
    expect(res2.status).toBe(200);
    const body = await res2.json() as any;
    expect(body.restored).toEqual({ sources: 0, prompts: 0, events: 0 });
  });

  it("a capture's note round-trips through export and restore", async () => {
    const cap = await jpost("/api/capture", { text: "note-cap", note: "remember this bit" });
    const { id: capId } = await cap.json() as { id: string };

    const files = await download();
    expect(strFromU8(files[`inbox/${capId}.md`])).toContain("note: remember this bit");

    await wipeData();

    const res = await post("/import?apply=1&restore=1", zipSync(files));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT note FROM captures WHERE id = ?").bind(capId).first();
    expect(row?.note).toBe("remember this bit");
  });
});
