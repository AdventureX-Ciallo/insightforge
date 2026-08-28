import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createInsightForgeServer } from "../dist/server.js";
import { hashValue } from "../dist/hash.js";

const root = process.cwd();
const reportPath = resolve(process.env.INSIGHTFORGE_CONTRACT_REPORT || join(root, ".insightforge", "contract-check-report.json"));
const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-contract-check-"));
const checks = [];
const startedAt = new Date().toISOString();
let baseUrl = null;
let requestKey = null;
let upload = null;
let runId = null;
let run = null;

function compact(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

class ContractFailure extends Error {
  constructor(message, evidence) {
    super(message);
    this.evidence = compact(evidence);
  }
}

function requireContract(condition, message, evidence) {
  if (!condition) throw new ContractFailure(message, evidence);
}

async function bodyEvidence(response) {
  const contentType = response.headers.get("content-type") || "";
  try {
    return contentType.includes("application/json") ? await response.clone().json() : await response.clone().text();
  } catch (error) {
    return { unreadableBody: error instanceof Error ? error.message : String(error) };
  }
}

async function expectResponse(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new ContractFailure(`${label} returned HTTP ${response.status}; expected ${expectedStatus}`, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await bodyEvidence(response),
    });
  }
  return response;
}

async function check(id, method, path, action) {
  const checkStartedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const evidence = compact(await action());
    checks.push({ id, method, path, status: "PASS", startedAt: checkStartedAt, durationMs: Math.round(performance.now() - started), evidence, error: null });
    return evidence;
  } catch (error) {
    checks.push({
      id,
      method,
      path,
      status: "FAIL",
      startedAt: checkStartedAt,
      durationMs: Math.round(performance.now() - started),
      evidence: compact(error instanceof ContractFailure ? error.evidence : { name: error?.name || "Error", stack: error?.stack || null }),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseSse(text) {
  return text.replaceAll("\r\n", "\n").split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || (lines.some((line) => line.startsWith(":")) ? "heartbeat" : "unknown");
    const rawData = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return { event, data: rawData ? JSON.parse(rawData) : null };
  });
}

function protectedOptions(options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return options;
  const headers = new Headers(options.headers);
  if (requestKey) headers.set("x-insightforge-request-key", requestKey);
  return { ...options, headers };
}

function apiFetch(path, options) {
  return fetch(`${baseUrl}${path}`, protectedOptions(options));
}

async function jsonRequest(path, options, expectedStatus = 200) {
  const response = await expectResponse(await apiFetch(path, options), expectedStatus, `${options?.method || "GET"} ${path}`);
  return response.json();
}

async function consumeRunSse(id) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await expectResponse(await apiFetch(`/api/runs/${id}/events`, { signal: controller.signal }), 200, "GET run SSE");
    requireContract(response.headers.get("content-type") === "text/event-stream; charset=utf-8", "SSE content type mismatch", Object.fromEntries(response.headers));
    const messages = parseSse(await response.text());
    requireContract(messages.some((item) => item.event === "tool"), "SSE did not contain tool events", { eventTypes: messages.map((item) => item.event) });
    requireContract(messages.at(-1)?.event === "terminal", "SSE did not close with terminal event", { lastEvent: messages.at(-1), eventTypes: messages.map((item) => item.event) });
    const snapshot = messages.filter((item) => item.event === "step").at(-1)?.data?.steps || [];
    requireContract(["PLAN", "COLLECT", "SYNTHESIZE", "AUDIT", "DELIVER"].every((state) => snapshot.some((step) => step.state === state && step.status === "success")), "SSE terminal snapshot did not contain five successful states", { snapshot });
    return { contentType: response.headers.get("content-type"), eventCount: messages.length, eventTypes: [...new Set(messages.map((item) => item.event))], terminal: messages.at(-1)?.data };
  } finally {
    clearTimeout(timeout);
  }
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const contractSearchFetcher = async () => new Response('<a href="https://example.com/contract-source">契约候选信源</a>', {
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
});
const app = createInsightForgeServer({
  fixtureDir: join(root, "fixtures", "golden"),
  publicDir: join(root, "public"),
  workspaceDir,
  stepDelayMs: 15,
  sseHeartbeatMs: 5,
  searchResolver: publicResolver,
  searchFetcher: contractSearchFetcher,
});

