import { Hono } from "hono";
import { requireOwner } from "../auth/session";
import {
  actionQueueFrom,
  getDashboardKpis,
  getGroupDetail,
  getSystemHealth,
  listAlerts,
  listCategorySummaries,
  listGroupSummaries,
} from "../db/repositories";
import type { DashboardPayload, DataMode } from "../db/types";
import type { AppEnv } from "../env";

function modeFrom(value: string | undefined): DataMode | null {
  if (value === undefined) return "demo";
  return value === "demo" || value === "real" ? value : null;
}

function integerFrom(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

export const dashboardRoutes = new Hono<{ Bindings: AppEnv }>();
dashboardRoutes.use("*", requireOwner);

dashboardRoutes.get("/dashboard", async (context) => {
  const mode = modeFrom(context.req.query("mode"));
  if (!mode) return context.json({ error: "invalid_mode" }, 400);

  const now = Date.now();
  const [{ groups }, kpis, categories, health] = await Promise.all([
    listGroupSummaries(context.env.DB, { mode, limit: 100, offset: 0 }),
    getDashboardKpis(context.env.DB, mode),
    listCategorySummaries(context.env.DB, mode),
    getSystemHealth(context.env.DB, now, context.env.APP_TIMEZONE),
  ]);
  const payload: DashboardPayload = {
    generatedAt: now,
    kpis,
    categories,
    groups,
    actionQueue: actionQueueFrom(groups),
    health,
  };
  return context.json(payload);
});

dashboardRoutes.get("/groups", async (context) => {
  const mode = modeFrom(context.req.query("mode"));
  const limit = integerFrom(context.req.query("limit"), 100, 1, 100);
  const offset = integerFrom(context.req.query("offset"), 0, 0, 1_000_000);
  const category = context.req.query("category");
  if (!mode || limit === null || offset === null || category === "") {
    return context.json({ error: "invalid_filter" }, 400);
  }
  return context.json(
    await listGroupSummaries(context.env.DB, {
      mode,
      limit,
      offset,
      ...(category ? { category } : {}),
    }),
  );
});

dashboardRoutes.get("/groups/:id", async (context) => {
  const detail = await getGroupDetail(context.env.DB, context.req.param("id"));
  return detail ? context.json(detail) : context.json({ error: "not_found" }, 404);
});

dashboardRoutes.get("/alerts", async (context) => {
  const updatedAfter = integerFrom(context.req.query("updated_after"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerFrom(context.req.query("limit"), 100, 1, 100);
  if (updatedAfter === null || limit === null) return context.json({ error: "invalid_filter" }, 400);
  const alerts = await listAlerts(context.env.DB, updatedAfter, limit);
  return context.json({ alerts });
});

dashboardRoutes.get("/categories", async (context) => {
  const mode = modeFrom(context.req.query("mode"));
  if (!mode) return context.json({ error: "invalid_mode" }, 400);
  return context.json({ categories: await listCategorySummaries(context.env.DB, mode) });
});

dashboardRoutes.get("/system/health", async (context) =>
  context.json(await getSystemHealth(context.env.DB, Date.now(), context.env.APP_TIMEZONE)),
);
