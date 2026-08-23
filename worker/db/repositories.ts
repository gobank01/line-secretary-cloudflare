import type { GroupRecord, NewGroup, NewMessage, RegisteredGroup } from "./types";

export async function countActiveRealGroups(db: D1Database): Promise<number> {
  return (
    (await db
      .prepare("SELECT count(*) AS count FROM groups WHERE data_mode = 'real' AND active = 1")
      .first<number>("count")) ?? 0
  );
}

export function upsertGroup(db: D1Database, group: NewGroup): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO groups(source_id, title, data_mode, active, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at`,
    )
    .bind(group.sourceId, group.title, group.dataMode, group.active ? 1 : 0, group.now, group.now)
    .run();
}

export function insertMessage(db: D1Database, message: NewMessage): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO messages(
         line_message_id, group_id, user_id, kind, text,
         sent_at, ingested_at, retention_expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_message_id) DO NOTHING`,
    )
    .bind(
      message.lineMessageId,
      message.groupId,
      message.userId,
      message.kind,
      message.text,
      message.sentAt,
      message.ingestedAt,
      message.retentionExpiresAt,
    )
    .run();
}

export async function findGroup(db: D1Database, sourceId: string): Promise<GroupRecord | null> {
  const row = await db
    .prepare(
      `SELECT source_id, title, active, disclosure_sent_at
       FROM groups WHERE source_id = ? AND data_mode = 'real'`,
    )
    .bind(sourceId)
    .first<{ source_id: string; title: string; active: number; disclosure_sent_at: number | null }>();
  if (!row) return null;
  return {
    sourceId: row.source_id,
    title: row.title,
    active: row.active === 1,
    disclosureSentAt: row.disclosure_sent_at,
  };
}

function fallbackGroupTitle(sourceId: string): string {
  return `กลุ่ม LINE • ${sourceId.slice(-6)}`;
}

export async function registerRealGroup(
  db: D1Database,
  sourceId: string,
  now: number,
  activeLimit: number,
): Promise<RegisteredGroup> {
  const existing = await findGroup(db, sourceId);
  if (existing) return { ...existing, created: false };

  const active = (await countActiveRealGroups(db)) < activeLimit;
  const title = fallbackGroupTitle(sourceId);
  const insertion = await db
    .prepare(
      `INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at)
       VALUES(?,?,'real',?,?,?) ON CONFLICT(source_id) DO NOTHING`,
    )
    .bind(sourceId, title, active ? 1 : 0, now, now)
    .run();

  const group = await findGroup(db, sourceId);
  if (!group) throw new Error("Failed to register LINE group");

  if (insertion.meta.changes === 1 && !group.active) {
    await db
      .prepare(
        `INSERT INTO alerts(group_id,message_id,kind,severity,status,excerpt,created_at)
         VALUES(?,NULL,'real_group_limit','high','open',?,?)`,
      )
      .bind(sourceId, `พักกลุ่มใหม่อัตโนมัติ เนื่องจากครบโควตา ${activeLimit} กลุ่มจริง`, now)
      .run();
  }
  return { ...group, created: insertion.meta.changes === 1 };
}

export function recordGroupJoin(db: D1Database, sourceId: string, now: number): Promise<D1Result> {
  return db
    .prepare("UPDATE groups SET joined_at = COALESCE(joined_at, ?), left_at = NULL, updated_at = ? WHERE source_id = ?")
    .bind(now, now, sourceId)
    .run();
}

export function markGroupLeft(db: D1Database, sourceId: string, now: number): Promise<D1Result> {
  return db
    .prepare("UPDATE groups SET active = 0, left_at = ?, updated_at = ? WHERE source_id = ? AND data_mode = 'real'")
    .bind(now, now, sourceId)
    .run();
}

export function markDisclosureSent(db: D1Database, sourceId: string, now: number): Promise<D1Result> {
  return db
    .prepare("UPDATE groups SET disclosure_sent_at = ?, updated_at = ? WHERE source_id = ? AND disclosure_sent_at IS NULL")
    .bind(now, now, sourceId)
    .run();
}

export function updateGroupTitle(db: D1Database, sourceId: string, title: string, now: number): Promise<D1Result> {
  return db
    .prepare("UPDATE groups SET title = ?, updated_at = ? WHERE source_id = ? AND data_mode = 'real'")
    .bind(title, now, sourceId)
    .run();
}

export async function getAlertWords(db: D1Database): Promise<string[]> {
  const value = await db.prepare("SELECT value_json FROM settings WHERE key = 'alert_words'").first<string>("value_json");
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function insertKeywordAlert(
  db: D1Database,
  lineMessageId: string,
  groupId: string,
  excerpt: string,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO alerts(group_id,message_id,kind,severity,status,excerpt,created_at)
       SELECT ?,id,'keyword','high','open',?,? FROM messages WHERE line_message_id = ?
       ON CONFLICT(kind,message_id) DO NOTHING`,
    )
    .bind(groupId, excerpt, now, lineMessageId)
    .run();
}

export function updateGroupLastMessage(db: D1Database, sourceId: string, sentAt: number): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE groups SET last_message_at = CASE
         WHEN last_message_at IS NULL OR last_message_at < ? THEN ? ELSE last_message_at END,
       updated_at = ? WHERE source_id = ?`,
    )
    .bind(sentAt, sentAt, sentAt, sourceId)
    .run();
}
