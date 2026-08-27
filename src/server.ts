import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { evidencePackageSchema, researchRunSchema, workflowStates, type ResearchRun, type RunStep } from "./domain.js";
import { runGoldenCase } from "./engine.js";
import { hashFile, hashValue } from "./hash.js";
import { applyHumanDecision, type HumanDecisionInput } from "./human-decision.js";
import { applySourceUpdate } from "./source-update.js";
import { writePptx } from "./tools/pptx-export.js";
import { checkLiveSources } from "./tools/live-source-check.js";
import { MAX_UPLOAD_SIZE_BYTES, sanitizeUploadFileName, UploadValidationError } from "./tools/upload-validator.js";
import { persistUpload, UploadStoreError, verifyPersistedUpload } from "./upload-store.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Job {
  runId: string;
  status: "running" | "completed" | "failed";
  steps: RunStep[];
  error: string | null;
  run?: ResearchRun;
}

function publicJob(job: Job) {
  return {
    runId: job.runId,
    status: job.status,
    steps: job.steps.map((step) => ({ ...step, error: step.error ? "Step failed" : null })),
    error: job.error ? "Research run failed" : null,
  };
}

function publicRun(run: ResearchRun) {
  return {
    ...run,
    artifacts: run.artifacts.map(({ path: _path, ...artifact }) => artifact),
  };
}

export interface ServerOptions {
  fixtureDir: string;
  publicDir: string;
  workspaceDir: string;
  stepDelayMs?: number;
}

