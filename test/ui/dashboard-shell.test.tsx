import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const dashboard = {
  generatedAt: Date.UTC(2026, 7, 23, 12),
  kpis: { totalGroups: 100, urgent: 8, waiting: 14, active: 35, normal: 43 },
  categories: [],
  groups: [],
  actionQueue: [],
  health: { backlogGroups: 2, aiCallsToday: 18, aiInputTokensToday: 1200, linePushesMonth: 42, warnings: [] },
};
const emptyDashboard = {
  ...dashboard,
  kpis: { totalGroups: 0, urgent: 0, waiting: 0, active: 0, normal: 0 },
  categories: [],
  groups: [],
  actionQueue: [],
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resilient dashboard shell", () => {
  it("shows a loading skeleton and then the latest system status", async () => {
    let resolveDashboard!: (response: Response) => void;
    const pendingDashboard = new Promise<Response>((resolve) => {
      resolveDashboard = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockReturnValueOnce(pendingDashboard)
      .mockResolvedValueOnce(json(emptyDashboard));
    render(<App />);

    expect(await screen.findByRole("status", { name: "กำลังโหลด dashboard" })).toBeVisible();
    resolveDashboard(json(dashboard));

    expect(await screen.findByText("อัปเดตล่าสุด")).toBeVisible();
    expect(screen.getByText("AI วันนี้ 18 ครั้ง · 1,200 tokens")).toBeVisible();
    expect(screen.getByText("LINE เดือนนี้ 42 / 280")).toBeVisible();
    expect(screen.getByRole("link", { name: "เปิด Cloudflare Analytics" })).toHaveAttribute(
      "href",
      "https://dash.cloudflare.com/",
    );
  });

  it("retains cached data and shows a stale banner when alert polling fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard))
      .mockResolvedValueOnce(json(emptyDashboard))
      .mockRejectedValueOnce(new Error("offline"));
    render(<App />);

    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("ข้อมูลเดิมยังแสดงอยู่");
    expect(screen.getByText("ติดตาม 100 กลุ่ม")).toBeVisible();
  });

  it("refreshes the dashboard when lightweight polling finds a new alert", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const refreshedDashboard = {
      ...dashboard,
      kpis: { ...dashboard.kpis, urgent: 9 },
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard))
      .mockResolvedValueOnce(json(emptyDashboard))
      .mockResolvedValueOnce(json({
        alerts: [{ id: 1, groupId: "C-urgent", groupTitle: "กลุ่มด่วน", createdAt: Date.now() }],
      }))
      .mockResolvedValueOnce(json(refreshedDashboard))
      .mockResolvedValueOnce(json(emptyDashboard));
    render(<App />);
    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByLabelText("ตัวเลขภาพรวม").querySelector(".kpi-card--danger strong")).toHaveTextContent("9");
  });

  it("keeps cached data visible while the browser is offline", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard))
      .mockResolvedValueOnce(json(emptyDashboard));
    render(<App />);
    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();

    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("ออฟไลน์");
    expect(screen.getByText("ติดตาม 100 กลุ่ม")).toBeVisible();
  });
});
