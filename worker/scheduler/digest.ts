import { pushDigest } from "../line/client";

export interface DigestEnv {
  DB: D1Database;
  LINE_PUSH_ENABLED: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  OWNER_USER_ID: string;
  AUTOMATED_MONTHLY_PUSH_CAP: string;
  DASHBOARD_URL: string;
  APP_TIMEZONE: string;
}

interface DigestAlert {
  id: number;
  group_title: string;
  severity: string;
  excerpt: string;
  created_at: number;
}

interface DigestReport {
  id: number;
  group_title: string;
  category_name: string | null;
  summary: string;
  action_items_json: string;
  priority_score: number;
  created_at: number;
}

interface DigestSelection {
  text: string;
  alertIds: number[];
  reportIds: number[];
}

interface RetryableDelivery {
  id: number;
  retry_key: string;
  message_text: string;
  alert_ids_json: string;
  report_ids_json: string;
  quota_day: string | null;
  quota_month: string | null;
}

const LINE_TEXT_LIMIT = 5_000;
const DIGEST_TEXT_LIMIT = 4_950;

export function localDateTimeParts(now: number, timeZone = "Asia/Bangkok") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  return {
    day,
    month: day.slice(0, 7),
    weekday: value("weekday"),
    hour: Number.parseInt(value("hour"), 10),
    minute: Number.parseInt(value("minute"), 10),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function compact(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function renderDigest(alerts: DigestAlert[], reports: DigestReport[], dashboardUrl: string): string {
  const lines = ["สรุปเลขากลุ่ม"];
  if (alerts.length > 0) {
    lines.push("", "🚨 เรื่องเร่งด่วน");
    for (const alert of alerts) {
      lines.push(
        `• [${alert.severity.toUpperCase()}] ${compact(alert.group_title, 100)}: ${compact(alert.excerpt, 240)}`,
      );
    }
  }

  const actionReports = reports.filter((report) => parseStringArray(report.action_items_json).length > 0);
  if (actionReports.length > 0) {
    lines.push("", "✅ งานที่ต้องทำ");
    for (const report of actionReports) {
      const actions = parseStringArray(report.action_items_json);
      for (const action of actions.slice(0, 3)) {
        lines.push(`• ${compact(report.group_title, 100)}: ${compact(action, 220)}`);
      }
      if (actions.length > 3) lines.push(`  …และอีก ${actions.length - 3} งาน ดูต่อบนเว็บ`);
    }
  }

  if (reports.length > 0) {
    lines.push("", "📂 สรุปตามหมวด");
    for (const report of reports) {
      lines.push(
        `• ${compact(report.category_name ?? "ยังไม่จัดหมวด", 60)} — ${compact(report.group_title, 100)}: ${compact(report.summary, 420)}`,
      );
    }
  }

  return `${lines.join("\n")}\nดูรายละเอียดทั้งหมด: ${compact(dashboardUrl, 500)}`;
}

function selectDigestContent(alerts: DigestAlert[], reports: DigestReport[], dashboardUrl: string): DigestSelection {
  const selectedAlerts: DigestAlert[] = [];
  const selectedReports: DigestReport[] = [];
  for (const alert of alerts) {
    const candidate = renderDigest([...selectedAlerts, alert], selectedReports, dashboardUrl);
    if (candidate.length > DIGEST_TEXT_LIMIT) break;
    selectedAlerts.push(alert);
  }
  for (const report of reports) {
    const candidate = renderDigest(selectedAlerts, [...selectedReports, report], dashboardUrl);
    if (candidate.length > DIGEST_TEXT_LIMIT) break;
    selectedReports.push(report);
  }
  const text = renderDigest(selectedAlerts, selectedReports, dashboardUrl);
  if (text.length > LINE_TEXT_LIMIT) throw new Error("Digest formatter exceeded the LINE text limit");
  return {
    text,
    alertIds: selectedAlerts.map((item) => item.id),
    reportIds: selectedReports.map((item) => item.id),
  };
}

async function loadDigestContent(db: D1Database, cutoff: number) {
  const [alerts, reports] = await Promise.all([
    db
      .prepare(
        `SELECT a.id,g.title AS group_title,a.severity,a.excerpt,a.created_at
         FROM alerts a JOIN groups g ON g.source_id=a.group_id
         WHERE g.data_mode='real' AND a.notified_at IS NULL AND a.digest_finalized_at IS NULL
         AND a.status='open' AND a.created_at<=?
         ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         a.created_at,a.id LIMIT 50`,
      )
      .bind(cutoff)
      .all<DigestAlert>(),
    db
      .prepare(
        `SELECT r.id,g.title AS group_title,c.name AS category_name,r.summary,r.action_items_json,
         r.priority_score,r.created_at
         FROM reports r JOIN groups g ON g.source_id=r.group_id
         LEFT JOIN categories c ON c.id=g.category_id
         WHERE g.data_mode='real' AND r.notified_at IS NULL AND r.digest_finalized_at IS NULL AND r.created_at<=?
         ORDER BY r.priority_score DESC,r.created_at,r.id LIMIT 100`,
      )
      .bind(cutoff)
      .all<DigestReport>(),
  ]);
  return { alerts: alerts.results, reports: reports.results };
}

// D1 allows at most 100 bound parameters per statement; chunk id lists safely below.
const MAX_IDS_PER_STATEMENT = 90;

function setColumnByIds(
  db: D1Database,
  table: "alerts" | "reports",
  column: "notified_at" | "digest_finalized_at",
  ids: number[],
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < ids.length; index += MAX_IDS_PER_STATEMENT) {
    const slice = ids.slice(index, index + MAX_IDS_PER_STATEMENT);
    statements.push(
      db
        .prepare(`UPDATE ${table} SET ${column}=? WHERE id IN (${slice.map(() => "?").join(",")})`)
        .bind(now, ...slice),
    );
  }
  return statements;
}

const PUSH_RETRY_DELAYS_MS = [2_000, 5_000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runDigest(
  env: DigestEnv,
  scheduledTime: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<{ status: string; deliveryId?: number }> {
  if (env.LINE_PUSH_ENABLED !== "true") return { status: "disabled" };

  const local = localDateTimeParts(scheduledTime, env.APP_TIMEZONE);
  const retryable = await env.DB.prepare(
    `SELECT id,retry_key,message_text,alert_ids_json,report_ids_json,quota_day,quota_month
     FROM digest_deliveries
     WHERE created_at>=? AND message_text IS NOT NULL
       AND ((status='failed' AND (
         error='network_error' OR error IN ('line_status_408','line_status_429') OR error GLOB 'line_status_5??'
       )) OR (status='pending' AND COALESCE(attempted_at,created_at)<=?))
     ORDER BY created_at,id LIMIT 1`,
  )
    .bind(scheduledTime - 24 * 60 * 60_000, scheduledTime - 60_000)
    .first<RetryableDelivery>();
  const [dailyCount, monthlyCount] = await Promise.all([
    env.DB
      .prepare("SELECT count(*) AS count FROM digest_deliveries WHERE quota_day=? AND status IN ('pending','sent')")
      .bind(local.day)
      .first<number>("count"),
    env.DB
      .prepare("SELECT count(*) AS count FROM digest_deliveries WHERE quota_month=? AND status IN ('pending','sent')")
      .bind(local.month)
      .first<number>("count"),
  ]);
  const monthlyCap = Number.parseInt(env.AUTOMATED_MONTHLY_PUSH_CAP, 10) || 280;
  const ownsDailyReservation = retryable?.quota_day === local.day;
  const ownsMonthlyReservation = retryable?.quota_month === local.month;
  if ((dailyCount ?? 0) >= 10 && !ownsDailyReservation) return { status: "daily_cap" };
  if ((monthlyCount ?? 0) >= monthlyCap && !ownsMonthlyReservation) return { status: "monthly_cap" };

  let deliveryId: number;
  let retryKey: string;
  let text: string;
  let alertIds: number[];
  let reportIds: number[];
  if (retryable) {
    const retryReservation = await env.DB.prepare(
      `UPDATE digest_deliveries
       SET status='pending',error=NULL,quota_day=?,quota_month=?,attempted_at=?
       WHERE id=? AND created_at>=?
         AND ((status='failed' AND (
           error='network_error' OR error IN ('line_status_408','line_status_429') OR error GLOB 'line_status_5??'
         )) OR (status='pending' AND COALESCE(attempted_at,created_at)<=?))
         AND (quota_day=? OR (
           SELECT count(*) FROM digest_deliveries WHERE quota_day=? AND status IN ('pending','sent')
         )<10)
         AND (quota_month=? OR (
           SELECT count(*) FROM digest_deliveries WHERE quota_month=? AND status IN ('pending','sent')
         )<?)`,
    )
      .bind(
        local.day,
        local.month,
        scheduledTime,
        retryable.id,
        scheduledTime - 24 * 60 * 60_000,
        scheduledTime - 60_000,
        local.day,
        local.day,
        local.month,
        local.month,
        monthlyCap,
      )
      .run();
    if (retryReservation.meta.changes !== 1) return { status: "duplicate" };
    deliveryId = retryable.id;
    retryKey = retryable.retry_key;
    text = retryable.message_text;
    alertIds = parseNumberArray(retryable.alert_ids_json);
    reportIds = parseNumberArray(retryable.report_ids_json);
  } else {
    const content = await loadDigestContent(env.DB, scheduledTime);
    if (content.alerts.length === 0 && content.reports.length === 0) return { status: "empty" };
    const selection = selectDigestContent(content.alerts, content.reports, env.DASHBOARD_URL);
    if (selection.alertIds.length === 0 && selection.reportIds.length === 0) return { status: "empty" };

    const slotKey = `${local.day}-${String(local.hour).padStart(2, "0")}`;
    retryKey = crypto.randomUUID();
    text = selection.text;
    alertIds = selection.alertIds;
    reportIds = selection.reportIds;
    const includedAlerts = new Set(alertIds);
    const includedReports = new Set(reportIds);
    const times = [
      ...content.alerts.filter((item) => includedAlerts.has(item.id)).map((item) => item.created_at),
      ...content.reports.filter((item) => includedReports.has(item.id)).map((item) => item.created_at),
    ];
    const reservation = await env.DB.prepare(
      `INSERT INTO digest_deliveries(slot_key,retry_key,period_start,period_end,status,message_count,created_at,
       message_text,alert_ids_json,report_ids_json,quota_day,quota_month,attempted_at)
       SELECT ?,?,?,?,'pending',?,?,?,?,?,?,?,?
       WHERE (SELECT count(*) FROM digest_deliveries WHERE quota_day=? AND status IN ('pending','sent'))<10
         AND (SELECT count(*) FROM digest_deliveries WHERE quota_month=? AND status IN ('pending','sent'))<?
       ON CONFLICT(slot_key) DO NOTHING`,
    )
      .bind(
        slotKey,
        retryKey,
        Math.min(...times),
        Math.max(...times),
        1,
        scheduledTime,
        text,
        JSON.stringify(alertIds),
        JSON.stringify(reportIds),
        local.day,
        local.month,
        scheduledTime,
        local.day,
        local.month,
        monthlyCap,
      )
      .run();
    if (reservation.meta.changes !== 1) {
      const existing = await env.DB.prepare("SELECT id FROM digest_deliveries WHERE slot_key=?")
        .bind(slotKey)
        .first<number>("id");
      if (existing !== null) return { status: "duplicate" };
      const latestDailyCount = await env.DB
        .prepare("SELECT count(*) AS count FROM digest_deliveries WHERE quota_day=? AND status IN ('pending','sent')")
        .bind(local.day)
        .first<number>("count");
      return { status: (latestDailyCount ?? 0) >= 10 ? "daily_cap" : "monthly_cap" };
    }
    deliveryId =
      (await env.DB.prepare("SELECT id FROM digest_deliveries WHERE slot_key=?").bind(slotKey).first<number>("id")) ?? 0;
  }

  let lastStatus = 0;
  let requestId: string | null = null;
  let accepted = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Back off between attempts so a LINE 429/5xx is not hammered three times in a row.
    if (attempt > 0) await sleep(PUSH_RETRY_DELAYS_MS[attempt - 1] ?? 5_000);
    try {
      const result = await pushDigest(env.OWNER_USER_ID, text, retryKey, env.LINE_CHANNEL_ACCESS_TOKEN);
      lastStatus = result.status;
      requestId = result.requestId;
      if (result.ok || result.status === 409) {
        accepted = true;
        break;
      }
      if (result.status !== 429 && result.status < 500) break;
    } catch {
      lastStatus = 0;
    }
  }

  if (!accepted) {
    const retryableFailure = lastStatus === 0 || lastStatus === 408 || lastStatus === 429 || lastStatus >= 500;
    const failureStatements: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE digest_deliveries SET status='failed',error=?,quota_day=NULL,quota_month=NULL WHERE id=?",
      )
        .bind(lastStatus === 0 ? "network_error" : `line_status_${lastStatus}`, deliveryId),
    ];
    if (!retryableFailure) {
      failureStatements.push(
        ...setColumnByIds(env.DB, "alerts", "digest_finalized_at", alertIds, scheduledTime),
        ...setColumnByIds(env.DB, "reports", "digest_finalized_at", reportIds, scheduledTime),
      );
    }
    await env.DB.batch(failureStatements);
    return { status: "failed", deliveryId };
  }

  const notifiedAt = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE digest_deliveries SET status='sent',line_request_id=?,sent_at=?,error=NULL,message_text=NULL WHERE id=?",
    )
      .bind(requestId, notifiedAt, deliveryId),
    env.DB.prepare(
      `INSERT INTO usage_daily(day,ai_calls,ai_input_tokens,ai_output_tokens,line_pushes,updated_at)
       VALUES(?,0,0,0,1,?) ON CONFLICT(day) DO UPDATE SET
       line_pushes=usage_daily.line_pushes+1,updated_at=excluded.updated_at`,
    ).bind(local.day, notifiedAt),
  ];
  statements.push(
    ...setColumnByIds(env.DB, "alerts", "notified_at", alertIds, notifiedAt),
    ...setColumnByIds(env.DB, "reports", "notified_at", reportIds, notifiedAt),
  );
  await env.DB.batch(statements);
  return { status: "sent", deliveryId };
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number" && Number.isInteger(item))
      : [];
  } catch {
    return [];
  }
}
