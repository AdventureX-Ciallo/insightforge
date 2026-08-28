import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import { createInsightForgeServer } from "../src/server.js";
import { MAX_RETAINED_UPLOADS, persistUpload } from "../src/upload-store.js";

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  const observed = new Set<string>();
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      job: { status: string; steps: Array<{ state: string; status: string }> };
      run?: { id: string; artifacts?: Array<Record<string, unknown>> };
    };
    for (const step of body.job.steps) observed.add(`${step.state}:${step.status}`);
    if (body.run) return { body, observed };
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for research run");
}

test("HTTP entrypoint runs, persists, reviews, updates, and downloads real artifacts", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-server-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 35,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);

    const create = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    assert.equal(create.status, 202);
    const { runId } = await create.json() as { runId: string };
    const { body, observed } = await waitForRun(baseUrl, runId);
    assert.equal(body.run?.id, runId);
    assert.ok(body.run?.artifacts?.every((artifact) => !("path" in artifact)));
    assert.ok([...observed].some((value) => value.endsWith(":running")), "polling should observe real progress");

    const current = await fetch(`${baseUrl}/api/current`);
    assert.equal(current.status, 200);
    assert.equal(((await current.json()) as { run: { id: string } }).run.id, runId);

    const decisionPromise = fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "EDIT", text: "人工修订后的候选判断。" }),
    });
    const updatePromise = fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" });
    const [decision, update] = await Promise.all([decisionPromise, updatePromise]);
    assert.equal(decision.status, 200);
    const edited = ((await decision.json()) as { run: { conclusions: Array<{ id: string; type: string; reviewStatus: string }> } }).run.conclusions.find((item) => item.id === "conclusion-charging-growth");
    assert.equal(edited?.type, "AI_JUDGMENT");
    assert.equal(edited?.reviewStatus, "PENDING_REVIEW");

    assert.equal(update.status, 200);
    assert.equal(((await update.json()) as { run: { sourceVersion: string } }).run.sourceVersion, "v2");
    const afterConcurrentWrites = ((await (await fetch(`${baseUrl}/api/runs/${runId}`)).json()) as {
      run: { sourceVersion: string; conclusions: Array<{ id: string; text: string }> };
    }).run;
    assert.equal(afterConcurrentWrites.sourceVersion, "v2");
    assert.equal(afterConcurrentWrites.conclusions.find((item) => item.id === "conclusion-charging-growth")?.text, "人工修订后的候选判断。");

    const artifact = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX`);
    assert.equal(artifact.status, 200);
    assert.match(artifact.headers.get("content-type") ?? "", /presentationml/);
    const bytes = new Uint8Array(await artifact.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 2)), "PK");
    const originalArtifact = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=1`);
    assert.equal(originalArtifact.status, 200);
    const originalBytes = new Uint8Array(await originalArtifact.arrayBuffer());
    assert.equal(new TextDecoder().decode(originalBytes.slice(0, 2)), "PK");
    assert.notDeepEqual(originalBytes, bytes, "the immutable v1 deck remains downloadable and differs from current");

    const traversal = await fetch(`${baseUrl}/../../../../etc/passwd`);
    assert.equal(traversal.status, 404);
  } finally {
    await app.stop();
  }
});

test("upload endpoint validates bytes, size, and traversal before persisting", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-upload-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
    const accepted = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-insightforge-file-name": encodeURIComponent("source.pdf") },
      body: pdfBytes,
    });
    assert.equal(accepted.status, 201);
    const acceptedBody = await accepted.json() as {
      upload: {
        id: string;
        originalFileName: string;
        sanitizedFileName: string;
        storageKey: string;
        sizeBytes: number;
        sha256: string;
        persisted: boolean;
        hashMatches: boolean;
        verificationUrl: string;
      };
    };
    assert.equal(acceptedBody.upload.originalFileName, "source.pdf");
    assert.equal(acceptedBody.upload.sanitizedFileName, "source.pdf");
    assert.equal(acceptedBody.upload.sizeBytes, pdfBytes.length);
    assert.match(acceptedBody.upload.sha256, /^[a-f0-9]{64}$/);
    assert.equal(acceptedBody.upload.persisted, true);
    assert.equal(acceptedBody.upload.hashMatches, true);
    assert.equal(isAbsolute(acceptedBody.upload.storageKey), false);
    const persistedPath = resolve(workspaceDir, acceptedBody.upload.storageKey);
    assert.deepEqual(await readFile(persistedPath), pdfBytes);
    assert.equal((await stat(persistedPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(workspaceDir, "uploads"))).mode & 0o777, 0o700);
    const verified = await fetch(`${baseUrl}${acceptedBody.upload.verificationUrl}`);
    assert.equal(verified.status, 200);
    assert.equal(((await verified.json()) as { upload: { sha256: string } }).upload.sha256, acceptedBody.upload.sha256);

    await writeFile(persistedPath, "tampered", "utf8");
    const tampered = await fetch(`${baseUrl}${acceptedBody.upload.verificationUrl}`);
    assert.equal(tampered.status, 409);
    assert.match(((await tampered.json()) as { error: string }).error, /digest/i);

    const workbook = new JSZip();
    workbook.file("[Content_Types].xml", "<Types/>");
    workbook.file("_rels/.rels", "<Relationships/>");
    workbook.file("xl/workbook.xml", "<workbook/>");
    const workbookBytes = await workbook.generateAsync({ type: "nodebuffer" });
    const acceptedWorkbook = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x-insightforge-file-name": encodeURIComponent("source.xlsx"),
      },
      body: new Uint8Array(workbookBytes),
    });
    assert.equal(acceptedWorkbook.status, 201);

    const incompleteWorkbook = new JSZip();
    incompleteWorkbook.file("[Content_Types].xml", "<Types/>");
    const rejectedWorkbook = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x-insightforge-file-name": encodeURIComponent("spoofed.xlsx"),
      },
      body: new Uint8Array(await incompleteWorkbook.generateAsync({ type: "nodebuffer" })),
    });
    assert.equal(rejectedWorkbook.status, 415);

    const spoofed = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-insightforge-file-name": encodeURIComponent("spoofed.pdf") },
      body: "not a PDF",
    });
    assert.equal(spoofed.status, 415);

    const traversal = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-insightforge-file-name": encodeURIComponent("../secret.pdf") },
      body: pdfBytes,
    });
    assert.equal(traversal.status, 400);

    const nulText = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-insightforge-file-name": encodeURIComponent("notes.txt") },
      body: Buffer.from([0x73, 0x61, 0x66, 0x65, 0x00, 0x78]),
    });
    assert.equal(nulText.status, 415);

    const oversized = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "text/csv", "x-insightforge-file-name": encodeURIComponent("large.csv") },
      body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    });
    assert.equal(oversized.status, 413);

    for (let index = 0; index < MAX_RETAINED_UPLOADS - 2; index += 1) {
      await persistUpload({
        workspaceDir,
        originalFileName: `quota-${index}.txt`,
        declaredMimeType: "text/plain",
        bytes: Buffer.from(`quota evidence ${index}\n`, "utf8"),
      });
    }
    const quotaExceeded = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-insightforge-file-name": encodeURIComponent("quota-overflow.txt") },
      body: "quota overflow\n",
    });
    assert.equal(quotaExceeded.status, 413);
    assert.match(((await quotaExceeded.json()) as { error: string }).error, /Aggregate upload quota exceeded/u);
  } finally {
    await app.stop();
  }
});

