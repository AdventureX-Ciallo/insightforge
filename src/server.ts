import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

import { researchRunSchema, runStepSchema, toolCallEventSchema, workflowStates, type ArtifactVersion, type ResearchRun, type RunStep, type ToolCallEvent } from "./domain.js";
import { DomainError } from "./domain-error.js";
import { isMainModule } from "./main-module.js";
import { atomicWriteJson } from "./atomic-file.js";
import { loadPersistedRun, persistRun } from "./artifacts.js";
import { buildBoundaryQuestions } from "./boundary-questions.js";
import { MAX_RUN_SOURCES, MAX_RUN_UPLOADS, runGoldenCase, type CollectedUploadInput } from "./engine.js";
import { applyHumanDecisionAndPersist, type HumanDecisionInput } from "./human-decision.js";
import { applySourceUpdate } from "./source-update.js";
import { loadApiLlmSettings, publicLlmSettings, saveApiLlmSettings, SettingsStoreError } from "./settings-store.js";
import { researchPresets } from "./presets.js";
import { MAX_CONCURRENT_RUNS, MAX_RETAINED_RUNS, progressFileRunId, pruneRunWorkspace } from "./run-retention.js";
import { checkLiveSources, type AuthorityFetcher } from "./tools/live-source-check.js";
import { searchLiveSingleProvider, type LiveSearchFetcher } from "./tools/live-source-search.js";
import { FAKE_IP_PROXY_ERROR, searchEngines, searchSelectedEngine, type SearchFetcher, type SearchResolver } from "./tools/search-engines.js";
import { MAX_UPLOAD_SIZE_BYTES, sanitizeUploadFileName, UploadValidationError } from "./tools/upload-validator.js";
import { maintainUploadRetention, persistUpload, UploadStoreError, verifyPersistedUpload } from "./upload-store.js";

const LOOPBACK_ADDRESS_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_BIND_HOSTS = new Set([...LOOPBACK_ADDRESS_HOSTS, "localhost"]);
const REQUEST_KEY_HEADER = "x-insightforge-request-key";
const DISABLE_REQUEST_KEY_ENV = "INSIGHTFORGE_DISABLE_REQUEST_KEY";

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function normalizedHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isAllowedLoopbackOrigin(value: string) {
  try {
    const origin = new URL(value);
    return origin.protocol === "http:"
      && LOOPBACK_ADDRESS_HOSTS.has(normalizedHostname(origin.hostname))
      && !origin.username
      && !origin.password
      && origin.pathname === "/"
      && !origin.search
      && !origin.hash;
  } catch {
    return false;
  }
}

export function isAllowedHostHeader(value: string | string[] | undefined, listeningPort: number | undefined) {
  if (typeof value !== "string" || listeningPort === undefined || value.trim() !== value) return false;
  try {
    const host = new URL(`http://${value}`);
    const port = host.port ? Number(host.port) : 80;
    return LOOPBACK_ADDRESS_HOSTS.has(normalizedHostname(host.hostname))
      && port === listeningPort
      && !host.username
      && !host.password
      && host.pathname === "/"
      && !host.search
      && !host.hash;
  } catch {
    return false;
  }
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

export function enforceBrowserRequestBoundary(request: IncomingMessage, requestKey: string, disabled: boolean) {
  if (disabled) return;
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || !isAllowedLoopbackOrigin(origin))) {
    throw new RequestError(403, "Cross-origin requests are not allowed");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && (typeof fetchSite !== "string" || (fetchSite !== "same-origin" && fetchSite !== "none"))) {
    throw new RequestError(403, "Cross-site browser requests are not allowed");
  }
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && headerValue(request, REQUEST_KEY_HEADER) !== requestKey) {
    throw new RequestError(403, "A valid InsightForge request key is required");
  }
}

