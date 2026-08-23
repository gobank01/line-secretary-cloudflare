import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createCategory,
  deleteRawHistory,
  getAuditLog,
  getGroup,
  setAlertStatus,
  setGroupCategory,
  setGroupStatus,
  updateCategory,
} from "../api";
import type { AuditEntry, CategorySummary, GroupDetail as GroupDetailValue } from "../types";

interface GroupDetailProps {
  groupId: string;
  categories: CategorySummary[];
  onClose(): void;
  onChanged(): void;
}

type Confirmation = "pause" | "delete" | null;

function actorLabel(actor: AuditEntry["actor"]): string {
  if (actor === "owner") return "เจ้าของ";
  if (actor === "ai") return "AI";
  return "ระบบ";
}

export default function GroupDetail({ groupId, categories, onClose, onChanged }: GroupDetailProps) {
  const [detail, setDetail] = useState<GroupDetailValue | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [newCategory, setNewCategory] = useState({ slug: "", name: "", color: "#2563eb" });
  const [categoryNames, setCategoryNames] = useState<Record<number, string>>(() =>
    Object.fromEntries(categories.map((category) => [category.id, category.name])),
  );

  const load = useCallback(async () => {
    const [nextDetail, nextAudit] = await Promise.all([getGroup(groupId), getAuditLog("group", groupId)]);
    setDetail(nextDetail);
    setAudit(nextAudit.entries);
    setSelectedCategoryId(nextDetail.group.category ? String(nextDetail.group.category.id) : "");
  }, [groupId]);

  useEffect(() => {
    let active = true;
    void Promise.all([getGroup(groupId), getAuditLog("group", groupId)])
      .then(([nextDetail, nextAudit]) => {
        if (!active) return;
        setDetail(nextDetail);
        setAudit(nextAudit.entries);
        setSelectedCategoryId(nextDetail.group.category ? String(nextDetail.group.category.id) : "");
      })
      .catch(() => {
        if (active) setError("เปิดรายละเอียดกลุ่มไม่สำเร็จ กรุณาลองอีกครั้ง");
      });
    return () => {
      active = false;
    };
  }, [groupId]);

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch {
      setError("บันทึกไม่สำเร็จ ข้อมูลเดิมยังคงอยู่ กรุณาลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  };

  const addCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await mutate(async () => {
      await createCategory(newCategory);
      setNewCategory({ slug: "", name: "", color: "#2563eb" });
    });
  };

  if (!detail) {
    return (
      <aside className="detail-overlay" role="dialog" aria-modal="true" aria-label="รายละเอียดกลุ่ม">
        <div className="detail-panel detail-panel--loading" role="status">
          {error ?? "กำลังโหลดรายละเอียด…"}
          <button className="button button--quiet" type="button" onClick={onClose}>ปิด</button>
        </div>
      </aside>
    );
  }

  const group = detail.group;
  return (
    <aside className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <button className="detail-backdrop" type="button" aria-label="ปิดรายละเอียด" onClick={onClose} />
      <article className="detail-panel">
        <header className="detail-header">
          <div>
            <div className="detail-badges">
              <span className={`mode-badge mode-badge--${group.dataMode}`}>{group.dataMode === "real" ? "REAL" : "DEMO"}</span>
              <span className={`state-badge state-badge--${group.active ? "active" : "paused"}`}>{group.active ? "กำลังติดตาม" : "พักอยู่"}</span>
              <span className="score-badge">AI score {group.priorityScore}</span>
            </div>
            <h2 id="detail-title">{group.title}</h2>
            <p>{group.latestSummary ?? "ยังไม่มีสรุปล่าสุด"}</p>
          </div>
          <button className="icon-button" type="button" aria-label="ปิดรายละเอียด" onClick={onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </header>

        {error ? <div className="notice notice--danger" role="alert">{error}</div> : null}

        <section className="detail-section" aria-labelledby="category-control-title">
          <div className="detail-section-heading">
            <h3 id="category-control-title">หมวดและสถานะ</h3>
            <span>ข้อความดิบ {detail.messageCount} รายการ</span>
          </div>
          <div className="category-control">
            <label>
              <span>เลือกหมวด</span>
              <select value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(event.target.value)}>
                <option value="" disabled>เลือกหมวด</option>
                {categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}
              </select>
            </label>
            <button
              className="button button--primary button--inline"
              type="button"
              disabled={busy || !selectedCategoryId}
              onClick={() => void mutate(() => setGroupCategory(groupId, Number(selectedCategoryId), true))}
            >
              บันทึกและล็อกหมวด
            </button>
            {group.categoryLocked && group.category ? (
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => void mutate(() => setGroupCategory(groupId, group.category!.id, false))}
              >
                ปลดล็อกให้ AI
              </button>
            ) : null}
          </div>
          <p className="control-help">
            {group.categoryLocked
              ? "ล็อกโดยเจ้าของ — AI จะไม่เปลี่ยนหมวดนี้"
              : `AI สามารถเสนอหมวดใหม่ได้${group.categoryConfidence === null ? "" : ` · ความมั่นใจ ${Math.round(group.categoryConfidence * 100)}%`}`}
          </p>
          <div className="group-commands">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => group.active ? setConfirmation("pause") : void mutate(() => setGroupStatus(groupId, true))}
            >
              {group.active ? "พักกลุ่ม" : "เปิดติดตามกลุ่ม"}
            </button>
            <button className="button button--danger" type="button" onClick={() => setConfirmation("delete")}>
              ลบข้อความดิบ
            </button>
          </div>
        </section>

        <section className="detail-section" aria-labelledby="actions-title">
          <h3 id="actions-title">สิ่งที่ต้องทำ</h3>
          {group.actionItems.length > 0 ? <ul>{group.actionItems.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted-copy">ยังไม่มีงานค้าง</p>}
        </section>

        <section className="detail-section" aria-labelledby="questions-title">
          <h3 id="questions-title">คำถามที่ยังไม่จบ</h3>
          {group.unresolvedQuestions.length > 0 ? <ul>{group.unresolvedQuestions.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted-copy">ไม่มีคำถามค้าง</p>}
        </section>

        <section className="detail-section" aria-labelledby="alerts-title">
          <h3 id="alerts-title">แจ้งเตือน</h3>
          <div className="detail-stack">
            {detail.alerts.length === 0 ? <p className="muted-copy">ไม่มีแจ้งเตือน</p> : null}
            {detail.alerts.map((alert) => (
              <article className="detail-alert" key={alert.id}>
                <div><span className={`severity-label severity-label--${alert.severity === "critical" || alert.severity === "high" ? "danger" : "warning"}`}>{alert.severity}</span><p>{alert.excerpt}</p></div>
                <div className="detail-alert-actions">
                  {alert.status === "open" ? (
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => void mutate(() => setAlertStatus(alert.id, "acknowledged"))}>รับทราบ</button>
                  ) : <span className="state-badge state-badge--active">{alert.status === "resolved" ? "ปิดแล้ว" : "รับทราบแล้ว"}</span>}
                  {alert.status !== "resolved" ? (
                    <button className="button button--quiet" type="button" disabled={busy} onClick={() => void mutate(() => setAlertStatus(alert.id, "resolved"))}>ปิดเรื่อง</button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="detail-section" aria-labelledby="reports-title">
          <h3 id="reports-title">ประวัติรายงาน</h3>
          <div className="detail-stack">
            {detail.reports.map((report) => (
              <article className="report-card" key={report.id}>
                <div><time>{new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(report.createdAt)}</time><strong>{report.priorityScore}</strong></div>
                <p>{report.summary}</p>
              </article>
            ))}
          </div>
        </section>

        <details className="category-manager">
          <summary>จัดการหมวดหมู่</summary>
          <form className="new-category-form" onSubmit={(event) => void addCategory(event)}>
            <label><span>Slug ใหม่</span><input required pattern="[a-z0-9-]+" value={newCategory.slug} onChange={(event) => setNewCategory((value) => ({ ...value, slug: event.target.value }))} /></label>
            <label><span>ชื่อหมวดใหม่</span><input required value={newCategory.name} onChange={(event) => setNewCategory((value) => ({ ...value, name: event.target.value }))} /></label>
            <label><span>สีหมวดใหม่</span><input type="color" value={newCategory.color} onChange={(event) => setNewCategory((value) => ({ ...value, color: event.target.value }))} /></label>
            <button className="button button--quiet" type="submit" disabled={busy}>เพิ่มหมวด</button>
          </form>
          <div className="category-manager-list">
            {categories.map((category) => (
              <div className="category-manager-row" key={category.id}>
                <span className="category-swatch" style={{ backgroundColor: category.color }} aria-hidden="true" />
                <input
                  aria-label={`ชื่อหมวด ${category.name}`}
                  value={categoryNames[category.id] ?? category.name}
                  onChange={(event) => setCategoryNames((value) => ({ ...value, [category.id]: event.target.value }))}
                />
                <button className="button button--quiet" type="button" aria-label={`บันทึกชื่อ${category.name}`} onClick={() => void mutate(() => updateCategory(category.id, { name: categoryNames[category.id] ?? category.name }))}>บันทึก</button>
                <button className="button button--danger-quiet" type="button" aria-label={`ปิดใช้งาน${category.name}`} onClick={() => void mutate(() => updateCategory(category.id, { active: false }))}>ปิดใช้</button>
              </div>
            ))}
          </div>
        </details>

        <section className="detail-section" aria-labelledby="audit-title">
          <h3 id="audit-title">ประวัติการเปลี่ยนแปลง</h3>
          <div className="audit-list">
            {audit.map((entry) => (
              <div className="audit-row" key={entry.id}>
                <span>{actorLabel(entry.actor)}</span>
                <strong>{entry.action}</strong>
                <time>{new Intl.DateTimeFormat("th-TH", { dateStyle: "short", timeStyle: "short" }).format(entry.createdAt)}</time>
              </div>
            ))}
          </div>
        </section>
      </article>

      {confirmation ? (
        <div className="confirm-layer" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="confirm-card">
            <h3 id="confirm-title">{confirmation === "pause" ? "พักการติดตามกลุ่ม" : "ลบข้อความดิบถาวร"}</h3>
            <p>
              {confirmation === "pause"
                ? `ยืนยันพักกลุ่ม “${group.title}” ระบบจะไม่เก็บข้อความใหม่จนกว่าจะเปิดอีกครั้ง`
                : `ยืนยันลบข้อความดิบของ “${group.title}” จำนวน ${detail.messageCount} รายการ รายงานและแจ้งเตือนจะยังอยู่`}
            </p>
            <div>
              <button className="button button--quiet" type="button" onClick={() => setConfirmation(null)}>ยกเลิก</button>
              <button
                className="button button--danger"
                type="button"
                onClick={() => {
                  const current = confirmation;
                  setConfirmation(null);
                  void mutate(() => current === "pause" ? setGroupStatus(groupId, false) : deleteRawHistory(groupId));
                }}
              >
                {confirmation === "pause" ? "ยืนยันพักกลุ่ม" : "ยืนยันลบข้อความดิบ"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
