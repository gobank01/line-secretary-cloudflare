import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { createSession, verifySession } from "../../worker/auth/session";

const origin = "http://example.com";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env, createExecutionContext());
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM auth_attempts").run();
});

describe("owner sessions", () => {
  it("signs a 12-hour token and rejects tampering or expiration", async () => {
    const now = Date.UTC(2026, 7, 23, 12, 0, 0);
    const token = await createSession(env.SESSION_SECRET, now);
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(verifySession(token, env.SESSION_SECRET, now + 11 * 60 * 60 * 1_000)).resolves.toBe(true);
    await expect(verifySession(tamperedToken, env.SESSION_SECRET, now)).resolves.toBe(false);
    await expect(verifySession(token, env.SESSION_SECRET, now + 13 * 60 * 60 * 1_000)).resolves.toBe(false);
  });

  it("requires authentication and sets a hardened cookie after login", async () => {
    expect((await request("/api/auth/session")).status).toBe(401);

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/owner_session=.*HttpOnly.*Secure.*SameSite=Strict/);

    const session = await request("/api/auth/session", { headers: { cookie: cookiePair(setCookie) } });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({ authenticated: true });

    const tampered = `${cookiePair(setCookie)}x`;
    expect((await request("/api/auth/session", { headers: { cookie: tampered } })).status).toBe(401);
  });

  it("rejects cross-origin mutations and clears the session on logout", async () => {
    const forbidden = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    });
    expect(forbidden.status).toBe(403);

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    });
    const cookie = cookiePair(login.headers.get("set-cookie") ?? "");
    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, origin },
    });

    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/owner_session=;.*Max-Age=0/);
  });

  it("rate-limits the sixth wrong password and stores no raw IP", async () => {
    const headers = {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.42",
      origin,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request("/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(response.status).toBe(401);
    }

    const sixth = await request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(sixth.status).toBe(429);

    const rows = await env.DB.prepare("SELECT ip_hash FROM auth_attempts").all<{ ip_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.ip_hash).not.toContain("203.0.113.42");
    expect(rows.results[0]?.ip_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
