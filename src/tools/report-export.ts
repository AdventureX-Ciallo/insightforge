import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";

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

function markdownText(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|<>])/gu, "\\$1").replace(/\r?\n/gu, " ");
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

function reportLines(model: ReportModel) {
  const lines = [model.title, `研究问题：${model.question}`];
  for (const section of model.sections) {
    lines.push(section.heading);
    for (const item of section.items) {
      const characters = [...item.replace(/\s+/gu, " ").trim()];
      for (let offset = 0; offset < characters.length; offset += 42) {
        lines.push(`${offset === 0 ? "- " : "  "}${characters.slice(offset, offset + 42).join("")}`);
      }
    }
  }
  return lines;
}

async function writePureNodePdf(model: ReportModel, path: string) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const require = createRequire(import.meta.url);
  const fontPath = require.resolve("@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf");
  // pdf-lib/fontkit currently corrupts some CFF glyph references when subsetting this
  // 65k-glyph font. Full embedding is larger but renders correctly in PDFium/Poppler/WPS.
  const font = await pdf.embedFont(await readFile(fontPath), { subset: false });
  const stableDate = new Date("2020-01-01T00:00:00.000Z");
  pdf.setTitle(model.title);
  pdf.setProducer("InsightForge");
  pdf.setCreator("InsightForge");
  pdf.setCreationDate(stableDate);
  pdf.setModificationDate(stableDate);
  const lines = reportLines(model);
  for (let offset = 0; offset < lines.length; offset += 44) {
    const page = pdf.addPage([595, 842]);
    lines.slice(offset, offset + 44).forEach((line, index) => {
      page.drawText(line, { x: 48, y: 800 - index * 17, size: 10, font });
    });
  }
  await writeFile(path, await pdf.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: Number.POSITIVE_INFINITY }));
}

export async function writePdfReport(run: ResearchRun, path: string) {
  // 交付路径保持纯 Node；内嵌 Noto Sans CJK SC，不依赖查看器字体替换。
  await writePureNodePdf(reportModel(run), path);
}
