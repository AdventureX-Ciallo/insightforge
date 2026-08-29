import { createHash } from "node:crypto";
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

  await conclusions.first().getByRole("button", { name: "确认" }).click();
  const decisionDialog = page.getByRole("dialog", { name: "确认结论" });
  await decisionDialog.getByLabel("决定理由").fill("保留双值，不把不同统计口径合并为一个事实。");
  await decisionDialog.getByLabel("适用范围").fill("仅适用于 2024 年中国新能源乘用车与全汽车销量口径对照。");
  await decisionDialog.getByRole("button", { name: "显式确认" }).click();
  await expect(conclusions.first().getByText(/已确认/u)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /第 4 步 · 变化/u }).click();
  await page.getByRole("button", { name: "检查来源更新" }).click();
  await expect(page.getByText("v2 已应用")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/STALE/u).first()).toBeVisible();
  await expect(page.getByText(/重算结果/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: "来源更新，精确影响成果" })).toBeVisible();
  await expect(page.getByRole("button", { name: /第 4 步 · 变化/u })).toHaveAttribute("aria-current", "step");

  await page.getByRole("button", { name: /第 3 步 · 研究报告/u }).click();
  const staleConclusion = page.locator("#chapter-report article").filter({ hasText: "STALE" }).first();
  await staleConclusion.getByRole("button", { name: "基于 v2 复核" }).click();
  await expect(staleConclusion.getByText("STALE", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /第 5 步 · 交付/u }).click();
  await expect(page.getByRole("heading", { name: "成果交付" })).toBeVisible();
  await expect(page.getByText(/v\d+ · 重新复核/u).first()).toBeVisible();
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

test("selected search engine is sent to the backend and labels returned candidates", async ({ page }) => {
  let observedBody: unknown;
  await page.route("**/api/sources/search", async (route) => {
    observedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        engine: "google",
        query: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
        capturedAt: "2026-08-29T00:00:00.000Z",
        dnsResolution: [],
        candidates: [{
          title: "Google 候选来源",
          url: "https://example.com/google-candidate",
          engine: "google",
          materialRole: "CANDIDATE_SOURCE",
          authorityVerified: false,
        }],
        sourceLimitTrace: { discovered: 1, retained: 1, truncated: 0, limit: 10, reason: null },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await page.getByText("实时服务 · 信源 / 核验 / 模型").click();
  await page.getByRole("button", { name: "Google", exact: true }).click();
  await page.getByRole("button", { name: "运行实时发现" }).click();

  await expect(page.getByText(/google · 命中 1 条候选来源/u)).toBeVisible();
  expect(observedBody).toEqual({
    engine: "google",
    query: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
  });
});

test("preconfigured model status displays only backend masks", async ({ page }) => {
  await page.route("**/api/settings/llm", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        source: "api",
        baseUrlMasked: "https://mo…/v1",
        modelMasked: "gpt…5",
        apiKeyMasked: "sk-…1234",
        planMaxTokens: 8192,
        synthesisMaxTokens: 16384,
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await page.getByText("实时服务 · 信源 / 核验 / 模型").click();
  await expect(page.getByText(/服务端已预配置端点：https:\/\/mo…\/v1 · gpt…5/u)).toBeVisible();
  await expect(page.getByText(/sk-…1234/u)).toHaveCount(0);
  await expect(page.getByText(/undefined/u)).toHaveCount(0);
});

test("rejected upload integrity never enters a run and backend errors stay visible", async ({ page }) => {
  const bytes = Buffer.from("year,value\n2026,42\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let runBody: { uploadIds?: string[] } | undefined;

  await page.route("**/api/uploads", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        upload: {
          id: "00000000-0000-4000-8000-000000000999",
          originalFileName: "tampered.csv",
          sanitizedFileName: "tampered.csv",
          sizeBytes: bytes.length,
          sha256,
          verificationUrl: "/api/uploads/00000000-0000-4000-8000-000000000999",
        },
      }),
    });
  });
  await page.route("**/api/uploads/00000000-0000-4000-8000-000000000999", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ upload: { sha256, hashMatches: false } }),
    });
  });
  await page.route("**/api/runs", async (route) => {
    runBody = route.request().postDataJSON() as { uploadIds?: string[] };
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "上传资料合同测试失败" }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await page.getByText("资料库 · 验证并保存文件").click();
  await page.getByLabel("选择资料文件").setInputFiles({ name: "tampered.csv", mimeType: "text/csv", buffer: bytes });
  await expect(page.getByText("哈希不一致 · 已拒绝")).toBeVisible();
  await expect(page.getByText("未加入下一次运行")).toBeVisible();

  await page.getByRole("button", { name: "开始研究" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "上传资料合同测试失败" })).toBeVisible();
  expect(runBody?.uploadIds).toEqual([]);
});

test("refresh reconnects to the backend-owned active run", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  const accepted = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.status() === 202);
  await page.getByRole("button", { name: "开始研究" }).click();
  await accepted;
  await page.reload();
  await page.getByRole("button", { name: /第 2 步 · 任务/u }).click();
  await expect(page.getByRole("button", { name: "研究进行中…" })).toBeVisible();
  await expect(page.getByText(/终态 NEEDS_REVIEW/u).last()).toBeVisible({ timeout: 25_000 });
});

test("model settings failure is not mislabeled as unconfigured", async ({ page }) => {
  await page.route("**/api/settings/llm", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Stored LLM settings are invalid" }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await page.getByText("实时服务 · 信源 / 核验 / 模型").click();
  await expect(page.getByText(/配置读取失败（HTTP 500）/u)).toBeVisible();
  await expect(page.getByText(/服务端未预配置模型端点/u)).toHaveCount(0);
});
