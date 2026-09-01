import { unzipSync } from "fflate";
import type { Env } from "../env.d";
import { buildExportZip } from "../exporter";
import { applyForeignImport, applyImport, computeImportDiff, restoreFromZip, RestoreNotEmptyError } from "../importer";
import { InteropError, parseAnkiTsv, parseMochi } from "../interop";

export async function exportZip(env: Env): Promise<Response> {
  const zip = await buildExportZip(env);
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="sr-export-${new Date().toISOString().slice(0, 10)}.zip"`
    }
  });
}

export async function importZip(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "1";
  const restore = url.searchParams.get("restore") === "1";
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await request.arrayBuffer()));
  } catch {
    return Response.json({ errors: ["not a readable zip"] }, { status: 400 });
  }
  try {
    if (restore) {
      if (!apply) return Response.json({ errors: ["restore requires apply=1"] }, { status: 400 });
      const restored = await restoreFromZip(env, files, new Date());
      return Response.json({ restored });
    }
    if (!apply) {
      const diff = await computeImportDiff(env, files);
      return diff.errors.length
        ? Response.json({ errors: diff.errors }, { status: 400 })
        : Response.json({ diff });
    }
    const applied = await applyImport(env, files, new Date());
    return Response.json({ applied });
  } catch (e) {
    if (e instanceof RestoreNotEmptyError) return Response.json({ errors: [e.message] }, { status: 409 });
    return Response.json({ errors: [String(e instanceof Error ? e.message : e)] }, { status: 400 });
  }
}

function isZip(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function hasAnkiDb(files: Record<string, Uint8Array>): boolean {
  return Object.keys(files).some(p => /^collection\.anki2/.test(p));
}

export async function importForeign(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "1";
  const fallbackTopic = url.searchParams.get("topic")?.trim() || "Anki import";
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return Response.json({ errors: ["empty upload"] }, { status: 400 });

  try {
    if (isZip(buf)) {
      let files: Record<string, Uint8Array>;
      try { files = unzipSync(buf); }
      catch { return Response.json({ errors: ["not a readable zip"] }, { status: 400 }); }

      if (hasAnkiDb(files)) {
        return Response.json({
          errors: ["Anki .apkg/.colpkg is not supported — re-export from Anki as plain text (File → Export → Notes in plain text)"]
        }, { status: 400 });
      }
      if (files["cards.csv"] && !files["data.json"]) {
        return Response.json({
          errors: ["Mochi CSV export is not supported — re-export from Mochi as .mochi format"]
        }, { status: 400 });
      }
      if (!files["data.json"]) {
        return Response.json({ errors: ["unrecognized zip — expected Mochi .mochi export (data.json inside)"] }, { status: 400 });
      }
      const data = parseMochi(files);
      const result = await applyForeignImport(env, data, new Date(), apply);
      return Response.json(apply ? { applied: result } : { preview: result });
    }

    const text = new TextDecoder().decode(buf);
    if (!text.includes("\t") && !text.includes("#separator")) {
      return Response.json({ errors: ["expected Anki plain-text TSV or Mochi .mochi zip"] }, { status: 400 });
    }
    const data = parseAnkiTsv(text, fallbackTopic);
    const result = await applyForeignImport(env, data, new Date(), apply);
    return Response.json(apply ? { applied: result } : { preview: result });
  } catch (e) {
    if (e instanceof InteropError) return Response.json({ errors: [e.message] }, { status: 400 });
    return Response.json({ errors: [String(e instanceof Error ? e.message : e)] }, { status: 400 });
  }
}

