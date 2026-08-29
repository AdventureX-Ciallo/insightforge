import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "playwright/test";
import JSZip from "jszip";

test("React workbench completes the evidence, decision, update, and delivery path", async ({ page }) => {
  test.setTimeout(60_000);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "选择一个研究选题" })).toBeVisible();
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await expect(page.getByRole("button", { name: "开始研究" })).toBeVisible();

  await page.getByText("资料库 · 验证并保存文件").click();
  await page.getByLabel("选择资料文件").setInputFiles({
    name: "market-<img src=x onerror=alert(1)>.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("year,value\n2026,42\n", "utf8"),
  });
  await expect(page.getByText("三方 SHA-256 一致 · 已安全落盘")).toBeVisible();
  await expect(page.getByText("已保存 · 将随下次运行进入证据链")).toBeVisible();

  await page.getByRole("button", { name: "开始研究" }).click();
  await expect(page.getByText(/终态 NEEDS_REVIEW/u).last()).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole("list", { name: "研究任务五状态" }).getByText("完成", { exact: true })).toHaveCount(5);

  await page.getByRole("button", { name: /第 3 步 · 研究报告/u }).click();
  await expect(page.getByRole("heading", { name: "每条结论都能说出“凭什么”" })).toBeVisible();
  const conclusions = page.locator("#chapter-report article");
  await expect(conclusions).toHaveCount(4);
  await expect(page.getByText("INSUFFICIENT_EVIDENCE").first()).toBeVisible();
  await expect(conclusions.filter({ hasText: "INSUFFICIENT_EVIDENCE" }).getByRole("button", { name: "确认" })).toBeDisabled();

  await conclusions.first().getByRole("button", { name: "查看依据" }).click();
  const evidenceDialog = page.getByRole("dialog", { name: /证据路径/u });
  await expect(evidenceDialog).toBeVisible();
  await expect(evidenceDialog.getByText("Claim", { exact: true })).toBeVisible();
  await expect(evidenceDialog.getByText("Evidence", { exact: true }).first()).toBeVisible();
  await expect(evidenceDialog.getByText("Source", { exact: true }).first()).toBeVisible();
  await expect(evidenceDialog.getByText("Locator", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "关闭证据抽屉" }).click();

  await conclusions.first().getByRole("button", { name: "驳回" }).click();
  await page.getByRole("dialog", { name: "驳回结论" }).getByRole("button", { name: "确认驳回" }).click();
  await expect(conclusions.first().getByText(/已驳回/u)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /第 4 步 · 变化/u }).click();
  await page.getByRole("button", { name: "检查来源更新" }).click();
  await expect(page.getByText("v2 已应用")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/STALE/u).first()).toBeVisible();
  await expect(page.getByText(/重算结果/u)).toBeVisible();

  await page.getByRole("button", { name: /第 5 步 · 交付/u }).click();
  await expect(page.getByRole("heading", { name: "成果交付" })).toBeVisible();
  await expect(page.getByText("PPTX · 可编辑五页模板")).toBeVisible();
  await expect(page.getByText("证据 JSON · 完整证据链")).toBeVisible();
  await expect(page.getByText("研究报告 · Markdown")).toBeVisible();
  await expect(page.getByText("研究报告 · PDF")).toBeVisible();

  const pptxCard = page.locator("#chapter-delivery .rounded-card").filter({ hasText: "PPTX · 可编辑五页模板" });
  const downloadPromise = page.waitForEvent("download");
  await pptxCard.getByRole("link", { name: "下载" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("insightforge-report.pptx");
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const pptx = await JSZip.loadAsync(await readFile(downloadedPath!));
  expect(Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))).toHaveLength(5);

  const evidenceDir = resolve("evidence", "playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, "insightforge-react-delivery.png"), fullPage: true });
  expect(externalRequests).toEqual([]);
});
