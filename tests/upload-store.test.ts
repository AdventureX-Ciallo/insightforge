import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  assertUploadCapacity,
  isPathInside,
  maintainUploadRetention,
  MAX_RETAINED_UPLOADS,
  MAX_UPLOAD_STORAGE_BYTES,
  persistedUploadMatches,
  persistUpload,
  UploadStoreError,
  verifyPersistedUpload,
} from "../src/upload-store.js";
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

test("aggregate upload quota is serialized across concurrent writes", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-quota-"));
  const attempts = await Promise.allSettled(Array.from({ length: MAX_RETAINED_UPLOADS + 1 }, (_, index) => persistUpload({
    workspaceDir,
    originalFileName: `note-${index}.txt`,
    declaredMimeType: "text/plain",
    bytes: Buffer.from(`evidence note ${index}\n`, "utf8"),
  })));
  const accepted = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(accepted.length, MAX_RETAINED_UPLOADS);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof UploadStoreError);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.statusCode, 413);
  const trace = await maintainUploadRetention(workspaceDir);
  assert.equal(trace.retainedUploadCount, MAX_RETAINED_UPLOADS);

  assert.doesNotThrow(() => assertUploadCapacity({ retainedBytes: 0, retainedUploadCount: 0 }, 1, 4_097, 1));
  assert.throws(
    () => assertUploadCapacity({ retainedBytes: 1, retainedUploadCount: 0 }, 1, 4_097, 1),
    (error: unknown) => error instanceof UploadStoreError && error.statusCode === 413,
  );
  assert.throws(
    () => assertUploadCapacity({ retainedBytes: 0, retainedUploadCount: 1 }, 0, MAX_UPLOAD_STORAGE_BYTES, 1),
    (error: unknown) => error instanceof UploadStoreError && error.statusCode === 413,
  );
});

test("expired uploads are removed in pairs while malformed and failed cleanup remain quota-visible", async () => {
  const expired = await stored();
  await rewriteRecord(expired, (record) => { record.expiresAt = "2000-01-01T00:00:00.000Z"; });
  const expiredTrace = await maintainUploadRetention(expired.workspaceDir, Date.now());
  assert.deepEqual(expiredTrace.removedUploadIds, [expired.record.id]);
  assert.equal(expiredTrace.retainedUploadCount, 0);
  assert.equal(expiredTrace.retainedBytes, 0);
  await assert.rejects(access(expired.recordPath));
  await assert.rejects(access(expired.filePath));

  const accessExpired = await stored();
  await rewriteRecord(accessExpired, (record) => { record.expiresAt = "2000-01-01T00:00:00.000Z"; });
  await assert.rejects(
    verifyPersistedUpload(accessExpired.workspaceDir, accessExpired.record.id),
    (error: unknown) => error instanceof UploadStoreError && error.statusCode === 410,
  );
  await assert.rejects(access(accessExpired.recordPath));
  await assert.rejects(access(accessExpired.filePath));

  const legacyExpired = await stored();
  await rewriteRecord(legacyExpired, (record) => {
    delete record.expiresAt;
    record.uploadedAt = "2000-01-01T00:00:00.000Z";
  });
  const legacyTrace = await maintainUploadRetention(legacyExpired.workspaceDir, Date.now());
  assert.deepEqual(legacyTrace.removedUploadIds, [legacyExpired.record.id], "legacy records derive expiry from uploadedAt");

  const unsafeExpired = await stored();
  await rewriteRecord(unsafeExpired, (record) => {
    record.expiresAt = "2000-01-01T00:00:00.000Z";
    record.storedFileName = "../../../outside.txt";
    record.storageKey = "uploads/files/../../../outside.txt";
  });
  const unsafeTrace = await maintainUploadRetention(unsafeExpired.workspaceDir, Date.now());
  assert.equal(unsafeTrace.errorCount, 1);
  assert.deepEqual(unsafeTrace.removedUploadIds, []);
  await access(unsafeExpired.filePath);

  const malformed = await mkdtemp(join(tmpdir(), "insightforge-upload-malformed-retention-"));
  await maintainUploadRetention(malformed);
  await writeFile(join(malformed, "uploads", "records", "bad.json"), "{bad", "utf8");
  await writeFile(join(malformed, "uploads", "records", "ignored.txt"), "not a record", "utf8");
  await mkdir(join(malformed, "uploads", "records", "ignored-directory"));
  await writeFile(join(malformed, "uploads", "files", "orphan.bin"), "orphan", "utf8");
  const malformedTrace = await maintainUploadRetention(malformed);
  assert.equal(malformedTrace.errorCount, 1);
  assert.equal(malformedTrace.retainedUploadCount, 3);
  assert.ok(malformedTrace.retainedBytes > 0);

  const inspectionFailure = await maintainUploadRetention(
    malformed,
    Date.now(),
    undefined,
    async () => { throw new Error("injected lstat race"); },
  );
  assert.equal(inspectionFailure.errorCount, 5, "all four retained entries plus malformed JSON remain visible as errors");

  const removalFailure = await stored();
  await rewriteRecord(removalFailure, (record) => { record.expiresAt = "2000-01-01T00:00:00.000Z"; });
  const failedTrace = await maintainUploadRetention(removalFailure.workspaceDir, Date.now(), async () => { throw new Error("injected removal failure"); });
  assert.equal(failedTrace.errorCount, 2);
  assert.deepEqual(failedTrace.removedUploadIds, []);
  assert.equal(failedTrace.retainedUploadCount, 1);
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