function requestKeyBootstrap(requestKey: string, nonce: string) {
  return `<script nonce="${nonce}">(()=>{const k=${JSON.stringify(requestKey)},f=globalThis.fetch.bind(globalThis),p=r=>{const t=r.headers.get('content-type')||'';if(t.includes('application/json'))void r.clone().json().then(b=>{const x=b&&b.run,e=document.querySelector('.offline-pill');if(x&&typeof x.offlineModeLabel==='string'&&e){const d=document.createElement('i');e.replaceChildren(d,document.createTextNode(' '+x.offlineModeLabel));e.dataset.mode=x.offlineMode?'offline':'live'}}).catch(()=>{});return r};globalThis.fetch=(i,n={})=>{const m=String(n.method||(i instanceof Request?i.method:"GET")).toUpperCase(),u=new URL(i instanceof Request?i.url:String(i),location.href);if(u.origin===location.origin&&!['GET','HEAD','OPTIONS'].includes(m)){const h=new Headers(i instanceof Request?i.headers:undefined);new Headers(n.headers).forEach((v,x)=>h.set(x,v));h.set('${REQUEST_KEY_HEADER}',k);return f(i,{...n,headers:h}).then(p)}return f(i,n).then(p)}})();</script>`;
}

interface Job {
  runId: string;
  status: "running" | "completed" | "failed";
  steps: RunStep[];
  error: string | null;
  events: ToolCallEvent[];
  run?: ResearchRun;
}

const persistedJobSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["running", "completed", "failed"]),
  steps: z.array(runStepSchema).length(5),
  error: z.string().nullable(),
  events: z.array(toolCallEventSchema),
  run: researchRunSchema.optional(),
}).strict().superRefine((job, ctx) => {
  if (job.status === "completed" && !job.run) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["run"], message: "Completed progress requires a ResearchRun" });
  if (job.run && job.run.id !== job.runId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["run", "id"], message: "Progress run ID mismatch" });
});

interface RunEventSubscriber {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  idleTimeout?: ReturnType<typeof setTimeout>;
}

export const MAX_SSE_SUBSCRIBERS_PER_RUN = 4;
export const MAX_TOTAL_SSE_SUBSCRIBERS = 6;
export const SSE_IDLE_TIMEOUT_MS = 60_000;

function destroySseResponse(response: ServerResponse) {
  try {
    response.destroy();
  } catch {
    // The stream is already unusable; a second transport error must stay isolated.
  }
}

export function writeSseChunk(response: ServerResponse, chunk: string) {
  if (response.destroyed || response.writableEnded || response.writableFinished) return false;
  try {
    response.write(chunk);
    return true;
  } catch {
    destroySseResponse(response);
    return false;
  }
}

export function endSseStream(response: ServerResponse, chunk: string) {
  if (response.destroyed || response.writableEnded || response.writableFinished) return false;
  try {
    response.end(chunk);
    return true;
  } catch {
    destroySseResponse(response);
    return false;
  }
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
  sseHeartbeatMs?: number;
  sseIdleTimeoutMs?: number;
  sseWriter?: typeof writeSseChunk;
  loopbackResolver?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
}

export async function resolveLoopbackBindHost(
  host: string,
  resolver: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>> = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  if (LOOPBACK_ADDRESS_HOSTS.has(host)) return host;
  if (host !== "localhost") throw new Error("InsightForge is single-user software and only permits a loopback listener");
  const answers = await resolver(host);
  if (answers.length === 0 || answers.some((answer) => !LOOPBACK_ADDRESS_HOSTS.has(normalizedHostname(answer.address)))) {
    throw new Error("localhost did not resolve exclusively to loopback addresses; listener start was refused");
  }
  return normalizedHostname(answers[0]!.address);
}

const API_ROUTE_METHODS: Array<{ pattern: RegExp; methods: readonly string[] }> = [
  { pattern: /^\/api\/(?:health|presets|request-key|current)$/u, methods: ["GET"] },
  { pattern: /^\/api\/settings\/llm$/u, methods: ["GET", "POST"] },
  { pattern: /^\/api\/uploads$/u, methods: ["POST"] },
  { pattern: /^\/api\/uploads\/[0-9a-f-]+$/iu, methods: ["GET"] },
  { pattern: /^\/api\/sources\/(?:live-check|live-search|search)$/u, methods: ["POST"] },
  { pattern: /^\/api\/runs$/u, methods: ["POST"] },
  { pattern: /^\/api\/runs\/[^/]+$/u, methods: ["GET"] },
  { pattern: /^\/api\/runs\/[^/]+\/events$/u, methods: ["GET"] },
  { pattern: /^\/api\/runs\/[^/]+\/(?:decisions|source-update)$/u, methods: ["POST"] },
  { pattern: /^\/api\/runs\/[^/]+\/(?:boundary-questions|artifact-versions(?:\/[^/]+)?|artifacts\/(?:PPTX|EVIDENCE_JSON|REPORT_MD|REPORT_PDF))$/u, methods: ["GET"] },
];

