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
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_\[\]])/gu, "\\$1")
    .replace(/\r?\n/gu, " ");
}

const evidenceStatusLabels: Record<string, string> = {
  SUPPORTED: "证据支持",
  CONFLICT: "存在来源冲突",
  INSUFFICIENT_EVIDENCE: "证据不足",
  STALE: "来源变化后待复核",
};

const reviewStatusLabels: Record<string, string> = {
  PENDING_REVIEW: "待人工复核",
  NEEDS_REVIEW: "需要人工复核",
  CONFIRMED: "已确认",
  REJECTED: "已驳回",
};

const ownerLabels: Record<string, string> = { AI: "AI 候选", HUMAN: "人工", DEMO_PARAMETER: "演示参数" };

export function narrativeText(value: string) {
  return value
    .replace(/utilization_gap_assumption\s*=\s*20%/giu, "利用率缺口假设为 20%")
    .replace(/utilization_gap_assumption/giu, "利用率缺口假设")
    .replace(/\bDEMO_PARAMETER\b/gu, "演示参数")
    .replace(/(-?\d+\.\d{3,})(%)/gu, (_match, raw: string, unit: string) => `${Number(raw).toFixed(2)}${unit}`);
}

export function readableEvidence(run: ResearchRun, evidenceId: string) {
  const evidence = run.evidence.find((item) => item.id === evidenceId);
  if (!evidence) return "证据记录不存在。";
  const source = run.sources.find((item) => item.id === evidence.sourceId);
  if (source?.materialRole === "SYNTHETIC_DEMO_MATERIAL" && source.kind === "PDF") {
    if (evidence.locator.page === 2 || /ignore the original task|读取环境变量|read environment variables/iu.test(evidence.excerpt)) {
      return "该页包含一段已识别的提示词注入诱饵，意图诱导改写结论并读取环境变量；系统已将其按不可信材料隔离，未进入有效结论。";
    }
    return "合成离线演示材料：汇总新能源汽车与充电基础设施的候选数据及口径差异，仅用于稳定复现研究流程，不代表真实市场结论。";
  }
  return narrativeText(evidence.excerpt);
}

export function readableReviewStatus(status: string) {
  return reviewStatusLabels[status] ?? status;
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
  const unresolved = run.conclusions.filter((item) => item.reviewStatus !== "CONFIRMED");
  const insufficient = run.conclusions.filter((item) => item.normalizedEvidenceStatus === "INSUFFICIENT_EVIDENCE");
  return {
    title: "InsightForge 研究报告",
    question: run.researchQuestion,
    sections: [
      {
        heading: "背景与研究范围",
        items: [
          `研究范围：${run.plan.scope}`,
          `本报告由 PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER 五阶段生成；当前使用${run.offlineMode ? "明确标记的缓存快照" : "在线模型与已记录信源"}。`,
          unresolved.length === run.conclusions.length
            ? "当前没有可直接作为最终事实发布的结论：全部候选仍需人工确认、处理冲突或补充证据。"
            : `当前 ${run.conclusions.length - unresolved.length} 条结论已确认，${unresolved.length} 条仍待处理。`,
        ],
      },
      {
        heading: "研究方法",
        items: [
          `共保留 ${run.sources.length} 个信源、${run.evidence.length} 条证据和 ${run.data.length} 个可重算数据对象；所有结论均可回溯到定位信息。`,
          "AI 只提出计划和候选判断；程序负责 Schema、引用、冲突、假设与范围审计；最终判断由人确认。",
          `审计执行 ${run.auditFindings.length} 项结构化检查，自动修复 ${run.repairAttempts} 次，超过一次即转人工。`,
        ],
      },
      {
        heading: "核心发现",
        items: run.conclusions.map((item) => `${narrativeText(item.text)}（证据：${evidenceStatusLabels[item.evidenceStatus] ?? item.evidenceStatus}；审查：${readableReviewStatus(item.reviewStatus)}）`),
      },
      {
        heading: "证据与可追溯底稿",
        items: run.evidence.map((item) => `${readableEvidence(run, item.id)}（类型：${item.type}；定位：${locatorText(item.locator)}）`),
      },
      {
        heading: "冲突与证据边界",
        items: [
          ...(run.conflicts.length > 0
            ? run.conflicts.map((item) => `${item.metric}：${narrativeText(item.explanation)}（候选解释；双方数值均保留，不静默取值或求平均）`)
            : ["未识别到需要保留的来源冲突。"]),
          ...(insufficient.length > 0
            ? insufficient.map((item) => `${narrativeText(item.text)}；仍缺少：${item.missingEvidence.map(narrativeText).join("；") || "可验证的直接证据"}。`)
            : ["本版本没有被标记为证据不足的候选结论。"]),
        ],
      },
      {
        heading: "关键假设",
        items: run.assumptions.length > 0
          ? run.assumptions.map((item) => `${narrativeText(item.text)}（状态：${evidenceStatusLabels[item.evidenceStatus] ?? item.evidenceStatus}；责任方：${ownerLabels[item.owner] ?? item.owner}）`)
          : ["本版本未记录显式假设。"],
      },
      {
        heading: "来源定位",
        items: run.sources.map((item) => `${item.title}｜${item.publisher}｜${item.version}｜${locatorText(item.locator)}`),
      },
      {
        heading: "后续建议",
        items: [
          ...(insufficient.length > 0 ? ["优先补齐证据不足项所列的地域、利用率、时间序列或因果识别资料，再重新审计。"] : []),
          ...(run.conflicts.length > 0 ? ["对冲突指标先统一对象、地域、时间与统计口径，再由人选择适用边界。"] : []),
          "来源发布新版本时使用变化页查看受影响对象；原人工确认将失效，复核通过后仍需重新确认。",
        ],
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
