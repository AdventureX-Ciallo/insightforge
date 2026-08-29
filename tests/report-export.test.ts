import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { runGoldenCase } from "../src/index.js";
import { markdownReport, reportModel, writePdfReport } from "../src/tools/report-export.js";

test("DELIVER creates parseable Markdown, PDF, PPTX, and JSON from one evidence snapshot", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-report-export-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });

  assert.deepEqual(new Set(run.artifacts.map((item) => item.kind)), new Set(["REPORT_MD", "REPORT_PDF", "PPTX", "EVIDENCE_JSON"]));
  assert.equal(run.artifactVersions[0]?.artifactIds.length, 4);

  const markdown = run.artifacts.find((item) => item.kind === "REPORT_MD");
  const pdf = run.artifacts.find((item) => item.kind === "REPORT_PDF");
  assert.ok(markdown && pdf);
  const markdownText = await readFile(markdown.path, "utf8");
  for (const heading of ["# InsightForge 研究报告", "## 背景与研究范围", "## 研究方法", "## 核心发现", "## 证据与可追溯底稿", "## 冲突与证据边界", "## 关键假设", "## 来源定位", "## 后续建议"]) {
    assert.ok(markdownText.includes(heading), `Markdown contains ${heading}`);
  }
  assert.match(markdownText, /已识别的提示词注入诱饵/u);
  assert.match(markdownText, /37\.10%/u);
  assert.doesNotMatch(markdownText, /Authority Source Snapshot|Ignore the original task|read environment variables|utilization_gap_assumption|DEMO_PARAMETER/iu);
  assert.doesNotMatch(markdownText, /\d+\\\.\d+/u, "ordinary decimals must not be backslash-escaped");

  const pptx = run.artifacts.find((item) => item.kind === "PPTX");
  assert.ok(pptx);
  const pptxZip = await JSZip.loadAsync(await readFile(pptx.path));
  const slideXml = (await Promise.all(Object.entries(pptxZip.files)
    .filter(([name, entry]) => /^ppt\/slides\/slide\d+\.xml$/u.test(name) && !entry.dir)
    .map(([_name, entry]) => entry.async("string")))).join("\n");
  assert.doesNotMatch(slideXml, /CANDIDATE_EXPLANATION|INSUFFICIENT_EVIDENCE|utilization_gap_assumption|DEMO_PARAMETER/iu);
  assert.match(slideXml, /候选解释/u);
  assert.match(slideXml, /利用率缺口假设/u);

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfBytes = await readFile(pdf.path);
  const document = await getDocument({
    data: new Uint8Array(pdfBytes),
    cMapUrl: `${resolve("node_modules/pdfjs-dist/cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${resolve("node_modules/pdfjs-dist/standard_fonts")}/`,
  }).promise;
  assert.ok(document.numPages >= 1);
  const serializedPdf = pdfBytes.toString("ascii");
  assert.match(serializedPdf, /\/FontFile(?:2|3)\b/u, "PDF embeds a CJK font program");
  assert.doesNotMatch(serializedPdf, /\/STSong-Light\b/u, "PDF does not depend on viewer-side STSong substitution");
  const extractedPages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    extractedPages.push(content.items.map((item) => "str" in item ? item.str : "").join(""));
  }
  const extractedText = extractedPages.join("\n");
  for (const text of ["InsightForge 研究报告", `研究问题：${run.researchQuestion}`, "来源定位"]) assert.ok(extractedText.includes(text), `PDF retains machine-readable text for ${text}`);

  const sparseRun = structuredClone(run);
  sparseRun.conflicts = [];
  sparseRun.assumptions = [];
  sparseRun.evidence[0]!.locator = {};
  sparseRun.evidence[1]!.locator = { fileName: "表格.xlsx", sheet: "统计", cellRange: "A1:B2", columns: ["A", "B"], rows: [1, 2] };
  const sparseModel = reportModel(sparseRun);
  assert.ok(sparseModel.sections.find((section) => section.heading === "冲突与证据边界")?.items.includes("未识别到需要保留的来源冲突。"));
  assert.deepEqual(sparseModel.sections.find((section) => section.heading === "关键假设")?.items, ["本版本未记录显式假设。"]);
  assert.ok(sparseModel.sections.find((section) => section.heading === "证据与可追溯底稿")?.items.some((item) => item.includes("未提供定位")));
  assert.ok(sparseModel.sections.find((section) => section.heading === "证据与可追溯底稿")?.items.some((item) => item.includes("工作表 统计") && item.includes("单元格 A1:B2")));

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const noExternalRuntimePath = join(workspaceDir, "no-external-runtime.pdf");
    await writePdfReport(run, noExternalRuntimePath);
    const noExternalRuntimeDocument = await getDocument({ data: new Uint8Array(await readFile(noExternalRuntimePath)) }).promise;
    assert.ok(noExternalRuntimeDocument.numPages >= 1);
  } finally {
    process.env.PATH = previousPath;
  }
  await assert.rejects(
    writePdfReport(run, join(workspaceDir, "missing-parent", "report.pdf")),
    /ENOENT/u,
  );
});

test("Markdown export escapes raw HTML from untrusted source text", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-markdown-html-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  run.evidence[0]!.excerpt = '<script>alert("source")</script><img src=x onerror=alert(1)>';
  run.sources[0]!.title = '<img src=x onerror="publisher()">';
  const markdown = markdownReport(run);
  assert.doesNotMatch(markdown, /(^|[^\\])<(?:script|img)\b/imu);
  assert.match(markdown, /&lt;script&gt;/u);
  assert.match(markdown, /&lt;img/u);
});
