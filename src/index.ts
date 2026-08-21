import type { Env } from "./env.d";
import { requireAuth } from "./auth";
import { gradeApi, reviewPage } from "./routes/review";
import { captureApi, capturePage, capturesToday, sourcesApi } from "./routes/capture";
import { serveAsset, uploadAsset } from "./routes/assets";
import { deleteCapture, inboxPage, previewApi, refineApi, refinePage } from "./routes/inbox";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denied = requireAuth(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/" && request.method === "GET") return reviewPage(request, env);
    if (url.pathname === "/api/grade" && request.method === "POST") return gradeApi(request, env);
    if (url.pathname === "/capture" && request.method === "GET") return capturePage();
    if (url.pathname === "/api/capture" && request.method === "POST") return captureApi(request, env);
    if (url.pathname === "/api/captures/today" && request.method === "GET") return capturesToday(env);
    if (url.pathname === "/api/sources" && request.method === "GET") return sourcesApi(request, env);
    if (url.pathname === "/api/assets" && request.method === "POST") return uploadAsset(request, env);
    const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f]{32})$/);
    if (assetMatch && request.method === "GET") return serveAsset(assetMatch[1], env);
    if (url.pathname === "/inbox" && request.method === "GET") return inboxPage(env);
    const refineMatch = url.pathname.match(/^\/refine\/([a-z0-9]{10})$/);
    if (refineMatch && request.method === "GET") return refinePage(refineMatch[1], env);
    if (url.pathname === "/api/refine" && request.method === "POST") return refineApi(request, env);
    const delMatch = url.pathname.match(/^\/api\/capture\/([a-z0-9]{10})\/delete$/);
    if (delMatch && request.method === "POST") return deleteCapture(delMatch[1], env);
    if (url.pathname === "/api/preview" && request.method === "POST") return previewApi(request, env);
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 14
  }
} satisfies ExportedHandler<Env>;
