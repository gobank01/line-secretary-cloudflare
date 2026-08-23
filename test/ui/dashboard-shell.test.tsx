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
      .mockReturnValueOnce(pendingDashboard);
    render(<App />);

    expect(await screen.findByRole("status", { name: "กำลังโหลด dashboard" })).toBeVisible();
    resolveDashboard(json(dashboard));

    expect(await screen.findByText("อัปเดตล่าสุด")).toBeVisible();
    expect(screen.getByText("AI วันนี้ 18 ครั้ง")).toBeVisible();
    expect(screen.getByText("LINE เดือนนี้ 42 / 280")).toBeVisible();
  });

  it("retains cached data and shows a stale banner when alert polling fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard))
      .mockRejectedValueOnce(new Error("offline"));
    render(<App />);

    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("ข้อมูลเดิมยังแสดงอยู่");
    expect(screen.getByText("ติดตาม 100 กลุ่ม")).toBeVisible();
  });

  it("keeps cached data visible while the browser is offline", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard));
    render(<App />);
    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();

    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("ออฟไลน์");
    expect(screen.getByText("ติดตาม 100 กลุ่ม")).toBeVisible();
  });
});
