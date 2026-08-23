const encoder = new TextEncoder();
const WINDOW_MS = 15 * 60 * 1_000;

export async function hashLoginIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(ip)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface AttemptRow {
  window_start: number;
  attempts: number;
  blocked_until: number | null;
}

export async function isLoginBlocked(db: D1Database, ipHash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT window_start, attempts, blocked_until FROM auth_attempts WHERE ip_hash = ?")
    .bind(ipHash)
    .first<AttemptRow>();
  return row?.blocked_until !== null && row?.blocked_until !== undefined && row.blocked_until > now;
}

export async function recordLoginFailure(db: D1Database, ipHash: string, now: number): Promise<void> {
  const row = await db
    .prepare("SELECT window_start, attempts, blocked_until FROM auth_attempts WHERE ip_hash = ?")
    .bind(ipHash)
    .first<AttemptRow>();
  const inWindow = row !== null && now - row.window_start < WINDOW_MS;
  const attempts = inWindow ? row.attempts + 1 : 1;
  const windowStart = inWindow ? row.window_start : now;
  const blockedUntil = attempts >= 5 ? now + WINDOW_MS : null;

  await db
    .prepare(
      `INSERT INTO auth_attempts(ip_hash,window_start,attempts,blocked_until) VALUES(?,?,?,?)
       ON CONFLICT(ip_hash) DO UPDATE SET
         window_start=excluded.window_start,
         attempts=excluded.attempts,
         blocked_until=excluded.blocked_until`,
    )
    .bind(ipHash, windowStart, attempts, blockedUntil)
    .run();
}

export function clearLoginFailures(db: D1Database, ipHash: string): Promise<D1Result> {
  return db.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).run();
}
