import type {
  ActionQueueItemDto,
  CategorySummaryDto,
  DashboardHealthDto,
  DataMode,
  GroupRecord,
  GroupSummaryDto,
  NewGroup,
  NewMessage,
  RegisteredGroup,
} from "./types";

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

interface GroupSummaryRow {
  source_id: string;
  title: string;
  data_mode: DataMode;
  active: number;
  priority_score: number;
  last_message_at: number | null;
  last_summary_at: number | null;
  needs_category_review: number;
  category_id: number | null;
  category_slug: string | null;
  category_name: string | null;
  category_color: string | null;
  report_summary: string | null;
  action_items_json: string | null;
  unresolved_json: string | null;
  open_alerts: number;
}

function stringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function groupSummaryFrom(row: GroupSummaryRow): GroupSummaryDto {
  return {
    id: row.source_id,
    title: row.title,
    dataMode: row.data_mode,
    active: row.active === 1,
    priorityScore: row.priority_score,
    lastMessageAt: row.last_message_at,
    lastSummaryAt: row.last_summary_at,
    needsCategoryReview: row.needs_category_review === 1,
    category:
      row.category_id === null || row.category_slug === null || row.category_name === null || row.category_color === null
        ? null
        : {
            id: row.category_id,
            slug: row.category_slug,
            name: row.category_name,
            color: row.category_color,
          },
    latestSummary: row.report_summary,
    actionItems: stringArray(row.action_items_json),
    unresolvedQuestions: stringArray(row.unresolved_json),
    openAlerts: row.open_alerts,
  };
}

