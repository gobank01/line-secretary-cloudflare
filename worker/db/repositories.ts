import type { NewGroup, NewMessage } from "./types";

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
