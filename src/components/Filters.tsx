import type { CategorySummary } from "../types";

export type ViewMode = "action" | "category";
export type DashboardFilters = {
  query: string;
  categoryId: number | "all";
  priority: "all" | "urgent" | "waiting" | "normal";
  dataMode: "all" | "real" | "demo";
};

interface FiltersProps {
  viewMode: ViewMode;
  filters: DashboardFilters;
  categories: CategorySummary[];
  onViewMode(value: ViewMode): void;
  onFilters(value: DashboardFilters): void;
}

function ViewIcon({ kind }: { kind: ViewMode }) {
  return kind === "action" ? (
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-9" /></svg>
  ) : (
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h5v5H3zM12 4h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z" /></svg>
  );
}

export default function Filters({ viewMode, filters, categories, onViewMode, onFilters }: FiltersProps) {
  const update = <Key extends keyof DashboardFilters>(key: Key, value: DashboardFilters[Key]) => {
    onFilters({ ...filters, [key]: value });
  };

  return (
    <section className="workspace-controls" aria-label="ตัวกรองและมุมมอง">
      <div className="view-toggle" aria-label="มุมมอง dashboard">
        <button type="button" aria-pressed={viewMode === "action"} onClick={() => onViewMode("action")}>
          <ViewIcon kind="action" />
          ต้องจัดการ
        </button>
        <button type="button" aria-pressed={viewMode === "category"} onClick={() => onViewMode("category")}>
          <ViewIcon kind="category" />
          ตามหมวด
        </button>
      </div>

      <div className="filter-grid">
        <label className="search-field">
          <span>ค้นหากลุ่ม</span>
          <span className="input-with-icon">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.5 12.5 4 4" /></svg>
            <input
              type="search"
              value={filters.query}
              onChange={(event) => update("query", event.target.value)}
              placeholder="ชื่อกลุ่มหรือสรุป"
            />
          </span>
        </label>
        <label>
          <span>หมวดหมู่</span>
          <select
            value={filters.categoryId}
            onChange={(event) => update("categoryId", event.target.value === "all" ? "all" : Number(event.target.value))}
          >
            <option value="all">ทุกหมวด</option>
            {categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label>
          <span>ความสำคัญ</span>
          <select value={filters.priority} onChange={(event) => update("priority", event.target.value as DashboardFilters["priority"])}>
            <option value="all">ทุกระดับ</option>
            <option value="urgent">เร่งด่วน</option>
            <option value="waiting">รอติดตาม</option>
            <option value="normal">ปกติ</option>
          </select>
        </label>
        <label>
          <span>แหล่งข้อมูล</span>
          <select value={filters.dataMode} onChange={(event) => update("dataMode", event.target.value as DashboardFilters["dataMode"])}>
            <option value="all">ทั้งหมด</option>
            <option value="real">กลุ่มจริง</option>
            <option value="demo">ข้อมูลจำลอง</option>
          </select>
        </label>
      </div>
    </section>
  );
}
