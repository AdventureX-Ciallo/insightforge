import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isMainModule } from "../src/main-module.js";
import { DomainError } from "../src/domain-error.js";
import {
  assertRuntimeAssets,
  contentType,
  createInsightForgeServer,
  defaultServerPaths,
  discardRequestBody,
  endSseStream,
  friendlyListenError,
  inside,
  loadLocalEnvironment,
  normalizeRequestMethod,
  pipeArtifactStream,
  publicHttpError,
  readJson,
  readUploadBytes,
  resolveServerPaths,
  serverBaseUrl,
  settleServerClose,
  startDefaultServer,
  staticFilePath,
  uploadFileName,
  writeSseChunk,
} from "../src/server.js";

async function prepareRuntimeRoot(root: string) {
  await cp(resolve("public"), join(root, "public"), { recursive: true });
  await cp(resolve("fixtures/golden"), join(root, "fixtures/golden"), { recursive: true });
}

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
  const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
  await assert.rejects(readJson(incoming(["{}"], { "content-type": "text/plain" }).request), /Content-Type/u);
  assert.deepEqual(await readJson(incoming(["{}"], jsonHeaders).request), {});
  assert.deepEqual(await readJson(incoming([], jsonHeaders).request), {});
  for (const value of ["{", "null", "[]", "42"]) {
    await assert.rejects(readJson(incoming([value], jsonHeaders).request), /valid JSON|JSON object/u);
  }
  const streamedLargeJson = incoming([new Uint8Array(65 * 1024)], jsonHeaders);
  await assert.rejects(readJson(streamedLargeJson.request), /too large/u);
  assert.equal(streamedLargeJson.resumes(), 1);
  const declaredLargeJson = incoming([], { ...jsonHeaders, "content-length": String(65 * 1024) });
  await assert.rejects(readJson(declaredLargeJson.request), /too large/u);
  assert.equal(declaredLargeJson.resumes(), 1);
  const invalidLengthJson = incoming([], { ...jsonHeaders, "content-length": "not-a-number" });
  await assert.rejects(readJson(invalidLengthJson.request), /Content-Length is invalid/u);
  assert.equal(invalidLengthJson.resumes(), 1);
  const bodylessAction = incoming(["ignored action body"]);
  await discardRequestBody(bodylessAction.request);
  assert.equal(bodylessAction.resumes(), 0);
  const oversizedAction = incoming([new Uint8Array(65 * 1024)]);
  await assert.rejects(discardRequestBody(oversizedAction.request), /too large/u);
  assert.equal(oversizedAction.resumes(), 1);

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
  assert.deepEqual(["a.html", "a.css", "a.js", "a.woff2", "a.woff", "a.svg", "a.png", "a.webp", "a.jpg", "a.jpeg", "a.ico", "a.pptx", "a.pdf", "a.md", "a.json", "a.bin"].map(contentType), [
    "text/html; charset=utf-8",
    "text/css; charset=utf-8",
    "text/javascript; charset=utf-8",
    "font/woff2",
    "font/woff",
    "image/svg+xml",
    "image/png",
    "image/webp",
    "image/jpeg",
    "image/jpeg",
    "image/x-icon",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/pdf",
    "text/markdown; charset=utf-8",
    "application/json; charset=utf-8",
    "application/octet-stream",
  ]);
  assert.deepEqual(publicHttpError("secret internal error"), { status: 500, message: "Request failed" });
  assert.deepEqual(publicHttpError(new DomainError(422, "SOURCE_UPDATE_GRAPH_INVALID", "graph rejected")), { status: 422, message: "graph rejected", code: "SOURCE_UPDATE_GRAPH_INVALID" });

  const publicDir = resolve("public");
  assert.equal(staticFilePath(publicDir, "/"), join(publicDir, "index.html"));
  assert.throws(() => staticFilePath(publicDir, "../package.json"), /Not found/u);
  assert.equal(serverBaseUrl("127.0.0.1", { address: "127.0.0.1", port: 4399, family: "IPv4" }), "http://127.0.0.1:4399");
  assert.throws(() => serverBaseUrl("127.0.0.1", null), /resolve server address/u);
  assert.throws(() => serverBaseUrl("127.0.0.1", "pipe"), /resolve server address/u);
  assert.match(friendlyListenError(Object.assign(new Error("bind"), { code: "EADDRINUSE" }), 4399).message, /Port 4399 is already in use/u);
  assert.equal(friendlyListenError(new Error("other"), 4399).message, "other");
  assert.equal(friendlyListenError("other", 4399).message, "InsightForge could not start its HTTP listener");
  assert.equal(normalizeRequestMethod(undefined), "GET");
  assert.equal(normalizeRequestMethod("post"), "POST");
  await new Promise<void>((resolveClose, rejectClose) => settleServerClose(undefined, resolveClose, rejectClose));
  const closeError = new Error("close failed");
  await assert.rejects(new Promise<void>((resolveClose, rejectClose) => settleServerClose(closeError, resolveClose, rejectClose)), closeError);
});

