import { Hono } from "hono";
import type { AppEnv } from "./env";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { lineRoutes } from "./routes/line";

export const createApp = () => {
  const app = new Hono<{ Bindings: AppEnv }>();

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "line-secretary-cloudflare",
      environment: context.env.APP_ENV,
    }),
  );

  app.route("/api/line", lineRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api", dashboardRoutes);

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((error, context) => {
    console.error("request_failed", { path: context.req.path, name: error.name });
    return context.json({ error: "internal_error" }, 500);
  });

  return app;
};
