import app from "./index";
import { collectTicketSnapshots } from "./ticket-snapshots";

// 前端资源独立部署，这里保持对外来源稳定。
export default {
  async scheduled(controller, env) {
    await collectTicketSnapshots(env.DB, controller.scheduledTime);
  },
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.WEB.fetch(request);
  },
} satisfies ExportedHandler<Env>;
