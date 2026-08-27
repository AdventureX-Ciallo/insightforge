import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { hashFile } from "./hash.js";
import {
  MAX_UPLOAD_SIZE_BYTES,
  sanitizeUploadFileName,
  UploadValidationError,
  validateUpload,
  validateUploadBytes,
} from "./tools/upload-validator.js";

const uploadRecordSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().uuid(),
  originalFileName: z.string().min(1).max(512),
  sanitizedFileName: z.string().min(1).max(200),
  storedFileName: z.string().min(1).max(260),
  kind: z.enum(["PDF", "CSV", "XLSX", "TXT"]),
  declaredMimeType: z.string().min(1).max(160),
  detectedMimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: z.string().datetime(),
  storageKey: z.string().min(1).max(400),
}).strict();

export type UploadRecord = z.infer<typeof uploadRecordSchema>;

export interface VerifiedUpload extends UploadRecord {
  persisted: true;
  hashMatches: true;
  verificationUrl: string;
}

export class UploadStoreError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "UploadStoreError";
  }
}

interface UploadDirectories {
  workspaceRoot: string;
  filesRoot: string;
  recordsRoot: string;
}

export function isPathInside(root: string, target: string, allowSame = false) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return allowSame;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertInside(root: string, target: string, message: string, allowSame = false) {
  if (!isPathInside(root, target, allowSame)) throw new UploadStoreError(500, message);
}

async function ensureUploadDirectories(workspaceDir: string): Promise<UploadDirectories> {
  const workspaceRoot = resolve(workspaceDir);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceReal = await realpath(workspaceRoot);
  const uploadRoot = resolve(workspaceRoot, "uploads");
  assertInside(workspaceRoot, uploadRoot, "Upload root is outside the runtime workspace");
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const uploadReal = await realpath(uploadRoot);
  assertInside(workspaceReal, uploadReal, "Upload root resolves outside the runtime workspace");
  await chmod(uploadReal, 0o700);

  const filesRoot = resolve(uploadReal, "files");
  const recordsRoot = resolve(uploadReal, "records");
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
  const filesReal = await realpath(filesRoot);
  const recordsReal = await realpath(recordsRoot);
  assertInside(uploadReal, filesReal, "Upload file directory resolves outside the upload root");
  assertInside(uploadReal, recordsReal, "Upload record directory resolves outside the upload root");
  await chmod(filesReal, 0o700);
  await chmod(recordsReal, 0o700);
  return { workspaceRoot: workspaceReal, filesRoot: filesReal, recordsRoot: recordsReal };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function storageKey(storedFileName: string) {
  return ["uploads", "files", storedFileName].join("/");
}

function verificationUrl(id: string) {
  return `/api/uploads/${encodeURIComponent(id)}`;
}

export async function persistUpload(input: {
  workspaceDir: string;
  originalFileName: string;
  declaredMimeType: string;
  bytes: Uint8Array;
}, integrityVerifier: (path: string, record: UploadRecord) => Promise<boolean> = persistedUploadMatches): Promise<UploadRecord> {
  const directories = await ensureUploadDirectories(input.workspaceDir);
  const sanitizedFileName = sanitizeUploadFileName(input.originalFileName);
  const id = randomUUID();
  const storedFileName = `${id}-${sanitizedFileName}`;
  const targetPath = resolve(directories.filesRoot, storedFileName);
  const temporaryPath = resolve(directories.filesRoot, `.${id}.uploading`);
  const recordPath = resolve(directories.recordsRoot, `${id}.json`);
  const temporaryRecordPath = resolve(directories.recordsRoot, `.${id}.json.uploading`);
  assertInside(directories.filesRoot, targetPath, "Upload target is outside the upload directory");
  assertInside(directories.filesRoot, temporaryPath, "Temporary upload target is outside the upload directory");
  assertInside(directories.recordsRoot, recordPath, "Upload record target is outside the record directory");
  assertInside(directories.recordsRoot, temporaryRecordPath, "Temporary upload record is outside the record directory");

  const validation = await validateUploadBytes({
    fileName: input.originalFileName,
    mimeType: input.declaredMimeType,
    sizeBytes: input.bytes.byteLength,
    allowedRoot: directories.filesRoot,
    targetPath,
  }, input.bytes);

  const record: UploadRecord = uploadRecordSchema.parse({
    schemaVersion: "1.0",
    id,
    originalFileName: input.originalFileName,
    sanitizedFileName: validation.sanitizedFileName,
    storedFileName,
    kind: validation.kind,
    declaredMimeType: validation.declaredMimeType,
    detectedMimeType: validation.detectedMimeType,
    sizeBytes: input.bytes.byteLength,
    sha256: sha256(input.bytes),
    uploadedAt: new Date().toISOString(),
    storageKey: storageKey(storedFileName),
  });

  let fileCreated = false;
  try {
    await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, targetPath);
    fileCreated = true;
    if (!await integrityVerifier(targetPath, record)) {
      throw new UploadStoreError(500, "Persisted upload failed byte verification");
    }
    await writeFile(temporaryRecordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryRecordPath, recordPath);
    return record;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    await unlink(temporaryRecordPath).catch(() => undefined);
    if (fileCreated) await unlink(targetPath).catch(() => undefined);
    if (error instanceof UploadValidationError || error instanceof UploadStoreError) throw error;
    throw new UploadStoreError(500, "Upload could not be persisted safely");
  }
}

