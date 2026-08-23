import type { CategorySummary } from "../types";

export type ViewMode = "action" | "category";
export type DashboardFilters = {
  query: string;
  categoryId: number | "all" | "review";
  priority: "all" | "urgent" | "waiting" | "normal";
  dataMode: "all" | "real" | "demo";
  timeRange: "all" | "24h" | "7d" | "30d";
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
              placeholder="ชื่อกลุ่ม สรุป หรืองาน"
            />
          </span>
        </label>
        <label>
          <span>หมวดหมู่</span>
          <select
            value={filters.categoryId}
            onChange={(event) => {
              const value = event.target.value;
              update("categoryId", value === "all" || value === "review" ? value : Number(value));
            }}
          >
            <option value="all">ทุกหมวด</option>
            <option value="review">รอยืนยันหมวด</option>
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
        <label>
          <span>ช่วงเวลา</span>
          <select value={filters.timeRange} onChange={(event) => update("timeRange", event.target.value as DashboardFilters["timeRange"])}>
            <option value="all">ทั้งหมด</option>
            <option value="24h">24 ชั่วโมง</option>
            <option value="7d">7 วัน</option>
            <option value="30d">30 วัน</option>
          </select>
        </label>
      </div>
    </section>
  );
}
