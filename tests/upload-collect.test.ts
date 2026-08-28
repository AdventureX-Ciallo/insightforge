import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import { runGoldenCase } from "../src/engine.js";
import { createInsightForgeServer } from "../src/server.js";

async function completedRun(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { job: { status: string; error?: string }; run?: Record<string, unknown> };
    if (body.job.status === "completed") return body.run as {
      uploadedFileIds: string[];
      events: Array<{ toolName: string }>;
      sources: Array<{ id: string; materialRole: string; locator: { page?: number; fileName?: string }; customWhitelist: null | { uploadId: string; originalFileName: string; sha256: string; parsedKind: string; status: string } }>;
      evidence: Array<{ sourceId: string; locator: { page?: number; fileName?: string } }>;
    };
    if (body.job.status === "failed") throw new Error(body.job.error ?? "run failed");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("run did not complete");
}

test("a validated upload is consumed by COLLECT in the same five-state run", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-collect-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const bytes = await readFile(resolve("fixtures/golden/market-brief.pdf"));
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const uploaded = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-insightforge-file-name": encodeURIComponent("评委补充材料.pdf") },
      body: new Uint8Array(bytes),
    });
    assert.equal(uploaded.status, 201);
    const uploadId = ((await uploaded.json()) as { upload: { id: string } }).upload.id;
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？", uploadIds: [uploadId] }),
    });
    assert.equal(created.status, 202);
    const runId = ((await created.json()) as { runId: string }).runId;
    const run = await completedRun(baseUrl, runId);
    assert.deepEqual(run.uploadedFileIds, [uploadId]);
    assert.ok(run.events.some((event) => event.toolName === "local-file-reader"));
    const uploadedSource = run.sources.find((source) => source.materialRole === "USER_UPLOAD");
    assert.ok(uploadedSource);
    assert.deepEqual(uploadedSource.customWhitelist, {
      uploadId,
      originalFileName: "评委补充材料.pdf",
      sha256: expectedSha256,
      parsedKind: "PDF",
      status: "PARSED",
    });
    assert.equal(uploadedSource.customWhitelist.sha256, expectedSha256);
    assert.ok(run.evidence.some((item) => item.sourceId === uploadedSource.id && item.locator.fileName && item.locator.page === 1));
  } finally {
    await app.stop();
  }
});

test("a byte-valid but structurally unreadable whitelist upload fails COLLECT instead of being ignored", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-fail-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("_rels/.rels", "<Relationships/>");
    zip.file("xl/workbook.xml", "<workbook/>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const uploaded = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-insightforge-file-name": "empty.xlsx" },
      body: new Uint8Array(bytes),
    });
    assert.equal(uploaded.status, 201);
    const uploadId = ((await uploaded.json()) as { upload: { id: string } }).upload.id;
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？", uploadIds: [uploadId] }),
    });
    const runId = ((await created.json()) as { runId: string }).runId;
    let terminal: { job: { status: string }; run?: unknown } | undefined;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      terminal = await (await fetch(`${baseUrl}/api/runs/${runId}`)).json() as { job: { status: string }; run?: unknown };
      if (terminal.job.status !== "running") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(terminal?.job.status, "failed");
    assert.equal(terminal?.run, undefined);
  } finally {
    await app.stop();
  }
});

test("COLLECT hashes the exact upload bytes it parses and rejects post-validation changes", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-toctou-"));
  const path = join(workspaceDir, "changed.txt");
  await writeFile(path, "bytes changed after the API verification step", "utf8");
  await assert.rejects(runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    uploadedFiles: [{
      id: "00000000-0000-4000-8000-000000000001",
      kind: "TXT",
      originalFileName: "changed.txt",
      path,
      sha256: "0".repeat(64),
      uploadedAt: new Date().toISOString(),
    }],
  }), /changed after validation/u);
});
