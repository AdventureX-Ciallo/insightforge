import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

import { createInsightForgeServer } from "../dist/server.js";

const root = process.cwd();
const recordings = join(root, "demo-assets", ".recordings");
const videoOutput = join(root, "demo-assets", "insightforge-demo.webm");
const imageDir = join(root, "docs", "assets");
const recordingWorkspace = join(root, ".insightforge", "recording");
await rm(recordingWorkspace, { recursive: true, force: true });
await mkdir(recordings, { recursive: true });
await mkdir(imageDir, { recursive: true });

const app = createInsightForgeServer({
  fixtureDir: join(root, "fixtures", "golden"),
  publicDir: join(root, "public"),
  workspaceDir: recordingWorkspace,
  stepDelayMs: 150,
});
const baseUrl = await app.start(0, "127.0.0.1");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: recordings, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
page.setDefaultTimeout(25_000);

const pause = (milliseconds) => page.waitForTimeout(milliseconds);
const clearCaption = async () => {
  await page.evaluate(() => document.querySelector("#insightforge-demo-caption")?.remove());
  await pause(250);
};
const screenshot = async (name) => {
  await clearCaption();
  await pause(750);
  await page.screenshot({ path: join(imageDir, name), animations: "disabled" });
};
const showCaption = async (title, body, milliseconds = 5_000) => {
  await page.evaluate(({ title, body }) => {
    document.querySelector("#insightforge-demo-caption")?.remove();
    const caption = document.createElement("section");
    caption.id = "insightforge-demo-caption";
    caption.setAttribute("aria-label", "演示讲解字幕");
    caption.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "left:50%",
      "top:22px",
      "transform:translateX(-50%)",
      "width:min(1120px,calc(100vw - 64px))",
      "padding:16px 22px",
      "border:1px solid rgba(255,255,255,.20)",
      "border-radius:18px",
      "background:rgba(22,20,29,.92)",
      "box-shadow:0 18px 60px rgba(0,0,0,.22)",
      "color:#fff",
      "font-family:-apple-system,BlinkMacSystemFont,'Noto Sans SC',sans-serif",
      "pointer-events:none",
    ].join(";");
    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.cssText = "font-size:22px;font-weight:750;letter-spacing:.02em";
    const detail = document.createElement("div");
    detail.textContent = body;
    detail.style.cssText = "margin-top:5px;font-size:15px;line-height:1.55;color:rgba(255,255,255,.82)";
    caption.append(heading, detail);
    document.body.append(caption);
  }, { title, body });
  await pause(milliseconds);
};

