import type { SystemHealth } from "../types";

interface SystemStatusProps {
  health: SystemHealth;
  generatedAt: number;
}

export default function SystemStatus({ health, generatedAt }: SystemStatusProps) {
  const number = new Intl.NumberFormat("en-US");
  const lastCron = health.lastSuccessfulCron ?? null;
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
        <span>AI วันนี้ {health.aiCallsToday} ครั้ง · {number.format(health.aiInputTokensToday)} tokens</span>
        <span>LINE เดือนนี้ {health.linePushesMonth} / {health.linePushCap}</span>
        <span>
          Cron ล่าสุด {lastCron
            ? new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(lastCron)
            : "ยังไม่ทำงาน"}
        </span>
        <span className="external-metrics">
          Worker requests · D1 reads/writes · Workflow steps:{" "}
          <a
            href={health.platformMetrics?.dashboardUrl ?? "https://dash.cloudflare.com/"}
            target="_blank"
            rel="noreferrer"
            aria-label="เปิด Cloudflare Analytics"
          >
            ดูข้อมูลจริงจาก Cloudflare
          </a>
        </span>
      </div>
      {health.warnings.length > 0 ? (
        <div className="health-warnings" role="status" aria-label="คำเตือนระบบ">
          {health.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
    </section>
  );
}