try {
  baseUrl = await app.start(0, "127.0.0.1");

  await check("health", "GET", "/api/health", async () => {
    const body = await jsonRequest("/api/health");
    requireContract(body.ok === true && body.offlineDemo === true, "health response contract mismatch", body);
    return body;
  });

  await check("request-key", "GET", "/api/request-key", async () => {
    const body = await jsonRequest("/api/request-key");
    requireContract(/^[0-9a-f-]{36}$/u.test(body.requestKey), "request-key response contract mismatch", body);
    requestKey = body.requestKey;
    return { available: true, length: requestKey.length };
  });

  await check("presets", "GET", "/api/presets", async () => {
    const body = await jsonRequest("/api/presets");
    requireContract(Array.isArray(body) && body.length === 3, "presets must expose exactly three entries", body);
    requireContract(body.filter((item) => item.kind === "golden").length === 1 && body.filter((item) => item.kind === "boundary").length === 2, "presets must contain one golden and two boundary cases", body);
    return { count: body.length, ids: body.map((item) => item.id), kinds: body.map((item) => item.kind) };
  });

  await check("upload-create", "POST", "/api/uploads", async () => {
    const bytes = Buffer.from("contract_metric,year,value\npublic_chargers,2024,3.58\n", "utf8");
    const response = await expectResponse(await apiFetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-insightforge-file-name": encodeURIComponent("contract-source.csv") },
      body: bytes,
    }), 201, "POST upload");
    const body = await response.json();
    upload = body.upload;
    requireContract(upload?.persisted === true && upload?.hashMatches === true && upload?.sha256 === createHash("sha256").update(bytes).digest("hex"), "upload persistence or digest contract mismatch", body);
    return { id: upload.id, kind: upload.kind, sizeBytes: upload.sizeBytes, sha256: upload.sha256, verificationUrl: upload.verificationUrl };
  });

  await check("upload-verify", "GET", "/api/uploads/:id", async () => {
    requireContract(upload?.verificationUrl, "upload-create dependency unavailable", { upload });
    const body = await jsonRequest(upload.verificationUrl);
    requireContract(body.upload?.id === upload.id && body.upload?.sha256 === upload.sha256 && body.upload?.hashMatches === true, "persisted upload verification mismatch", body);
    return { id: body.upload.id, hashMatches: body.upload.hashMatches, persisted: body.upload.persisted };
  });

  await check("source-search", "POST", "/api/sources/search", async () => {
    const body = await jsonRequest("/api/sources/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "bing", query: "新能源汽车 充电基础设施" }),
    });
    requireContract(body.engine === "bing" && body.candidates?.length === 1 && body.candidates[0].materialRole === "CANDIDATE_SOURCE" && body.candidates[0].authorityVerified === false, "search candidate contract mismatch", body);
    requireContract(body.sourceLimitTrace?.maxSources === 10, "search response omitted MAX_SOURCES trace", body);
    requireContract(body.dnsResolution?.resolver === "injected" && body.dnsResolution?.addressCount === 1 && body.dnsResolution?.attempts?.length === 1, "search response omitted DNS resolution trace", body);
    return { mode: "deterministic-contract-provider-not-live-search", engine: body.engine, candidate: body.candidates[0], sourceLimitTrace: body.sourceLimitTrace, dnsResolution: body.dnsResolution };
  });

  await check("run-create", "POST", "/api/runs", async () => {
    requireContract(upload?.id, "upload-create dependency unavailable", { upload });
    const body = await jsonRequest("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？", uploadIds: [upload.id] }),
    }, 202);
    runId = body.runId;
    requireContract(typeof runId === "string" && body.statusUrl === `/api/runs/${runId}`, "run creation contract mismatch", body);
    return body;
  });

  await check("run-sse", "GET", "/api/runs/:id/events", async () => {
    requireContract(runId, "run-create dependency unavailable", { runId });
    return consumeRunSse(runId);
  });

  await check("run-read", "GET", "/api/runs/:id", async () => {
    requireContract(runId, "run-create dependency unavailable", { runId });
    const body = await jsonRequest(`/api/runs/${runId}`);
    run = body.run;
    requireContract(body.job?.status === "completed" && run?.id === runId, "completed run contract mismatch", body);
    requireContract(run.uploadedFileIds?.includes(upload.id) && run.events?.some((event) => event.toolName === "local-file-reader"), "uploaded source did not enter COLLECT", { uploadedFileIds: run.uploadedFileIds, tools: run.events?.map((event) => event.toolName) });
    const synthesizeStep = run.steps.find((step) => step.state === "SYNTHESIZE");
    requireContract(synthesizeStep?.outputId === hashValue(run.synthesisOutput), "persisted SYNTHESIZE outputId is not reproducible from its immutable snapshot", { outputId: synthesizeStep?.outputId, recomputed: hashValue(run.synthesisOutput) });
    const expectedStates = ["PLAN", "COLLECT", "SYNTHESIZE", "AUDIT", "DELIVER"];
    requireContract(run.steps.every((step, index) => step.state === expectedStates[index] && step.status === "success" && /^[a-f0-9]{64}$/u.test(step.outputId)), "five-state output contract mismatch", run.steps);
    requireContract(run.steps[0].consumedOutputIds.length === 0 && run.steps.slice(1).every((step, index) => step.consumedOutputIds.length === 1 && step.consumedOutputIds[0] === run.steps[index].outputId), "step output consumption chain mismatch", run.steps);
    return { runId, status: body.job.status, terminalStatus: run.terminalStatus, steps: run.steps.map((step) => `${step.state}:${step.status}`), toolNames: run.events.map((event) => event.toolName), uploadedFileIds: run.uploadedFileIds, synthesisOutputId: synthesizeStep.outputId };
  });

  await check("current-run", "GET", "/api/current", async () => {
    const body = await jsonRequest("/api/current");
    requireContract(body.run?.id === runId, "current run does not match created run", { expectedRunId: runId, actualRunId: body.run?.id });
    return { runId: body.run.id, terminalStatus: body.run.terminalStatus };
  });

  await check("boundary-questions", "GET", "/api/runs/:id/boundary-questions", async () => {
    requireContract(runId, "run-create dependency unavailable", { runId });
    const body = await jsonRequest(`/api/runs/${runId}/boundary-questions`);
    requireContract(Array.isArray(body) && body.length === 3 && body.every((item) => item.question && item.rationale && item.missingEvidence?.length > 0), "boundary question contract mismatch", body);
    return { count: body.length, questions: body.map((item) => ({ question: item.question, evidenceGapIds: item.evidenceGapIds, missingEvidenceCount: item.missingEvidence.length })) };
  });

  await check("decision-edit", "POST", "/api/runs/:id/decisions", async () => {
    const body = await jsonRequest(`/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "EDIT", text: "人工修订：充电设施增长仍需区域利用率证据验证。", reason: "契约检查：收窄判断边界" }),
    });
    const conclusion = body.run?.conclusions?.find((item) => item.id === "conclusion-charging-growth");
    requireContract(conclusion?.originType === "HUMAN_EDITED" && conclusion?.normalizedReviewStatus === "PENDING_REVIEW", "EDIT did not preserve the pending human boundary", conclusion);
    return { conclusionId: conclusion.id, originType: conclusion.originType, reviewStatus: conclusion.normalizedReviewStatus, artifactVersionCount: body.run.artifactVersions.length };
  });

  await check("decision-confirm", "POST", "/api/runs/:id/decisions", async () => {
    const body = await jsonRequest(`/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "CONFIRM", reason: "契约检查：证据支持有限范围判断", scopeNote: "仅限当前全国描述性资料范围" }),
    });
    const conclusion = body.run?.conclusions?.find((item) => item.id === "conclusion-charging-growth");
    requireContract(conclusion?.reviewStatus === "CONFIRMED" && conclusion?.normalizedReviewStatus === "HUMAN_CONFIRMED" && conclusion?.confirmedAt && conclusion?.confirmedText, "CONFIRM did not create consistent explicit human confirmation", conclusion);
    const decisionCount = body.run.humanDecisions.length;
    const artifactVersionCount = body.run.artifactVersions.length;
    const replay = await expectResponse(await fetch(`${baseUrl}/api/runs/${runId}/decisions`, protectedOptions({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-charging-growth", action: "CONFIRM" }),
    })), 409, "replayed final human decision");
    const replayBody = await replay.json();
    requireContract(/already has a final human decision.*EDIT/u.test(replayBody.error || ""), "replay rejection was not actionable", replayBody);
    const afterReplay = await jsonRequest(`/api/runs/${runId}`);
    requireContract(
      afterReplay.run?.humanDecisions?.length === decisionCount && afterReplay.run?.artifactVersions?.length === artifactVersionCount,
      "replayed final decision changed the decision ledger or artifact chain",
      { before: { decisionCount, artifactVersionCount }, after: { decisionCount: afterReplay.run?.humanDecisions?.length, artifactVersionCount: afterReplay.run?.artifactVersions?.length } },
    );
    return { conclusionId: conclusion.id, reviewStatus: conclusion.normalizedReviewStatus, confirmedAt: conclusion.confirmedAt, artifactVersionCount, replayStatus: replay.status };
  });

  await check("source-update", "POST", "/api/runs/:id/source-update", async () => {
    const body = await jsonRequest(`/api/runs/${runId}/source-update`, { method: "POST" });
    run = body.run;
    requireContract(run?.sourceVersion === "v2" && run?.affectedObjectIds?.length > 0, "source update contract mismatch", body);
    const staleConclusion = run.conclusions.find((item) => item.evidenceStatus === "STALE");
    requireContract(staleConclusion?.freshness === "STALE" && staleConclusion?.reviewStatus === "NEEDS_REVIEW" && staleConclusion?.normalizedReviewStatus === "NEEDS_REVIEW", "source update produced inconsistent stale/review axes", staleConclusion);
    return { sourceVersion: run.sourceVersion, affectedObjectIds: run.affectedObjectIds, artifactVersionCount: run.artifactVersions.length };
  });

  await check("artifact-versions", "GET", "/api/runs/:id/artifact-versions", async () => {
    const body = await jsonRequest(`/api/runs/${runId}/artifact-versions`);
    requireContract(Array.isArray(body) && body.length >= 4 && body.every((version) => version.artifacts?.length === 4 && version.sources?.length > 0 && version.adjustmentNote), "artifact version list contract mismatch", body);
    return { count: body.length, versions: body.map((version) => ({ version: version.version, trigger: version.trigger, artifactCount: version.artifacts.length, status: version.status })) };
  });

  await check("artifact-version-detail", "GET", "/api/runs/:id/artifact-versions/1", async () => {
    const body = await jsonRequest(`/api/runs/${runId}/artifact-versions/1`);
    requireContract(body.version === 1 && body.trigger === "initial" && body.artifacts?.length === 4 && body.sources?.length > 0 && body.conclusions?.length >= 3, "artifact version detail contract mismatch", body);
    return { version: body.version, trigger: body.trigger, artifactCount: body.artifacts.length, sourceCount: body.sources.length, conclusionCount: body.conclusions.length };
  });

  for (const expected of [
    { kind: "PPTX", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", signature: "PK" },
    { kind: "EVIDENCE_JSON", contentType: "application/json; charset=utf-8", signature: "{" },
    { kind: "REPORT_MD", contentType: "text/markdown; charset=utf-8", signature: "#" },
    { kind: "REPORT_PDF", contentType: "application/pdf", signature: "%PDF" },
  ]) {
    await check(`download-${expected.kind.toLowerCase()}`, "GET", `/api/runs/:id/artifacts/${expected.kind}`, async () => {
      const response = await expectResponse(await apiFetch(`/api/runs/${runId}/artifacts/${expected.kind}`), 200, `download ${expected.kind}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const prefix = new TextDecoder().decode(bytes.slice(0, expected.signature.length));
      const artifact = run?.artifacts?.find((item) => item.kind === expected.kind);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      requireContract(response.headers.get("content-type") === expected.contentType && prefix === expected.signature && artifact?.sizeBytes === bytes.byteLength && artifact?.sha256 === sha256, `${expected.kind} download contract mismatch`, { headers: Object.fromEntries(response.headers), prefix, bytes: bytes.byteLength, sha256, artifact });
      if (expected.kind === "EVIDENCE_JSON") {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        const artifactKinds = [...new Set(parsed.artifacts?.map((item) => item.kind) || [])].sort();
        requireContract(parsed.researchQuestion && parsed.sources?.length > 0 && parsed.artifacts?.length >= 4 && ["EVIDENCE_JSON", "PPTX", "REPORT_MD", "REPORT_PDF"].every((kind) => artifactKinds.includes(kind)), "evidence package JSON contract mismatch", { keys: Object.keys(parsed), artifactCount: parsed.artifacts?.length, artifactKinds });
      }
      return { kind: expected.kind, contentType: response.headers.get("content-type"), sizeBytes: bytes.byteLength, sha256 };
    });
  }

  await check("llm-settings-read", "GET", "/api/settings/llm", async () => {
    const body = await jsonRequest("/api/settings/llm");
    requireContract(typeof body.configured === "boolean" && !["apiKey", "baseUrl", "model"].some((key) => Object.hasOwn(body, key)), "settings GET leaked or omitted contract fields", body);
    return body;
  });

  const contractOnlyToken = `contract-${randomUUID()}`;
  await check("llm-settings-write", "POST", "/api/settings/llm", async () => {
    const body = await jsonRequest("/api/settings/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://model.contract.invalid/v1", model: "contract-model", apiKey: contractOnlyToken }),
    });
    requireContract(body.configured === true && body.source === "api" && body.apiKeyMasked?.endsWith(contractOnlyToken.slice(-4)) && body.baseUrlMasked && body.modelMasked && !["apiKey", "baseUrl", "model"].some((key) => Object.hasOwn(body, key)), "settings POST did not return a masked contract", body);
    return body;
  });

  await check("llm-settings-read-masked", "GET", "/api/settings/llm", async () => {
    const body = await jsonRequest("/api/settings/llm");
    requireContract(body.configured === true && body.source === "api" && body.apiKeyMasked?.endsWith(contractOnlyToken.slice(-4)) && body.baseUrlMasked && body.modelMasked && !["apiKey", "baseUrl", "model"].some((key) => Object.hasOwn(body, key)), "persisted settings GET did not stay masked", body);
    return body;
  });
} catch (error) {
  await check("harness-bootstrap", "INTERNAL", "loopback server", async () => {
    throw new ContractFailure(error instanceof Error ? error.message : String(error), { name: error?.name || "Error", stack: error?.stack || null });
  });
} finally {
  try {
    await app.stop();
  } catch (error) {
    await check("harness-shutdown", "INTERNAL", "loopback server", async () => {
      throw new ContractFailure(error instanceof Error ? error.message : String(error), { name: error?.name || "Error", stack: error?.stack || null });
    });
  }
  await rm(workspaceDir, { recursive: true, force: true });
}

const passed = checks.filter((item) => item.status === "PASS").length;
const failed = checks.length - passed;
const report = {
  schemaVersion: "1.0",
  startedAt,
  completedAt: new Date().toISOString(),
  mode: "ephemeral-loopback-contract-check",
  externalNetworkUsed: false,
  searchEvidenceMode: "deterministic injected provider; API/parser/SSRF contract only, not a live-search claim",
  serverUrl: baseUrl,
  reportPath,
  summary: { total: checks.length, passed, failed, status: failed === 0 ? "PASS" : "FAIL" },
  checks,
};
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

for (const item of checks) {
  const suffix = item.status === "PASS" ? "" : ` — ${item.error} — evidence=${JSON.stringify(item.evidence)}`;
  console.log(`${item.status.padEnd(4)} ${item.method.padEnd(8)} ${item.path} (${item.durationMs} ms)${suffix}`);
}
console.log(`Contract check ${report.summary.status}: ${passed}/${checks.length} PASS; report=${reportPath}`);
if (failed > 0) process.exitCode = 1;