try {
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "选择一个研究选题" }).waitFor();
  await showCaption(
    "InsightForge · Proof of Insight",
    "从一个行业问题，到一份能下钻、能质疑、能更新的研究成果。",
    6_000,
  );
  await showCaption(
    "01 选择研究问题",
    "黄金案例离线可运行；边界案例用于证明系统不会把已有材料硬套到无关问题。",
    6_000,
  );

  await page.getByRole("button", { name: /全功能研究案例/u }).click();
  await page.getByRole("button", { name: "开始研究" }).waitFor();
  await showCaption(
    "02 接住整个任务",
    "点击一次开始研究，后端真实推进 PLAN、COLLECT、SYNTHESIZE、AUDIT、DELIVER。",
    5_000,
  );
  await page.getByRole("button", { name: "开始研究" }).click();
  await page.getByText(/终态 NEEDS_REVIEW/u).last().waitFor();
  await page.getByRole("list", { name: "研究任务五状态" }).scrollIntoViewIfNeeded();
  await screenshot("insightforge-task-chain.png");
  await showCaption(
    "五状态 + 四类真实工具",
    "搜索快照、PDF、本地表格计算和可编辑 PPTX 进入同一条事件链；任一步失败都不会伪装为全局成功。",
    10_000,
  );

  await page.getByRole("button", { name: /第 3 步 · 研究报告/u }).click();
  await page.getByRole("heading", { name: "每条结论都能说出“凭什么”" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot("insightforge-workbench.png");
  await showCaption(
    "03 模型提出，程序校验，人负责判断",
    "冲突双值平等保留；证据不足不能确认；计算、估算、AI 判断和人工状态分别存储。",
    10_000,
  );

  const conclusions = page.locator("#chapter-report article");
  await conclusions.first().getByRole("button", { name: "查看依据" }).click();
  await page.getByRole("dialog", { name: /证据路径/u }).waitFor();
  await screenshot("insightforge-evidence-drilldown.png");
  await showCaption(
    "高光一：两次操作追到底稿",
    "Conclusion → Claim → Evidence / Datum → Source → Locator；网页、PDF 页码、CSV 行号和公式都可核查。",
    12_000,
  );
  await page.getByRole("button", { name: "关闭证据抽屉" }).click();

  await conclusions.first().getByRole("button", { name: "确认" }).click();
  const decisionDialog = page.getByRole("dialog", { name: "确认结论" });
  await decisionDialog.getByLabel("决定理由").fill("保留双值，不把不同统计口径合并为一个事实。");
  await decisionDialog.getByLabel("适用范围").fill("仅适用于 2024 年中国新能源乘用车与全汽车销量口径对照。");
  await decisionDialog.getByRole("button", { name: "显式确认" }).click();
  await conclusions.first().getByText(/已确认/u).waitFor();
  await showCaption(
    "人工承担最终责任",
    "确认会记录时间、理由和适用范围；原始模型文本仍作为历史保留。",
    8_000,
  );

  await page.getByRole("button", { name: /第 4 步 · 变化/u }).click();
  await page.getByRole("heading", { name: "来源更新，精确影响成果" }).waitFor();
  await showCaption(
    "04 跟踪变化",
    "内置来源从 v1 更新为 v2。系统沿证据依赖图定位受影响对象，而不是覆盖整份报告。",
    7_000,
  );
  await page.getByRole("button", { name: "检查来源更新" }).click();
  await page.getByText("v2 已应用").waitFor();
  const updateNav = page.getByRole("button", { name: /第 4 步 · 变化/u });
  if (await updateNav.getAttribute("aria-current") !== "step") await updateNav.click();
  await page.getByRole("heading", { name: "来源更新，精确影响成果" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot("insightforge-source-update.png");
  await showCaption(
    "高光二：变化精确传播",
    "相关 Datum、Claim、Conclusion 和人工确认变为 STALE / NEEDS_REVIEW；无关结论保持不变，旧决定和旧成果仍可审计。",
    12_000,
  );

  await page.getByRole("button", { name: /第 3 步 · 研究报告/u }).click();
  const staleConclusion = page.locator("#chapter-report article").filter({ hasText: "STALE" }).first();
  await staleConclusion.getByRole("button", { name: "基于 v2 复核" }).click();
  await staleConclusion.getByText("STALE", { exact: true }).waitFor({ state: "detached" });
  await showCaption(
    "重新复核后恢复 CURRENT",
    "受影响结论使用 v2 重新计算并生成新的成果版本；人工决定仍须重新作出。",
    8_000,
  );

  await page.getByRole("button", { name: /第 5 步 · 交付/u }).click();
  await page.getByRole("heading", { name: "成果交付" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot("insightforge-delivery.png");
  await showCaption(
    "05 交付可继续编辑的成果",
    "交互报告、五页可编辑 PPTX、证据 JSON、Markdown 和 PDF 共享同一研究快照，并保留冲突、假设与待审状态。",
    12_000,
  );

  await page.getByRole("button", { name: /第 2 步 · 任务/u }).click();
  await page.getByRole("button", { name: "重置工作台" }).click();
  await page.getByRole("button", { name: /第 1 步 · 选题/u }).click();
  await page.getByRole("heading", { name: "选择一个研究选题" }).waitFor();
  await showCaption(
    "边界不是失败，而是可信度",
    "换成资料不匹配的问题时，系统返回 EvidenceGap 和所缺信源，不复用新能源汽车的预写结论。",
    9_000,
  );
  await showCaption(
    "InsightForge",
    "AI 不止完成一步；让每条行业判断，经得起追问。",
    7_000,
  );

  await clearCaption();
  const video = page.video();
  await page.close();
  if (!video) throw new Error("Playwright did not create a demo video");
  await video.saveAs(videoOutput);
  console.log(JSON.stringify({
    video: videoOutput,
    images: [
      "insightforge-workbench.png",
      "insightforge-task-chain.png",
      "insightforge-evidence-drilldown.png",
      "insightforge-source-update.png",
      "insightforge-delivery.png",
    ].map((name) => join(imageDir, name)),
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await app.stop();
}
