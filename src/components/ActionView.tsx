import type { ActionQueueItem, GroupSummary } from "../types";

export interface ActionRow extends ActionQueueItem {
  dataMode: "real" | "demo";
  categoryId: number | null;
}

interface ActionViewProps {
  actions: ActionRow[];
  groups: GroupSummary[];
  onOpenGroup(groupId: string): void;
}

function severity(score: number) {
  if (score >= 80) return { label: "เร่งด่วน", tone: "danger" };
  if (score >= 60) return { label: "รอติดตาม", tone: "warning" };
  return { label: "ปกติ", tone: "neutral" };
}

function ageLabel(timestamp: number | null): string {
  if (!timestamp) return "ยังไม่มีกิจกรรม";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} ชม.ที่แล้ว` : `${Math.floor(hours / 24)} วันที่แล้ว`;
}

export default function ActionView({ actions, groups, onOpenGroup }: ActionViewProps) {
  const groupIds = new Set(actions.map((action) => action.groupId));
  const remaining = groups.filter((group) => !groupIds.has(group.id));
  const rows: ActionRow[] = [
    ...actions,
    ...remaining.map((group) => ({
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
      dataMode: group.dataMode,
      categoryId: group.category?.id ?? null,
    })),
  ];

  return (
    <section className="workspace-panel" aria-labelledby="action-view-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ACTION QUEUE</p>
          <h2 id="action-view-title">คิวที่ต้องจัดการ</h2>
        </div>
        <span className="count-badge">{rows.length} กลุ่ม</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty-list">ไม่พบกลุ่มที่ตรงกับตัวกรอง</div>
      ) : (
        <div className="action-list">
          {rows.map((row) => {
            const level = severity(row.priorityScore);
            const reason = row.openAlerts > 0
              ? `มี ${row.openAlerts} แจ้งเตือนที่ยังไม่ปิด`
              : row.summary ?? "ยังไม่มีสรุปล่าสุด";
            const nextAction = row.actionItems[0] ?? row.unresolvedQuestions[0] ?? "ตรวจดูรายละเอียด";
            return (
              <button
                className="action-row"
                type="button"
                onClick={() => onOpenGroup(row.groupId)}
                aria-label={`เปิด ${row.title}`}
                key={row.groupId}
              >
                <span className={`severity-mark severity-mark--${level.tone}`} aria-hidden="true">
                  <svg viewBox="0 0 20 20"><path d="M10 3v8M10 15h.01" /></svg>
                </span>
                <span className="action-main">
                  <span className="action-title-line">
                    <strong>{row.title}</strong>
                    <span className={`severity-label severity-label--${level.tone}`}>{level.label}</span>
                    <span className={`mode-badge mode-badge--${row.dataMode}`}>{row.dataMode === "real" ? "REAL" : "DEMO"}</span>
                  </span>
                  <span className="action-reason">{reason}</span>
                  <span className="action-next">ถัดไป: {nextAction}</span>
                </span>
                <span className="action-meta">
                  <span className="category-dot" style={{ backgroundColor: row.categoryColor ?? "#94a3b8" }} aria-hidden="true" />
                  {row.categoryName ?? "ยังไม่จัดหมวด"}
                  <span>{ageLabel(row.lastActivityAt)}</span>
                  <strong>{row.priorityScore}</strong>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
