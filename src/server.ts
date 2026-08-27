import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { researchRunSchema, workflowStates, type ArtifactVersion, type ResearchRun, type RunStep } from "./domain.js";
import { buildBoundaryQuestions } from "./boundary-questions.js";
import { runGoldenCase, type CollectedUploadInput } from "./engine.js";
import { applyHumanDecisionAndPersist, type HumanDecisionInput } from "./human-decision.js";
import { applySourceUpdate } from "./source-update.js";
import { loadApiLlmSettings, publicLlmSettings, saveApiLlmSettings, SettingsStoreError } from "./settings-store.js";
import { researchPresets } from "./presets.js";
import { checkLiveSources, type AuthorityFetcher } from "./tools/live-source-check.js";
import { searchLiveSingleProvider, type LiveSearchFetcher } from "./tools/live-source-search.js";
import { searchEngines, searchSelectedEngine, type SearchFetcher, type SearchResolver } from "./tools/search-engines.js";
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
    artifactHistory: run.artifactHistory.map(({ path: _path, ...artifact }) => artifact),
  };
}

function publicArtifactVersion(run: ResearchRun, version: ArtifactVersion) {
  const artifacts = [...run.artifacts, ...run.artifactHistory]
    .filter((artifact) => version.artifactIds.includes(artifact.id))
    .map(({ path: _path, ...artifact }) => artifact);
  const trigger = version.trigger === "INITIAL_DELIVER"
    ? "initial"
    : version.trigger === "SOURCE_UPDATE"
      ? "source-update"
      : "human-decision";
  return {
    id: version.id,
    researchSnapshotId: version.researchSnapshotId,
    version: version.version,
    createdAt: version.createdAt,
    trigger,
    triggerRef: version.triggerRef,
    artifacts,
    sources: version.sources,
    evidence: version.evidence,
    conclusions: version.conclusions,
    adjustmentNote: version.adjustmentNote,
    status: version.status,
    supersedesId: version.supersedesId,
  };
}

