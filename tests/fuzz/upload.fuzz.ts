import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { persistUpload } from "../../src/upload-store.js";
import { sanitizeUploadFileName, UploadValidationError, validateUpload, validateUploadBytes } from "../../src/tools/upload-validator.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

const ALLOWED = [
  [".pdf", "application/pdf"],
  [".csv", "text/csv"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".txt", "text/plain"],
] as const;

function rejected(action: () => unknown, caseIndex: number, message: string) {
  try {
    action();
  } catch (error) {
    invariant(error instanceof UploadValidationError, `case=${caseIndex}: upload rejection lost its typed error`);
    return;
  }
  throw new Error(`case=${caseIndex}: ${message}`);
}

export async function runUploadFuzz(rng: SeededPrng, cases: number, workspaceDir: string) {
  const allowedRoot = resolve(workspaceDir, "fuzz-upload-root");
  for (let index = 0; index < cases; index += 1) {
    if (index < 8) {
      const bytes = new TextEncoder().encode(`seeded fuzz upload ${rng.token(32)}`);
      const record = await persistUpload({ workspaceDir, originalFileName: `${rng.token()}.txt`, declaredMimeType: "text/plain", bytes });
      const fileInfo = await stat(resolve(workspaceDir, record.storageKey));
      invariant((fileInfo.mode & 0o777) === 0o600, `case=${index}: successful upload was not persisted with mode 0600`);
      continue;
    }

    const variant = rng.int(6);
    const [extension, mimeType] = rng.pick(ALLOWED);
    const fileName = `${rng.token()}${extension}`;
    const candidate = { fileName, mimeType, sizeBytes: 4, allowedRoot, targetPath: resolve(allowedRoot, fileName) };
    if (variant === 0) {
      rejected(() => sanitizeUploadFileName(`../${fileName}`), index, "path traversal filename was accepted");
    } else if (variant === 1) {
      rejected(() => validateUpload({ ...candidate, targetPath: resolve(workspaceDir, `outside-${fileName}`) }), index, "outside target path was accepted");
    } else if (variant === 2) {
      rejected(() => validateUpload({ ...candidate, fileName: `${rng.token()}.${rng.pick(["exe", "html", "svg", "docx"])}` }), index, "non-whitelist extension was accepted");
    } else if (variant === 3) {
      rejected(() => validateUpload({ ...candidate, mimeType: rng.pick(["text/html", "image/svg+xml", "application/x-msdownload"]) }), index, "spoofed MIME was accepted");
    } else if (variant === 4) {
      const bytes = rng.bytes(64, 1);
      try {
        const result = await validateUploadBytes({ ...candidate, sizeBytes: bytes.byteLength }, bytes);
        invariant(["PDF", "CSV", "XLSX", "TXT"].includes(result.kind), `case=${index}: byte fuzz escaped the upload whitelist`);
      } catch (error) {
        invariant(error instanceof UploadValidationError, `case=${index}: random bytes caused an untyped failure`);
      }
    } else {
      const bytes = new TextEncoder().encode(`valid-${rng.token(40)}`);
      const result = await validateUploadBytes({ ...candidate, fileName: `${rng.token()}.txt`, mimeType: "text/plain", sizeBytes: bytes.byteLength, targetPath: resolve(allowedRoot, `${rng.token()}.txt`) }, bytes);
      invariant(result.kind === "TXT", `case=${index}: valid whitelist text was not accepted as TXT`);
    }
  }
  return { cases, value: undefined };
}
