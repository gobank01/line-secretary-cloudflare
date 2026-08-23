import { Hono } from "hono";
import { clearLoginFailures, hashLoginIp, isLoginBlocked, recordLoginFailure } from "../auth/login-limit";
import {
  authConfigurationValid,
  createSession,
  expiredSessionCookie,
  passwordMatches,
  requireMutationOrigin,
  requireOwner,
  sessionCookie,
} from "../auth/session";
import type { AppEnv } from "../env";

export const authRoutes = new Hono<{ Bindings: AppEnv }>();

authRoutes.post("/login", requireMutationOrigin, async (context) => {
  if (!authConfigurationValid(context.env.DASHBOARD_PASSWORD, context.env.SESSION_SECRET)) {
    return context.json({ error: "authentication_unavailable" }, 503);
  }
  const ipHash = await hashLoginIp(
    context.req.header("cf-connecting-ip") ?? "unknown",
    context.env.SESSION_SECRET,
  );
  const now = Date.now();
  if (await isLoginBlocked(context.env.DB, ipHash, now)) {
    return context.json({ error: "too_many_attempts" }, 429);
  }

  let password: string;
  try {
    const payload: unknown = await context.req.json();
    if (typeof payload !== "object" || payload === null || !("password" in payload) || typeof payload.password !== "string") {
      return context.json({ error: "invalid_request" }, 400);
    }
    password = payload.password;
  } catch {
    return context.json({ error: "invalid_request" }, 400);
  }

  if (!(await passwordMatches(password, context.env.DASHBOARD_PASSWORD))) {
    const failure = await recordLoginFailure(context.env.DB, ipHash, now);
    if (failure.attempts > 5) return context.json({ error: "too_many_attempts" }, 429);
    return context.json({ error: "invalid_credentials" }, 401);
  }

  await clearLoginFailures(context.env.DB, ipHash);
  const token = await createSession(context.env.SESSION_SECRET, now);
  context.header("set-cookie", sessionCookie(token));
  return context.json({ authenticated: true });
});

authRoutes.get("/session", requireOwner, (context) => context.json({ authenticated: true }));

authRoutes.post("/logout", requireMutationOrigin, requireOwner, (context) => {
  context.header("set-cookie", expiredSessionCookie());
  return context.json({ authenticated: false });
});
