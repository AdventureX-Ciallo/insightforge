import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { atomicWriteUtf8 } from "../src/atomic-file.js";
import { persistRun } from "../src/artifacts.js";
import { buildBoundaryQuestions } from "../src/boundary-questions.js";
import { hashValue } from "../src/hash.js";
import { runGoldenCase } from "../src/index.js";
import { calculateMarketMetrics } from "../src/tools/csv-calculator.js";
import { parseCsv } from "../src/tools/csv-parser.js";
import { readLocalFile } from "../src/tools/local-file-reader.js";
import { assertPdfPageCount, MAX_PDF_PAGES } from "../src/tools/pdf-reader.js";
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
  await assert.rejects(calculateMarketMetrics(await temporaryFile("zero-sales.csv", "year,nev,total,chargers\n2023,1,2,3\n2024,1,0,4\n")), /denominator must not be zero/u);
  await assert.rejects(calculateMarketMetrics(await temporaryFile("zero-chargers.csv", "year,nev,total,chargers\n2023,1,2,0\n2024,1,2,4\n")), /denominator must not be zero/u);
  assert.doesNotThrow(() => assertPdfPageCount(MAX_PDF_PAGES));
  assert.throws(() => assertPdfPageCount(MAX_PDF_PAGES + 1), /page parsing limit/u);
  assert.throws(() => assertPdfPageCount(0), /invalid page count/u);
});

test("CSV parsing preserves quoted commas, escaped quotes, embedded newlines, and logical row locators", async () => {
  const text = '\uFEFF"地区,范围","说""明"\r\n"北京,上海","第一行\r\n第二行"\r\n广州,普通\r\n';
  assert.deepEqual(parseCsv(text), [
    { recordNumber: 1, fields: ["地区,范围", '说"明'] },
    { recordNumber: 2, fields: ["北京,上海", "第一行\r\n第二行"] },
    { recordNumber: 3, fields: ["广州", "普通"] },
  ]);
  const path = await temporaryFile("quoted.csv", text);
  const result = await readLocalFile(path, "CSV");
  assert.deepEqual(result.excerpts[0]?.locator.columns, ["地区,范围", '说"明']);
  assert.deepEqual(result.excerpts[0]?.locator.rows, [2, 3]);

  const metricsPath = await temporaryFile("quoted-market.csv", 'year,nev,total,chargers\r\n"2023","1","2","3"\r\n"2024","4","8","6"\r\n');
  const metrics = await calculateMarketMetrics(metricsPath);
  assert.equal(metrics.penetration, 50);
  assert.equal(metrics.chargerGrowth, 100);
  assert.deepEqual(metrics.rows.map((row) => row.rowNumber), [2, 3]);

  assert.throws(() => parseCsv('a,b\n"open'), /unclosed quoted field/u);
  assert.throws(() => parseCsv('a,b\nun"safe,1'), /quote inside an unquoted field/u);
  assert.throws(() => parseCsv('a,b\n"closed"x,1'), /unexpected character after closing quote/u);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("single"), [{ recordNumber: 1, fields: ["single"] }]);
  await assert.rejects(readLocalFile(await temporaryFile("empty.csv", ""), "CSV"), /no header row/u);
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

test("XLSX cells cannot borrow values across empty or style-only neighbors", async () => {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", '<workbook><sheets><sheet name="Sparse" sheetId="1"/></sheets></workbook>');
  zip.file("xl/worksheets/sheet1.xml", [
    "<worksheet><sheetData><row r=\"1\">",
    '<c r="A1"><v>0</v></c>',
    '<c r="B1" s="1"/>',
    '<c r="C1"><v>3</v></c>',
    '<c r="D1" s="2"></c>',
    '<c r="E1" t="str"><v>&lt;&amp;&gt;&quot;&apos;</v></c>',
    '<c r="F1" t="inlineStr"><is><t>A&amp;B</t></is></c>',
    '<c r="G1"><f>1+1</f></c>',
    '<c r="H1"><f>4+4</f><v>8</v></c>',
    "</row></sheetData></worksheet>",
  ].join(""));
  const path = await temporaryFile("sparse-cells.xlsx", await zip.generateAsync({ type: "uint8array" }));
  const result = await readLocalFile(path, "XLSX");
  assert.equal(result.excerpts[0]?.locator.cellRange, "A1:H1");
  assert.equal(result.excerpts[0]?.text, `A1=0；C1=3；E1=<&>"'；F1=A&B；H1=8`);
  assert.doesNotMatch(result.excerpts[0]?.text ?? "", /B1=3|D1=|G1=/u);
});

test("XLSX worksheet parts are paired to workbook names in numeric order", async () => {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", '<workbook><sheets><sheet name="Two" sheetId="2"/><sheet name="Ten" sheetId="10"/></sheets></workbook>');
  zip.file("xl/worksheets/sheet10.xml", '<worksheet><sheetData><row r="1"><c r="A1"><v>10</v></c></row></sheetData></worksheet>');
  zip.file("xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>');
  const path = await temporaryFile("numeric-sheet-order.xlsx", await zip.generateAsync({ type: "uint8array" }));
  const result = await readLocalFile(path, "XLSX");
  assert.deepEqual(result.excerpts.map((excerpt) => [excerpt.locator.sheet, excerpt.text]), [["Two", "A1=2"], ["Ten", "A1=10"]]);
});

test("sparse PPTX uses honest no-conflict/no-insufficient fallbacks and escapes XML", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sparse-pptx-run-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const linkedAssumption = structuredClone(run);
  linkedAssumption.data.find((item) => item.id === "datum-adequacy-estimate")!.assumptions = ["assumption-utilization-gap"];
  const linkedAssumptionPath = join(workspaceDir, "linked-assumption.pptx");
  await writePptx(linkedAssumption, linkedAssumptionPath);
  const linkedAssumptionZip = await JSZip.loadAsync(await readFile(linkedAssumptionPath));
  assert.match(await linkedAssumptionZip.file("ppt/slides/slide3.xml")!.async("text"), /15% 利用率折损仅用于演示情景/u);
  const sparse = structuredClone(run);
  sparse.researchQuestion = `XML <unsafe> & "quoted" 'value'`;
  sparse.conflicts = [];
  sparse.conclusions = sparse.conclusions.filter((item) => item.evidenceStatus !== "INSUFFICIENT_EVIDENCE");
  sparse.data = sparse.data.filter((item) => item.id !== "datum-penetration" && item.id !== "datum-adequacy-estimate");
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
  assert.match(slides, /数据缺失/u);
  assert.match(slides, /估算缺失/u);
  assert.doesNotMatch(slides, /undefined/u);
  assert.match(slides, /rows 2,3/u);
  assert.match(slides, /p\.2/u);
});

test("PPTX conclusions slide keeps the schema-maximum fifth conclusion on canvas", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-five-conclusions-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const fifth = structuredClone(run.conclusions[0]!);
  fifth.id = "conclusion-fifth-layout-boundary";
  fifth.text = "第五条候选结论用于验证五条上限下的长文本、来源编号和人工审阅状态全部留在可编辑幻灯片画布内。".repeat(2);
  run.conclusions.push(fifth);
  assert.equal(run.conclusions.length, 5);

  const path = join(workspaceDir, "five-conclusions.pptx");
  await writePptx(run, path);
  const zip = await JSZip.loadAsync(await readFile(path));
  const slide = await zip.file("ppt/slides/slide2.xml")!.async("text");
  assert.match(slide, /第五条候选结论/u);
  assert.match(slide, /<a:t>05<\/a:t>/u);
  const bounds = [...slide.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/gu)]
    .map((match) => ({ bottom: Number(match[2]) + Number(match[4]) }));
  assert.ok(bounds.length > 0);
  assert.ok(bounds.every((item) => item.bottom <= 6_858_000), `off-canvas shape bottom=${Math.max(...bounds.map((item) => item.bottom))}`);
});

