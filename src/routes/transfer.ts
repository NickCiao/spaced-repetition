import { unzipSync } from "fflate";
import type { Env } from "../env.d";
import { buildExportZip } from "../exporter";
import { applyImport, computeImportDiff, restoreFromZip, RestoreNotEmptyError } from "../importer";

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
