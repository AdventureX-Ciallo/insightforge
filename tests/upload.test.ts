import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  MAX_UPLOAD_SIZE_BYTES,
  UploadValidationError,
  sanitizeUploadFileName,
  validateUpload,
  validateUploadBytes,
} from "../src/tools/upload-validator.js";
import { readLocalFile } from "../src/tools/local-file-reader.js";
import {
  assertXlsxContainerLimits,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES,
} from "../src/tools/xlsx-container.js";

const allowedRoot = resolve(".insightforge-test-uploads");

function candidate(fileName: string, mimeType: string, bytes: Uint8Array) {
  return {
    fileName,
    mimeType,
    sizeBytes: bytes.byteLength,
    allowedRoot,
    targetPath: resolve(allowedRoot, sanitizeUploadFileName(fileName)),
  };
}

async function minimalXlsx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", "<Relationships/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  return zip.generateAsync({ type: "uint8array" });
}

function forgeCentralDirectorySizes(bytes: Uint8Array, sizes: Readonly<Record<string, number>>) {
  const output = Buffer.from(bytes);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const patched = new Set<string>();
  let offset = 0;
  while ((offset = output.indexOf(signature, offset)) !== -1) {
    const nameLength = output.readUInt16LE(offset + 28);
    const extraLength = output.readUInt16LE(offset + 30);
    const commentLength = output.readUInt16LE(offset + 32);
    const name = output.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const size = sizes[name];
    if (size !== undefined) {
      output.writeUInt32LE(size, offset + 24);
      patched.add(name);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.deepEqual([...patched].sort(), Object.keys(sizes).sort());
  return output;
}

test("byte validator accepts the four allowed upload formats", async () => {
  const pdf = Buffer.from("%PDF-1.7\n%%EOF\n", "utf8");
  assert.equal((await validateUploadBytes(candidate("brief.pdf", "application/pdf", pdf), pdf)).kind, "PDF");
  const csv = Buffer.from("year,value\n2026,42\n", "utf8");
  assert.equal((await validateUploadBytes(candidate("table.csv", "text/csv", csv), csv)).kind, "CSV");
  const text = Buffer.from("plain research note\n", "utf8");
  assert.equal((await validateUploadBytes(candidate("note.txt", "text/plain", text), text)).kind, "TXT");
  const xlsx = await minimalXlsx();
  assert.equal((await validateUploadBytes(candidate("book.xlsx", "application/octet-stream", xlsx), xlsx)).kind, "XLSX");
});

test("byte validator rejects disguised, malformed, invalid UTF-8, and oversized files", async () => {
  const fakePdf = Buffer.from("this is not a PDF", "utf8");
  await assert.rejects(validateUploadBytes(candidate("fake.pdf", "application/pdf", fakePdf), fakePdf), /%PDF-/i);
  const fakeXlsx = Buffer.from("PK but not a zip workbook", "utf8");
  await assert.rejects(validateUploadBytes(candidate("fake.xlsx", "application/octet-stream", fakeXlsx), fakeXlsx), /ZIP container|workbook/i);
  const nulText = Buffer.from([0x61, 0x00, 0x62]);
  await assert.rejects(validateUploadBytes(candidate("nul.txt", "text/plain", nulText), nulText), /NUL/i);
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  await assert.rejects(validateUploadBytes(candidate("invalid.txt", "text/plain", invalidUtf8), invalidUtf8), /UTF-8/i);
  const oversized = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1, 0x61);
  await assert.rejects(validateUploadBytes(candidate("large.txt", "text/plain", oversized), oversized), /size/i);
  const declared = candidate("count.txt", "text/plain", Buffer.from("abc", "utf8"));
  declared.sizeBytes = 2;
  await assert.rejects(validateUploadBytes(declared, Buffer.from("abc", "utf8")), /byte count/i);
});

test("filename normalization removes unsafe characters and rejects path traversal", () => {
  assert.equal(sanitizeUploadFileName("季度报告<>:?.TXT"), "季度报告-.txt");
  assert.equal(sanitizeUploadFileName("CON.txt"), "upload-CON.txt");
  assert.equal(sanitizeUploadFileName("report\u202Efdp.txt"), "report-fdp.txt");
  assert.throws(() => sanitizeUploadFileName("../escape.txt"), /path separators/i);
  assert.throws(() => sanitizeUploadFileName("..\\escape.txt"), /path separators/i);
  assert.throws(() => sanitizeUploadFileName("   "), /required/u);
  assert.throws(() => sanitizeUploadFileName(`${"a".repeat(513)}.txt`), /too long/u);
  assert.equal(sanitizeUploadFileName("....txt"), "upload.txt");
  const truncated = sanitizeUploadFileName(`${"界".repeat(100)}.txt`);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 160);
});