export async function persistedUploadMatches(path: string, record: Pick<UploadRecord, "sizeBytes" | "sha256">) {
  const fileInfo = await stat(path);
  return fileInfo.isFile() && fileInfo.size === record.sizeBytes && await hashFile(path) === record.sha256;
}

export async function verifyPersistedUpload(
  workspaceDir: string,
  id: string,
  inspectFile: (targetPath: string, filesRoot: string, record: UploadRecord) => Promise<void> = inspectPersistedUpload,
): Promise<VerifiedUpload> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new UploadValidationError(400, "Upload identifier is invalid");
  }
  const directories = await ensureUploadDirectories(workspaceDir);
  const recordPath = resolve(directories.recordsRoot, `${id}.json`);
  assertInside(directories.recordsRoot, recordPath, "Upload record target is outside the record directory");

  let record: UploadRecord;
  try {
    record = uploadRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new UploadStoreError(404, "Upload not found");
    throw new UploadStoreError(409, "Stored upload metadata is invalid");
  }
  if (record.id !== id) throw new UploadStoreError(409, "Stored upload metadata does not match the requested upload");

  const expectedStorageKey = storageKey(record.storedFileName);
  if (record.storageKey !== expectedStorageKey) throw new UploadStoreError(409, "Stored upload path metadata is invalid");
  const targetPath = resolve(directories.workspaceRoot, record.storageKey);
  assertInside(directories.filesRoot, targetPath, "Stored upload path resolves outside the upload directory");

  try {
    const validation = validateUpload({
      fileName: record.originalFileName,
      mimeType: record.declaredMimeType,
      sizeBytes: record.sizeBytes,
      allowedRoot: directories.filesRoot,
      targetPath,
    });
    if (validation.sanitizedFileName !== record.sanitizedFileName
      || validation.kind !== record.kind
      || validation.detectedMimeType !== record.detectedMimeType
      || record.storedFileName !== `${record.id}-${record.sanitizedFileName}`) {
      throw new UploadStoreError(409, "Stored upload metadata is internally inconsistent");
    }
  } catch (error) {
    if (error instanceof UploadStoreError) throw error;
    throw new UploadStoreError(409, "Stored upload metadata is invalid");
  }

  try {
    await inspectFile(targetPath, directories.filesRoot, record);
  } catch (error) {
    if (error instanceof UploadStoreError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new UploadStoreError(404, "Upload not found");
    throw new UploadStoreError(409, "Stored upload could not be verified");
  }

  return { ...record, persisted: true, hashMatches: true, verificationUrl: verificationUrl(record.id) };
}

async function inspectPersistedUpload(targetPath: string, filesRoot: string, record: UploadRecord) {
  const linkInfo = await lstat(targetPath);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) throw new UploadStoreError(409, "Stored upload is not a regular file");
  const realTarget = await realpath(targetPath);
  assertInside(filesRoot, realTarget, "Stored upload resolves outside the upload directory");
  const fileInfo = await stat(realTarget);
  if (fileInfo.size !== record.sizeBytes || await hashFile(realTarget) !== record.sha256) {
    throw new UploadStoreError(409, "Stored upload no longer matches its byte digest");
  }
}
