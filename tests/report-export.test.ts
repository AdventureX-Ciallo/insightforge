import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase } from "../src/index.js";
import { reportModel, writePdfReport } from "../src/tools/report-export.js";

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
  for (const heading of ["# InsightForge 研究报告", "## 结论", "## 证据", "## 冲突", "## 假设", "## 来源定位"]) {
    assert.ok(markdownText.includes(heading), `Markdown contains ${heading}`);
  }

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(await readFile(pdf.path)),
    cMapUrl: `${resolve("node_modules/pdfjs-dist/cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${resolve("node_modules/pdfjs-dist/standard_fonts")}/`,
  }).promise;
  assert.ok(document.numPages >= 1);
  const pageTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
  }
  const extracted = pageTexts.join("\n");
  assert.match(extracted, /InsightForge 研究报告/u);
  assert.match(extracted, /中国新能源乘用车渗透率/u);
  assert.match(extracted, /来源定位/u);

  const sparseRun = structuredClone(run);
  sparseRun.conflicts = [];
  sparseRun.assumptions = [];
  sparseRun.evidence[0]!.locator = {};
  sparseRun.evidence[1]!.locator = { fileName: "表格.xlsx", sheet: "统计", cellRange: "A1:B2", columns: ["A", "B"], rows: [1, 2] };
  const sparseModel = reportModel(sparseRun);
  assert.deepEqual(sparseModel.sections.find((section) => section.heading === "冲突")?.items, ["未识别到需要保留的来源冲突。"]);
  assert.deepEqual(sparseModel.sections.find((section) => section.heading === "假设")?.items, ["本版本未记录显式假设。"]);
  assert.ok(sparseModel.sections.find((section) => section.heading === "证据")?.items.some((item) => item.includes("未提供定位")));
  assert.ok(sparseModel.sections.find((section) => section.heading === "证据")?.items.some((item) => item.includes("工作表 统计") && item.includes("单元格 A1:B2")));

  class FakeElement {
    className = "";
    textContent = "";
    children: FakeElement[] = [];
    append(...items: FakeElement[]) { this.children.push(...items); }
  }
  const roots: Array<FakeElement | null> = [null, new FakeElement(), new FakeElement()];
  const pdfCalls: unknown[] = [];
  let pageCloses = 0;
  let browserCloses = 0;
  let launches = 0;
  const fakeBrowser = {
    async newPage() {
      const root = roots.length > 0 ? roots.shift()! : new FakeElement();
      return {
        async setContent(html: string) { assert.match(html, /<main id="report">/u); },
        async evaluate(callback: (value: unknown) => void, value: unknown) {
          const previous = (globalThis as { document?: unknown }).document;
          (globalThis as { document?: unknown }).document = {
            title: "",
            querySelector: () => root,
            createElement: () => new FakeElement(),
          };
          try { callback(value); } finally { (globalThis as { document?: unknown }).document = previous; }
        },
        async pdf(options: unknown) { pdfCalls.push(options); },
        async close() { pageCloses += 1; },
      };
    },
    async close() { browserCloses += 1; },
  };
  const launcher = async () => {
    launches += 1;
    return fakeBrowser as never;
  };
  const fallbackPath = join(workspaceDir, "fake-browser-fallback.pdf");
  await writePdfReport(sparseRun, fallbackPath, launcher);
  const browserPath = join(workspaceDir, "fake-browser-success.pdf");
  await writePdfReport(run, browserPath, launcher);
  assert.equal(launches, 1, "a pending close is cancelled and the shared browser is reused");
  assert.equal(pageCloses, 2);
  assert.deepEqual(pdfCalls, [{ path: browserPath, format: "A4", printBackground: true, preferCSSPageSize: true }]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  assert.equal(browserCloses, 1);

  const launchFailurePdf = join(workspaceDir, "launch-failure.pdf");
  await writePdfReport(run, launchFailurePdf, async () => { throw new Error("sandbox blocks browser"); });
  const recovered = await getDocument({ data: new Uint8Array(await readFile(launchFailurePdf)) }).promise;
  assert.ok(recovered.numPages >= 1);

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(writePdfReport(run, join(workspaceDir, "no-python.pdf")), /spawn python3 ENOENT/u);
  } finally {
    process.env.PATH = previousPath;
  }
  await assert.rejects(
    writePdfReport(run, join(workspaceDir, "missing-parent", "report.pdf")),
    /PDF fallback renderer failed/u,
  );
});