test("upload metadata and byte validation cover empty MIME, numeric bounds, unsafe ZIPs, corrupt ZIPs, and disguised binary text", async () => {
  const pdf = Buffer.from("%PDF-1.7\n%%EOF\n", "utf8");
  assert.equal((await validateUploadBytes(candidate("brief.pdf", "", pdf), pdf)).declaredMimeType, "application/octet-stream");

  const invalidNumber = candidate("note.txt", "text/plain", Buffer.from("x"));
  invalidNumber.sizeBytes = 1.5;
  assert.throws(() => validateUpload(invalidNumber), /at least one byte/u);
  const zero = candidate("note.txt", "text/plain", new Uint8Array());
  await assert.rejects(validateUploadBytes(zero, new Uint8Array()), /at least one byte/u);

  const unsafeZip = new JSZip();
  unsafeZip.file("[Content_Types].xml", "<Types/>");
  unsafeZip.file("_rels/.rels", "<Relationships/>");
  unsafeZip.file("xl/workbook.xml", "<workbook/>");
  unsafeZip.file("/absolute-entry", "bad");
  const unsafeBytes = await unsafeZip.generateAsync({ type: "uint8array" });
  await assert.rejects(validateUploadBytes(candidate("unsafe.xlsx", "application/zip", unsafeBytes), unsafeBytes), /unsafe entry layout/u);

  const corruptZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
  await assert.rejects(validateUploadBytes(candidate("corrupt.xlsx", "application/zip", corruptZip), corruptZip), /readable workbook container/u);

  await assert.rejects(validateUploadBytes(candidate("pdf.txt", "text/plain", pdf), pdf), /binary file signature/u);
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41]);
  await assert.rejects(validateUploadBytes(candidate("zip.txt", "text/plain", zipBytes), zipBytes), /binary file signature/u);
});

test("XLSX validation and reading reject forged decompressed sizes before inflating entries", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", "<Relationships/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  zip.file("xl/worksheets/sheet1.xml", "<worksheet/>");
  const compressed = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const oversizedEntry = forgeCentralDirectorySizes(compressed, {
    "xl/worksheets/sheet1.xml": MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES + 1,
  });
  const oversizedCandidate = candidate("bomb.xlsx", "application/zip", oversizedEntry);
  await assert.rejects(
    validateUploadBytes(oversizedCandidate, oversizedEntry),
    (error: unknown) => error instanceof UploadValidationError
      && error.statusCode === 413
      && /entry exceeds.*decompressed size limit/u.test(error.message),
  );

  const directory = await mkdtemp(join(tmpdir(), "insightforge-xlsx-size-limit-"));
  const path = join(directory, "bomb.xlsx");
  await writeFile(path, oversizedEntry);
  await assert.rejects(readLocalFile(path, "XLSX"), /entry exceeds.*decompressed size limit/u);

  const aggregateNames = ["xl/a.xml", "xl/b.xml", "xl/c.xml", "xl/d.xml"];
  for (const name of aggregateNames) zip.file(name, "x");
  const aggregateCompressed = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const aggregateSize = Math.floor(MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES / aggregateNames.length) + 1;
  const aggregate = forgeCentralDirectorySizes(
    aggregateCompressed,
    Object.fromEntries(aggregateNames.map((name) => [name, aggregateSize])),
  );
  await assert.rejects(
    validateUploadBytes(candidate("aggregate.xlsx", "application/zip", aggregate), aggregate),
    /total decompressed size limit/u,
  );

  assert.throws(
    () => assertXlsxContainerLimits({ files: { bad: { name: "bad", dir: false, _data: {} } } } as never),
    /invalid uncompressed-size metadata/u,
  );
  const tooManyDirectories = Object.fromEntries(Array.from(
    { length: MAX_XLSX_ENTRIES + 1 },
    (_, index) => [`d${index}/`, { name: `d${index}/`, dir: true }],
  ));
  assert.throws(() => assertXlsxContainerLimits({ files: tooManyDirectories } as never), /entry limit/u);
});

test("COLLECT local-file reader extracts real XLSX cells with worksheet locators", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("_rels/.rels", "<Relationships/>");
  zip.file("xl/workbook.xml", '<workbook><sheets><sheet name="市场数据" sheetId="1"/></sheets></workbook>');
  zip.file("xl/sharedStrings.xml", '<sst><si><t>指标</t></si><si><t>渗透率</t></si></sst>');
  zip.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>2024</v></c><c r="B2"><v>47.6</v></c></row></sheetData></worksheet>');
  const directory = await mkdtemp(join(tmpdir(), "insightforge-xlsx-reader-"));
  const path = join(directory, "market.xlsx");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  const result = await readLocalFile(path, "XLSX");
  assert.equal(result.excerpts[0]?.locator.sheet, "市场数据");
  assert.equal(result.excerpts[0]?.locator.cellRange, "A1:B2");
  assert.match(result.excerpts[0]?.text ?? "", /B2=47\.6/);
});
