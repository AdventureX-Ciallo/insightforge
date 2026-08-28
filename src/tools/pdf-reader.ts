import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_PAGES = 100;

export function assertPdfPageCount(pageCount: number) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("PDF contains an invalid page count");
  if (pageCount > MAX_PDF_PAGES) throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page parsing limit`);
}

export async function readPdfPagesBytes(bytes: Uint8Array, fileName: string) {
  const document = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  assertPdfPageCount(document.numPages);
  const pages: Array<{ page: number; text: string }> = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item): item is typeof item & { str: string } => "str" in item)
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ page: pageNumber, text });
  }
  return { fileName, pages };
}

export async function readPdfPages(path: string) {
  return readPdfPagesBytes(new Uint8Array(await readFile(path)), basename(path));
}
