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

export async function recordLoginFailure(
  db: D1Database,
  ipHash: string,
  now: number,
): Promise<{ attempts: number; blockedUntil: number | null }> {
  const row = await db
    .prepare(
      `INSERT INTO auth_attempts(ip_hash,window_start,attempts,blocked_until) VALUES(?,?,1,NULL)
       ON CONFLICT(ip_hash) DO UPDATE SET
         window_start=CASE
           WHEN excluded.window_start-auth_attempts.window_start>=? THEN excluded.window_start
           ELSE auth_attempts.window_start END,
         attempts=CASE
           WHEN excluded.window_start-auth_attempts.window_start>=? THEN 1
           ELSE auth_attempts.attempts+1 END,
         blocked_until=CASE
           WHEN excluded.window_start-auth_attempts.window_start>=? THEN NULL
           WHEN auth_attempts.attempts+1>=5 THEN excluded.window_start+?
           ELSE auth_attempts.blocked_until END
       RETURNING attempts,blocked_until`,
    )
    .bind(ipHash, now, WINDOW_MS, WINDOW_MS, WINDOW_MS, WINDOW_MS)
    .first<{ attempts: number; blocked_until: number | null }>();
  if (!row) throw new Error("Failed to record login attempt");
  return { attempts: row.attempts, blockedUntil: row.blocked_until };
}

export function clearLoginFailures(db: D1Database, ipHash: string): Promise<D1Result> {
  return db.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).run();
}
