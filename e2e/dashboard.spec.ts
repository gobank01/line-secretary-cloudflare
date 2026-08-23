import { expect, test } from "@playwright/test";

test("owner reviews and controls 100 demo groups without contacting LINE", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("รหัสผ่าน").fill("local-owner-password");
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();

  await expect(page.getByRole("heading", { name: "คิวที่ต้องจัดการ" })).toBeVisible();
  await expect(page.getByText("100 กลุ่ม", { exact: true }).first()).toBeVisible();

  await page.getByLabel("แหล่งข้อมูล").selectOption("demo");
  await page.getByLabel("ค้นหากลุ่ม").fill("ลูกค้า 01");
  await page.getByRole("button", { name: "ตามหมวด" }).click();

  await expect(page.getByRole("heading", { name: "ภาพรวมตามหมวด" })).toBeVisible();
  await expect(page.getByLabel("แหล่งข้อมูล")).toHaveValue("demo");
  await expect(page.getByLabel("ค้นหากลุ่ม")).toHaveValue("ลูกค้า 01");
  await expect(page.getByText("1 กลุ่ม", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /ลูกค้า 01/ }).last().click();
  const detail = page.getByRole("dialog", { name: "ลูกค้า 01" });
  await expect(detail).toBeVisible();

  await detail.getByLabel("เลือกหมวด").selectOption({ label: "ทีมงาน" });
  await detail.getByRole("button", { name: "บันทึกและล็อกหมวด" }).click();
  await expect(detail.getByText("ล็อกโดยเจ้าของ — AI จะไม่เปลี่ยนหมวดนี้")).toBeVisible();

  await detail.getByRole("button", { name: "พักกลุ่ม" }).click();
  await page.getByRole("button", { name: "ยืนยันพักกลุ่ม" }).click();
  await expect(detail.getByText("พักอยู่", { exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "เปิดติดตามกลุ่ม" }).click();
  await expect(detail.getByText("กำลังติดตาม", { exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "ปิดรายละเอียด" }).last().click();
  await page.getByRole("button", { name: "ออกจากระบบ" }).click();
  await expect(page.getByRole("heading", { name: "เลขากลุ่ม" })).toBeVisible();
});