test("PPTX traceability slide includes all ten allowed sources without truncation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-ten-sources-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  for (let index = 6; index <= 10; index += 1) {
    const extra = structuredClone(run.sources[(index - 6) % run.sources.length]!);
    extra.id = `source-layout-${index}`;
    extra.sourceVersionId = `source-version-layout-${index}`;
    extra.title = `附加可追溯来源 ${index}`;
    extra.locator = { url: `https://example.test/source-${index}` };
    run.sources.push(extra);
  }
  assert.equal(run.sources.length, 10);

  const path = join(workspaceDir, "ten-sources.pptx");
  await writePptx(run, path);
  const zip = await JSZip.loadAsync(await readFile(path));
  const slide = await zip.file("ppt/slides/slide5.xml")!.async("text");
  for (let index = 1; index <= 10; index += 1) assert.match(slide, new RegExp(`<a:t>\\[S${index}\\]</a:t>`, "u"));
  for (let index = 6; index <= 10; index += 1) assert.match(slide, new RegExp(`附加可追溯来源 ${index}`, "u"));
  assert.match(slide, /AI 生成候选判断/u);
  assert.match(slide, /未确认内容不冒充最终结论/u);
  const bounds = [...slide.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/gu)]
    .map((match) => ({ right: Number(match[1]) + Number(match[3]), bottom: Number(match[2]) + Number(match[4]) }));
  assert.ok(bounds.every((item) => item.right <= 12_192_000 && item.bottom <= 6_858_000));
});

test("hash, artifact path, and boundary focus fallbacks are deterministic and fail closed", async () => {
  assert.match(hashValue(undefined), /^[a-f0-9]{64}$/u);
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-artifact-path-"));
  await assert.rejects(persistRun({ id: ".." } as never, workspaceDir), /outside the allowed workspace/u);
  const questions = buildBoundaryQuestions({ researchQuestion: "??? !!!", evidenceGaps: [] } as never);
  assert.equal(questions.length, 3);
  assert.ok(questions.every((item) => item.question.includes("当前研究问题")));
});

test("atomic state writes clean their same-directory temporary file when replacement fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-atomic-write-"));
  const occupiedDirectory = join(directory, "current.json");
  await mkdir(occupiedDirectory);
  await assert.rejects(atomicWriteUtf8(occupiedDirectory, "state\n"));
  assert.deepEqual((await readdir(directory)).sort(), ["current.json"]);
});
