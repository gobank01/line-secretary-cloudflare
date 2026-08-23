import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const health = { backlogGroups: 1, aiCallsToday: 3, aiInputTokensToday: 500, linePushesMonth: 20, warnings: [] };
const categories = [
  { id: 1, slug: "customer", name: "ลูกค้า", color: "#0ea5e9", groupCount: 1, urgentCount: 1, openActionCount: 1 },
  { id: 2, slug: "team", name: "ทีมงาน", color: "#8b5cf6", groupCount: 1, urgentCount: 0, openActionCount: 0 },
];
const demoDashboard = {
  generatedAt: Date.now(),
  kpis: { totalGroups: 2, urgent: 1, waiting: 0, active: 0, normal: 1 },
  categories,
  groups: [
    {
      id: "DEMO-001",
      title: "ลูกค้าจำลองเร่งด่วน",
      dataMode: "demo",
      active: true,
      priorityScore: 92,
      lastMessageAt: Date.now() - 10 * 60_000,
      lastSummaryAt: Date.now(),
      needsCategoryReview: false,
      category: { id: 1, slug: "customer", name: "ลูกค้า", color: "#0ea5e9" },
      latestSummary: "ลูกค้ารอคำตอบ",
      actionItems: ["โทรกลับลูกค้า"],
      unresolvedQuestions: [],
      openAlerts: 1,
    },
    {
      id: "DEMO-002",
      title: "ทีมจำลองรอยืนยัน",
      dataMode: "demo",
      active: true,
      priorityScore: 22,
      lastMessageAt: Date.now() - 50 * 60_000,
      lastSummaryAt: Date.now(),
      needsCategoryReview: true,
      category: { id: 2, slug: "team", name: "ทีมงาน", color: "#8b5cf6" },
      latestSummary: "ทีมคุยงานทั่วไป",
      actionItems: [],
      unresolvedQuestions: [],
      openAlerts: 0,
    },
  ],
  actionQueue: [
    {
      groupId: "DEMO-001",
      title: "ลูกค้าจำลองเร่งด่วน",
      priorityScore: 92,
      categoryName: "ลูกค้า",
      categoryColor: "#0ea5e9",
      summary: "ลูกค้ารอคำตอบ",
      actionItems: ["โทรกลับลูกค้า"],
      unresolvedQuestions: [],
      openAlerts: 1,
      lastActivityAt: Date.now() - 10 * 60_000,
    },
  ],
  health,
};
const realDashboard = {
  generatedAt: Date.now(),
  kpis: { totalGroups: 1, urgent: 0, waiting: 1, active: 0, normal: 0 },
  categories: categories.map((category) => ({ ...category, groupCount: category.id === 1 ? 1 : 0, urgentCount: 0 })),
  groups: [
    {
      id: "C-REAL-001",
      title: "คู่ค้าจริงรอติดตาม",
      dataMode: "real",
      active: true,
      priorityScore: 68,
      lastMessageAt: Date.now() - 30 * 60_000,
      lastSummaryAt: Date.now(),
      needsCategoryReview: false,
      category: { id: 1, slug: "customer", name: "ลูกค้า", color: "#0ea5e9" },
      latestSummary: "รอเอกสารจากคู่ค้า",
      actionItems: ["ติดตามเอกสาร"],
      unresolvedQuestions: [],
      openAlerts: 0,
    },
  ],
  actionQueue: [
    {
      groupId: "C-REAL-001",
      title: "คู่ค้าจริงรอติดตาม",
      priorityScore: 68,
      categoryName: "ลูกค้า",
      categoryColor: "#0ea5e9",
      summary: "รอเอกสารจากคู่ค้า",
      actionItems: ["ติดตามเอกสาร"],
      unresolvedQuestions: [],
      openAlerts: 0,
      lastActivityAt: Date.now() - 30 * 60_000,
    },
  ],
  health,
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/auth/session") return Response.json({ authenticated: true });
    if (url.includes("mode=demo")) return Response.json(demoDashboard);
    if (url.includes("mode=real")) return Response.json(realDashboard);
    if (url.startsWith("/api/alerts")) return Response.json({ alerts: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shared Action and Category views", () => {
  it("defaults to Action and preserves shared filters when toggling views", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("button", { name: "ต้องจัดการ", pressed: true })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("แหล่งข้อมูล"), "real");
    expect(screen.getByText("คู่ค้าจริงรอติดตาม")).toBeVisible();
    expect(screen.queryByText("ลูกค้าจำลองเร่งด่วน")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ตามหมวด" }));
    expect(screen.getByLabelText("แหล่งข้อมูล")).toHaveValue("real");
    expect(screen.getByText("คู่ค้าจริงรอติดตาม")).toBeVisible();
    expect(screen.queryByText("ทีมจำลองรอยืนยัน")).not.toBeInTheDocument();
  });

  it("restores only the preferred view from localStorage", async () => {
    localStorage.setItem("line-secretary:view", "category");
    render(<App />);

    expect(await screen.findByRole("button", { name: "ตามหมวด", pressed: true })).toBeVisible();
    expect(screen.getByLabelText("แหล่งข้อมูล")).toHaveValue("all");
  });

  it("applies search, category, and priority to both views and shared KPIs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "ต้องจัดการ", pressed: true });

    await user.type(screen.getByLabelText("ค้นหากลุ่ม"), "ลูกค้าจำลอง");
    expect(screen.getByText("ลูกค้าจำลองเร่งด่วน")).toBeVisible();
    expect(screen.queryByText("คู่ค้าจริงรอติดตาม")).not.toBeInTheDocument();
    const kpis = screen.getByLabelText("ตัวเลขภาพรวม");
    expect(within(kpis).getByText("1", { selector: "strong" })).toBeVisible();

    await user.selectOptions(screen.getByLabelText("ความสำคัญ"), "urgent");
    await user.click(screen.getByRole("button", { name: "ตามหมวด" }));
    expect(screen.getByText("ลูกค้าจำลองเร่งด่วน")).toBeVisible();
    expect(screen.queryByText("ทีมจำลองรอยืนยัน")).not.toBeInTheDocument();
  });
});
