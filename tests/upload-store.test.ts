import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { isPathInside, persistedUploadMatches, persistUpload, UploadStoreError, verifyPersistedUpload } from "../src/upload-store.js";
import { UploadValidationError } from "../src/tools/upload-validator.js";

const bytes = Buffer.from("evidence note\n", "utf8");

async function stored() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-store-"));
  const record = await persistUpload({ workspaceDir, originalFileName: "note.txt", declaredMimeType: "text/plain", bytes });
  return {
    workspaceDir,
    record,
    recordPath: join(workspaceDir, "uploads", "records", `${record.id}.json`),
    filePath: join(workspaceDir, "uploads", "files", record.storedFileName),
  };
}

async function rewriteRecord(state: Awaited<ReturnType<typeof stored>>, mutate: (record: Record<string, unknown>) => void) {
  const record = JSON.parse(await readFile(state.recordPath, "utf8")) as Record<string, unknown>;
  mutate(record);
  await writeFile(state.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("upload path and post-write integrity helpers fail closed for same, outside, directory, size, and digest variants", async () => {
  const root = resolve("/tmp/insightforge-path-root");
  assert.equal(isPathInside(root, root), false);
  assert.equal(isPathInside(root, root, true), true);
  assert.equal(isPathInside(root, join(root, "child")), true);
  assert.equal(isPathInside(root, resolve(root, "..", "escape")), false);

  const directory = await mkdtemp(join(tmpdir(), "insightforge-upload-integrity-"));
  const path = join(directory, "bytes.txt");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await persistedUploadMatches(path, { sizeBytes: bytes.length, sha256 }), true);
  assert.equal(await persistedUploadMatches(path, { sizeBytes: bytes.length + 1, sha256 }), false);
  assert.equal(await persistedUploadMatches(path, { sizeBytes: bytes.length, sha256: "0".repeat(64) }), false);
  const folder = join(directory, "folder");
  await mkdir(folder);
  assert.equal(await persistedUploadMatches(folder, { sizeBytes: bytes.length, sha256 }), false);
});

test("upload persistence cleans partial state and preserves typed validation/store errors", async () => {
  for (const injected of [
    async () => false,
    async () => { throw new UploadValidationError(400, "injected validation failure"); },
    async () => { throw new Error("injected filesystem failure"); },
  ]) {
    const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-write-fail-"));
    await assert.rejects(
      persistUpload({ workspaceDir, originalFileName: "note.txt", declaredMimeType: "text/plain", bytes }, injected),
      (error: unknown) => error instanceof UploadStoreError || error instanceof UploadValidationError,
    );
  }
});

test("persisted upload verification rejects forged identifiers, metadata, paths, file types, and bytes", async () => {
  await assert.rejects(verifyPersistedUpload(await mkdtemp(join(tmpdir(), "insightforge-upload-id-")), "../bad"), /identifier is invalid/u);
  await assert.rejects(verifyPersistedUpload(await mkdtemp(join(tmpdir(), "insightforge-upload-missing-")), randomUUID()), (error: unknown) => error instanceof UploadStoreError && error.statusCode === 404);

  const valid = await stored();
  const verified = await verifyPersistedUpload(valid.workspaceDir, valid.record.id);
  assert.equal(verified.persisted, true);
  assert.equal(verified.hashMatches, true);
  assert.equal(verified.verificationUrl, `/api/uploads/${valid.record.id}`);

  const badJson = await stored();
  await writeFile(badJson.recordPath, "{bad", "utf8");
  await assert.rejects(verifyPersistedUpload(badJson.workspaceDir, badJson.record.id), (error: unknown) => error instanceof UploadStoreError && error.statusCode === 409);

  const wrongId = await stored();
  await rewriteRecord(wrongId, (record) => { record.id = randomUUID(); });
  await assert.rejects(verifyPersistedUpload(wrongId.workspaceDir, wrongId.record.id), /does not match the requested upload/u);

  const wrongStorage = await stored();
  await rewriteRecord(wrongStorage, (record) => { record.storageKey = "uploads/files/forged.txt"; });
  await assert.rejects(verifyPersistedUpload(wrongStorage.workspaceDir, wrongStorage.record.id), /path metadata is invalid/u);

  const traversal = await stored();
  await rewriteRecord(traversal, (record) => {
    record.storedFileName = "../../../outside.txt";
    record.storageKey = "uploads/files/../../../outside.txt";
  });
  await assert.rejects(verifyPersistedUpload(traversal.workspaceDir, traversal.record.id), /resolves outside/u);

  const inconsistent = await stored();
  await rewriteRecord(inconsistent, (record) => { record.sanitizedFileName = "different.txt"; });
  await assert.rejects(verifyPersistedUpload(inconsistent.workspaceDir, inconsistent.record.id), /internally inconsistent/u);

  const invalidMetadata = await stored();
  await rewriteRecord(invalidMetadata, (record) => { record.originalFileName = "../escape.txt"; });
  await assert.rejects(verifyPersistedUpload(invalidMetadata.workspaceDir, invalidMetadata.record.id), /metadata is invalid/u);

  const symbolic = await stored();
  const external = join(symbolic.workspaceDir, "external.txt");
  await writeFile(external, bytes);
  await unlink(symbolic.filePath);
  await symlink(external, symbolic.filePath);
  await assert.rejects(verifyPersistedUpload(symbolic.workspaceDir, symbolic.record.id), /not a regular file/u);

  const directoryTarget = await stored();
  await unlink(directoryTarget.filePath);
  await mkdir(directoryTarget.filePath);
  await assert.rejects(verifyPersistedUpload(directoryTarget.workspaceDir, directoryTarget.record.id), /not a regular file/u);

  const changed = await stored();
  await writeFile(changed.filePath, Buffer.from("tampered note\n", "utf8"));
  await assert.rejects(verifyPersistedUpload(changed.workspaceDir, changed.record.id), /byte digest/u);

  const missingFile = await stored();
  await unlink(missingFile.filePath);
  await assert.rejects(verifyPersistedUpload(missingFile.workspaceDir, missingFile.record.id), (error: unknown) => error instanceof UploadStoreError && error.statusCode === 404);

  const unreadable = await stored();
  await assert.rejects(
    verifyPersistedUpload(unreadable.workspaceDir, unreadable.record.id, async () => { throw new Error("EACCES without a code"); }),
    /could not be verified/u,
  );
  await assert.rejects(
    verifyPersistedUpload(unreadable.workspaceDir, unreadable.record.id, async () => { throw null; }),
    /could not be verified/u,
  );
});

test("pre-existing upload directory symlinks cannot escape the workspace", async () => {
  for (const child of ["uploads", join("uploads", "files"), join("uploads", "records")]) {
    const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-symlink-root-"));
    const external = await mkdtemp(join(tmpdir(), "insightforge-upload-external-"));
    const path = join(workspaceDir, child);
    await mkdir(dirname(path), { recursive: true });
    await symlink(external, path);
    await assert.rejects(
      persistUpload({ workspaceDir, originalFileName: "note.txt", declaredMimeType: "text/plain", bytes }),
      /outside/u,
    );
  }
});
