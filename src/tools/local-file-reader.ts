import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import JSZip from "jszip";

import type { SourceLocator } from "../domain.js";
import { parseCsv } from "./csv-parser.js";
import { readPdfPagesBytes } from "./pdf-reader.js";
import { assertXlsxContainerLimits } from "./xlsx-container.js";

export interface LocalFileReadResult {
  fileName: string;
  kind: "PDF" | "CSV" | "XLSX" | "TXT";
  excerpts: Array<{ locator: SourceLocator; text: string }>;
}

function decodeXml(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function readXlsx(bytes: Uint8Array, fileName: string): Promise<LocalFileReadResult> {
  const zip = await JSZip.loadAsync(bytes);
  assertXlsxContainerLimits(zip);
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("text") ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((match) => decodeXml(match[1]!));
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text") ?? "";
  const sheetNames = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/gu)].map((match) => decodeXml(match[1]!));
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => Number(left.match(/sheet(\d+)\.xml$/u)?.[1]) - Number(right.match(/sheet(\d+)\.xml$/u)?.[1]));
  const excerpts = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const name = sheets[index];
    const xml = await zip.file(name!)!.async("text");
    const cells: string[] = [];
    let firstCell = "A1";
    let lastCell = "A1";
    for (const match of xml.matchAll(/<c\b(?=[^>]*\br="([A-Z]+\d+)")([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const ref = match[1]!;
      const attrs = match[2]!;
      const body = match[3] ?? "";
      const inline = /\bt="inlineStr"/u.test(attrs);
      const inlineParts = inline
        ? [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((part) => decodeXml(part[1]!))
        : [];
      const valueMatch = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u);
      if (inlineParts.length === 0 && !valueMatch) continue;
      const raw = inline ? inlineParts.join("") : decodeXml(valueMatch![1]!);
      const value = /\bt="s"/u.test(attrs) ? sharedStrings[Number(raw)] ?? raw : raw;
      if (cells.length === 0) firstCell = ref;
      lastCell = ref;
      cells.push(`${ref}=${value}`);
    }
    excerpts.push({
      locator: { fileName, sheet: sheetNames[index] ?? `Sheet${index + 1}`, cellRange: `${firstCell}:${lastCell}` },
      text: cells.slice(0, 300).join("；"),
    });
  }
  if (excerpts.length === 0) throw new Error("XLSX workbook contains no readable worksheet cells");
  return { fileName, kind: "XLSX", excerpts };
}

export async function readLocalFileBytes(bytes: Uint8Array, fileName: string, kind: LocalFileReadResult["kind"]): Promise<LocalFileReadResult> {
  if (kind === "PDF") {
    const parsed = await readPdfPagesBytes(bytes, fileName);
    return { fileName: parsed.fileName, kind, excerpts: parsed.pages.map((page) => ({ locator: { fileName: parsed.fileName, page: page.page }, text: page.text })) };
  }
  if (kind === "XLSX") return readXlsx(bytes, fileName);
  const text = Buffer.from(bytes).toString("utf8");
  if (kind === "CSV") {
    const records = parseCsv(text);
    if (records.length === 0) throw new Error("CSV file contains no header row");
    const columns = records[0]!.fields.map((item) => item.trim()).filter(Boolean);
    const rows = records.slice(1).filter((record) => record.fields.some((item) => item.length > 0)).map((record) => record.recordNumber);
    return { fileName, kind, excerpts: [{ locator: { fileName, columns, rows }, text }] };
  }
  return { fileName, kind, excerpts: [{ locator: { fileName }, text }] };
}

export async function readLocalFile(path: string, kind: LocalFileReadResult["kind"]): Promise<LocalFileReadResult> {
  return readLocalFileBytes(new Uint8Array(await readFile(path)), basename(path), kind);
}
