import type { Env } from "./env.d";
import { requireAuth } from "./auth";
import { rememberBaseUrl } from "./db";
import { gradeApi, reviewPage } from "./routes/review";
import { captureApi, capturePage, capturesToday, topicsApi } from "./routes/capture";
import { serveAsset, uploadAsset } from "./routes/assets";
import { deleteCapture, inboxPage, previewApi, refineApi, refinePage } from "./routes/inbox";
import { browseIndex, browseTopic, deletePrompt, promptApi, promptForm, topicApi } from "./routes/browse";
import { settingsApi, settingsPage } from "./routes/settings";
import { emailLoginLink, loginPage, verifyLogin } from "./routes/auth";
import { exportZip, importForeign, importZip } from "./routes/transfer";
import { runReminderCron } from "./email";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denied = requireAuth(request, env);
    if (denied) {
      // Successful ?token=… redirect: learn the public origin while we still have the request.
      if (denied.status === 302) ctx.waitUntil(rememberBaseUrl(env.DB, request.url));
      // Browser navigations get a sign-in screen instead of the bare 401; API
      // callers (fetch, curl, Shortcuts) keep the plain text response.
      if (denied.status === 401 && request.method === "GET" &&
          (request.headers.get("Accept") ?? "").includes("text/html")) {
        const u = new URL(request.url);
        u.searchParams.delete("token");
        return loginPage({ redirect: u.pathname + u.search });
      }
      return denied;
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // The assets layer serves these before the worker runs in production; serving them here
    // too keeps the worker self-sufficient and its HTTP surface testable end to end.
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      return env.ASSETS.fetch(new Request(new URL("/static/favicon-32.png", url), request));
    }
    if (request.method === "GET" && /^\/(sw\.js$|static\/)/.test(url.pathname)) return env.ASSETS.fetch(request);

    // Magic-link sign-in: public by necessity, handled before rememberBaseUrl so
    // an unauthenticated request can never seed the app's public origin.
    if (url.pathname === "/auth/email" && request.method === "POST") return emailLoginLink(request, env);
    if (url.pathname === "/auth/verify" && request.method === "GET") return verifyLogin(request, env);

    ctx.waitUntil(rememberBaseUrl(env.DB, request.url));

    if (url.pathname === "/" && request.method === "GET") return reviewPage(request, env);
    if (url.pathname === "/api/grade" && request.method === "POST") return gradeApi(request, env);
    if (url.pathname === "/capture" && request.method === "GET") return capturePage(env);
    if (url.pathname === "/api/capture" && request.method === "POST") return captureApi(request, env);
    if (url.pathname === "/api/captures/today" && request.method === "GET") return capturesToday(env);
    if (url.pathname === "/api/topics" && request.method === "GET") return topicsApi(env);
    if (url.pathname === "/api/assets" && request.method === "POST") return uploadAsset(request, env);
    const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f]{32})$/);
    if (assetMatch && request.method === "GET") return serveAsset(assetMatch[1], env);
    if (url.pathname === "/inbox" && request.method === "GET") return inboxPage(env);
    const refineMatch = url.pathname.match(/^\/refine\/([a-z0-9]{10})$/);
    if (refineMatch && request.method === "GET") return refinePage(refineMatch[1], env);
    if (url.pathname === "/api/refine" && request.method === "POST") return refineApi(request, env);
    const delMatch = url.pathname.match(/^\/api\/capture\/([a-z0-9]{10})\/delete$/);
    if (delMatch && request.method === "POST") return deleteCapture(delMatch[1], env);
    if (url.pathname === "/api/preview" && request.method === "POST") return previewApi(request);
    if (url.pathname === "/browse" && request.method === "GET") return browseIndex(env);
    if (url.pathname === "/api/topic" && request.method === "POST") return topicApi(request, env);
    const topicMatch = url.pathname.match(/^\/browse\/([a-z0-9]{10})$/);
    if (topicMatch && request.method === "GET") return browseTopic(topicMatch[1], env);
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