export function allowedApiMethods(pathname: string) {
  return API_ROUTE_METHODS.find((route) => route.pattern.test(pathname))?.methods ?? null;
}

export function normalizeRequestMethod(method: string | undefined) {
  return (method ?? "GET").toUpperCase();
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

export function formatSseEvent(event: "step" | "tool" | "terminal" | "stream-end", value: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

/** Pipeline owns both stream errors and client disconnects; no error event is left unhandled. */
export function pipeArtifactStream(stream: Readable, response: ServerResponse) {
  void pipeline(stream, response).catch(() => response.destroy());
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestError(415, "Content-Type must be application/json");
  const rawLength = headerValue(request, "content-length");
  if (rawLength !== null) {
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      request.resume();
      throw new RequestError(400, "Request Content-Length is invalid");
    }
    if (declaredLength > 64 * 1024) {
      request.resume();
      throw new RequestError(413, "Request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      request.resume();
      throw new RequestError(413, "Request body is too large");
    }
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

/** Consume action-request bodies so unread bytes cannot survive on a keep-alive connection. */
export async function discardRequestBody(request: IncomingMessage) {
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (size > 64 * 1024) {
      request.resume();
      throw new RequestError(413, "Request body is too large");
    }
  }
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
  if (error instanceof DomainError) return { status: error.statusCode, message: error.message };
  if (error instanceof UploadValidationError || error instanceof UploadStoreError) {
    return { status: error.statusCode, message: error.message };
  }
  if (error instanceof SettingsStoreError) return { status: error.statusCode, message: error.message };
  if (error instanceof Error && error.message === FAKE_IP_PROXY_ERROR) return { status: 503, message: FAKE_IP_PROXY_ERROR };
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

export function friendlyListenError(error: unknown, port: number) {
  if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    return new Error(`Port ${port} is already in use; stop the other process or choose a different PORT`, { cause: error });
  }
  return error instanceof Error ? error : new Error("InsightForge could not start its HTTP listener");
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

export function loadLocalEnvironment(root: string) {
  const result = loadDotEnv({ path: join(root, ".env"), override: false, quiet: true });
  if (!result.error) return true;
  if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw new Error("Could not load the local .env file", { cause: result.error });
}

export function defaultServerPaths(moduleUrl = import.meta.url) {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const moduleFolder = basename(moduleDir);
  const sourceExecution = moduleFolder === "src";
  const assetRoot = sourceExecution ? dirname(moduleDir) : moduleDir;
  const stateRoot = moduleFolder === "src" || moduleFolder === "dist" ? dirname(moduleDir) : moduleDir;
  return {
    envRoot: stateRoot,
    fixtureDir: join(assetRoot, "fixtures", "golden"),
    publicDir: join(assetRoot, "public"),
    workspaceDir: join(stateRoot, ".insightforge"),
  };
}

export function resolveServerPaths(root?: string, moduleUrl = import.meta.url) {
  return root === undefined
    ? defaultServerPaths(moduleUrl)
    : { envRoot: root, fixtureDir: join(root, "fixtures", "golden"), publicDir: join(root, "public"), workspaceDir: join(root, ".insightforge") };
}

export async function assertRuntimeAssets(publicDir: string, fixtureDir: string) {
  const requiredFiles = [
    join(publicDir, "index.html"),
    join(publicDir, "app.js"),
    join(publicDir, "styles.css"),
    ...["search-index.json", "market-brief.pdf", "market_v1.csv", "market_v2.csv", "model-cache-manifest.json", "model-plan-cache.json", "model-plan-prompt.txt", "model-synthesis-cache.json", "model-synthesis-prompt.txt"].map((name) => join(fixtureDir, name)),
  ];
  try {
    const entries = await Promise.all(requiredFiles.map((path) => stat(path)));
    if (entries.some((entry) => !entry.isFile())) throw new Error("not a regular file");
  } catch (error) {
    throw new Error("InsightForge runtime assets are incomplete; rebuild the project or restore dist/public and dist/fixtures/golden", { cause: error });
  }
}

export function createInsightForgeServer(options: ServerOptions) {
  const jobs = new Map<string, Job>();
  const eventSubscribers = new Map<string, Set<RunEventSubscriber>>();
  const runMutationQueues = new Map<string, Promise<void>>();
  const searchFetcher = options.searchFetcher ?? fetch;
  const stepDelayMs = options.stepDelayMs ?? 120;
  const sseHeartbeatMs = options.sseHeartbeatMs ?? 15_000;
  const sseIdleTimeoutMs = options.sseIdleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  const writeRunStream = options.sseWriter ?? writeSseChunk;
  const requestKey = randomUUID();
  const requestKeyProtectionDisabled = process.env[DISABLE_REQUEST_KEY_ENV] === "1";
  let currentRun: ResearchRun | undefined;
  let currentRunPublication = Promise.resolve();
  let server: Server | undefined;
  let listeningPort: number | undefined;

  async function persistJob(job: Job) {
    await mkdir(options.workspaceDir, { recursive: true });
    await atomicWriteJson(join(options.workspaceDir, `${job.runId}-progress.json`), job);
  }

  async function recoverPersistedJobs() {
    for (const entry of await readdir(options.workspaceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const expectedRunId = progressFileRunId(entry.name);
      if (!expectedRunId) continue;
      let parsed: ReturnType<typeof persistedJobSchema.parse>;
      try {
        parsed = persistedJobSchema.parse(JSON.parse(await readFile(join(options.workspaceDir, entry.name), "utf8")) as unknown);
      } catch {
        continue;
      }
      if (parsed.runId !== expectedRunId) continue;
      const job = parsed as Job;
      if (job.status === "running") {
        const interrupted = job.steps.find((step) => step.status === "running");
        if (interrupted) {
          interrupted.status = "failed";
          interrupted.completedAt = new Date().toISOString();
          interrupted.error = "Step interrupted by process restart";
        }
        job.status = "failed";
        job.error = "Research run interrupted by process restart";
        await persistJob(job);
      }
      jobs.set(job.runId, job);
    }
  }

  function serializeRunMutation<T>(runId: string, action: () => Promise<T>) {
    const previous = runMutationQueues.get(runId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    runMutationQueues.set(runId, tail);
    void tail.then(() => {
      if (runMutationQueues.get(runId) === tail) runMutationQueues.delete(runId);
    });
    return result;
  }

  function activeRunCount() {
    return [...jobs.values()].filter((job) => job.status === "running").length;
  }

  function trimJobMap(targetSize = MAX_RETAINED_RUNS) {
    for (const [runId, job] of jobs) {
      if (jobs.size <= targetSize) break;
      if (job.status === "running" || runId === currentRun?.id) continue;
      jobs.delete(runId);
      runMutationQueues.delete(runId);
    }
  }

  async function maintainRunRetention() {
    const protectedRunIds = new Set([...jobs.values()].filter((job) => job.status === "running").map((job) => job.runId));
    if (currentRun) protectedRunIds.add(currentRun.id);
    const trace = await pruneRunWorkspace(options.workspaceDir, protectedRunIds);
    for (const runId of trace.removedRunIds) {
      jobs.delete(runId);
      runMutationQueues.delete(runId);
    }
    trimJobMap();
    return trace;
  }

  function publishCurrentRun(run: ResearchRun) {
    const publication = currentRunPublication.then(async () => {
      await persistRun(run, options.workspaceDir);
      currentRun = run;
    });
    currentRunPublication = publication.then(() => undefined, () => undefined);
    return publication;
  }

  function publishRunEvent(runId: string, event: "step" | "tool", value: unknown) {
    const message = formatSseEvent(event, value);
    for (const subscriber of eventSubscribers.get(runId) ?? []) {
      if (!writeRunStream(subscriber.response, message)) removeSubscriber(runId, subscriber);
      else armSubscriberIdleTimeout(runId, subscriber);
    }
  }

  function totalEventSubscriberCount() {
    return [...eventSubscribers.values()].reduce((total, subscribers) => total + subscribers.size, 0);
  }

  function armSubscriberIdleTimeout(runId: string, subscriber: RunEventSubscriber) {
    clearTimeout(subscriber.idleTimeout);
    subscriber.idleTimeout = setTimeout(() => {
      removeSubscriber(runId, subscriber);
      endSseStream(subscriber.response, formatSseEvent("stream-end", { runId, reason: "idle-timeout", reconnect: true }));
    }, sseIdleTimeoutMs);
    subscriber.idleTimeout.unref();
  }

  function removeSubscriber(runId: string, subscriber: RunEventSubscriber) {
    clearInterval(subscriber.heartbeat);
    clearTimeout(subscriber.idleTimeout);
    const subscribers = eventSubscribers.get(runId);
    subscribers?.delete(subscriber);
    if (subscribers?.size === 0) eventSubscribers.delete(runId);
  }

  function closeRunStreams(job: Job) {
    const subscribers = [...(eventSubscribers.get(job.runId) ?? [])];
    for (const subscriber of subscribers) {
      removeSubscriber(job.runId, subscriber);
      endSseStream(subscriber.response, formatSseEvent("terminal", { runId: job.runId, status: job.status, error: job.error }));
    }
  }

  function openRunStream(request: IncomingMessage, response: ServerResponse, job: Job) {
    if (job.status === "running") {
      const runSubscriberCount = eventSubscribers.get(job.runId)?.size ?? 0;
      if (runSubscriberCount >= MAX_SSE_SUBSCRIBERS_PER_RUN || totalEventSubscriberCount() >= MAX_TOTAL_SSE_SUBSCRIBERS) {
        response.setHeader("retry-after", "1");
        sendJson(response, 429, {
          error: "SSE subscriber capacity reached; retry after an existing stream closes",
          code: "SSE_CAPACITY_EXCEEDED",
          maxSubscribersPerRun: MAX_SSE_SUBSCRIBERS_PER_RUN,
          maxTotalSubscribers: MAX_TOTAL_SSE_SUBSCRIBERS,
        });
        return;
      }
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    let subscriber: RunEventSubscriber | undefined;
    const cleanup = () => {
      if (subscriber) removeSubscriber(job.runId, subscriber);
    };
    request.once("aborted", cleanup);
    response.once("close", cleanup);
    response.on("error", cleanup);
    if (!writeRunStream(response, formatSseEvent("step", { runId: job.runId, steps: job.steps }))) return;
    for (const event of job.events) {
      if (!writeRunStream(response, formatSseEvent("tool", { runId: job.runId, event }))) return;
    }
    if (job.status !== "running") {
      endSseStream(response, formatSseEvent("terminal", { runId: job.runId, status: job.status, error: job.error }));
      return;
    }
    subscriber = {
      response,
      heartbeat: setInterval(() => {
        if (!writeRunStream(response, ": heartbeat\n\n")) cleanup();
      }, sseHeartbeatMs),
    };
    armSubscriberIdleTimeout(job.runId, subscriber);
    const subscribers = eventSubscribers.get(job.runId) ?? new Set<RunEventSubscriber>();
    subscribers.add(subscriber);
    eventSubscribers.set(job.runId, subscribers);
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
        publishCurrent: false,
        onProgress: async (steps) => {
          job.steps = steps;
          await persistJob(job);
          publishRunEvent(runId, "step", { runId, steps });
        },
        onToolEvent: async (event) => {
          job.events.push(event);
          await persistJob(job);
          publishRunEvent(runId, "tool", { runId, event });
        },
      });
      await serializeRunMutation(runId, async () => {
        await publishCurrentRun(run);
        job.status = "completed";
        job.steps = run.steps;
        job.run = run;
        await persistJob(job);
      });
      closeRunStreams(job);
    } catch (error) {
      job.status = "failed";
      job.error = "Research run failed";
      job.steps = job.steps.map((step) => ({ ...step, error: step.error ? "Step failed" : null }));
      await persistJob(job);
      closeRunStreams(job);
    }
    await maintainRunRetention();
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url!, "http://localhost");
      const method = normalizeRequestMethod(request.method);
      if (!isAllowedHostHeader(request.headers.host, listeningPort)) throw new RequestError(403, "Host header must match the loopback listener");
      enforceBrowserRequestBoundary(request, requestKey, requestKeyProtectionDisabled);
      const allowedMethods = allowedApiMethods(url.pathname);
      if (allowedMethods && !allowedMethods.includes(method)) {
        response.setHeader("allow", allowedMethods.join(", "));
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, offlineDemo: true, defaultSynthesisMode: "CACHED_MODEL_OUTPUT" });
        return;
      }
      if (method === "GET" && url.pathname === "/api/presets") {
        sendJson(response, 200, researchPresets);
        return;
      }
      if (method === "GET" && url.pathname === "/api/request-key") {
        sendJson(response, 200, { requestKey });
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
        await discardRequestBody(request);
        sendJson(response, 200, await checkLiveSources(options.authorityFetcher));
        return;
      }
      if (method === "POST" && url.pathname === "/api/sources/live-search") {
        const body = await readJson(request);
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (query.length < 2 || query.length > 160) {
          sendJson(response, 400, { error: "query must contain 2–160 characters" });
          return;
        }
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
        if (!Array.isArray(uploadIds) || uploadIds.length > MAX_RUN_UPLOADS || uploadIds.some((id) => typeof id !== "string")) {
          sendJson(response, 400, {
            error: `uploadIds must be an array containing at most ${MAX_RUN_UPLOADS} upload identifiers`,
            code: "SOURCE_LIMIT_EXCEEDED",
            maxSources: MAX_RUN_SOURCES,
            maxUploads: MAX_RUN_UPLOADS,
          });
          return;
        }
        if (new Set(uploadIds).size !== uploadIds.length) {
          sendJson(response, 400, { error: "uploadIds must not contain duplicates", code: "DUPLICATE_UPLOAD_ID" });
          return;
        }
        trimJobMap(MAX_RETAINED_RUNS - 1);
        if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
          response.setHeader("retry-after", "1");
          sendJson(response, 429, { error: `At most ${MAX_CONCURRENT_RUNS} research runs may execute concurrently`, code: "RUN_CAPACITY_EXCEEDED", maxConcurrentRuns: MAX_CONCURRENT_RUNS, maxRetainedRuns: MAX_RETAINED_RUNS });
          return;
        }
        const runId = `run-${randomUUID()}`;
        const job: Job = { runId, status: "running", steps: pendingSteps(), error: null, events: [] };
        jobs.set(runId, job);
        try {
          const uploadedFiles: CollectedUploadInput[] = [];
          for (const id of uploadIds) {
            const verified = await verifyPersistedUpload(options.workspaceDir, id as string);
            uploadedFiles.push({ id: verified.id, kind: verified.kind, originalFileName: verified.originalFileName, path: resolve(options.workspaceDir, verified.storageKey), sha256: verified.sha256, uploadedAt: verified.uploadedAt });
          }
          await persistJob(job);
          void startRun(runId, researchQuestion, uploadedFiles);
          sendJson(response, 202, { runId, statusUrl: `/api/runs/${runId}` });
        } catch (error) {
          jobs.delete(runId);
          throw error;
        }
        return;
      }
      const eventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch?.[1]) {
        const job = jobs.get(eventsMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        openRunStream(request, response, job);
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
        const updatedRun = await serializeRunMutation(job.runId, async () => {
          job.run = await applyHumanDecisionAndPersist(job.run!, input as HumanDecisionInput, options.workspaceDir);
          await publishCurrentRun(job.run);
          await persistJob(job);
          return job.run;
        });
        sendJson(response, 200, { run: publicRun(updatedRun) });
        return;
      }
      const updateMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/source-update$/);
      if (method === "POST" && updateMatch?.[1]) {
        await discardRequestBody(request);
        const job = jobs.get(updateMatch[1]);
        if (!job?.run) {
          sendJson(response, 404, { error: "Completed run not found" });
          return;
        }
        const updatedRun = await serializeRunMutation(job.runId, async () => {
          job.run = await applySourceUpdate(job.run!, { fixtureDir: options.fixtureDir, workspaceDir: options.workspaceDir });
          await publishCurrentRun(job.run);
          await persistJob(job);
          return job.run;
        });
        sendJson(response, 200, { run: publicRun(updatedRun) });
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
      const versionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifact-versions(?:\/([^/]+))?$/);
      if (method === "GET" && versionMatch?.[1]) {
        const job = jobs.get(versionMatch[1]);
        if (!job?.run) {
          sendJson(response, 404, { error: "Completed run not found" });
          return;
        }
        if (versionMatch[2] && !/^[1-9]\d*$/u.test(versionMatch[2])) {
          sendJson(response, 400, { error: "Artifact version must be a positive integer" });
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
        let info;
        try {
          info = await stat(artifact.path);
        } catch {
          sendJson(response, 404, { error: "Artifact file is unavailable" });
          return;
        }
        response.writeHead(200, {
          "content-type": contentType(artifact.path),
          "content-length": info.size,
          "content-disposition": `attachment; filename="${basename(artifact.path)}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        pipeArtifactStream(createReadStream(artifact.path), response);
        return;
      }
      if (method === "GET" && !url.pathname.startsWith("/api/")) {
        const filePath = staticFilePath(options.publicDir, url.pathname);
        try {
          let file = await readFile(filePath);
          let scriptPolicy = "script-src 'self'";
          if (extname(filePath).toLowerCase() === ".html" && !requestKeyProtectionDisabled) {
            const nonce = randomUUID();
            const html = file.toString("utf8").replace("</head>", `${requestKeyBootstrap(requestKey, nonce)}\n  </head>`);
            file = Buffer.from(html, "utf8");
            scriptPolicy = `script-src 'self' 'nonce-${nonce}'`;
          }
          response.writeHead(200, {
            "content-type": contentType(filePath),
            "content-length": file.length,
            "cache-control": extname(filePath).toLowerCase() === ".html" ? "no-store" : "no-cache",
            "x-content-type-options": "nosniff",
            "content-security-policy": `default-src 'self'; img-src 'self' data:; style-src 'self'; ${scriptPolicy}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
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
    activeRunCount,
    eventSubscriberCount(runId: string) {
      return eventSubscribers.get(runId)?.size ?? 0;
    },
    totalEventSubscriberCount,
    jobCount() {
      return jobs.size;
    },
    async start(port = 4399, host = "127.0.0.1") {
      if (!LOOPBACK_BIND_HOSTS.has(host)) {
        throw new Error("InsightForge is single-user software and only permits a loopback listener");
      }
      const bindHost = await resolveLoopbackBindHost(host, options.loopbackResolver);
      await mkdir(options.workspaceDir, { recursive: true });
      await maintainUploadRetention(options.workspaceDir);
      await recoverPersistedJobs();
      currentRun = await loadPersistedRun(options.workspaceDir) ?? undefined;
      if (currentRun) {
        jobs.set(currentRun.id, { runId: currentRun.id, status: "completed", steps: currentRun.steps, error: null, events: currentRun.events, run: currentRun });
      }
      await maintainRunRetention();
      server = createServer((request, response) => void route(request, response));
      const activeServer = server;
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: Error) => rejectListen(error);
          activeServer.once("error", onError);
          activeServer.listen(port, bindHost, () => {
            activeServer.off("error", onError);
            resolveListen();
          });
        });
      } catch (error) {
        server = undefined;
        throw friendlyListenError(error, port);
      }
      const baseUrl = serverBaseUrl(bindHost.includes(":") ? `[${bindHost}]` : bindHost, activeServer.address());
      listeningPort = Number(new URL(baseUrl).port);
      return baseUrl;
    },
    async stop() {
      if (!server) return;
      const activeServer = server;
      await new Promise<void>((resolveClose, rejectClose) => activeServer.close((error) => settleServerClose(error, resolveClose, rejectClose)));
      server = undefined;
      listeningPort = undefined;
    },
  };
}

export async function startDefaultServer(root?: string, port?: number, host?: string) {
  const paths = resolveServerPaths(root);
  loadLocalEnvironment(paths.envRoot);
  await assertRuntimeAssets(paths.publicDir, paths.fixtureDir);
  const resolvedPort = port ?? Number(process.env.PORT ?? 4399);
  const resolvedHost = host ?? process.env.HOST ?? "127.0.0.1";
  const app = createInsightForgeServer({
    fixtureDir: paths.fixtureDir,
    publicDir: paths.publicDir,
    workspaceDir: paths.workspaceDir,
  });
  const url = await app.start(resolvedPort, resolvedHost);
  console.log(`InsightForge is running at ${url}`);
  return { app, url };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void startDefaultServer();
}
