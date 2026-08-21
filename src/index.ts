import type { Env } from "./env.d";
import { requireAuth } from "./auth";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denied = requireAuth(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // wired in Task 14
  }
} satisfies ExportedHandler<Env>;
