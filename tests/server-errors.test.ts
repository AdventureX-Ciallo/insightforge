import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  contentType,
  createInsightForgeServer,
  inside,
  publicHttpError,
  readJson,
  readUploadBytes,
  serverBaseUrl,
  settleServerClose,
  startDefaultServer,
  staticFilePath,
  uploadFileName,
} from "../src/server.js";

function incoming(chunks: Array<string | Buffer | Uint8Array>, headers: Record<string, string> = {}) {
  let resumes = 0;
  const request = {
    headers,
    resume() { resumes += 1; },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
  return { request, resumes: () => resumes };
}

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { job: { status: string }; run?: { artifacts: Array<{ kind: string }> } };
    if (body.run) return body.run;
    if (body.job.status === "failed") throw new Error("run failed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("run timeout");
}

test("request readers reject malformed, non-object, oversized, empty, and unsafe inputs", async () => {
  assert.deepEqual(await readJson(incoming(["{}"]).request), {});
  assert.deepEqual(await readJson(incoming([]).request), {});
  for (const value of ["{", "null", "[]", "42"]) {
    await assert.rejects(readJson(incoming([value]).request), /valid JSON|JSON object/u);
  }
  await assert.rejects(readJson(incoming([new Uint8Array(65 * 1024)]).request), /too large/u);

  await assert.rejects(readUploadBytes(incoming([], { "content-length": "-1" }).request), /Content-Length/u);
  const declaredLarge = incoming([], { "content-length": String(5 * 1024 * 1024 + 1) });
  await assert.rejects(readUploadBytes(declaredLarge.request), /5 MiB/u);
  assert.equal(declaredLarge.resumes(), 1);
  const streamedLarge = incoming([new Uint8Array(5 * 1024 * 1024 + 1)]);
  await assert.rejects(readUploadBytes(streamedLarge.request), /5 MiB/u);
  assert.equal(streamedLarge.resumes(), 1);
  await assert.rejects(readUploadBytes(incoming([]).request), /empty/u);
  assert.deepEqual(await readUploadBytes(incoming([new Uint8Array([1, 2, 3])]).request), Buffer.from([1, 2, 3]));

  const missingName = incoming([]);
  assert.throws(() => uploadFileName(missingName.request), /required/u);
  assert.equal(missingName.resumes(), 1);
  const badEncoding = incoming([], { "x-insightforge-file-name": "%" });
  assert.throws(() => uploadFileName(badEncoding.request), /invalid/u);
  assert.equal(badEncoding.resumes(), 1);
  const traversal = incoming([], { "x-insightforge-file-name": encodeURIComponent("../bad.pdf") });
  assert.throws(() => uploadFileName(traversal.request), /path separators/u);
  assert.equal(uploadFileName(incoming([], { "x-insightforge-file-name": "safe.pdf" }).request), "safe.pdf");

  assert.equal(inside("/tmp/root", "/tmp/root/file"), true);
  assert.equal(inside("/tmp/root", "/tmp/root"), false);
  assert.equal(inside("/tmp/root", "/tmp/other"), false);
  assert.deepEqual(["a.html", "a.css", "a.js", "a.pptx", "a.pdf", "a.md", "a.json", "a.bin"].map(contentType), [
    "text/html; charset=utf-8",
    "text/css; charset=utf-8",
    "text/javascript; charset=utf-8",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/pdf",
    "text/markdown; charset=utf-8",
    "application/json; charset=utf-8",
    "application/octet-stream",
  ]);
  assert.deepEqual(publicHttpError("secret internal error"), { status: 500, message: "Request failed" });

  const publicDir = resolve("public");
  assert.equal(staticFilePath(publicDir, "/"), join(publicDir, "index.html"));
  assert.throws(() => staticFilePath(publicDir, "../package.json"), /Not found/u);
  assert.equal(serverBaseUrl("127.0.0.1", { address: "127.0.0.1", port: 4399, family: "IPv4" }), "http://127.0.0.1:4399");
  assert.throws(() => serverBaseUrl("127.0.0.1", null), /resolve server address/u);
  assert.throws(() => serverBaseUrl("127.0.0.1", "pipe"), /resolve server address/u);
  await new Promise<void>((resolveClose, rejectClose) => settleServerClose(undefined, resolveClose, rejectClose));
  const closeError = new Error("close failed");
  await assert.rejects(new Promise<void>((resolveClose, rejectClose) => settleServerClose(closeError, resolveClose, rejectClose)), closeError);
});

test("HTTP API covers fail-closed route errors and all artifact/static content types", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-server-errors-"));
  const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
    searchResolver: publicResolver,
    authorityFetcher: async (input) => new Response(`<html><body>${input} 新能源汽车 1150 1286.6 40.9% 47.6% 1,089.9 357.9 272.6 authority source body long enough for verification</body></html>`, { status: 200, headers: { "content-type": "text/html" } }),
    legacySearchFetcher: async () => new Response(JSON.stringify({ query: { search: [] } }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await app.stop();
  const baseUrl = await app.start(0, "localhost");
  try {
    assert.equal((await fetch(`${baseUrl}/api/current`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/sources/live-check`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sources/live-search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "新能源" }) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sources/live-search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: 1 }) })).status, 400);

    assert.equal((await fetch(`${baseUrl}/api/settings/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/settings/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" })).status, 400);
    const hugeJson = JSON.stringify({ value: "x".repeat(70 * 1024) });
    assert.equal((await fetch(`${baseUrl}/api/settings/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: hugeJson })).status, 413);

    assert.equal((await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: "x" })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { "x-insightforge-file-name": "empty.pdf", "content-type": "application/pdf" } })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { "x-insightforge-file-name": "missing-mime.txt" }, body: Buffer.from("plain text") })).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/uploads/00000000-0000-4000-8000-000000000000`)).status, 404);

    assert.equal((await fetch(`${baseUrl}/api/sources/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "bing", query: 1 }) })).status, 400);

    for (const body of [
      {},
      { researchQuestion: "短" },
      { researchQuestion: "问".repeat(241) },
      { researchQuestion: "足够长度的研究问题用于输入校验？", uploadIds: "bad" },
      { researchQuestion: "足够长度的研究问题用于输入校验？", uploadIds: [1] },
    ]) {
      const response = await fetch(`${baseUrl}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    const overSourceLimit = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "足够长度的研究问题用于信源上限校验？", uploadIds: Array(6).fill("x") }),
    });
    assert.equal(overSourceLimit.status, 400);
    assert.deepEqual(await overSourceLimit.json(), {
      error: "uploadIds must be an array containing at most 5 upload identifiers",
      code: "SOURCE_LIMIT_EXCEEDED",
      maxSources: 10,
      maxUploads: 5,
    });
    assert.equal((await fetch(`${baseUrl}/api/runs/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/decisions`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/source-update`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/artifact-versions`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/artifacts/PPTX`)).status, 404);

    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    const { runId } = await created.json() as { runId: string };
    await waitForRun(baseUrl, runId);
    assert.equal((await fetch(`${baseUrl}/api/current`)).status, 200);
    for (const body of [{}, { conclusionId: 1, action: "REJECT" }, { conclusionId: "x", action: "INVALID" }]) {
      assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "missing", action: "REJECT" }) })).status, 500);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "EDIT", text: 42 }) })).status, 500);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "REJECT", scopeNote: "对抗式范围说明" }) })).status, 200);

    for (const kind of ["PPTX", "EVIDENCE_JSON", "REPORT_MD", "REPORT_PDF"]) {
      assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/${kind}`)).status, 200);
    }
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=0`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=999`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/999`)).status, 404);

    const firstUpdate = await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" });
    assert.equal(firstUpdate.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" })).status, 500);

    for (const file of ["/", "/styles.css", "/app.js"]) assert.equal((await fetch(`${baseUrl}${file}`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/missing.css`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/unknown`)).status, 404);
  } finally {
    await app.stop();
    await app.stop();
  }
});

test("corrupt settings fail closed and default server entry can start on an ephemeral port", async () => {
  const corruptWorkspace = await mkdtemp(join(tmpdir(), "insightforge-corrupt-settings-"));
  await writeFile(join(corruptWorkspace, "settings.json"), "not-json", "utf8");
  const corrupt = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir: corruptWorkspace });
  const corruptUrl = await corrupt.start(0, "127.0.0.1");
  try {
    const response = await fetch(`${corruptUrl}/api/settings/llm`);
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: string }).error, "Stored LLM settings are invalid");
  } finally {
    await corrupt.stop();
  }

  const root = await mkdtemp(join(tmpdir(), "insightforge-default-server-"));
  const { app, url } = await startDefaultServer(root, 0, "127.0.0.1");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  await app.stop();

  const priorHost = process.env.HOST;
  delete process.env.HOST;
  try {
    await assert.rejects(startDefaultServer(root, Number.NaN), /port|range/u);
  } finally {
    if (priorHost === undefined) delete process.env.HOST;
    else process.env.HOST = priorHost;
  }

  const directEnv = { ...process.env, HOST: "0.0.0.0" };
  delete directEnv.PORT;
  const direct = spawnSync(process.execPath, ["--import", "tsx", resolve("src/server.ts")], {
    cwd: resolve("."),
    env: directEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /only permits a loopback listener/u);
});