export interface ServerOptions {
  fixtureDir: string;
  publicDir: string;
  workspaceDir: string;
  stepDelayMs?: number;
  searchFetcher?: SearchFetcher;
  searchResolver?: SearchResolver;
  authorityFetcher?: AuthorityFetcher;
  legacySearchFetcher?: LiveSearchFetcher;
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

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
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

export async function readUploadBytes(request: IncomingMessage) {
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

export function uploadFileName(request: IncomingMessage) {
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

export function publicHttpError(error: unknown) {
  if (error instanceof RequestError) return { status: error.status, message: error.message };
  if (error instanceof UploadValidationError || error instanceof UploadStoreError) {
    return { status: error.statusCode, message: error.message };
  }
  if (error instanceof SettingsStoreError) return { status: error.statusCode, message: error.message };
  return { status: 500, message: "Request failed" };
}

export function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function contentType(path: string) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".md") return "text/markdown; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export function staticFilePath(publicDir: string, pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const filePath = resolve(publicDir, requested);
  if (!inside(publicDir, filePath)) throw new RequestError(404, "Not found");
  return filePath;
}

export function serverBaseUrl(host: string, address: ReturnType<Server["address"]>) {
  if (!address || typeof address === "string") throw new Error("Could not resolve server address");
  return `http://${host}:${address.port}`;
}

export function settleServerClose(
  error: Error | undefined,
  resolveClose: () => void,
  rejectClose: (error: Error) => void,
) {
  if (error) {
    rejectClose(error);
    return;
  }
  resolveClose();
}

export function createInsightForgeServer(options: ServerOptions) {
  const jobs = new Map<string, Job>();
  const searchFetcher = options.searchFetcher ?? fetch;
  const stepDelayMs = options.stepDelayMs ?? 120;
  let currentRun: ResearchRun | undefined;
  let server: Server | undefined;

  async function persistJob(job: Job) {
    await mkdir(options.workspaceDir, { recursive: true });
    await writeFile(join(options.workspaceDir, `${job.runId}-progress.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  async function startRun(runId: string, question: string, uploadedFiles: CollectedUploadInput[]) {
    const job = jobs.get(runId)!;
    try {
      const apiLlmConfig = await loadApiLlmSettings(options.workspaceDir);
      const run = await runGoldenCase({
        researchQuestion: question,
        fixtureDir: options.fixtureDir,
        workspaceDir: options.workspaceDir,
        runId,
        stepDelayMs,
        // 黄金路径默认使用经过 SHA-256、问题域、Schema 与引用 ID 校验的认证模型缓存；
        // 显式 INSIGHTFORGE_LLM=1 才调用单一在线端点，不做模型 fallback。
        llmMode: apiLlmConfig || process.env.INSIGHTFORGE_LLM === "1" ? "auto" : "cached",
        ...(apiLlmConfig ? { llmConfig: apiLlmConfig } : {}),
        uploadedFiles,
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
      const url = new URL(request.url!, "http://localhost");
      const method = request.method!;
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, offlineDemo: true, defaultSynthesisMode: "CACHED_MODEL_OUTPUT" });
        return;
      }
      if (method === "GET" && url.pathname === "/api/presets") {
        sendJson(response, 200, researchPresets);
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
      if (method === "GET" && url.pathname === "/api/settings/llm") {
        sendJson(response, 200, publicLlmSettings(await loadApiLlmSettings(options.workspaceDir)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/settings/llm") {
        const config = await saveApiLlmSettings(options.workspaceDir, await readJson(request));
        sendJson(response, 200, publicLlmSettings(config));
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
        sendJson(response, 200, await checkLiveSources(options.authorityFetcher));
        return;
      }
      if (method === "POST" && url.pathname === "/api/sources/live-search") {
        const body = await readJson(request);
        const query = typeof body.query === "string" ? body.query : "";
        sendJson(response, 200, await searchLiveSingleProvider(query, options.legacySearchFetcher, options.searchResolver));
        return;
      }
      if (method === "POST" && url.pathname === "/api/sources/search") {
        const body = await readJson(request);
        const engine = body.engine;
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (typeof engine !== "string" || !searchEngines.includes(engine as (typeof searchEngines)[number]) || query.length < 2 || query.length > 160) {
          sendJson(response, 400, { error: "engine must be bing, google, or baidu and query must contain 2–160 characters" });
          return;
        }
        sendJson(response, 200, await searchSelectedEngine(
          engine as (typeof searchEngines)[number],
          query,
          searchFetcher,
          options.searchResolver,
        ));
        return;
      }
      if (method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        const researchQuestion = typeof body.researchQuestion === "string" ? body.researchQuestion.trim() : "";
        if (researchQuestion.length < 8 || researchQuestion.length > 240) {
          sendJson(response, 400, { error: "researchQuestion must contain 8–240 characters" });
          return;
        }
        const uploadIds = body.uploadIds === undefined ? [] : body.uploadIds;
        if (!Array.isArray(uploadIds) || uploadIds.length > 8 || uploadIds.some((id) => typeof id !== "string")) {
          sendJson(response, 400, { error: "uploadIds must be an array containing at most 8 upload identifiers" });
          return;
        }
        const uploadedFiles: CollectedUploadInput[] = [];
        for (const id of uploadIds) {
          const verified = await verifyPersistedUpload(options.workspaceDir, id as string);
          uploadedFiles.push({ id: verified.id, kind: verified.kind, originalFileName: verified.originalFileName, path: resolve(options.workspaceDir, verified.storageKey), sha256: verified.sha256, uploadedAt: verified.uploadedAt });
        }
        const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const job: Job = { runId, status: "running", steps: pendingSteps(), error: null };
        jobs.set(runId, job);
        await persistJob(job);
        void startRun(runId, researchQuestion, uploadedFiles);
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
        const decisionContext = {
          reason: typeof body.reason === "string" ? body.reason : undefined,
          scopeNote: typeof body.scopeNote === "string" ? body.scopeNote : undefined,
        };
        const input = action === "EDIT"
          ? { conclusionId, action, text: typeof body.text === "string" ? body.text : "", ...decisionContext }
          : { conclusionId, action, ...decisionContext };
        job.run = await applyHumanDecisionAndPersist(job.run, input as HumanDecisionInput, options.workspaceDir);
        currentRun = job.run;
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
      const boundaryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/boundary-questions$/);
      if (method === "GET" && boundaryMatch?.[1]) {
        const job = jobs.get(boundaryMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        if (!job.run) {
          sendJson(response, 409, { error: "Run is not completed" });
          return;
        }
        sendJson(response, 200, buildBoundaryQuestions(job.run));
        return;
      }
      const versionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifact-versions(?:\/([1-9]\d*))?$/);
      if (method === "GET" && versionMatch?.[1]) {
        const job = jobs.get(versionMatch[1]);
        if (!job?.run) {
          sendJson(response, 404, { error: "Completed run not found" });
          return;
        }
        if (versionMatch[2]) {
          const version = job.run.artifactVersions.find((item) => item.version === Number(versionMatch[2]));
          if (!version) {
            sendJson(response, 404, { error: "Artifact version not found" });
            return;
          }
          sendJson(response, 200, publicArtifactVersion(job.run, version));
          return;
        }
        sendJson(response, 200, [...job.run.artifactVersions]
          .sort((left, right) => left.version - right.version)
          .map((version) => publicArtifactVersion(job.run as ResearchRun, version)));
        return;
      }
      const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/(PPTX|EVIDENCE_JSON|REPORT_MD|REPORT_PDF)$/);
      if (method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
        const job = jobs.get(artifactMatch[1]);
        const requestedVersion = url.searchParams.get("version");
        if (requestedVersion !== null && !/^[1-9]\d*$/u.test(requestedVersion)) {
          sendJson(response, 400, { error: "Artifact version must be a positive integer" });
          return;
        }
        const candidates = job?.run ? [...job.run.artifacts, ...job.run.artifactHistory] : [];
        const artifact = candidates.find((item) => item.kind === artifactMatch[2] && (requestedVersion === null || item.version === Number(requestedVersion)));
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
        const filePath = staticFilePath(options.publicDir, url.pathname);
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
      const activeServer = server;
      await new Promise<void>((resolveListen, rejectListen) => {
        activeServer.once("error", rejectListen);
        activeServer.listen(port, host, () => resolveListen());
      });
      return serverBaseUrl(host, activeServer.address());
    },
    async stop() {
      if (!server) return;
      const activeServer = server;
      await new Promise<void>((resolveClose, rejectClose) => activeServer.close((error) => settleServerClose(error, resolveClose, rejectClose)));
      server = undefined;
    },
  };
}

export async function startDefaultServer(root = process.cwd(), port = Number(process.env.PORT ?? 4399), host = process.env.HOST ?? "127.0.0.1") {
  const app = createInsightForgeServer({
    fixtureDir: join(root, "fixtures", "golden"),
    publicDir: join(root, "public"),
    workspaceDir: join(root, ".insightforge"),
  });
  const url = await app.start(port, host);
  console.log(`InsightForge is running at ${url}`);
  return { app, url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startDefaultServer();
}