export async function listGroupSummaries(
  db: D1Database,
  options: { mode: DataMode; limit: number; offset: number; category?: string },
): Promise<{ groups: GroupSummaryDto[]; nextOffset: number | null }> {
  const conditions = ["g.data_mode = ?"];
  const bindings: Array<string | number> = [options.mode];
  if (options.category) {
    conditions.push("c.slug = ?");
    bindings.push(options.category);
  }
  bindings.push(options.limit + 1, options.offset);

  const result = await db
    .prepare(
      `SELECT g.source_id,g.title,g.data_mode,g.active,g.priority_score,g.last_message_at,g.last_summary_at,
        g.needs_category_review,c.id AS category_id,c.slug AS category_slug,c.name AS category_name,
        c.color AS category_color,r.summary AS report_summary,r.action_items_json,r.unresolved_json,
        (SELECT count(*) FROM alerts a WHERE a.group_id=g.source_id AND a.status='open') AS open_alerts
       FROM groups g
       LEFT JOIN categories c ON c.id=g.category_id
       LEFT JOIN reports r ON r.id=(SELECT id FROM reports WHERE group_id=g.source_id ORDER BY created_at DESC LIMIT 1)
       WHERE ${conditions.join(" AND ")}
       ORDER BY g.priority_score DESC,COALESCE(g.last_message_at,0) DESC,g.source_id
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<GroupSummaryRow>();
  const hasMore = result.results.length > options.limit;
  const groups = result.results.slice(0, options.limit).map(groupSummaryFrom);
  return { groups, nextOffset: hasMore ? options.offset + options.limit : null };
}

export async function getDashboardKpis(
  db: D1Database,
  mode: DataMode,
): Promise<{ totalGroups: number; urgent: number; waiting: number; active: number; normal: number }> {
  const row = await db
    .prepare(
      `SELECT count(*) AS total,
        COALESCE(sum(CASE WHEN priority_score>=80 THEN 1 ELSE 0 END),0) AS urgent,
        COALESCE(sum(CASE WHEN priority_score>=60 AND priority_score<80 THEN 1 ELSE 0 END),0) AS waiting,
        COALESCE(sum(CASE WHEN priority_score>=30 AND priority_score<60 THEN 1 ELSE 0 END),0) AS active,
        COALESCE(sum(CASE WHEN priority_score<30 THEN 1 ELSE 0 END),0) AS normal
       FROM groups WHERE data_mode=?`,
    )
    .bind(mode)
    .first<{ total: number; urgent: number; waiting: number; active: number; normal: number }>();
  return {
    totalGroups: row?.total ?? 0,
    urgent: row?.urgent ?? 0,
    waiting: row?.waiting ?? 0,
    active: row?.active ?? 0,
    normal: row?.normal ?? 0,
  };
}

export async function listCategorySummaries(db: D1Database, mode: DataMode): Promise<CategorySummaryDto[]> {
  const result = await db
    .prepare(
      `SELECT c.id,c.slug,c.name,c.color,count(g.source_id) AS group_count,
        COALESCE(sum(CASE WHEN g.priority_score>=80 THEN 1 ELSE 0 END),0) AS urgent_count,
        COALESCE(sum(CASE WHEN g.priority_score>=60 OR EXISTS(
          SELECT 1 FROM alerts a WHERE a.group_id=g.source_id AND a.status='open'
        ) THEN 1 ELSE 0 END),0) AS open_action_count
       FROM categories c
       LEFT JOIN groups g ON g.category_id=c.id AND g.data_mode=?
       WHERE c.active=1 GROUP BY c.id,c.slug,c.name,c.color,c.sort_order ORDER BY c.sort_order,c.id`,
    )
    .bind(mode)
    .all<{
      id: number;
      slug: string;
      name: string;
      color: string;
      group_count: number;
      urgent_count: number;
      open_action_count: number;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    groupCount: row.group_count,
    urgentCount: row.urgent_count,
    openActionCount: row.open_action_count,
  }));
}

export function actionQueueFrom(groups: GroupSummaryDto[]): ActionQueueItemDto[] {
  return groups
    .filter(
      (group) =>
        group.priorityScore >= 60 ||
        group.openAlerts > 0 ||
        group.actionItems.length > 0 ||
        group.unresolvedQuestions.length > 0,
    )
    .slice(0, 50)
    .map((group) => ({
      groupId: group.id,
      title: group.title,
      priorityScore: group.priorityScore,
      categoryName: group.category?.name ?? null,
      categoryColor: group.category?.color ?? null,
      summary: group.latestSummary,
      actionItems: group.actionItems,
      unresolvedQuestions: group.unresolvedQuestions,
      openAlerts: group.openAlerts,
      lastActivityAt: group.lastMessageAt,
    }));
}

export async function getGroupDetail(db: D1Database, sourceId: string) {
  const row = await db
    .prepare(
      `SELECT g.source_id,g.title,g.data_mode,g.active,g.priority_score,g.last_message_at,g.last_summary_at,
        g.needs_category_review,c.id AS category_id,c.slug AS category_slug,c.name AS category_name,
        c.color AS category_color,NULL AS report_summary,NULL AS action_items_json,NULL AS unresolved_json,
        (SELECT count(*) FROM alerts a WHERE a.group_id=g.source_id AND a.status='open') AS open_alerts,
        (SELECT count(*) FROM messages m WHERE m.group_id=g.source_id) AS message_count
       FROM groups g LEFT JOIN categories c ON c.id=g.category_id WHERE g.source_id=?`,
    )
    .bind(sourceId)
    .first<GroupSummaryRow & { message_count: number }>();
  if (!row) return null;

  const [reports, alerts] = await Promise.all([
    db
      .prepare(
        `SELECT id,period_start,period_end,summary,action_items_json,unresolved_json,priority_score,created_at
         FROM reports WHERE group_id=? ORDER BY created_at DESC LIMIT 30`,
      )
      .bind(sourceId)
      .all<{
        id: number;
        period_start: number;
        period_end: number;
        summary: string;
        action_items_json: string;
        unresolved_json: string;
        priority_score: number;
        created_at: number;
      }>(),
    db
      .prepare(
        `SELECT id,kind,severity,status,excerpt,created_at,acknowledged_at,resolved_at
         FROM alerts WHERE group_id=? ORDER BY created_at DESC LIMIT 50`,
      )
      .bind(sourceId)
      .all<{
        id: number;
        kind: string;
        severity: string;
        status: string;
        excerpt: string;
        created_at: number;
        acknowledged_at: number | null;
        resolved_at: number | null;
      }>(),
  ]);

  return {
    group: groupSummaryFrom(row),
    messageCount: row.message_count,
    reports: reports.results.map((report) => ({
      id: report.id,
      periodStart: report.period_start,
      periodEnd: report.period_end,
      summary: report.summary,
      actionItems: stringArray(report.action_items_json),
      unresolvedQuestions: stringArray(report.unresolved_json),
      priorityScore: report.priority_score,
      createdAt: report.created_at,
    })),
    alerts: alerts.results.map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      status: alert.status,
      excerpt: alert.excerpt,
      createdAt: alert.created_at,
      acknowledgedAt: alert.acknowledged_at,
      resolvedAt: alert.resolved_at,
    })),
  };
}

export async function listAlerts(db: D1Database, updatedAfter: number, limit: number) {
  const result = await db
    .prepare(
      `SELECT a.id,a.group_id,g.title AS group_title,a.kind,a.severity,a.status,a.excerpt,a.created_at,
        a.acknowledged_at,a.resolved_at
       FROM alerts a JOIN groups g ON g.source_id=a.group_id
       WHERE a.created_at>? ORDER BY a.created_at,a.id LIMIT ?`,
    )
    .bind(updatedAfter, limit)
    .all<{
      id: number;
      group_id: string;
      group_title: string;
      kind: string;
      severity: string;
      status: string;
      excerpt: string;
      created_at: number;
      acknowledged_at: number | null;
      resolved_at: number | null;
    }>();
  return result.results.map((alert) => ({
    id: alert.id,
    groupId: alert.group_id,
    groupTitle: alert.group_title,
    kind: alert.kind,
    severity: alert.severity,
    status: alert.status,
    excerpt: alert.excerpt,
    createdAt: alert.created_at,
    acknowledgedAt: alert.acknowledged_at,
    resolvedAt: alert.resolved_at,
  }));
}

function localDateParts(now: number, timeZone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  return { day, month: day.slice(0, 7) };
}

export async function getSystemHealth(
  db: D1Database,
  now: number,
  timeZone: string,
): Promise<DashboardHealthDto> {
  const date = localDateParts(now, timeZone);
  const [backlog, today, month] = await Promise.all([
    db
      .prepare(
        `SELECT count(DISTINCT g.source_id) AS count FROM groups g JOIN messages m ON m.group_id=g.source_id
         WHERE g.data_mode='real' AND g.active=1 AND m.processed_at IS NULL`,
      )
      .first<number>("count"),
    db
      .prepare("SELECT ai_calls,ai_input_tokens FROM usage_daily WHERE day=?")
      .bind(date.day)
      .first<{ ai_calls: number; ai_input_tokens: number }>(),
    db
      .prepare("SELECT COALESCE(sum(line_pushes),0) AS pushes FROM usage_daily WHERE day LIKE ?")
      .bind(`${date.month}%`)
      .first<number>("pushes"),
  ]);
  return {
    backlogGroups: backlog ?? 0,
    aiCallsToday: today?.ai_calls ?? 0,
    aiInputTokensToday: today?.ai_input_tokens ?? 0,
    linePushesMonth: month ?? 0,
    warnings: [],
  };
}
