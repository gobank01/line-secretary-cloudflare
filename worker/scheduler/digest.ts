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

function formatDigest(alerts: DigestAlert[], reports: DigestReport[], dashboardUrl: string): string {
  const footer = `\nดูรายละเอียดทั้งหมด: ${dashboardUrl}`;
  const lines = ["สรุปเลขากลุ่ม"];
  let length = lines[0].length + footer.length;
  const append = (line: string) => {
    if (length + line.length + 1 > 4_950) return false;
    lines.push(line);
    length += line.length + 1;
    return true;
  };

  if (alerts.length > 0) {
    append("");
    append("🚨 เรื่องเร่งด่วน");
    for (const alert of alerts) {
      if (!append(`• [${alert.severity.toUpperCase()}] ${alert.group_title}: ${alert.excerpt}`)) break;
    }
  }

  const actionReports = reports.filter((report) => parseStringArray(report.action_items_json).length > 0);
  if (actionReports.length > 0) {
    append("");
    append("✅ งานที่ต้องทำ");
    for (const report of actionReports) {
      for (const action of parseStringArray(report.action_items_json)) {
        if (!append(`• ${report.group_title}: ${action}`)) break;
      }
    }
  }

  if (reports.length > 0) {
    append("");
    append("📂 สรุปตามหมวด");
    for (const report of reports) {
      if (!append(`• ${report.category_name ?? "ยังไม่จัดหมวด"} — ${report.group_title}: ${report.summary}`)) break;
    }
  }

  return `${lines.join("\n")}${footer}`.slice(0, 5_000);
}

async function loadDigestContent(db: D1Database) {
  const [alerts, reports] = await Promise.all([
    db
      .prepare(
        `SELECT a.id,g.title AS group_title,a.severity,a.excerpt,a.created_at
         FROM alerts a JOIN groups g ON g.source_id=a.group_id
         WHERE g.data_mode='real' AND a.notified_at IS NULL AND a.status='open'
         ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         a.created_at,a.id LIMIT 50`,
      )
      .all<DigestAlert>(),
    db
      .prepare(
        `SELECT r.id,g.title AS group_title,c.name AS category_name,r.summary,r.action_items_json,
         r.priority_score,r.created_at
         FROM reports r JOIN groups g ON g.source_id=r.group_id
         LEFT JOIN categories c ON c.id=g.category_id
         WHERE g.data_mode='real' AND r.notified_at IS NULL
         ORDER BY r.priority_score DESC,r.created_at,r.id LIMIT 100`,
      )
      .all<DigestReport>(),
  ]);
  return { alerts: alerts.results, reports: reports.results };
}

function updateIds(db: D1Database, table: "alerts" | "reports", ids: number[], now: number): D1PreparedStatement | null {
  if (ids.length === 0) return null;
  return db
    .prepare(`UPDATE ${table} SET notified_at=? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(now, ...ids);
}

export async function runDigest(env: DigestEnv, scheduledTime: number): Promise<{ status: string; deliveryId?: number }> {
  if (env.LINE_PUSH_ENABLED !== "true") return { status: "disabled" };

  const content = await loadDigestContent(env.DB);
  if (content.alerts.length === 0 && content.reports.length === 0) return { status: "empty" };

  const local = localDateTimeParts(scheduledTime, env.APP_TIMEZONE);
  const [dailyCount, monthlyCount] = await Promise.all([
    env.DB
      .prepare("SELECT count(*) AS count FROM digest_deliveries WHERE slot_key LIKE ? AND status IN ('pending','sent')")
      .bind(`${local.day}-%`)
      .first<number>("count"),
    env.DB
      .prepare("SELECT count(*) AS count FROM digest_deliveries WHERE slot_key LIKE ? AND status IN ('pending','sent')")
      .bind(`${local.month}-%`)
      .first<number>("count"),
  ]);
  if ((dailyCount ?? 0) >= 10) return { status: "daily_cap" };
  const monthlyCap = Number.parseInt(env.AUTOMATED_MONTHLY_PUSH_CAP, 10) || 280;
  if ((monthlyCount ?? 0) >= monthlyCap) return { status: "monthly_cap" };

  const slotKey = `${local.day}-${String(local.hour).padStart(2, "0")}`;
  const retryKey = crypto.randomUUID();
  const createdAt = Date.now();
  const times = [...content.alerts.map((item) => item.created_at), ...content.reports.map((item) => item.created_at)];
  const reservation = await env.DB.prepare(
    `INSERT INTO digest_deliveries(slot_key,retry_key,period_start,period_end,status,message_count,created_at)
     VALUES(?,?,?,?,'pending',?,?) ON CONFLICT(slot_key) DO NOTHING`,
  )
    .bind(slotKey, retryKey, Math.min(...times), Math.max(...times), 1, createdAt)
    .run();
  if (reservation.meta.changes !== 1) return { status: "duplicate" };
  const deliveryId =
    (await env.DB.prepare("SELECT id FROM digest_deliveries WHERE slot_key=?").bind(slotKey).first<number>("id")) ?? 0;
  const text = formatDigest(content.alerts, content.reports, env.DASHBOARD_URL);

  let lastStatus = 0;
  let requestId: string | null = null;
  let accepted = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
    await env.DB.prepare("UPDATE digest_deliveries SET status='failed',error=? WHERE id=?")
      .bind(lastStatus === 0 ? "network_error" : `line_status_${lastStatus}`, deliveryId)
      .run();
    return { status: "failed", deliveryId };
  }

  const notifiedAt = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE digest_deliveries SET status='sent',line_request_id=?,sent_at=?,error=NULL WHERE id=?")
      .bind(requestId, notifiedAt, deliveryId),
    env.DB.prepare(
      `INSERT INTO usage_daily(day,ai_calls,ai_input_tokens,ai_output_tokens,line_pushes,updated_at)
       VALUES(?,0,0,0,1,?) ON CONFLICT(day) DO UPDATE SET
       line_pushes=usage_daily.line_pushes+1,updated_at=excluded.updated_at`,
    ).bind(local.day, notifiedAt),
  ];
  const alertUpdate = updateIds(env.DB, "alerts", content.alerts.map((item) => item.id), notifiedAt);
  const reportUpdate = updateIds(env.DB, "reports", content.reports.map((item) => item.id), notifiedAt);
  if (alertUpdate) statements.push(alertUpdate);
  if (reportUpdate) statements.push(reportUpdate);
  await env.DB.batch(statements);
  return { status: "sent", deliveryId };
}
