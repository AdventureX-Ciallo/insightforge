import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase, validateUpload } from "../src/index.js";

test("upload validation is fail-closed for extension, MIME, size, and path", () => {
  const allowedRoot = "/tmp/insightforge-uploads";
  const valid = validateUpload({
    fileName: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    allowedRoot,
    targetPath: "/tmp/insightforge-uploads/source.pdf",
  });
  assert.equal(valid.extension, ".pdf");
  assert.equal(valid.kind, "PDF");
  assert.equal(valid.maxSizeBytes, 5 * 1024 * 1024);
  assert.equal(valid.sanitizedFileName, "source.pdf");
  assert.throws(
    () => validateUpload({ fileName: ".env", mimeType: "text/plain", sizeBytes: 10, allowedRoot, targetPath: `${allowedRoot}/.env` }),
    /extension/i,
  );
  assert.throws(
    () => validateUpload({ fileName: "source.pdf", mimeType: "text/plain", sizeBytes: 10, allowedRoot, targetPath: `${allowedRoot}/source.pdf` }),
    /MIME/i,
  );
  assert.throws(
    () => validateUpload({ fileName: "source.csv", mimeType: "text/csv", sizeBytes: 5 * 1024 * 1024 + 1, allowedRoot, targetPath: `${allowedRoot}/source.csv` }),
    /size/i,
  );
  assert.throws(
    () => validateUpload({ fileName: "source.txt", mimeType: "text/plain", sizeBytes: 10, allowedRoot, targetPath: "/tmp/outside.txt" }),
    /outside/i,
  );
});

test("prompt injection in a PDF remains inert source material", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-injection-"));
  const run = await runGoldenCase({
    researchQuestion: "验证充电基础设施是否构成新能源汽车增长约束",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const adversarialEvidence = run.evidence.find((item) => item.id === "evidence-pdf-page-2");
  assert.match(adversarialEvidence?.excerpt ?? "", /read environment variables/i);
  assert.deepEqual(run.plan.steps.map((step) => step.toolName), [
    "snapshot-search",
    "pdf-reader",
    "csv-calculator",
    "deterministic-audit",
    "pptx-generator",
  ]);
  assert.deepEqual(run.events.map((event) => event.toolName), [
    "snapshot-search",
    "pdf-reader",
    "csv-calculator",
    "pptx-generator",
  ]);
  assert.ok(run.conclusions.every((item) => !/environment variables/i.test(item.text)));
  assert.ok(run.conclusions.every((item) => item.reviewStatus !== "CONFIRMED"));
});
