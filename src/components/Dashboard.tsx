import { useEffect, useRef, useState } from "react";
import { ApiError, getAlertsSince, getDashboard, logout } from "../api";
import type { DashboardPayload } from "../types";
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
  const alertCursor = useRef(0);

  useEffect(() => {
    let active = true;
    void getDashboard()
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

  const signOut = async () => {
    setLogoutError(false);
    try {
      await logout();
      onUnauthorized();
    } catch {
      setLogoutError(true);
    }
  };

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
            <h2>ติดตาม {data.kpis.totalGroups} กลุ่ม</h2>
            <p>เริ่มจากเรื่องเร่งด่วน แล้วค่อยไล่ดูตามหมวดที่รับผิดชอบ</p>
          </div>
          <SystemStatus health={data.health} generatedAt={data.generatedAt} />
        </section>

        <section className="kpi-grid" aria-label="ตัวเลขภาพรวม">
          {KPI_ITEMS.map((item) => (
            <article className={`kpi-card kpi-card--${item.tone}`} key={item.key}>
              <span className="kpi-label">{item.label}</span>
              <strong>{data.kpis[item.key]}</strong>
            </article>
          ))}
        </section>

        <section className="dashboard-placeholder" aria-label="พื้นที่รายการกลุ่ม">
          <div className="section-heading">
            <div>
              <p className="eyebrow">WORKSPACE</p>
              <h2>รายการที่ต้องดู</h2>
            </div>
            <span className="count-badge">{data.actionQueue.length} รายการ</span>
          </div>
          <p>เลือกดูแบบตามสิ่งที่ต้องทำ หรือตามหมวดหมู่ได้จากแถบมุมมอง</p>
        </section>
      </main>
    </div>
  );
}
