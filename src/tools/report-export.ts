import { writeFile } from "node:fs/promises";

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

function pdfHexText(value: string) {
  const littleEndian = Buffer.from(value, "utf16le");
  for (let index = 0; index < littleEndian.length; index += 2) {
    const first = littleEndian[index]!;
    littleEndian[index] = littleEndian[index + 1]!;
    littleEndian[index + 1] = first;
  }
  return littleEndian.toString("hex").toUpperCase();
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

function pdfBuffer(model: ReportModel) {
  const pages: string[][] = [];
  const lines = reportLines(model);
  for (let offset = 0; offset < lines.length; offset += 44) pages.push(lines.slice(offset, offset + 44));
  const pageObjectIds = pages.map((_page, index) => 6 + index * 2);
  const codeUnits = [...new Set(lines.flatMap((line) => Array.from({ length: line.length }, (_value, index) => line.charCodeAt(index))))].sort((left, right) => left - right);
  const mappings: string[] = [];
  for (let offset = 0; offset < codeUnits.length; offset += 100) {
    const group = codeUnits.slice(offset, offset + 100);
    mappings.push(`${group.length} beginbfchar`);
    for (const codeUnit of group) {
      const code = codeUnit.toString(16).toUpperCase().padStart(4, "0");
      mappings.push(`<${code}> <${code}>`);
    }
    mappings.push("endbfchar");
  }
  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${mappings.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
    `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`,
  ];
  pages.forEach((pageLines, index) => {
    const pageObjectId = pageObjectIds[index]!;
    const contentObjectId = pageObjectId + 1;
    const commands = ["BT", "/F1 10 Tf", "48 800 Td", "14 TL"];
    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) commands.push("T*");
      const text = pdfHexText(line);
      commands.push(`/Span << /ActualText <FEFF${text}> >> BDC`, `<${text}> Tj`, "EMC");
    });
    commands.push("ET");
    const stream = `${commands.join("\n")}\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  });

  const chunks = [Buffer.from("%PDF-1.4\n%InsightForge\n", "ascii")];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"));
  });
  const xrefOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("\n");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

async function writePureNodePdf(model: ReportModel, path: string) {
  await writeFile(path, pdfBuffer(model));
}

export async function writePdfReport(run: ResearchRun, path: string) {
  // 交付路径保持确定性：Type0/CID + ActualText，不启动浏览器，也不依赖 Python、ReportLab 或系统包。
  await writePureNodePdf(reportModel(run), path);
}
