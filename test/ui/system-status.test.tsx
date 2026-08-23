import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SystemStatus from "../../src/components/SystemStatus";

afterEach(cleanup);

describe("system status", () => {
  it("shows budgets, last Cron, and actionable warning text", () => {
    render(
      <SystemStatus
        generatedAt={Date.UTC(2026, 7, 23, 12)}
        health={{
          backlogGroups: 7,
          aiCallsToday: 120,
          aiInputTokensToday: 500_000,
          linePushesMonth: 280,
          lastSuccessfulCron: Date.UTC(2026, 7, 23, 11, 30),
          warnings: [
            "AI หยุดชั่วคราว: ใช้โควตารายวันครบแล้ว",
            "Digest หยุดชั่วคราว: ใช้โควตา LINE รายเดือนครบแล้ว",
            "สรุปล่าช้า: มี 7 กลุ่มรอประมวลผล",
          ],
        }}
      />,
    );

    expect(screen.getByText("AI วันนี้ 120 ครั้ง · 500,000 tokens")).toBeVisible();
    expect(screen.getByText("LINE เดือนนี้ 280 / 280")).toBeVisible();
    expect(screen.getByText(/Cron ล่าสุด/)).toBeVisible();
    expect(screen.getByText(/AI หยุดชั่วคราว/)).toBeVisible();
    expect(screen.getByText(/Digest หยุดชั่วคราว/)).toBeVisible();
    expect(screen.getByText(/สรุปล่าช้า/)).toBeVisible();
  });
});
