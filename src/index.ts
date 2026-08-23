import type { Env } from "./env.d";
import { requireAuth } from "./auth";
import { gradeApi, reviewPage } from "./routes/review";
import { captureApi, capturePage, capturesToday, sourcesApi } from "./routes/capture";
import { serveAsset, uploadAsset } from "./routes/assets";
import { deleteCapture, inboxPage, previewApi, refineApi, refinePage } from "./routes/inbox";
import { browseIndex, browseSource, deletePrompt, promptApi, promptForm } from "./routes/browse";
import { settingsApi, settingsPage } from "./routes/settings";
import { exportZip, importForeign, importZip } from "./routes/transfer";
import { runReminderCron } from "./email";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denied = requireAuth(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // The assets layer serves these before the worker runs in production; serving them here
    // too keeps the worker self-sufficient and its HTTP surface testable end to end.
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      return env.ASSETS.fetch(new Request(new URL("/static/favicon.svg", url), request));
    }
    if (request.method === "GET" && /^\/(sw\.js$|static\/)/.test(url.pathname)) return env.ASSETS.fetch(request);
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
    if (url.pathname === "/browse" && request.method === "GET") return browseIndex(env);
    const srcMatch = url.pathname.match(/^\/browse\/([a-z0-9]{10})$/);
    if (srcMatch && request.method === "GET") return browseSource(srcMatch[1], env);
    const pMatch = url.pathname.match(/^\/prompt\/(new|[a-z0-9]{10})$/);
    if (pMatch && request.method === "GET") return promptForm(pMatch[1], request, env);
    if (url.pathname === "/api/prompt" && request.method === "POST") return promptApi(request, env);
    const promptDelMatch = url.pathname.match(/^\/api\/prompt\/([a-z0-9]{10})\/delete$/);
    if (promptDelMatch && request.method === "POST") return deletePrompt(promptDelMatch[1], env);
    if (url.pathname === "/settings" && request.method === "GET") return settingsPage(env);
    if (url.pathname === "/api/settings" && request.method === "POST") return settingsApi(request, env);
    if (url.pathname === "/export.zip" && request.method === "GET") return exportZip(env);
    if (url.pathname === "/import" && request.method === "POST") return importZip(request, env);
    if (url.pathname === "/import/foreign" && request.method === "POST") return importForeign(request, env);
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReminderCron(env, new Date(controller.scheduledTime)));
  }
} satisfies ExportedHandler<Env>;
