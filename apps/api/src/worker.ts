import app from "./index";

// 前端资源独立部署，这里保持对外来源稳定。
export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.WEB.fetch(request);
  },
} satisfies ExportedHandler<Env>;
