import type { CategorySummary, GroupSummary } from "../types";

export interface FilteredCategory extends CategorySummary {
  mostRecentAt: number | null;
}

interface CategoryViewProps {
  categories: FilteredCategory[];
  groups: GroupSummary[];
  reviewCount: number;
  onCategory(categoryId: number | "review"): void;
  onOpenGroup(groupId: string): void;
}

function dateLabel(timestamp: number | null): string {
  return timestamp
    ? new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(timestamp)
    : "ยังไม่มีกิจกรรม";
}

export default function CategoryView({ categories, groups, reviewCount, onCategory, onOpenGroup }: CategoryViewProps) {
  return (
    <section className="category-workspace" aria-labelledby="category-view-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CATEGORY MAP</p>
          <h2 id="category-view-title">ภาพรวมตามหมวด</h2>
        </div>
        <span className="count-badge">{groups.length} กลุ่ม</span>
      </div>
      <div className="category-grid">
        {reviewCount > 0 ? (
          <button className="category-card category-card--review" type="button" onClick={() => onCategory("review")}>
            <span className="category-card-top"><span className="review-symbol" aria-hidden="true">?</span><strong>รอยืนยันหมวด</strong></span>
            <span className="category-count">{reviewCount}</span>
            <span>AI ยังไม่มั่นใจ กรุณาตรวจหมวด</span>
          </button>
        ) : null}
        {categories.map((category) => (
          <button
            className="category-card"
            type="button"
            aria-label={`ดูหมวด ${category.name}`}
            onClick={() => onCategory(category.id)}
            key={category.id}
          >
            <span className="category-card-top">
              <span className="category-swatch" style={{ backgroundColor: category.color }} aria-hidden="true" />
              <strong>{category.name}</strong>
            </span>
            <span className="category-count">{category.groupCount}</span>
            <span className="category-stats">เร่งด่วน {category.urgentCount} · งานเปิด {category.openActionCount}</span>
            <span className="category-activity">ล่าสุด {dateLabel(category.mostRecentAt)}</span>
          </button>
        ))}
      </div>

      <div className="category-group-list">
        <h3>กลุ่มในมุมมองนี้</h3>
        {groups.length === 0 ? <div className="empty-list">ไม่พบกลุ่มที่ตรงกับตัวกรอง</div> : null}
        {groups.map((group) => (
          <button className="category-group-row" type="button" onClick={() => onOpenGroup(group.id)} key={group.id}>
            <span className="category-dot" style={{ backgroundColor: group.category?.color ?? "#94a3b8" }} aria-hidden="true" />
            <span><strong>{group.title}</strong><small>{group.latestSummary ?? "ยังไม่มีสรุป"}</small></span>
            <span className={`mode-badge mode-badge--${group.dataMode}`}>{group.dataMode === "real" ? "REAL" : "DEMO"}</span>
            <strong className="group-score">{group.priorityScore}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
