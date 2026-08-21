import type { Env } from "./env.d";
import { requireAuth } from "./auth";
import { gradeApi, reviewPage } from "./routes/review";
import { captureApi, capturePage, capturesToday, sourcesApi } from "./routes/capture";

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
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 14
  }
} satisfies ExportedHandler<Env>;
