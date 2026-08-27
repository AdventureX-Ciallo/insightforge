import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "playwright/test";

test("golden case reaches an editable, traceable, update-aware delivery", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /让每条行业判断/ })).toBeVisible();
  await expect(page.getByText("使用缓存快照").first()).toBeVisible();

  await page.locator("#source-file").setInputFiles({
    name: "market-<img src=x onerror=alert(1)>.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("year,value\n2026,42\n", "utf8"),
  });
  await page.getByRole("button", { name: "验证并上传资料" }).click();
  await expect(page.locator("#upload-result")).toContainText("已持久化并复核");
  await expect(page.locator("#upload-result")).toContainText("所选文件 SHA-256 一致");
  await expect(page.locator("#upload-result")).toContainText(/SHA-256 [a-f0-9]{64}/);
  await expect(page.locator("#upload-result img")).toHaveCount(0);

  await page.getByRole("button", { name: /运行黄金案例/ }).click();
  await expect(page.locator(".state-card.running")).toBeVisible();
  await expect(page.locator("#terminal-status")).toHaveText("NEEDS_REVIEW", { timeout: 15_000 });
  await expect(page.locator(".state-card.success")).toHaveCount(5);
  await expect(page.locator(".tool-row")).toHaveCount(4);

  await page.getByRole("button", { name: /候选结论/ }).click();
  await expect(page.locator(".conclusion-card")).toHaveCount(4);
  await expect(page.getByText("INSUFFICIENT_EVIDENCE").first()).toBeVisible();
  const insufficient = page.locator(".conclusion-card.insufficient");
  await expect(insufficient.getByRole("button", { name: "确认" })).toBeDisabled();
  await expect(insufficient.getByRole("button", { name: "编辑" })).toBeEnabled();

  await page.locator(".conclusion-card").first().getByRole("button", { name: "查看依据" }).click();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await expect(page.locator("#drawer-content")).toContainText("CONCLUSION");
  await expect(page.locator("#drawer-content")).toContainText("SOURCE");
  await expect(page.locator("#drawer-content")).toContainText("market_v1.csv");
  await page.getByRole("button", { name: "关闭证据路径" }).click();

  const charging = page.locator(".conclusion-card").nth(1);
  await charging.getByRole("button", { name: "编辑" }).click();
  await page.locator("#edit-text").fill("人工修订：名义供给增长不能替代区域利用率验证。");
  await page.getByRole("button", { name: "保存并确认" }).click();
  await expect(charging).toContainText("HUMAN_CONFIRMED");

  await page.getByRole("button", { name: /审查修正/ }).click();
  await expect.poll(() => page.locator(".audit-card").count()).toBeGreaterThanOrEqual(6);
  await expect(page.getByText("MISSING_ASSUMPTION", { exact: true })).toBeVisible();
  await expect(page.getByText("BEFORE").first()).toBeVisible();
  await expect(page.getByText("AFTER").first()).toBeVisible();

  await page.getByRole("button", { name: /来源更新/ }).click();
  await page.getByRole("button", { name: /发现新版来源/ }).click();
  await expect(page.getByText("来源已更新到 v2")).toBeVisible();
  await expect(page.locator(".impact")).toHaveCount(5);

  await page.getByRole("button", { name: /成果交付/ }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(3);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载 PPTX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("insightforge-report.pptx");

  const evidenceDir = resolve("evidence", "playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, "insightforge-artifacts.png"), fullPage: true });
  expect(externalRequests).toEqual([]);
});
