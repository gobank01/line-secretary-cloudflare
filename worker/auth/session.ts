import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

const encoder = new TextEncoder();
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 12;
const MIN_SESSION_SECRET_LENGTH = 32;

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantWorkEqual(expected: Uint8Array, actual: Uint8Array): boolean {
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (actual[index] ?? 0);
  }
  return difference === 0;
}

export function authConfigurationValid(password: string | undefined, secret: string | undefined): boolean {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    typeof secret === "string" &&
    secret.length >= MIN_SESSION_SECRET_LENGTH
  );
}

export async function createSession(secret: string | undefined, now: number): Promise<string> {
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error("SESSION_SECRET is not configured securely");
  }
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: "owner", exp: Math.floor(now / 1_000) + SESSION_SECONDS })),
  );
  const signature = base64UrlEncode(await hmac(payload, secret));
  return `${payload}.${signature}`;
}

export async function verifySession(cookie: string, secret: string | undefined, now: number): Promise<boolean> {
  try {
    if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) return false;
    const parts = cookie.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

    const expected = await hmac(parts[0], secret);
    const actual = base64UrlDecode(parts[1]);
    if (!constantWorkEqual(expected, actual)) return false;

    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    return (
      typeof payload === "object" &&
      payload !== null &&
      "sub" in payload &&
      payload.sub === "owner" &&
      "exp" in payload &&
      typeof payload.exp === "number" &&
      payload.exp > Math.floor(now / 1_000)
    );
  } catch {
    return false;
  }
}

export function sessionCookie(value: string): string {
  return `owner_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function expiredSessionCookie(): string {
  return "owner_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export const requireOwner: MiddlewareHandler<{ Bindings: AppEnv }> = async (context, next) => {
  const token = readCookie(context.req.header("cookie"), "owner_session");
  if (!token || !(await verifySession(token, context.env.SESSION_SECRET, Date.now()))) {
    return context.json({ error: "unauthorized" }, 401);
  }
  await next();
};

export const requireMutationOrigin: MiddlewareHandler<{ Bindings: AppEnv }> = async (context, next) => {
  const origin = context.req.header("origin");
  try {
    if (!origin || new URL(origin).host !== new URL(context.req.url).host) {
      return context.json({ error: "forbidden_origin" }, 403);
    }
  } catch {
    return context.json({ error: "forbidden_origin" }, 403);
  }
  await next();
};

export async function passwordMatches(candidate: string, configured: string | undefined): Promise<boolean> {
  if (candidate.length === 0 || typeof configured !== "string" || configured.length < MIN_PASSWORD_LENGTH) return false;
  const [candidateDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  return constantWorkEqual(new Uint8Array(configuredDigest), new Uint8Array(candidateDigest));
}
