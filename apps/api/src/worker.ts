import app from "./index";

// Keep the public origin stable while web assets deploy independently.
export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.WEB.fetch(request);
  },
} satisfies ExportedHandler<Env>;
