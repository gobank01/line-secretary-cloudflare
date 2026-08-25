const CATEGORY_SLUGS = ["customer", "team", "order", "partner", "project", "other"] as const;

type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export interface DemoGroup {
  sourceId: string;
  title: string;
  categorySlug: CategorySlug;
  priorityScore: number;
  lastMessageAt: number;
  categoryConfidence: number;
  needsCategoryReview: boolean;
}

export interface DemoReport {
  groupId: string;
  periodStart: number;
  periodEnd: number;
  summary: string;
  actionItems: string[];
  unresolvedQuestions: string[];
  priorityScore: number;
  createdAt: number;
}

export interface DemoAlert {
  groupId: string;
  kind: string;
  severity: "medium" | "high" | "critical";
  excerpt: string;
  createdAt: number;
}

export interface DemoDataset {
  groups: DemoGroup[];
  reports: DemoReport[];
  alerts: DemoAlert[];
}

const TITLES: Record<CategorySlug, string[]> = {
  customer: ["ลูกค้า", "ดูแลหลังการขาย", "ลูกค้าองค์กร"],
  team: ["ทีมขาย", "ทีมปฏิบัติการ", "ทีมหน้าร้าน"],
  order: ["ออเดอร์", "จัดส่ง", "สั่งซื้อประจำวัน"],
  partner: ["คู่ค้า", "ซัพพลายเออร์", "พาร์ตเนอร์"],
  project: ["โปรเจกต์", "เปิดสาขา", "แคมเปญ"],
  other: ["ประสานงาน", "ชุมชน", "เรื่องทั่วไป"],
};

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function buildDemoDataset(count: number, seed: number): DemoDataset {
  const random = mulberry32(seed);
  const baseTime = Date.UTC(2026, 7, 23, 10, 30, 0);
  const groups: DemoGroup[] = [];
  const reports: DemoReport[] = [];
  const alerts: DemoAlert[] = [];

  for (let index = 0; index < count; index += 1) {
    const categorySlug = CATEGORY_SLUGS[index % CATEGORY_SLUGS.length];
    const sourceId = `DEMO-${String(index + 1).padStart(3, "0")}`;
    const priorityScore = Math.floor(random() * 101);
    const ageMinutes = 2 + Math.floor(random() * 1_438);
    const lastMessageAt = baseTime - ageMinutes * 60_000;
    const categoryConfidence = Number((0.58 + random() * 0.41).toFixed(2));
    const needsCategoryReview = categoryConfidence < 0.75;
    const titleStem = TITLES[categorySlug][index % TITLES[categorySlug].length];
    const title = `${titleStem} ${String(index + 1).padStart(2, "0")}`;

    groups.push({
      sourceId,
      title,
      categorySlug,
      priorityScore,
      lastMessageAt,
      categoryConfidence,
      needsCategoryReview,
    });

    reports.push({
      groupId: sourceId,
      periodStart: lastMessageAt - 30 * 60_000,
      periodEnd: lastMessageAt,
      summary:
        priorityScore >= 80
          ? `มีประเด็นสำคัญใน${title}ที่เจ้าของควรตรวจสอบ`
          : `การสนทนาใน${title}ดำเนินตามปกติ`,
      actionItems: priorityScore >= 60 ? [`ตรวจรายการค้างของ${title}`] : [],
      unresolvedQuestions: priorityScore >= 75 ? ["ใครเป็นผู้รับผิดชอบเรื่องนี้?"] : [],
      priorityScore,
      createdAt: lastMessageAt + 60_000,
    });

    if (priorityScore >= 80) {
      alerts.push({
        groupId: sourceId,
        kind: "demo_priority",
        severity: priorityScore >= 95 ? "critical" : priorityScore >= 88 ? "high" : "medium",
        excerpt: `ตัวอย่างเหตุเร่งด่วนจาก${title}`,
        createdAt: lastMessageAt,
      });
    }
  }

  return { groups, reports, alerts };
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableText(value: string | null): string {
  return value === null ? "NULL" : sqlText(value);
}

export function renderDemoSeedSql(dataset: DemoDataset): string {
  const lines = [
    "PRAGMA foreign_keys = ON;",
    // D1 rejects explicit BEGIN/COMMIT; `wrangler d1 execute --file` batches the file itself.
    "DELETE FROM alerts WHERE group_id IN (SELECT source_id FROM groups WHERE data_mode = 'demo');",
    "DELETE FROM reports WHERE group_id IN (SELECT source_id FROM groups WHERE data_mode = 'demo');",
    "DELETE FROM messages WHERE group_id IN (SELECT source_id FROM groups WHERE data_mode = 'demo');",
    "DELETE FROM groups WHERE data_mode = 'demo';",
  ];

  for (const group of dataset.groups) {
    lines.push(
      `INSERT INTO groups(source_id,title,data_mode,active,category_id,category_source,category_locked,category_confidence,needs_category_review,priority_score,last_message_at,last_summary_at,created_at,updated_at) VALUES(${sqlText(group.sourceId)},${sqlText(group.title)},'demo',1,(SELECT id FROM categories WHERE slug=${sqlText(group.categorySlug)}),'ai',0,${group.categoryConfidence},${group.needsCategoryReview ? 1 : 0},${group.priorityScore},${group.lastMessageAt},${group.lastMessageAt},${group.lastMessageAt},${group.lastMessageAt});`,
    );
  }

  for (const report of dataset.reports) {
    lines.push(
      `INSERT INTO reports(group_id,period_start,period_end,summary,action_items_json,unresolved_json,priority_score,model,prompt_version,created_at) VALUES(${sqlText(report.groupId)},${report.periodStart},${report.periodEnd},${sqlText(report.summary)},${sqlText(JSON.stringify(report.actionItems))},${sqlText(JSON.stringify(report.unresolvedQuestions))},${report.priorityScore},'demo-seed','demo-v1',${report.createdAt});`,
    );
  }

  for (const alert of dataset.alerts) {
    lines.push(
      `INSERT INTO alerts(group_id,message_id,kind,severity,status,excerpt,created_at) VALUES(${sqlText(alert.groupId)},${sqlNullableText(null)},${sqlText(alert.kind)},${sqlText(alert.severity)},'open',${sqlText(alert.excerpt)},${alert.createdAt});`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

