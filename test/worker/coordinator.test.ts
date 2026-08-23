import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDigestSlot,
  runScheduled,
  selectEligibleGroups,
  type CoordinatorEnv,
} from "../../worker/scheduler/coordinator";

function bangkokEpoch(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("bad Bangkok date");
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 7,
    Number(match[5]),
  );
}

const monday0830 = bangkokEpoch("2026-08-24 08:30");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM groups"),
    env.DB.prepare("DELETE FROM job_runs"),
    env.DB.prepare("DELETE FROM digest_deliveries"),
    env.DB.prepare("DELETE FROM ai_call_reservations"),
    env.DB.prepare("DELETE FROM usage_daily"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM settings WHERE key='maintenance_last_day'"),
  ]);
  vi.restoreAllMocks();
});

describe("Bangkok coordinator schedule", () => {
  it("recognizes only hourly workday digest slots", () => {
    expect(isDigestSlot(bangkokEpoch("2026-08-24 08:00"))).toBe(true);
    expect(isDigestSlot(bangkokEpoch("2026-08-24 17:00"))).toBe(true);
    expect(isDigestSlot(bangkokEpoch("2026-08-24 08:30"))).toBe(false);
    expect(isDigestSlot(bangkokEpoch("2026-08-23 08:00"))).toBe(false);
    expect(isDigestSlot(bangkokEpoch("2026-08-24 18:00"))).toBe(false);
  });

  it("selects urgent then oldest eligible real groups and excludes demo data", async () => {
    const rows = [
      { id: "C-old", mode: "real", sentAt: monday0830 - 3 * 60 * 60_000, urgent: false },
      { id: "C-urgent", mode: "real", sentAt: monday0830 - 10 * 60_000, urgent: true },
      { id: "DEMO-hidden", mode: "demo", sentAt: monday0830 - 5 * 60 * 60_000, urgent: true },
    ];
    for (const row of rows) {
      await env.DB.prepare(
        "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
      )
        .bind(row.id, `กลุ่ม ${row.id}`, row.mode, monday0830, monday0830)
        .run();
      await env.DB.prepare(
        `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
         VALUES(?,?, 'text','งานค้าง',?,?,?)`,
      )
        .bind(`m-${row.id}`, row.id, row.sentAt, monday0830, monday0830 + 99_999_999)
        .run();
      if (row.urgent) {
        const messageId = await env.DB.prepare("SELECT id FROM messages WHERE group_id=?")
          .bind(row.id)
          .first<number>("id");
        await env.DB.prepare(
          "INSERT INTO alerts(group_id,message_id,kind,severity,status,excerpt,created_at) VALUES(?,?,'keyword','high','open','ด่วน',?)",
        )
          .bind(row.id, messageId, monday0830)
          .run();
      }
    }

    const selected = await selectEligibleGroups(env.DB, monday0830, 10, true);
    expect(selected.map((group) => group.groupId)).toEqual(["C-urgent", "C-old"]);
    expect(selected.every((group) => group.dataMode === "real")).toBe(true);
  });

  it("deduplicates scheduled events, dispatches stable Workflow IDs, and runs daily retention", async () => {
    await env.DB.prepare(
      "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES('C-run','กลุ่มจริง','real',1,?,?)",
    )
      .bind(monday0830, monday0830)
      .run();
    for (let index = 0; index < 5; index += 1) {
      await env.DB.prepare(
        `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
         VALUES(?, 'C-run','text','ข้อความ',?,?,?)`,
      )
        .bind(`m-run-${index}`, monday0830 - index * 1_000, monday0830, monday0830 + 99_999_999)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
       VALUES('m-expired','C-run','text','หมดอายุ',1,1,2)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO auth_attempts(ip_hash,window_start,attempts,blocked_until) VALUES('old-hash',1,1,2)",
    ).run();

    const create = vi.fn(async () => ({ id: "workflow" }));
    const coordinatorEnv: CoordinatorEnv = {
      DB: env.DB,
      GROUP_SUMMARIZER: { create },
      APP_TIMEZONE: env.APP_TIMEZONE,
      AI_DAILY_CALL_CAP: env.AI_DAILY_CALL_CAP,
      AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
      AI_MIN_MESSAGES: env.AI_MIN_MESSAGES,
      AI_MAX_WAIT_MINUTES: env.AI_MAX_WAIT_MINUTES,
      LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_PUSH_ENABLED: "false",
      OWNER_USER_ID: env.OWNER_USER_ID,
      AUTOMATED_MONTHLY_PUSH_CAP: env.AUTOMATED_MONTHLY_PUSH_CAP,
      DASHBOARD_URL: env.DASHBOARD_URL,
    };

    await expect(runScheduled(coordinatorEnv, monday0830)).resolves.toMatchObject({ status: "dispatched" });
    await expect(runScheduled(coordinatorEnv, monday0830)).resolves.toEqual({ status: "duplicate" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `C-run:${monday0830}`,
        params: expect.objectContaining({
          groupId: "C-run",
          aiReservationId: expect.any(String),
          aiReservationDay: "2026-08-24",
        }),
      }),
    );
    expect(await env.DB.prepare("SELECT status FROM ai_call_reservations").first("status")).toBe("reserved");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM job_runs WHERE scheduled_for=?").bind(monday0830).first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE line_message_id='m-expired'").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM auth_attempts WHERE ip_hash='old-hash'").first("count")).toBe(0);
  });

  it("leases a group window so adjacent Cron runs cannot dispatch overlapping summaries", async () => {
    await env.DB.prepare(
      "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES('C-lease','กลุ่มเช่า','real',1,?,?)",
    )
      .bind(monday0830, monday0830)
      .run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
           VALUES(?,'C-lease','text','ข้อความค้าง',?,?,?)`,
        ).bind(`m-lease-${index}`, monday0830 - index, monday0830, monday0830 + 99_999_999),
      ),
    );
    const create = vi.fn(async () => ({ id: "workflow" }));
    const coordinatorEnv: CoordinatorEnv = {
      DB: env.DB,
      GROUP_SUMMARIZER: { create },
      APP_TIMEZONE: env.APP_TIMEZONE,
      AI_DAILY_CALL_CAP: env.AI_DAILY_CALL_CAP,
      AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
      AI_MIN_MESSAGES: env.AI_MIN_MESSAGES,
      AI_MAX_WAIT_MINUTES: env.AI_MAX_WAIT_MINUTES,
      LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_PUSH_ENABLED: "false",
      OWNER_USER_ID: env.OWNER_USER_ID,
      AUTOMATED_MONTHLY_PUSH_CAP: env.AUTOMATED_MONTHLY_PUSH_CAP,
      DASHBOARD_URL: env.DASHBOARD_URL,
    };

    await expect(runScheduled(coordinatorEnv, monday0830)).resolves.toMatchObject({ groups: 1 });
    await expect(runScheduled(coordinatorEnv, monday0830 + 30 * 60_000)).resolves.toMatchObject({ groups: 0 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("records a failed dispatch and safely retries the same scheduled event", async () => {
    await env.DB.prepare(
      "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES('C-retry-run','กลุ่ม retry','real',1,?,?)",
    )
      .bind(monday0830, monday0830)
      .run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
           VALUES(?,'C-retry-run','text','ข้อความค้าง',?,?,?)`,
        ).bind(`m-retry-run-${index}`, monday0830 - index, monday0830, monday0830 + 99_999_999),
      ),
    );
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ id: "workflow" });
    const coordinatorEnv: CoordinatorEnv = {
      DB: env.DB,
      GROUP_SUMMARIZER: { create },
      APP_TIMEZONE: env.APP_TIMEZONE,
      AI_DAILY_CALL_CAP: env.AI_DAILY_CALL_CAP,
      AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
      AI_MIN_MESSAGES: env.AI_MIN_MESSAGES,
      AI_MAX_WAIT_MINUTES: env.AI_MAX_WAIT_MINUTES,
      LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_PUSH_ENABLED: "false",
      OWNER_USER_ID: env.OWNER_USER_ID,
      AUTOMATED_MONTHLY_PUSH_CAP: env.AUTOMATED_MONTHLY_PUSH_CAP,
      DASHBOARD_URL: env.DASHBOARD_URL,
    };

    await expect(runScheduled(coordinatorEnv, monday0830)).rejects.toThrow("workflow unavailable");
    expect(await env.DB.prepare("SELECT status FROM job_runs WHERE scheduled_for=?").bind(monday0830).first("status"))
      .toBe("failed");
    await expect(runScheduled(coordinatorEnv, monday0830)).resolves.toMatchObject({ status: "dispatched", groups: 1 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("acquires Workflow leases from wall-clock time when Cron delivery is late", async () => {
    const deliveredAt = monday0830 + 2 * 60 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(deliveredAt);
    await env.DB.prepare(
      "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES('C-late','กลุ่ม Cron ช้า','real',1,?,?)",
    )
      .bind(monday0830, monday0830)
      .run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
           VALUES(?,'C-late','text','ข้อความค้าง',?,?,?)`,
        ).bind(`m-late-${index}`, monday0830 - index, monday0830, monday0830 + 99_999_999),
      ),
    );
    const create = vi.fn(async () => ({ id: "workflow" }));
    const coordinatorEnv: CoordinatorEnv = {
      DB: env.DB,
      GROUP_SUMMARIZER: { create },
      APP_TIMEZONE: env.APP_TIMEZONE,
      AI_DAILY_CALL_CAP: env.AI_DAILY_CALL_CAP,
      AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
      AI_MIN_MESSAGES: env.AI_MIN_MESSAGES,
      AI_MAX_WAIT_MINUTES: env.AI_MAX_WAIT_MINUTES,
      LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_PUSH_ENABLED: "false",
      OWNER_USER_ID: env.OWNER_USER_ID,
      AUTOMATED_MONTHLY_PUSH_CAP: env.AUTOMATED_MONTHLY_PUSH_CAP,
      DASHBOARD_URL: env.DASHBOARD_URL,
    };

    await runScheduled(coordinatorEnv, monday0830);

    expect(await env.DB.prepare("SELECT summary_inflight_until FROM groups WHERE source_id='C-late'")
      .first("summary_inflight_until")).toBe(deliveredAt + 45 * 60_000);
  });

  it("dispatches only the remaining atomically reserved daily AI call slots", async () => {
    const day = "2026-08-24";
    await env.DB.prepare(
      "INSERT INTO usage_daily(day,ai_calls,ai_input_tokens,updated_at) VALUES(?,119,0,?)",
    )
      .bind(day, monday0830)
      .run();
    for (const groupId of ["C-cap-a", "C-cap-b"]) {
      await env.DB.prepare(
        "INSERT INTO groups(source_id,title,data_mode,active,created_at,updated_at) VALUES(?,?, 'real',1,?,?)",
      )
        .bind(groupId, groupId, monday0830, monday0830)
        .run();
      await env.DB.batch(
        Array.from({ length: 5 }, (_, index) =>
          env.DB.prepare(
            `INSERT INTO messages(line_message_id,group_id,kind,text,sent_at,ingested_at,retention_expires_at)
             VALUES(?,?, 'text','ข้อความค้าง',?,?,?)`,
          ).bind(`m-${groupId}-${index}`, groupId, monday0830 - index, monday0830, monday0830 + 99_999_999),
        ),
      );
    }
    const create = vi.fn(async () => ({ id: "workflow" }));
    const coordinatorEnv: CoordinatorEnv = {
      DB: env.DB,
      GROUP_SUMMARIZER: { create },
      APP_TIMEZONE: env.APP_TIMEZONE,
      AI_DAILY_CALL_CAP: "120",
      AI_DAILY_INPUT_TOKEN_CAP: env.AI_DAILY_INPUT_TOKEN_CAP,
      AI_MIN_MESSAGES: env.AI_MIN_MESSAGES,
      AI_MAX_WAIT_MINUTES: env.AI_MAX_WAIT_MINUTES,
      LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_PUSH_ENABLED: "false",
      OWNER_USER_ID: env.OWNER_USER_ID,
      AUTOMATED_MONTHLY_PUSH_CAP: env.AUTOMATED_MONTHLY_PUSH_CAP,
      DASHBOARD_URL: env.DASHBOARD_URL,
    };

    await expect(runScheduled(coordinatorEnv, monday0830)).resolves.toMatchObject({ groups: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT ai_calls FROM usage_daily WHERE day=?").bind(day).first("ai_calls"))
      .toBe(120);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM ai_call_reservations WHERE day=? AND status='reserved'")
      .bind(day).first("count")).toBe(1);
  });
});
