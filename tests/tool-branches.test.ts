import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { persistRun } from "../src/artifacts.js";
import { buildBoundaryQuestions } from "../src/boundary-questions.js";
import { hashValue } from "../src/hash.js";
import { runGoldenCase } from "../src/index.js";
import { calculateMarketMetrics } from "../src/tools/csv-calculator.js";
import { readLocalFile } from "../src/tools/local-file-reader.js";
import { writePptx } from "../src/tools/pptx-export.js";

async function temporaryFile(name: string, contents: string | Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-tool-branches-"));
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

test("CSV calculator rejects undefined/non-finite rows and missing required years", async () => {
  await assert.rejects(calculateMarketMetrics(await temporaryFile("missing-column.csv", "year,nev,total,chargers\n2024,1,2\n")), /Invalid market CSV row 2/u);
  await assert.rejects(calculateMarketMetrics(await temporaryFile("non-finite.csv", "year,nev,total,chargers\n2024,x,2,3\n")), /Invalid market CSV row 2/u);
  await assert.rejects(calculateMarketMetrics(await temporaryFile("missing-2024.csv", "year,nev,total,chargers\n2023,1,2,3\n")), /does not contain 2024/u);
  await assert.rejects(calculateMarketMetrics(await temporaryFile("missing-2023.csv", "year,nev,total,chargers\n2024,1,2,3\n")), /does not contain 2023/u);
});

test("local file reader covers CSV/TXT and XLSX fallback names, XML entities, and missing shared strings", async () => {
  const csvPath = await temporaryFile("rows.csv", "year, value,\n2025,1\n2026,2\n");
  const csv = await readLocalFile(csvPath, "CSV");
  assert.deepEqual(csv.excerpts[0]?.locator.columns, ["year", "value"]);
  assert.deepEqual(csv.excerpts[0]?.locator.rows, [2, 3]);

  const txtPath = await temporaryFile("note.txt", "plain note");
  const txt = await readLocalFile(txtPath, "TXT");
  assert.equal(txt.excerpts[0]?.text, "plain note");

  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", "<Relationships/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  zip.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>9</v></c><c r="B1"><v>&lt;&amp;&gt;&quot;&apos;</v></c></row></sheetData></worksheet>');
  const xlsxPath = await temporaryFile("fallback.xlsx", await zip.generateAsync({ type: "uint8array" }));
  const xlsx = await readLocalFile(xlsxPath, "XLSX");
  assert.equal(xlsx.excerpts[0]?.locator.sheet, "Sheet1");
  assert.match(xlsx.excerpts[0]?.text ?? "", /A1=9/u);

  const noWorkbook = new JSZip();
  noWorkbook.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>');
  const noWorkbookPath = await temporaryFile("no-workbook.xlsx", await noWorkbook.generateAsync({ type: "uint8array" }));
  assert.equal((await readLocalFile(noWorkbookPath, "XLSX")).excerpts[0]?.locator.sheet, "Sheet1");
});

test("sparse PPTX uses honest no-conflict/no-insufficient fallbacks and escapes XML", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sparse-pptx-run-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const sparse = structuredClone(run);
  sparse.researchQuestion = `XML <unsafe> & "quoted" 'value'`;
  sparse.conflicts = [];
  sparse.conclusions = sparse.conclusions.filter((item) => item.evidenceStatus !== "INSUFFICIENT_EVIDENCE");
  sparse.sources = [
    { ...sparse.sources[0]!, locator: {} },
    { ...sparse.sources[1]!, locator: { fileName: "rows.csv", rows: [2, 3] } },
    { ...sparse.sources[2]!, locator: { fileName: "page.pdf", page: 2 } },
  ];
  const path = join(workspaceDir, "sparse.pptx");
  await writePptx(sparse, path);
  const zip = await JSZip.loadAsync(await readFile(path));
  const slides = (await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).map((name) => zip.file(name)!.async("text")))).join("\n");
  assert.match(slides, /&lt;unsafe&gt; &amp; &quot;quoted&quot; &apos;value&apos;/u);
  assert.match(slides, />无</u);
  assert.match(slides, /rows 2,3/u);
  assert.match(slides, /p\.2/u);
});

test("hash, artifact path, and boundary focus fallbacks are deterministic and fail closed", async () => {
  assert.match(hashValue(undefined), /^[a-f0-9]{64}$/u);
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-artifact-path-"));
  await assert.rejects(persistRun({ id: ".." } as never, workspaceDir), /outside the allowed workspace/u);
  const questions = buildBoundaryQuestions({ researchQuestion: "??? !!!", evidenceGaps: [] } as never);
  assert.equal(questions.length, 3);
  assert.ok(questions.every((item) => item.question.includes("当前研究问题")));
});