test("server refuses non-loopback listeners and serves browser hardening headers", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-loopback-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
  });
  await assert.rejects(app.start(0, "0.0.0.0"), /only permits a loopback listener/);
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await app.stop();
  }
});

test("server restores valid state, repairs truncated current state, and rejects unrecoverable corruption", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-restore-"));
  const options = {
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  };
  const writer = createInsightForgeServer(options);
  const writerUrl = await writer.start(0, "127.0.0.1");
  const create = await fetch(`${writerUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
  });
  const { runId } = await create.json() as { runId: string };
  await waitForRun(writerUrl, runId);
  await writer.stop();
  const legacyRun = JSON.parse(await readFile(join(workspaceDir, "current.json"), "utf8")) as { evictedArtifactVersionCount?: number };
  delete legacyRun.evictedArtifactVersionCount;
  await writeFile(join(workspaceDir, "current.json"), JSON.stringify(legacyRun), "utf8");

  const reader = createInsightForgeServer(options);
  const readerUrl = await reader.start(0, "127.0.0.1");
  try {
    const current = await fetch(`${readerUrl}/api/current`);
    assert.equal(current.status, 200);
    const restored = (await current.json()) as { run: { id: string; evictedArtifactVersionCount: number } };
    assert.equal(restored.run.id, runId);
    assert.equal(restored.run.evictedArtifactVersionCount, 0);
  } finally {
    await reader.stop();
  }

  await writeFile(join(workspaceDir, "current.json"), "{\n", "utf8");
  const recoveredReader = createInsightForgeServer(options);
  const recoveredUrl = await recoveredReader.start(0, "127.0.0.1");
  try {
    const recovered = await fetch(`${recoveredUrl}/api/current`);
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { run: { id: string } }).run.id, runId);
    assert.equal((JSON.parse(await readFile(join(workspaceDir, "current.json"), "utf8")) as { id: string }).id, runId);
  } finally {
    await recoveredReader.stop();
  }

  await writeFile(join(workspaceDir, "current.json"), JSON.stringify({
    schemaVersion: "1.0",
    id: "forged-delivered-run",
    researchQuestion: "伪造交付状态不得恢复",
    terminalStatus: "DELIVERED",
  }), "utf8");
  const forgedReader = createInsightForgeServer(options);
  const forgedUrl = await forgedReader.start(0, "127.0.0.1");
  try {
    const recovered = await fetch(`${forgedUrl}/api/current`);
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { run: { id: string } }).run.id, runId);
  } finally {
    await forgedReader.stop();
  }

  const unrecoverableWorkspace = await mkdtemp(join(tmpdir(), "insightforge-unrecoverable-current-"));
  await writeFile(join(unrecoverableWorkspace, "current.json"), "{bad", "utf8");
  const unrecoverable = createInsightForgeServer({ ...options, workspaceDir: unrecoverableWorkspace });
  await assert.rejects(unrecoverable.start(0, "127.0.0.1"), /no valid run snapshot can be recovered/u);

  const invalidSnapshotWorkspace = await mkdtemp(join(tmpdir(), "insightforge-unrecoverable-run-"));
  await mkdir(join(invalidSnapshotWorkspace, "broken-run"));
  await writeFile(join(invalidSnapshotWorkspace, "broken-run", "run.json"), "[]", "utf8");
  const invalidSnapshot = createInsightForgeServer({ ...options, workspaceDir: invalidSnapshotWorkspace });
  await assert.rejects(invalidSnapshot.start(0, "127.0.0.1"), /no valid run snapshot can be recovered/u);
});
