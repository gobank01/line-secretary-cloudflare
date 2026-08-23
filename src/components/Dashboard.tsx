import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getAlertsSince, getDashboard, logout } from "../api";
import type { DashboardPayload } from "../types";
import ActionView, { type ActionRow } from "./ActionView";
import CategoryView, { type FilteredCategory } from "./CategoryView";
import Filters, { type DashboardFilters, type ViewMode } from "./Filters";
import GroupDetail from "./GroupDetail";
import SystemStatus from "./SystemStatus";

interface DashboardProps {
  onUnauthorized(): void;
}

const KPI_ITEMS = [
  { key: "urgent", label: "เร่งด่วน", tone: "danger" },
  { key: "waiting", label: "รอติดตาม", tone: "warning" },
  { key: "active", label: "กำลังดำเนินการ", tone: "info" },
  { key: "normal", label: "ปกติ", tone: "neutral" },
] as const;

export default function Dashboard({ onUnauthorized }: DashboardProps) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pollError, setPollError] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [logoutError, setLogoutError] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem("line-secretary:view") === "category" ? "category" : "action",
  );
  const [filters, setFilters] = useState<DashboardFilters>({
    query: "",
    categoryId: "all",
    priority: "all",
    dataMode: "all",
  });
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("group"),
  );
  const alertCursor = useRef(0);

  useEffect(() => {
    let active = true;
    void getDashboard("all")
      .then((payload) => {
        if (!active) return;
        setData(payload);
        setLoadError(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        else setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [onUnauthorized]);

  useEffect(() => {
    if (!data) return;
    const poll = async () => {
      if (document.hidden || !navigator.onLine) return;
      try {
        const result = await getAlertsSince(alertCursor.current);
        for (const alert of result.alerts) alertCursor.current = Math.max(alertCursor.current, alert.createdAt);
        setPollError(false);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        else setPollError(true);
      }
    };
    const interval = window.setInterval(() => void poll(), 60_000);
    return () => window.clearInterval(interval);
  }, [data, onUnauthorized]);

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    const onPopState = () => setFocusedGroupId(new URLSearchParams(window.location.search).get("group"));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const signOut = async () => {
    setLogoutError(false);
    try {
      await logout();
      onUnauthorized();
    } catch {
      setLogoutError(true);
    }
  };

  const changeView = (value: ViewMode) => {
    setViewMode(value);
    localStorage.setItem("line-secretary:view", value);
  };

  const openGroup = (groupId: string) => {
    const query = new URLSearchParams(window.location.search);
    query.set("group", groupId);
    window.history.pushState({}, "", `${window.location.pathname}?${query.toString()}${window.location.hash}`);
    setFocusedGroupId(groupId);
  };

  const closeGroup = () => {
    const query = new URLSearchParams(window.location.search);
    query.delete("group");
    const suffix = query.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${suffix ? `?${suffix}` : ""}${window.location.hash}`);
    setFocusedGroupId(null);
  };

  const refreshDashboard = () => {
    void getDashboard("all")
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        else setPollError(true);
      });
  };

  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const query = filters.query.trim().toLocaleLowerCase("th");
    return data.groups.filter((group) => {
      if (filters.dataMode !== "all" && group.dataMode !== filters.dataMode) return false;
      if (filters.categoryId !== "all" && group.category?.id !== filters.categoryId) return false;
      if (filters.priority === "urgent" && group.priorityScore < 80) return false;
      if (filters.priority === "waiting" && (group.priorityScore < 60 || group.priorityScore >= 80)) return false;
      if (filters.priority === "normal" && group.priorityScore >= 60) return false;
      if (query && !`${group.title} ${group.latestSummary ?? ""}`.toLocaleLowerCase("th").includes(query)) return false;
      return true;
    });
  }, [data, filters]);

  const filteredActions = useMemo<ActionRow[]>(() => {
    if (!data) return [];
    const allowed = new Map(filteredGroups.map((group) => [group.id, group]));
    return data.actionQueue
      .flatMap((action) => {
        const group = allowed.get(action.groupId);
        return group
          ? [{ ...action, dataMode: group.dataMode, categoryId: group.category?.id ?? null }]
          : [];
      })
      .sort(
        (left, right) =>
          right.priorityScore - left.priorityScore ||
          right.openAlerts - left.openAlerts ||
          (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0),
      );
  }, [data, filteredGroups]);

  const filteredCategories = useMemo<FilteredCategory[]>(() => {
    if (!data) return [];
    return data.categories.flatMap((category) => {
      const groups = filteredGroups.filter((group) => group.category?.id === category.id);
      if (groups.length === 0) return [];
      let mostRecentAt: number | null = null;
      for (const group of groups) {
        if (group.lastMessageAt !== null && (mostRecentAt === null || group.lastMessageAt > mostRecentAt)) {
          mostRecentAt = group.lastMessageAt;
        }
      }
      return [{
        ...category,
        groupCount: groups.length,
        urgentCount: groups.filter((group) => group.priorityScore >= 80).length,
        openActionCount: groups.filter((group) => group.openAlerts > 0 || group.actionItems.length > 0).length,
        mostRecentAt,
      }];
    });
  }, [data, filteredGroups]);

  const filteredKpis = useMemo(
    () => ({
      urgent: filteredGroups.filter((group) => group.priorityScore >= 80).length,
      waiting: filteredGroups.filter((group) => group.priorityScore >= 60 && group.priorityScore < 80).length,
      active: filteredGroups.filter((group) => group.priorityScore >= 30 && group.priorityScore < 60).length,
      normal: filteredGroups.filter((group) => group.priorityScore < 30).length,
    }),
    [filteredGroups],
  );
  const hasActiveFilters =
    filters.query.trim() !== "" ||
    filters.categoryId !== "all" ||
    filters.priority !== "all" ||
    filters.dataMode !== "all";
  const useServerAggregate = !hasActiveFilters && data !== null && data.groups.length === 0;
  const displayedKpis = useServerAggregate ? data.kpis : filteredKpis;
  const displayedTotal = useServerAggregate ? data.kpis.totalGroups : filteredGroups.length;

  if (!data && !loadError) {
    return (
      <main className="dashboard-loading" role="status" aria-label="กำลังโหลด dashboard">
        <div className="skeleton skeleton--title" />
        <div className="skeleton-grid">
          {Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton--card" key={index} />)}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="dashboard-loading">
        <div className="empty-state" role="alert">
          <h1>เปิด dashboard ไม่สำเร็จ</h1>
          <p>ตรวจสอบการเชื่อมต่อแล้วโหลดหน้าใหม่อีกครั้ง</p>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" role="presentation">
              <path d="M7 7h18v13H14l-5 5v-5H7z" />
              <path d="M11 12h10M11 16h7" />
            </svg>
          </div>
          <div>
            <p className="eyebrow">OWNER CONSOLE</p>
            <h1>เลขากลุ่ม</h1>
          </div>
        </div>
        <button className="button button--quiet" type="button" onClick={() => void signOut()}>
          ออกจากระบบ
        </button>
      </header>

      <main className="dashboard-main">
        {!online ? (
          <div className="notice notice--warning" role="alert">
            ขณะนี้ออฟไลน์ — ข้อมูลล่าสุดยังแสดงอยู่ และจะอัปเดตเมื่อกลับมาออนไลน์
          </div>
        ) : null}
        {pollError ? (
          <div className="notice notice--warning" role="alert">
            ดึงข้อมูลล่าสุดไม่สำเร็จ ข้อมูลเดิมยังแสดงอยู่
          </div>
        ) : null}
        {logoutError ? <div className="notice notice--danger" role="alert">ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง</div> : null}

        <section className="dashboard-intro">
          <div>
            <p className="eyebrow">ภาพรวมวันนี้</p>
            <h2>ติดตาม {displayedTotal} กลุ่ม</h2>
            <p>เริ่มจากเรื่องเร่งด่วน แล้วค่อยไล่ดูตามหมวดที่รับผิดชอบ</p>
          </div>
          <SystemStatus health={data.health} generatedAt={data.generatedAt} />
        </section>

        <section className="kpi-grid" aria-label="ตัวเลขภาพรวม">
          {KPI_ITEMS.map((item) => (
            <article className={`kpi-card kpi-card--${item.tone}`} key={item.key}>
              <span className="kpi-label">{item.label}</span>
              <strong>{displayedKpis[item.key]}</strong>
            </article>
          ))}
        </section>

        <Filters
          viewMode={viewMode}
          filters={filters}
          categories={data.categories}
          onViewMode={changeView}
          onFilters={setFilters}
        />
        {viewMode === "action" ? (
          <ActionView actions={filteredActions} groups={filteredGroups} onOpenGroup={openGroup} />
        ) : (
          <CategoryView
            categories={filteredCategories}
            groups={filteredGroups}
            reviewCount={filteredGroups.filter((group) => group.needsCategoryReview).length}
            onCategory={(category) => {
              if (category === "review") setFilters((current) => ({ ...current, categoryId: "all" }));
              else setFilters((current) => ({ ...current, categoryId: category }));
            }}
            onOpenGroup={openGroup}
          />
        )}
      </main>
      {focusedGroupId ? (
        <GroupDetail
          groupId={focusedGroupId}
          categories={data.categories}
          onClose={closeGroup}
          onChanged={refreshDashboard}
        />
      ) : null}
    </div>
  );
}
