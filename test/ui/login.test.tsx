import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const dashboard = {
  generatedAt: Date.now(),
  kpis: { totalGroups: 100, urgent: 8, waiting: 14, active: 35, normal: 43 },
  categories: [],
  groups: [],
  actionQueue: [],
  health: { backlogGroups: 0, aiCallsToday: 0, aiInputTokensToday: 0, linePushesMonth: 0, warnings: [] },
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("owner login", () => {
  it("shows login, submits a cookie-based request, and opens the dashboard", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard));
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "เลขากลุ่ม" })).toBeVisible();
    await user.type(screen.getByLabelText("รหัสผ่าน"), "owner-pass");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ password: "owner-pass" }),
      }),
    );
    expect(await screen.findByText("ติดตาม 100 กลุ่ม")).toBeVisible();
  });

  it("keeps the password form usable after a rejected login", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json({ error: "invalid_credentials" }, 401));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("รหัสผ่าน");

    await user.type(screen.getByLabelText("รหัสผ่าน"), "wrong");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("รหัสผ่านไม่ถูกต้อง");
    expect(screen.getByRole("button", { name: "เข้าสู่ระบบ" })).toBeEnabled();
  });

  it("logs out and returns to the password screen", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(dashboard))
      .mockResolvedValueOnce(json({ authenticated: false }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(screen.getByLabelText("รหัสผ่าน")).toBeVisible());
  });
});
