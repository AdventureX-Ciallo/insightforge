import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

import { createInsightForgeServer } from "../dist/server.js";

const root = process.cwd();
const recordings = join(root, "demo-assets", ".recordings");
const output = join(root, "demo-assets", "insightforge-demo.webm");
await mkdir(recordings, { recursive: true });
const app = createInsightForgeServer({
  fixtureDir: join(root, "fixtures", "golden"),
  publicDir: join(root, "public"),
  workspaceDir: join(root, ".insightforge", "recording"),
  stepDelayMs: 150,
});
const baseUrl = await app.start(0, "127.0.0.1");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: recordings, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const pause = (milliseconds) => page.waitForTimeout(milliseconds);
try {
  await page.goto(baseUrl);
  await pause(1200);
  await page.getByRole("button", { name: /运行黄金案例/ }).click();
  await page.waitForFunction(() => document.querySelector("#terminal-status")?.textContent === "NEEDS_REVIEW", undefined, { timeout: 15_000 });
  await pause(1200);
  await page.getByRole("button", { name: /候选结论/ }).click();
  await pause(1000);
  await page.locator(".conclusion-card").first().getByRole("button", { name: "查看依据" }).click();
  await pause(1700);
  await page.getByRole("button", { name: "关闭证据路径" }).click();
  await page.getByRole("button", { name: /证据底稿/ }).click();
  await pause(1400);
  await page.getByRole("button", { name: /审查修正/ }).click();
  await pause(1500);
  await page.getByRole("button", { name: /来源更新/ }).click();
  await pause(900);
  await page.getByRole("button", { name: /发现新版来源/ }).click();
  await page.getByText("来源已更新到 v2").waitFor();
  await pause(1600);
  await page.getByRole("button", { name: /成果交付/ }).click();
  await pause(1800);
  const video = page.video();
  await page.close();
  if (!video) throw new Error("Playwright did not create a demo video");
  await video.saveAs(output);
  console.log(output);
} finally {
  await context.close();
  await browser.close();
  await app.stop();
}
