import type JSZip from "jszip";

export const MAX_XLSX_ENTRIES = 10_000;
export const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

type SizedZipEntry = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: unknown };
};

export class XlsxContainerSafetyError extends Error {
  constructor(readonly statusCode: 413 | 415, message: string) {
    super(message);
    this.name = "XlsxContainerSafetyError";
  }
}

/** Validate central-directory metadata before any entry is decompressed. */
export function assertXlsxContainerLimits(zip: Pick<JSZip, "files">) {
  const entries = Object.entries(zip.files) as Array<[string, SizedZipEntry]>;
  if (entries.length > MAX_XLSX_ENTRIES) {
    throw new XlsxContainerSafetyError(415, `XLSX ZIP container exceeds the ${MAX_XLSX_ENTRIES}-entry limit`);
  }

  let total = 0;
  for (const [name, entry] of entries) {
    const originalName = entry.unsafeOriginalName ?? name;
    if (originalName.startsWith("/") || originalName.split("/").includes("..")) {
      throw new XlsxContainerSafetyError(415, "XLSX ZIP container has an unsafe entry layout");
    }
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new XlsxContainerSafetyError(415, "XLSX entry has invalid uncompressed-size metadata");
    }
    if (size > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new XlsxContainerSafetyError(413, `XLSX entry exceeds the ${MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES}-byte decompressed size limit`);
    }
    total += size;
    if (total > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new XlsxContainerSafetyError(413, `XLSX workbook exceeds the ${MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES}-byte total decompressed size limit`);
    }
  }
  return { entryCount: entries.length, totalUncompressedBytes: total };
}
