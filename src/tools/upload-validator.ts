import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import JSZip from "jszip";
import { assertXlsxContainerLimits, XlsxContainerSafetyError } from "./xlsx-container.js";

export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_SANITIZED_FILE_NAME_BYTES = 160;

export type UploadKind = "PDF" | "CSV" | "XLSX" | "TXT";
type UploadExtension = ".pdf" | ".csv" | ".xlsx" | ".txt";

interface UploadPolicy {
  kind: UploadKind;
  canonicalMimeType: string;
  acceptedMimeTypes: readonly string[];
}

const UPLOAD_POLICIES: Readonly<Record<UploadExtension, UploadPolicy>> = {
  ".pdf": {
    kind: "PDF",
    canonicalMimeType: "application/pdf",
    acceptedMimeTypes: ["application/pdf", "application/octet-stream"],
  },
  ".csv": {
    kind: "CSV",
    canonicalMimeType: "text/csv",
    acceptedMimeTypes: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"],
  },
  ".xlsx": {
    kind: "XLSX",
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    acceptedMimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/octet-stream",
    ],
  },
  ".txt": {
    kind: "TXT",
    canonicalMimeType: "text/plain",
    acceptedMimeTypes: ["text/plain", "application/octet-stream"],
  },
};

export class UploadValidationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export interface UploadCandidate {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  allowedRoot: string;
  targetPath: string;
}

export interface UploadValidationResult {
  extension: UploadExtension;
  kind: UploadKind;
  maxSizeBytes: number;
  sanitizedFileName: string;
  declaredMimeType: string;
  detectedMimeType: string;
}

function normalizeMimeType(value: string) {
  return value.split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
}

function truncateUtf8(value: string, maxBytes: number) {
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

export function sanitizeUploadFileName(fileName: string) {
  const normalized = fileName.normalize("NFKC").trim();
  if (!normalized) throw new UploadValidationError(400, "Upload filename is required");
  if (Buffer.byteLength(normalized, "utf8") > 512) throw new UploadValidationError(400, "Upload filename is too long");
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new UploadValidationError(400, "Upload filename must not contain path separators");
  }

  const extension = extname(normalized).toLowerCase() as UploadExtension;
  if (!(extension in UPLOAD_POLICIES)) {
    throw new UploadValidationError(415, "Upload extension is not allowed; use PDF, CSV, XLSX, or TXT");
  }

  const rawStem = normalized.slice(0, -extension.length);
  let safeStem = rawStem
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>:"|?*]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .replace(/-+/gu, "-");
  if (!safeStem) safeStem = "upload";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(safeStem)) safeStem = `upload-${safeStem}`;

  const extensionBytes = Buffer.byteLength(extension, "utf8");
  safeStem = truncateUtf8(safeStem, MAX_SANITIZED_FILE_NAME_BYTES - extensionBytes).replace(/[. ]+$/gu, "");
  return `${safeStem}${extension}`;
}

function isPathInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function validateUpload(candidate: UploadCandidate): UploadValidationResult {
  const sanitizedFileName = sanitizeUploadFileName(candidate.fileName);
  const extension = extname(sanitizedFileName).toLowerCase() as UploadExtension;
  const policy = UPLOAD_POLICIES[extension];
  const declaredMimeType = normalizeMimeType(candidate.mimeType);

  if (!policy.acceptedMimeTypes.includes(declaredMimeType)) {
    throw new UploadValidationError(415, `Upload MIME does not match ${extension}`);
  }
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
    throw new UploadValidationError(400, "Upload must contain at least one byte");
  }
  if (candidate.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new UploadValidationError(413, `Upload size exceeds the ${MAX_UPLOAD_SIZE_BYTES} byte limit`);
  }
  if (!isPathInside(candidate.allowedRoot, candidate.targetPath)) {
    throw new UploadValidationError(400, "Upload target is outside the allowed workspace");
  }

  return {
    extension,
    kind: policy.kind,
    maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
    sanitizedFileName,
    declaredMimeType,
    detectedMimeType: policy.canonicalMimeType,
  };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function isZipSignature(bytes: Uint8Array) {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

async function validateXlsxContainer(bytes: Uint8Array) {
  if (!isZipSignature(bytes)) throw new UploadValidationError(415, "XLSX upload is not a ZIP container");
  try {
    const zip = await JSZip.loadAsync(bytes);
    assertXlsxContainerLimits(zip);
    const requiredEntries = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"];
    if (requiredEntries.some((entry) => !zip.file(entry))) {
      throw new UploadValidationError(415, "XLSX ZIP container is missing required workbook entries");
    }
  } catch (error) {
    if (error instanceof UploadValidationError) throw error;
    if (error instanceof XlsxContainerSafetyError) throw new UploadValidationError(error.statusCode, error.message);
    throw new UploadValidationError(415, "XLSX upload is not a readable workbook container");
  }
}

export async function validateUploadBytes(candidate: UploadCandidate, bytes: Uint8Array): Promise<UploadValidationResult> {
  if (bytes.byteLength !== candidate.sizeBytes) {
    throw new UploadValidationError(400, "Upload byte count does not match the received size");
  }
  const result = validateUpload(candidate);

  if (result.extension === ".pdf") {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      throw new UploadValidationError(415, "PDF upload is missing the %PDF- signature");
    }
  } else if (result.extension === ".xlsx") {
    await validateXlsxContainer(bytes);
  } else {
    if (bytes.includes(0)) throw new UploadValidationError(415, "Text upload contains a NUL byte");
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) || isZipSignature(bytes)) {
      throw new UploadValidationError(415, "Text upload contains a binary file signature");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new UploadValidationError(415, "Text upload is not valid UTF-8");
    }
  }

  return result;
}
