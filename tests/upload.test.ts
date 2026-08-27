import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  MAX_UPLOAD_SIZE_BYTES,
  sanitizeUploadFileName,
  validateUploadBytes,
} from "../src/tools/upload-validator.js";

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
});