function pendingSteps(): RunStep[] {
  return workflowStates.map((state) => ({
    state,
    status: "pending",
    outputId: "",
    consumedOutputIds: [],
    startedAt: null,
    completedAt: null,
    error: null,
    summary: "",
  }));
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new RequestError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new RequestError(400, "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function readUploadBytes(request: IncomingMessage) {
  const rawLength = request.headers["content-length"];
  if (rawLength !== undefined) {
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new RequestError(400, "Upload Content-Length is invalid");
    }
    if (declaredLength > MAX_UPLOAD_SIZE_BYTES) {
      request.resume();
      throw new RequestError(413, "Upload exceeds the 5 MiB limit");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UPLOAD_SIZE_BYTES) {
      request.resume();
      throw new RequestError(413, "Upload exceeds the 5 MiB limit");
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new RequestError(400, "Upload body is empty");
  return Buffer.concat(chunks);
}

function uploadFileName(request: IncomingMessage) {
  const header = request.headers["x-insightforge-file-name"];
  if (typeof header !== "string" || !header) {
    request.resume();
    throw new RequestError(400, "Upload filename header is required");
  }
  try {
    const fileName = decodeURIComponent(header);
    sanitizeUploadFileName(fileName);
    return fileName;
  } catch (error) {
    request.resume();
    if (error instanceof UploadValidationError) throw error;
    throw new RequestError(400, "Upload filename header is invalid");
  }
}

function publicHttpError(error: unknown) {
  if (error instanceof RequestError) return { status: error.status, message: error.message };
  if (error instanceof UploadValidationError || error instanceof UploadStoreError) {
    return { status: error.statusCode, message: error.message };
  }
  return { status: 500, message: "Request failed" };
}

function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function contentType(path: string) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function refreshDecisionArtifacts(run: ResearchRun, workspaceDir: string) {
  const pptx = run.artifacts.find((item) => item.kind === "PPTX");
  const evidenceJson = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON");
  if (!pptx || !evidenceJson || !inside(workspaceDir, pptx.path) || !inside(workspaceDir, evidenceJson.path)) {
    throw new Error("Artifact paths are outside the allowed workspace");
  }
  await writePptx(run, pptx.path);
  const evidencePackage = evidencePackageSchema.parse({
    schemaVersion: run.schemaVersion,
    researchQuestion: run.researchQuestion,
    synthesisMode: run.synthesisMode,
    sources: run.sources,
    evidence: run.evidence,
    data: run.data,
    claims: run.claims,
    conclusions: run.conclusions,
    auditFindings: run.auditFindings,
    humanDecisions: run.humanDecisions,
    artifacts: run.artifacts.map((item) => ({ kind: item.kind, fileName: basename(item.path) })),
  });
  await writeFile(evidenceJson.path, `${JSON.stringify(evidencePackage, null, 2)}\n`, "utf8");
  const pptxInfo = await stat(pptx.path);
  const jsonInfo = await stat(evidenceJson.path);
  const pptxDigest = await hashFile(pptx.path);
  const jsonDigest = await hashFile(evidenceJson.path);
  run.artifacts = [
    { id: hashValue({ fileName: basename(pptx.path), pptxDigest }), kind: "PPTX", path: pptx.path, sha256: pptxDigest, sizeBytes: pptxInfo.size },
    { id: hashValue({ fileName: basename(evidenceJson.path), jsonDigest }), kind: "EVIDENCE_JSON", path: evidenceJson.path, sha256: jsonDigest, sizeBytes: jsonInfo.size },
  ];
  const runDir = resolve(workspaceDir, run.id);
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(join(workspaceDir, "current.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export function createInsightForgeServer(options: ServerOptions) {
  const jobs = new Map<string, Job>();
  let currentRun: ResearchRun | undefined;
  let server: Server | undefined;

  async function persistJob(job: Job) {
    await mkdir(options.workspaceDir, { recursive: true });
    await writeFile(join(options.workspaceDir, `${job.runId}-progress.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  async function startRun(runId: string, question: string) {
    const job = jobs.get(runId);
    if (!job) return;
    try {
      const run = await runGoldenCase({
        researchQuestion: question,
        fixtureDir: options.fixtureDir,
        workspaceDir: options.workspaceDir,
        runId,
        stepDelayMs: options.stepDelayMs ?? 120,
        // LLM 候选判断（模型提出）默认关闭：只有显式设置 INSIGHTFORGE_LLM=1 且提供密钥时启用，
        // 无网络/无密钥环境下演示行为与测试基线完全一致。
        llmMode: process.env.INSIGHTFORGE_LLM === "1" ? "auto" : "off",
        onProgress: async (steps) => {
          job.steps = steps;
          await persistJob(job);
        },
      });
      job.status = "completed";
      job.steps = run.steps;
      job.run = run;
      currentRun = run;
      await persistJob(job);
      await writeFile(join(options.workspaceDir, "current.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    } catch (error) {
      job.status = "failed";
      job.error = "Research run failed";
      job.steps = job.steps.map((step) => ({ ...step, error: step.error ? "Step failed" : null }));
      await persistJob(job);
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, offlineDemo: true });
        return;
      }
      if (method === "GET" && url.pathname === "/api/current") {
        if (!currentRun) {
          sendJson(response, 404, { error: "No research run exists yet" });
          return;
        }
        sendJson(response, 200, { run: publicRun(currentRun) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/uploads") {
        const originalFileName = uploadFileName(request);
        const declaredMimeType = typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : "application/octet-stream";
        const bytes = await readUploadBytes(request);
        const record = await persistUpload({ workspaceDir: options.workspaceDir, originalFileName, declaredMimeType, bytes });
        const verified = await verifyPersistedUpload(options.workspaceDir, record.id);
        sendJson(response, 201, { upload: verified });
        return;
      }
      const uploadMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]+)$/iu);
      if (method === "GET" && uploadMatch?.[1]) {
        sendJson(response, 200, { upload: await verifyPersistedUpload(options.workspaceDir, uploadMatch[1]) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/sources/live-check") {
        sendJson(response, 200, await checkLiveSources());
        return;
      }
      if (method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        const researchQuestion = typeof body.researchQuestion === "string" ? body.researchQuestion.trim() : "";
        if (researchQuestion.length < 8 || researchQuestion.length > 240) {
          sendJson(response, 400, { error: "researchQuestion must contain 8–240 characters" });
          return;
        }
        const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const job: Job = { runId, status: "running", steps: pendingSteps(), error: null };
        jobs.set(runId, job);
        await persistJob(job);
        void startRun(runId, researchQuestion);
        sendJson(response, 202, { runId, statusUrl: `/api/runs/${runId}` });
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch?.[1]) {
        const job = jobs.get(runMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        sendJson(response, 200, { job: publicJob(job), ...(job.run ? { run: publicRun(job.run) } : {}) });
        return;
      }
      const decisionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/decisions$/);
      if (method === "POST" && decisionMatch?.[1]) {
        const job = jobs.get(decisionMatch[1]);
        if (!job?.run) {
          sendJson(response, 404, { error: "Completed run not found" });
          return;
        }
        const body = await readJson(request);
        const action = body.action;
        const conclusionId = body.conclusionId;
        if (typeof conclusionId !== "string" || (action !== "CONFIRM" && action !== "REJECT" && action !== "EDIT")) {
          sendJson(response, 400, { error: "Invalid human decision" });
          return;
        }
        const input = action === "EDIT"
          ? { conclusionId, action, text: typeof body.text === "string" ? body.text : "" }
          : { conclusionId, action };
        job.run = applyHumanDecision(job.run, input as HumanDecisionInput);
        currentRun = job.run;
        await refreshDecisionArtifacts(job.run, options.workspaceDir);
        await persistJob(job);
        sendJson(response, 200, { run: publicRun(job.run) });
        return;
      }
      const updateMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/source-update$/);
      if (method === "POST" && updateMatch?.[1]) {
        const job = jobs.get(updateMatch[1]);
        if (!job?.run) {
          sendJson(response, 404, { error: "Completed run not found" });
          return;
        }
        job.run = await applySourceUpdate(job.run, { fixtureDir: options.fixtureDir, workspaceDir: options.workspaceDir });
        currentRun = job.run;
        await writeFile(join(options.workspaceDir, "current.json"), `${JSON.stringify(job.run, null, 2)}\n`, "utf8");
        await persistJob(job);
        sendJson(response, 200, { run: publicRun(job.run) });
        return;
      }
      const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/(PPTX|EVIDENCE_JSON)$/);
      if (method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
        const job = jobs.get(artifactMatch[1]);
        const artifact = job?.run?.artifacts.find((item) => item.kind === artifactMatch[2]);
        if (!artifact || !inside(options.workspaceDir, artifact.path)) {
          sendJson(response, 404, { error: "Artifact not found" });
          return;
        }
        const info = await stat(artifact.path);
        response.writeHead(200, {
          "content-type": contentType(artifact.path),
          "content-length": info.size,
          "content-disposition": `attachment; filename="${basename(artifact.path)}"`,
          "x-content-type-options": "nosniff",
        });
        createReadStream(artifact.path).pipe(response);
        return;
      }
      if (method === "GET" && !url.pathname.startsWith("/api/")) {
        const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const filePath = resolve(options.publicDir, requested);
        if (!inside(options.publicDir, filePath)) {
          sendJson(response, 404, { error: "Not found" });
          return;
        }
        try {
          const file = await readFile(filePath);
          response.writeHead(200, {
            "content-type": contentType(filePath),
            "content-length": file.length,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
          });
          response.end(file);
        } catch {
          sendJson(response, 404, { error: "Not found" });
        }
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const publicError = publicHttpError(error);
      sendJson(response, publicError.status, { error: publicError.message });
    }
  }

  return {
    async start(port = 4399, host = "127.0.0.1") {
      if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error("InsightForge is single-user software and only permits a loopback listener");
      }
      await mkdir(options.workspaceDir, { recursive: true });
      try {
        currentRun = researchRunSchema.parse(JSON.parse(await readFile(join(options.workspaceDir, "current.json"), "utf8")) as unknown);
        jobs.set(currentRun.id, { runId: currentRun.id, status: "completed", steps: currentRun.steps, error: null, run: currentRun });
      } catch {
        currentRun = undefined;
      }
      server = createServer((request, response) => void route(request, response));
      await new Promise<void>((resolveListen, rejectListen) => {
        server?.once("error", rejectListen);
        server?.listen(port, host, () => resolveListen());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not resolve server address");
      return `http://${host}:${address.port}`;
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolveClose, rejectClose) => server?.close((error) => error ? rejectClose(error) : resolveClose()));
      server = undefined;
    },
  };
}

async function main() {
  const root = process.cwd();
  const app = createInsightForgeServer({
    fixtureDir: join(root, "fixtures", "golden"),
    publicDir: join(root, "public"),
    workspaceDir: join(root, ".insightforge"),
  });
  const url = await app.start(Number(process.env.PORT ?? 4399), process.env.HOST ?? "127.0.0.1");
  console.log(`InsightForge is running at ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
