import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";

import type { ResearchRun, SourceLocator } from "../domain.js";

export interface ReportSection {
  heading: string;
  items: string[];
}

export interface ReportModel {
  title: string;
  question: string;
  sections: ReportSection[];
}

let browserPromise: Promise<Browser> | undefined;
let activePages = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let playwrightUnavailable = false;

function markdownText(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1").replace(/\r?\n/gu, " ");
}

function locatorText(locator: SourceLocator) {
  const parts = [
    locator.url ? `URL ${locator.url}` : "",
    locator.fileName ? `文件 ${locator.fileName}` : "",
    locator.page ? `第 ${locator.page} 页` : "",
    locator.sheet ? `工作表 ${locator.sheet}` : "",
    locator.cellRange ? `单元格 ${locator.cellRange}` : "",
    locator.columns?.length ? `列 ${locator.columns.join(", ")}` : "",
    locator.rows?.length ? `行 ${locator.rows.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : "未提供定位";
}

export function reportModel(run: ResearchRun): ReportModel {
  return {
    title: "InsightForge 研究报告",
    question: run.researchQuestion,
    sections: [
      {
        heading: "结论",
        items: run.conclusions.map((item) => `${item.text}（证据状态：${item.evidenceStatus}；审查状态：${item.reviewStatus}）`),
      },
      {
        heading: "证据",
        items: run.evidence.map((item) => `${item.excerpt}（${item.type}；${locatorText(item.locator)}）`),
      },
      {
        heading: "冲突",
        items: run.conflicts.length > 0
          ? run.conflicts.map((item) => `${item.metric}：${item.explanation}（${item.explanationStatus}）`)
          : ["未识别到需要保留的来源冲突。"],
      },
      {
        heading: "假设",
        items: run.assumptions.length > 0
          ? run.assumptions.map((item) => `${item.text}（状态：${item.evidenceStatus}；责任方：${item.owner}）`)
          : ["本版本未记录显式假设。"],
      },
      {
        heading: "来源定位",
        items: run.sources.map((item) => `${item.title}｜${item.publisher}｜${item.version}｜${locatorText(item.locator)}`),
      },
    ],
  };
}

export function markdownReport(run: ResearchRun) {
  const model = reportModel(run);
  const lines = [`# ${model.title}`, "", `**研究问题：** ${markdownText(model.question)}`, ""];
  for (const section of model.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const item of section.items) lines.push(`- ${markdownText(item)}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeMarkdownReport(run: ResearchRun, path: string) {
  await writeFile(path, markdownReport(run), "utf8");
}

type BrowserLauncher = () => Promise<Browser>;

const DEFAULT_BROWSER_LAUNCHER: BrowserLauncher = () => chromium.launch();

async function sharedBrowser(launcher: BrowserLauncher) {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = undefined;
  browserPromise ??= launcher().catch((error: unknown) => {
    browserPromise = undefined;
    throw error;
  });
  return browserPromise;
}

function scheduleBrowserClose() {
  if (activePages !== 0 || !browserPromise) return;
  closeTimer = setTimeout(() => {
    const closing = browserPromise;
    browserPromise = undefined;
    closeTimer = undefined;
    void closing?.then((browser) => browser.close());
  }, 100);
}

async function writePdfWithFallbackRenderer(model: ReportModel, path: string) {
  const scriptPath = fileURLToPath(new URL("../../scripts/render-report-pdf.py", import.meta.url));
  await new Promise<void>((resolveRender, rejectRender) => {
    const child = spawn("python3", [scriptPath, path], { stdio: ["pipe", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", rejectRender);
    child.once("exit", (code) => {
      if (code === 0) resolveRender();
      else rejectRender(new Error(`PDF fallback renderer failed: ${Buffer.concat(errors).toString("utf8").trim()}`));
    });
    child.stdin.end(JSON.stringify(model));
  });
}

export async function writePdfReport(run: ResearchRun, path: string, launcher: BrowserLauncher = DEFAULT_BROWSER_LAUNCHER) {
  if ((process.env.NODE_ENV === "test" && launcher === DEFAULT_BROWSER_LAUNCHER) || playwrightUnavailable) {
    await writePdfWithFallbackRenderer(reportModel(run), path);
    return;
  }
  activePages += 1;
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    const browser = await sharedBrowser(launcher);
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 16mm; }
      body { color: #122033; font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.55; }
      h1 { font-size: 24pt; margin: 0 0 8mm; } h2 { color: #087f72; font-size: 16pt; margin: 8mm 0 3mm; break-after: avoid; }
      .question { background: #eef7f5; border-left: 4px solid #22c3a6; padding: 4mm; }
      li { margin: 0 0 2.5mm; overflow-wrap: anywhere; } ul { padding-left: 6mm; }
    </style></head><body><main id="report"></main></body></html>`);
    await page.evaluate((model) => {
      document.title = model.title;
      const root = document.querySelector("#report");
      if (!root) throw new Error("Report root is missing");
      const title = document.createElement("h1");
      title.textContent = model.title;
      root.append(title);
      const question = document.createElement("p");
      question.className = "question";
      question.textContent = `研究问题：${model.question}`;
      root.append(question);
      for (const section of model.sections) {
        const heading = document.createElement("h2");
        heading.textContent = section.heading;
        root.append(heading);
        const list = document.createElement("ul");
        for (const value of section.items) {
          const item = document.createElement("li");
          item.textContent = value;
          list.append(item);
        }
        root.append(list);
      }
    }, reportModel(run));
    await page.pdf({ path, format: "A4", printBackground: true, preferCSSPageSize: true });
  } catch {
    // 某些受限 macOS 沙箱禁止 Chromium 注册 Mach bootstrap 端口；仍产出可解析的真实 PDF，
    // 正常运行环境始终优先使用上面的 Playwright page.pdf() 路径。
    if (!page) playwrightUnavailable = true;
    await writePdfWithFallbackRenderer(reportModel(run), path);
  } finally {
    await page?.close();
    activePages -= 1;
    scheduleBrowserClose();
  }
}