test("actual listener conflicts return the friendly EADDRINUSE error", async () => {
  const blocker = createHttpServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-port-conflict-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir });
  try {
    await assert.rejects(app.start(address.port, "127.0.0.1"), new RegExp(`Port ${address.port} is already in use`, "u"));
  } finally {
    await app.stop();
    await new Promise<void>((resolveClose, rejectClose) => blocker.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("artifact stream read failures terminate only that response and leave the server alive", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.end("alive");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    let emitted = false;
    const failing = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from("partial"));
        queueMicrotask(() => this.destroy(new Error("injected artifact read failure")));
      },
    });
    pipeArtifactStream(failing, response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = serverBaseUrl("127.0.0.1", server.address());
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${baseUrl}/artifact`);
      await response.arrayBuffer();
    });
    assert.equal(await (await fetch(`${baseUrl}/health`)).text(), "alive");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("SSE writes and terminal closure fail soft for closing, throwing, and broken responses", () => {
  const calls: string[] = [];
  const open = {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    write(chunk: string) { calls.push(`write:${chunk}`); return false; },
    end(chunk: string) { calls.push(`end:${chunk}`); return this; },
    destroy() { calls.push("destroy"); return this; },
  } as unknown as ServerResponse;
  assert.equal(writeSseChunk(open, "event"), true, "backpressure is not a transport failure");
  assert.equal(endSseStream(open, "terminal"), true);
  assert.deepEqual(calls, ["write:event", "end:terminal"]);

  for (const state of ["destroyed", "writableEnded", "writableFinished"] as const) {
    const closed = { ...open, [state]: true } as ServerResponse;
    assert.equal(writeSseChunk(closed, "event"), false);
    assert.equal(endSseStream(closed, "terminal"), false);
  }

  let destroyCalls = 0;
  const throwing = {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    write() { throw new Error("synchronous SSE write failure"); },
    end() { throw new Error("synchronous SSE end failure"); },
    destroy() { destroyCalls += 1; throw new Error("transport destroy failure"); },
  } as unknown as ServerResponse;
  assert.equal(writeSseChunk(throwing, "event"), false);
  assert.equal(endSseStream(throwing, "terminal"), false);
  assert.equal(destroyCalls, 2);
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
    const emptyCurrent = await fetch(`${baseUrl}/api/current`);
    assert.equal(emptyCurrent.status, 200);
    assert.deepEqual(await emptyCurrent.json(), { run: null });
    assert.equal((await fetch(`${baseUrl}/api/sources/live-check`, { method: "POST", body: "consumed" })).status, 200);
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
    const duplicateUploads = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "足够长度的研究问题用于重复上传校验？", uploadIds: ["same", "same"] }),
    });
    assert.equal(duplicateUploads.status, 400);
    assert.equal((await duplicateUploads.json() as { code: string }).code, "DUPLICATE_UPLOAD_ID");
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
    assert.match(runId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await waitForRun(baseUrl, runId);
    assert.equal((await fetch(`${baseUrl}/api/current`)).status, 200);
    const beforeDomainErrors = await (await fetch(`${baseUrl}/api/runs/${runId}`)).json() as { run: { humanDecisions: unknown[]; artifactVersions: unknown[] } };
    for (const body of [{}, { conclusionId: 1, action: "REJECT" }, { conclusionId: "x", action: "INVALID" }]) {
      assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "missing", action: "REJECT" }) })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "EDIT", text: 42 }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-causality-gap", action: "CONFIRM" }) })).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-penetration", action: "CONFIRM" }) })).status, 400);
    const afterDomainErrors = await (await fetch(`${baseUrl}/api/runs/${runId}`)).json() as { run: { humanDecisions: unknown[]; artifactVersions: unknown[] } };
    assert.equal(afterDomainErrors.run.humanDecisions.length, beforeDomainErrors.run.humanDecisions.length);
    assert.equal(afterDomainErrors.run.artifactVersions.length, beforeDomainErrors.run.artifactVersions.length);
    const firstReject = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "REJECT", scopeNote: "对抗式范围说明" }) });
    assert.equal(firstReject.status, 200);
    const afterFirstReject = await firstReject.json() as { run: { humanDecisions: unknown[]; artifactVersions: unknown[] } };
    const repeatedReject = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "REJECT" }) });
    assert.equal(repeatedReject.status, 409);
    assert.match((await repeatedReject.json() as { error: string }).error, /already has a final human decision.*EDIT/u);
    const crossTerminalConfirm = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "CONFIRM" }) });
    assert.equal(crossTerminalConfirm.status, 409);
    const afterReplays = await fetch(`${baseUrl}/api/runs/${runId}`);
    const afterReplaysBody = await afterReplays.json() as { run: { humanDecisions: unknown[]; artifactVersions: unknown[] } };
    assert.equal(afterReplaysBody.run.humanDecisions.length, afterFirstReject.run.humanDecisions.length);
    assert.equal(afterReplaysBody.run.artifactVersions.length, afterFirstReject.run.artifactVersions.length);

    for (const kind of ["PPTX", "EVIDENCE_JSON", "REPORT_MD", "REPORT_PDF"]) {
      const download = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/${kind}`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("cache-control"), "no-store");
      await download.arrayBuffer();
    }
    const persisted = JSON.parse(await readFile(join(workspaceDir, "current.json"), "utf8")) as { artifacts: Array<{ kind: string; path: string }> };
    await rm(persisted.artifacts.find((item) => item.kind === "REPORT_MD")!.path);
    const missingArtifactFile = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/REPORT_MD`);
    assert.equal(missingArtifactFile.status, 404);
    assert.equal((await missingArtifactFile.json() as { error: string }).error, "Artifact file is unavailable");
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=0`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=999`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/0`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/999`)).status, 404);

    const firstUpdate = await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST", body: "consumed" });
    assert.equal(firstUpdate.status, 200);
    const repeatedUpdate = await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" });
    assert.equal(repeatedUpdate.status, 409);
    const repeatedUpdateBody = await repeatedUpdate.json() as { error: string; code: string };
    assert.match(repeatedUpdateBody.error, /来源已在 v2/u);
    assert.equal(repeatedUpdateBody.code, "SOURCE_ALREADY_V2");
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conclusionId: "conclusion-penetration", action: "CONFIRM", reason: "已说明口径", scopeNote: "仅限当前范围" }) })).status, 409);

    const mismatchCreated = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国光伏组件出口价格在 2025–2026 年会受到哪些结构性因素影响？" }),
    });
    const { runId: mismatchRunId } = await mismatchCreated.json() as { runId: string };
    await waitForRun(baseUrl, mismatchRunId);
    const mismatchedUpdate = await fetch(`${baseUrl}/api/runs/${mismatchRunId}/source-update`, { method: "POST" });
    assert.equal(mismatchedUpdate.status, 422);
    const mismatchedUpdateBody = await mismatchedUpdate.json() as { error: string; code: string };
    assert.equal(mismatchedUpdateBody.error, "来源更新仅适用于内置黄金案例的 v1→v2 演示");
    assert.equal(mismatchedUpdateBody.code, "SOURCE_UPDATE_NOT_APPLICABLE");

    for (const file of ["/", "/styles.css", "/app.js"]) assert.equal((await fetch(`${baseUrl}${file}`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/missing.css`)).status, 404);
    const wrongMethod = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    assert.equal((await fetch(`${baseUrl}/api/unknown`)).status, 404);
  } finally {
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
  await prepareRuntimeRoot(root);
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

  const directEnv: NodeJS.ProcessEnv = { ...process.env, HOST: "0.0.0.0" };
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

test("default server loads an optional .env before resolving listener settings", async () => {
  const keys = ["HOST", "PORT", "INSIGHTFORGE_LLM_MODEL"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), "insightforge-dotenv-"));
  await prepareRuntimeRoot(root);
  await writeFile(join(root, ".env"), "HOST=127.0.0.1\nPORT=0\nINSIGHTFORGE_LLM_MODEL=env-file-model\n", "utf8");
  keys.forEach((key) => { delete process.env[key]; });
  try {
    const { app, url } = await startDefaultServer(root);
    try {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.equal(process.env.INSIGHTFORGE_LLM_MODEL, "env-file-model");
    } finally {
      await app.stop();
    }

    process.env.HOST = "127.0.0.1";
    process.env.PORT = "0";
    process.env.INSIGHTFORGE_LLM_MODEL = "external-model";
    const external = await startDefaultServer(root);
    try {
      assert.equal(process.env.INSIGHTFORGE_LLM_MODEL, "external-model", "exported environment takes precedence over .env");
    } finally {
      await external.app.stop();
    }

    const missingRoot = await mkdtemp(join(tmpdir(), "insightforge-no-dotenv-"));
    assert.equal(loadLocalEnvironment(missingRoot), false);
    const invalidRoot = await mkdtemp(join(tmpdir(), "insightforge-bad-dotenv-"));
    await mkdir(join(invalidRoot, ".env"));
    assert.throws(() => loadLocalEnvironment(invalidRoot), /Could not load the local \.env file/u);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runtime assets resolve from the source or built module instead of process cwd", async () => {
  const projectRoot = resolve(".");
  const sourceUrl = pathToFileURL(join(projectRoot, "src", "server.ts")).href;
  const builtUrl = pathToFileURL(join(projectRoot, "dist", "server.js")).href;
  const bundleUrl = pathToFileURL(join(projectRoot, "standalone-bundle", "server.js")).href;
  assert.deepEqual(defaultServerPaths(sourceUrl), {
    envRoot: projectRoot,
    fixtureDir: join(projectRoot, "fixtures", "golden"),
    publicDir: join(projectRoot, "public"),
    workspaceDir: join(projectRoot, ".insightforge"),
  });
  assert.deepEqual(defaultServerPaths(builtUrl), {
    envRoot: projectRoot,
    fixtureDir: join(projectRoot, "dist", "fixtures", "golden"),
    publicDir: join(projectRoot, "dist", "public"),
    workspaceDir: join(projectRoot, ".insightforge"),
  });
  assert.deepEqual(resolveServerPaths(undefined, builtUrl), defaultServerPaths(builtUrl));
  assert.deepEqual(defaultServerPaths(bundleUrl), {
    envRoot: join(projectRoot, "standalone-bundle"),
    fixtureDir: join(projectRoot, "standalone-bundle", "fixtures", "golden"),
    publicDir: join(projectRoot, "standalone-bundle", "public"),
    workspaceDir: join(projectRoot, "standalone-bundle", ".insightforge"),
  });
  const explicit = resolveServerPaths("/opt/insightforge", builtUrl);
  assert.equal(explicit.publicDir, "/opt/insightforge/public");
  assert.equal(explicit.fixtureDir, "/opt/insightforge/fixtures/golden");

  await assert.doesNotReject(assertRuntimeAssets(resolve("public"), resolve("fixtures/golden")));
  const missing = await mkdtemp(join(tmpdir(), "insightforge-missing-runtime-"));
  await assert.rejects(assertRuntimeAssets(join(missing, "public"), join(missing, "fixtures/golden")), /runtime assets are incomplete/u);
  const nonFile = await mkdtemp(join(tmpdir(), "insightforge-nonfile-runtime-"));
  await prepareRuntimeRoot(nonFile);
  await rm(join(nonFile, "public", "index.html"));
  await mkdir(join(nonFile, "public", "index.html"));
  await assert.rejects(assertRuntimeAssets(join(nonFile, "public"), join(nonFile, "fixtures/golden")), /runtime assets are incomplete/u);
  const missingBundle = await mkdtemp(join(tmpdir(), "insightforge-missing-bundle-"));
  await prepareRuntimeRoot(missingBundle);
  await writeFile(join(missingBundle, "public", "index.html"), '<script type="module" src="/assets/missing.js"></script>', "utf8");
  await assert.rejects(assertRuntimeAssets(join(missingBundle, "public"), join(missingBundle, "fixtures/golden")), /runtime assets are incomplete/u);
  const nonFileFixture = await mkdtemp(join(tmpdir(), "insightforge-non-file-fixture-"));
  await prepareRuntimeRoot(nonFileFixture);
  await rm(join(nonFileFixture, "fixtures/golden/market_v1.csv"));
  await mkdir(join(nonFileFixture, "fixtures/golden/market_v1.csv"));
  await assert.rejects(assertRuntimeAssets(join(nonFileFixture, "public"), join(nonFileFixture, "fixtures/golden")), /runtime assets are incomplete/u);

  const entryRoot = await mkdtemp(join(tmpdir(), "insightforge-entrypoint-"));
  const realEntry = join(entryRoot, "server.js");
  const linkedEntry = join(entryRoot, "server-link.js");
  await writeFile(realEntry, "export {};\n", "utf8");
  await symlink(realEntry, linkedEntry);
  assert.equal(isMainModule(pathToFileURL(realEntry).href, realEntry), true);
  assert.equal(isMainModule(pathToFileURL(realEntry).href, linkedEntry), true, "symlinked argv paths resolve to the same module");
  assert.equal(isMainModule(pathToFileURL(realEntry).href, undefined), false);
  assert.equal(isMainModule(pathToFileURL(realEntry).href, join(entryRoot, "missing.js")), false);
});
