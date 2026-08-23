import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GroupDetail from "../../src/components/GroupDetail";

const categories = [
  { id: 1, slug: "customer", name: "ลูกค้า", color: "#0ea5e9", groupCount: 1, urgentCount: 1, openActionCount: 1 },
  { id: 2, slug: "team", name: "ทีมงาน", color: "#8b5cf6", groupCount: 1, urgentCount: 0, openActionCount: 0 },
];

let detail = {
  group: {
    id: "DEMO-001",
    title: "ลูกค้าทดสอบ",
    dataMode: "demo" as const,
    active: true,
    priorityScore: 87,
    lastMessageAt: Date.now(),
    lastSummaryAt: Date.now(),
    needsCategoryReview: false,
    categoryLocked: false,
    categoryConfidence: 0.72,
    categorySource: "ai" as const,
    category: { id: 1, slug: "customer", name: "ลูกค้า", color: "#0ea5e9" },
    latestSummary: "ลูกค้ารอการยืนยันราคา",
    actionItems: ["ส่งราคาใหม่"],
    unresolvedQuestions: ["ใครเป็นผู้อนุมัติ?"],
    openAlerts: 1,
  },
  messageCount: 14,
  reports: [
    {
      id: 1,
      periodStart: 1,
      periodEnd: 2,
      summary: "ลูกค้ารอการยืนยันราคา",
      actionItems: ["ส่งราคาใหม่"],
      unresolvedQuestions: ["ใครเป็นผู้อนุมัติ?"],
      priorityScore: 87,
      createdAt: Date.now(),
    },
  ],
  alerts: [
    {
      id: 9,
      kind: "keyword",
      severity: "high",
      status: "open",
      excerpt: "ด่วน ลูกค้าขอคำตอบวันนี้",
      createdAt: Date.now(),
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
};

const calls: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  calls.length = 0;
  detail = structuredClone(detail);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (url.startsWith("/api/groups/DEMO-001") && method === "GET") return Response.json(detail);
    if (url.startsWith("/api/audit-log")) {
      return Response.json({
        entries: [{ id: 1, actor: "owner", action: "group.category_changed", entityType: "group", entityId: "DEMO-001", before: null, after: null, createdAt: Date.now() }],
      });
    }
    if (url.endsWith("/category") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { categoryId: number; locked: boolean };
      detail.group.categoryLocked = body.locked;
      detail.group.category = categories.find((category) => category.id === body.categoryId) ?? detail.group.category;
      return Response.json({ categoryId: body.categoryId, categoryLocked: body.locked });
    }
    if (url.endsWith("/status") && method === "PATCH") {
      detail.group.active = (JSON.parse(String(init?.body)) as { active: boolean }).active;
      return Response.json({ active: detail.group.active });
    }
    if (url.endsWith("/raw-history") && method === "DELETE") {
      detail.messageCount = 0;
      return Response.json({ deletedMessages: 14 });
    }
    if (url === "/api/alerts/9" && method === "PATCH") {
      detail.alerts[0]!.status = "acknowledged";
      return Response.json({ id: 9, status: "acknowledged" });
    }
    if (url === "/api/categories" && method === "POST") return Response.json({ id: 3 }, { status: 201 });
    if (url.startsWith("/api/categories/") && method === "PATCH") return Response.json({ ok: true });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("group detail and guarded controls", () => {
  it("separates reports, actions, questions, alerts, audit, and demo identity", async () => {
    render(<GroupDetail groupId="DEMO-001" categories={categories} onClose={() => undefined} onChanged={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "ลูกค้าทดสอบ" })).toBeVisible();
    expect(screen.getByText("DEMO")).toBeVisible();
    expect(screen.getByRole("heading", { name: "สิ่งที่ต้องทำ" })).toBeVisible();
    expect(screen.getByText("ส่งราคาใหม่")).toBeVisible();
    expect(screen.getByRole("heading", { name: "คำถามที่ยังไม่จบ" })).toBeVisible();
    expect(screen.getByText("ใครเป็นผู้อนุมัติ?")).toBeVisible();
    expect(screen.getByText("ด่วน ลูกค้าขอคำตอบวันนี้")).toBeVisible();
    expect(screen.getByText("เจ้าของ")).toBeVisible();
  });

  it("locks category by default, supports explicit unlock, and acknowledges an alert", async () => {
    const user = userEvent.setup();
    render(<GroupDetail groupId="DEMO-001" categories={categories} onClose={() => undefined} onChanged={() => undefined} />);
    await screen.findByLabelText("เลือกหมวด");

    await user.selectOptions(screen.getByLabelText("เลือกหมวด"), "2");
    await user.click(screen.getByRole("button", { name: "บันทึกและล็อกหมวด" }));
    expect(calls).toContainEqual(expect.objectContaining({
      url: "/api/groups/DEMO-001/category",
      body: JSON.stringify({ categoryId: 2, locked: true }),
    }));

    await user.click(await screen.findByRole("button", { name: "ปลดล็อกให้ AI" }));
    expect(calls).toContainEqual(expect.objectContaining({
      url: "/api/groups/DEMO-001/category",
      body: JSON.stringify({ categoryId: 2, locked: false }),
    }));

    await user.click(screen.getByRole("button", { name: "รับทราบ" }));
    expect(calls).toContainEqual(expect.objectContaining({ url: "/api/alerts/9", method: "PATCH" }));
  });

  it("names the group in pause and destructive-history confirmations", async () => {
    const user = userEvent.setup();
    render(<GroupDetail groupId="DEMO-001" categories={categories} onClose={() => undefined} onChanged={() => undefined} />);
    await screen.findByRole("heading", { name: "ลูกค้าทดสอบ" });

    await user.click(screen.getByRole("button", { name: "พักกลุ่ม" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("ลูกค้าทดสอบ");
    await user.click(screen.getByRole("button", { name: "ยืนยันพักกลุ่ม" }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      url: "/api/groups/DEMO-001/status",
      body: JSON.stringify({ active: false }),
    })));

    await user.click(screen.getByRole("button", { name: "ลบข้อความดิบ" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("ลูกค้าทดสอบ");
    await user.click(screen.getByRole("button", { name: "ยืนยันลบข้อความดิบ" }));
    await waitFor(() => expect(screen.getByText("ข้อความดิบ 0 รายการ")).toBeVisible());
  });

  it("creates, renames, and disables categories from the manager", async () => {
    const user = userEvent.setup();
    render(<GroupDetail groupId="DEMO-001" categories={categories} onClose={() => undefined} onChanged={() => undefined} />);
    await screen.findByRole("heading", { name: "ลูกค้าทดสอบ" });
    await user.click(screen.getByText("จัดการหมวดหมู่"));

    await user.type(screen.getByLabelText("Slug ใหม่"), "vip");
    await user.type(screen.getByLabelText("ชื่อหมวดใหม่"), "VIP");
    await user.click(screen.getByRole("button", { name: "เพิ่มหมวด" }));
    expect(calls).toContainEqual(expect.objectContaining({ url: "/api/categories", method: "POST" }));

    await user.clear(screen.getByLabelText("ชื่อหมวด ลูกค้า"));
    await user.type(screen.getByLabelText("ชื่อหมวด ลูกค้า"), "ลูกค้าหลัก");
    await user.click(screen.getByRole("button", { name: "บันทึกชื่อลูกค้า" }));
    await user.click(screen.getByRole("button", { name: "ปิดใช้งานลูกค้า" }));
    expect(calls.filter((call) => call.url === "/api/categories/1" && call.method === "PATCH")).toHaveLength(2);
  });
});
