import { Hono } from "hono";
import { requireMutationOrigin, requireOwner } from "../auth/session";
import {
  assignOwnerCategory,
  createOwnerCategory,
  deleteGroupRawHistory,
  listAuditLog,
  setOwnerAlertStatus,
  setOwnerGroupStatus,
  updateOwnerCategory,
} from "../db/repositories";
import type { AppEnv } from "../env";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bodyRecord(context: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const value = await context.req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 60;
}

export const controlsRoutes = new Hono<{ Bindings: AppEnv }>();
controlsRoutes.use("*", requireOwner);

controlsRoutes.patch("/groups/:id/category", requireMutationOrigin, async (context) => {
  const body = await bodyRecord(context);
  if (!body || !Number.isInteger(body.categoryId) || (body.locked !== undefined && typeof body.locked !== "boolean")) {
    return context.json({ error: "invalid_request" }, 400);
  }
  const result = await assignOwnerCategory(
    context.env.DB,
    context.req.param("id"),
    body.categoryId as number,
    body.locked === undefined ? true : body.locked,
    Date.now(),
  );
  if (result.kind === "group_not_found") return context.json({ error: "not_found" }, 404);
  if (result.kind === "category_not_found") return context.json({ error: "invalid_category" }, 400);
  return context.json(result.value);
});

controlsRoutes.patch("/groups/:id/status", requireMutationOrigin, async (context) => {
  const body = await bodyRecord(context);
  if (!body || typeof body.active !== "boolean") return context.json({ error: "invalid_request" }, 400);
  const value = await setOwnerGroupStatus(context.env.DB, context.req.param("id"), body.active, Date.now());
  return value ? context.json(value) : context.json({ error: "not_found" }, 404);
});

controlsRoutes.delete("/groups/:id/raw-history", requireMutationOrigin, async (context) => {
  const value = await deleteGroupRawHistory(context.env.DB, context.req.param("id"), Date.now());
  return value ? context.json(value) : context.json({ error: "not_found" }, 404);
});

controlsRoutes.patch("/alerts/:id", requireMutationOrigin, async (context) => {
  const id = Number.parseInt(context.req.param("id"), 10);
  const body = await bodyRecord(context);
  if (
    !Number.isInteger(id) ||
    !body ||
    (body.status !== "open" && body.status !== "acknowledged" && body.status !== "resolved")
  ) {
    return context.json({ error: "invalid_request" }, 400);
  }
  const value = await setOwnerAlertStatus(context.env.DB, id, body.status, Date.now());
  return value ? context.json(value) : context.json({ error: "not_found" }, 404);
});

controlsRoutes.post("/categories", requireMutationOrigin, async (context) => {
  const body = await bodyRecord(context);
  if (
    !body ||
    typeof body.slug !== "string" ||
    !SLUG_PATTERN.test(body.slug) ||
    !validName(body.name) ||
    typeof body.color !== "string" ||
    !COLOR_PATTERN.test(body.color)
  ) {
    return context.json({ error: "invalid_request" }, 400);
  }
  const result = await createOwnerCategory(
    context.env.DB,
    { slug: body.slug, name: body.name.trim(), color: body.color.toLowerCase() },
    Date.now(),
  );
  return result.kind === "conflict"
    ? context.json({ error: "slug_exists" }, 409)
    : context.json(result.value, 201);
});

controlsRoutes.patch("/categories/:id", requireMutationOrigin, async (context) => {
  const id = Number.parseInt(context.req.param("id"), 10);
  const body = await bodyRecord(context);
  if (!Number.isInteger(id) || !body || "slug" in body) return context.json({ error: "invalid_request" }, 400);
  if (body.name !== undefined && !validName(body.name)) return context.json({ error: "invalid_name" }, 400);
  if (body.color !== undefined && (typeof body.color !== "string" || !COLOR_PATTERN.test(body.color))) {
    return context.json({ error: "invalid_color" }, 400);
  }
  if (body.active !== undefined && typeof body.active !== "boolean") {
    return context.json({ error: "invalid_active" }, 400);
  }
  if (body.name === undefined && body.color === undefined && body.active === undefined) {
    return context.json({ error: "empty_update" }, 400);
  }
  const value = await updateOwnerCategory(
    context.env.DB,
    id,
    {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.color === "string" ? { color: body.color.toLowerCase() } : {}),
      ...(typeof body.active === "boolean" ? { active: body.active } : {}),
    },
    Date.now(),
  );
  return value ? context.json(value) : context.json({ error: "not_found" }, 404);
});

controlsRoutes.get("/audit-log", async (context) => {
  const limitValue = context.req.query("limit") ?? "50";
  if (!/^\d+$/u.test(limitValue)) return context.json({ error: "invalid_limit" }, 400);
  const limit = Number.parseInt(limitValue, 10);
  if (limit < 1 || limit > 100) return context.json({ error: "invalid_limit" }, 400);
  const entries = await listAuditLog(context.env.DB, {
    ...(context.req.query("entity_type") ? { entityType: context.req.query("entity_type") } : {}),
    ...(context.req.query("entity_id") ? { entityId: context.req.query("entity_id") } : {}),
    limit,
  });
  return context.json({ entries });
});
