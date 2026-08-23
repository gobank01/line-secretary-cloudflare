import type { SystemHealth } from "../types";

interface SystemStatusProps {
  health: SystemHealth;
  generatedAt: number;
}

export default function SystemStatus({ health, generatedAt }: SystemStatusProps) {
  return (
    <section className="system-status" aria-label="สถานะระบบ">
      <div className="freshness">
        <span className="status-dot" aria-hidden="true" />
        <span>อัปเดตล่าสุด</span>
        <time dateTime={new Date(generatedAt).toISOString()}>
          {new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(generatedAt)} น.
        </time>
      </div>
      <div className="system-metrics">
        <span>คิวรอสรุป {health.backlogGroups} กลุ่ม</span>
        <span>AI วันนี้ {health.aiCallsToday} ครั้ง</span>
        <span>LINE เดือนนี้ {health.linePushesMonth} / 280</span>
      </div>
    </section>
  );
}
