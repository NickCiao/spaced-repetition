import type { Env } from "./env.d";
import { requireAuth } from "./auth";
import { gradeApi, reviewPage } from "./routes/review";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denied = requireAuth(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/" && request.method === "GET") return reviewPage(request, env);
    if (url.pathname === "/api/grade" && request.method === "POST") return gradeApi(request, env);
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 14
  }
} satisfies ExportedHandler<Env>;
