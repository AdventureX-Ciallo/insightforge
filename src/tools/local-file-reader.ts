import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import JSZip from "jszip";

import type { SourceLocator } from "../domain.js";
import { readPdfPages } from "./pdf-reader.js";

export interface LocalFileReadResult {
  fileName: string;
  kind: "PDF" | "CSV" | "XLSX" | "TXT";
  excerpts: Array<{ locator: SourceLocator; text: string }>;
}

function decodeXml(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function readXlsx(path: string): Promise<LocalFileReadResult> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("text") ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((match) => decodeXml(match[1]!));
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text") ?? "";
  const sheetNames = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/gu)].map((match) => decodeXml(match[1]!));
  const sheets = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  const excerpts = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const name = sheets[index];
    const xml = await zip.file(name!)!.async("text");
    const cells: string[] = [];
    let firstCell = "A1";
    let lastCell = "A1";
    for (const match of xml.matchAll(/<c[^>]*r="([A-Z]+\d+)"([^>]*)>[\s\S]*?<v>([^<]*)<\/v>[\s\S]*?<\/c>/gu)) {
      const ref = match[1]!;
      const attrs = match[2]!;
      const raw = match[3]!;
      const value = /t="s"/u.test(attrs) ? sharedStrings[Number(raw)] ?? raw : raw;
      if (cells.length === 0) firstCell = ref;
      lastCell = ref;
      cells.push(`${ref}=${value}`);
    }
    excerpts.push({
      locator: { fileName: basename(path), sheet: sheetNames[index] ?? `Sheet${index + 1}`, cellRange: `${firstCell}:${lastCell}` },
      text: cells.slice(0, 300).join("；"),
    });
  }
  if (excerpts.length === 0) throw new Error("XLSX workbook contains no readable worksheet cells");
  return { fileName: basename(path), kind: "XLSX", excerpts };
}

export async function readLocalFile(path: string, kind: LocalFileReadResult["kind"]): Promise<LocalFileReadResult> {
  if (kind === "PDF") {
    const parsed = await readPdfPages(path);
    return { fileName: parsed.fileName, kind, excerpts: parsed.pages.map((page) => ({ locator: { fileName: parsed.fileName, page: page.page }, text: page.text })) };
  }
  if (kind === "XLSX") return readXlsx(path);
  const text = await readFile(path, "utf8");
  if (kind === "CSV") {
    const lines = text.trim().split(/\r?\n/u);
    const columns = lines[0]!.split(",").map((item) => item.trim()).filter(Boolean);
    return { fileName: basename(path), kind, excerpts: [{ locator: { fileName: basename(path), columns, rows: lines.slice(1).map((_, index) => index + 2) }, text }] };
  }
  return { fileName: basename(path), kind, excerpts: [{ locator: { fileName: basename(path) }, text }] };
}
