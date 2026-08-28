import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { persistRun, writeArtifactVersion } from "./artifacts.js";
import { runDeterministicAudit } from "./audit.js";
import {
  researchRunSchema,
  workflowStates,
  type Evidence,
  type ModelProvenance,
  type ResearchPlan,
  type ResearchRun,
  type ResearchSource,
  type RunStep,
  type SourceVersion,
  type SynthesisMode,
  type ToolCallEvent,
  type WorkflowState,
} from "./domain.js";
import { hashFile, hashValue } from "./hash.js";
import { applySourceConfidence } from "./source-confidence.js";
import { MAX_SOURCES, truncateSources } from "./source-limit.js";
import { draftConclusions, draftPlanSteps, PLAN_TOOL_ALLOWLIST, resolveLlmConfig, validateLlmDrafts, validatePlanSteps, type LlmConfig } from "./llm.js";
import { GOLDEN_RESEARCH_QUESTION, loadCachedModelPlan, loadCachedModelSynthesis } from "./model-cache.js";
import {
  FIT_THRESHOLD,
  buildDeterministicSynthesis,
  buildMismatchSynthesis,
  bundleFromCachedModelDrafts,
  bundleFromLlmDrafts,
  evidenceCorpusText,
  planScope,
  questionFit,
  type SynthesisBundle,
} from "./synthesis.js";
import { calculateMarketMetrics } from "./tools/csv-calculator.js";
import { readLocalFile } from "./tools/local-file-reader.js";
import { readPdfPages } from "./tools/pdf-reader.js";
import { searchSnapshot } from "./tools/snapshot-search.js";

export interface CollectedUploadInput {
  id: string;
  kind: "PDF" | "CSV" | "XLSX" | "TXT";
  originalFileName: string;
  path: string;
  sha256: string;
  uploadedAt: string;
}

export interface RunGoldenCaseOptions {
  researchQuestion: string;
  fixtureDir: string;
  workspaceDir: string;
  sourceVersion?: "v1" | "v2";
  failAt?: WorkflowState;
  runId?: string;
  stepDelayMs?: number;
  llmMode?: "cached" | "auto" | "off";
  llmConfig?: LlmConfig;
  uploadedFiles?: CollectedUploadInput[];
  onProgress?: (steps: RunStep[]) => void | Promise<void>;
  onToolEvent?: (event: ToolCallEvent) => void | Promise<void>;
}

export const MAX_RUN_SOURCES = MAX_SOURCES;
export const MAX_RUN_UPLOADS = 5;

const isoNow = () => new Date().toISOString();

function makeSteps(): RunStep[] {
  return workflowStates.map((state) => ({ state, status: "pending", outputId: "", consumedOutputIds: [], startedAt: null, completedAt: null, error: null, summary: "" }));
}

function startStep(steps: RunStep[], state: WorkflowState, consumedOutputIds: string[]) {
  const step = steps.find((candidate) => candidate.state === state)!;
  step.status = "running";
  step.startedAt = isoNow();
  step.consumedOutputIds = consumedOutputIds;
  return step;
}

function finishStep(step: RunStep, output: unknown, summary: string) {
  step.outputId = hashValue(output);
  step.status = "success";
  step.completedAt = isoNow();
  step.summary = summary;
}

async function publishProgress(options: RunGoldenCaseOptions, steps: RunStep[]) {
  await options.onProgress?.(structuredClone(steps));
  if ((options.stepDelayMs ?? 0) > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, options.stepDelayMs));
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function publishToolEvent(options: RunGoldenCaseOptions, event: ToolCallEvent) {
  await options.onToolEvent?.(structuredClone(event));
}

async function recordTool<T>(options: RunGoldenCaseOptions, events: ToolCallEvent[], toolName: ToolCallEvent["toolName"], inputSummary: string, action: () => Promise<T>): Promise<T> {
  const startedAt = isoNow();
  const started = performance.now();
  try {
    const output = await action();
    const event: ToolCallEvent = { id: randomUUID(), kind: "TOOL_CALL", toolName, inputSummary, startedAt, status: "success", outputId: hashValue(output), duration: Math.round(performance.now() - started), error: null };
    events.push(event);
    await publishToolEvent(options, event);
    return output;
  } catch (error) {
    const event: ToolCallEvent = { id: randomUUID(), kind: "TOOL_CALL", toolName, inputSummary, startedAt, status: "failed", outputId: "", duration: Math.round(performance.now() - started), error: errorText(error) };
    events.push(event);
    await publishToolEvent(options, event);
    throw error;
  }
}

function deterministicPlan(question: string): ResearchPlan {
  const topic = question.replace(/[？?。]/gu, "").slice(0, 48);
  const steps: ResearchPlan["steps"] = [
    { id: "plan-search", objective: `发现与“${topic}”相关的公开信源`, toolName: "snapshot-search", expectedOutput: "带 URL、标题、时间和摘录的快照结果" },
    { id: "plan-pdf", objective: "读取本地 PDF/上传材料并保留精确定位", toolName: "pdf-reader", expectedOutput: "逐页文本与文件定位" },
    { id: "plan-calc", objective: "读取市场 CSV 并执行确定性重算", toolName: "csv-calculator", expectedOutput: "公式、输入、单位和行号" },
    { id: "plan-audit", objective: "检查引用、支撑、冲突、类型、假设和范围", toolName: "deterministic-audit", expectedOutput: "六类结构化审查与最多一次修正" },
    { id: "plan-deliver", objective: "交付可编辑 PPTX 和机器可读证据包", toolName: "pptx-generator", expectedOutput: "共享同一研究快照的版本化成果" },
  ];
  return { id: hashValue({ question, steps }), researchQuestion: question, scope: planScope(question), steps };
}

function planFromDrafts(question: string, drafts: Array<{ objective: string; toolName: string; expectedOutput: string }>): ResearchPlan {
  return {
    id: hashValue({ question, drafts }),
    researchQuestion: question,
    scope: planScope(question),
    steps: drafts.map((draft, index) => ({ id: `plan-${index + 1}-${draft.toolName}`, objective: draft.objective, toolName: draft.toolName as ResearchPlan["steps"][number]["toolName"], expectedOutput: draft.expectedOutput })),
  };
}

function webGraph(search: Awaited<ReturnType<typeof searchSnapshot>>): { sources: ResearchSource[]; sourceVersions: SourceVersion[]; evidence: Evidence[] } {
  const sources = search.results.map<ResearchSource>((result) => ({
    id: result.id,
    kind: "WEB",
    title: result.title,
    publisher: result.publisher,
    version: "snapshot",
    locator: { url: result.url },
    capturedAt: search.capturedAt,
    excerpt: result.excerpt,
    isOfflineSnapshot: true,
    sourceVersionId: `source-version-${result.id}-snapshot`,
    materialRole: "AUTHORITY_SOURCE",
    freshness: "CURRENT",
    customWhitelist: null,
  }));
  const sourceVersions = sources.map<SourceVersion>((source) => ({
    id: source.sourceVersionId,
    sourceId: source.id,
    version: "snapshot",
    capturedAt: source.capturedAt,
    sha256: hashValue(source.excerpt),
    locator: source.locator,
    knowledgeType: "SOURCE_OPINION",
    upstreamSourceIds: [],
    isCurrent: true,
  }));
  const evidence = search.results.map<Evidence>((result) => ({
    id: `evidence-${result.id}`,
    sourceId: result.id,
    type: "SOURCE_OPINION",
    excerpt: result.excerpt,
    locator: { url: result.url },
    datumIds: result.id === "source-web-association" ? ["datum-reported-penetration"] : result.id === "source-web-charging" ? ["datum-charger-growth", "datum-adequacy-estimate"] : [],
    knowledgeType: /预测/u.test(result.excerpt) ? "FORECAST" : "SOURCE_OPINION",
    originType: "SOURCE_EXTRACTED",
    freshness: "CURRENT",
  }));
  return { sources, sourceVersions, evidence };
}

async function uploadedGraph(files: CollectedUploadInput[]) {
  const sources: ResearchSource[] = [];
  const sourceVersions: SourceVersion[] = [];
  const evidence: Evidence[] = [];
  for (const file of files) {
    const parsed = await readLocalFile(file.path, file.kind);
    const sourceId = `source-upload-${file.id}`;
    const sourceVersionId = `source-version-upload-${file.id}`;
    sources.push({
      id: sourceId,
      kind: file.kind,
      title: file.originalFileName,
      publisher: "用户上传材料（未自动视为权威来源）",
      version: "upload",
      locator: parsed.excerpts[0]!.locator,
      capturedAt: file.uploadedAt,
      excerpt: parsed.excerpts.map((item) => item.text).join("\n").slice(0, 4000),
      isOfflineSnapshot: true,
      sourceVersionId,
      materialRole: "USER_UPLOAD",
      freshness: "CURRENT",
      customWhitelist: {
        uploadId: file.id,
        originalFileName: file.originalFileName,
        sha256: file.sha256,
        parsedKind: file.kind,
        status: "PARSED",
      },
    });
    sourceVersions.push({ id: sourceVersionId, sourceId, version: "upload", capturedAt: file.uploadedAt, sha256: file.sha256, locator: parsed.excerpts[0]!.locator, knowledgeType: "SOURCE_OPINION", upstreamSourceIds: [], isCurrent: true });
    parsed.excerpts.forEach((item, index) => evidence.push({
      id: `evidence-upload-${file.id}-${index + 1}`,
      sourceId,
      type: "SOURCE_OPINION",
      excerpt: item.text,
      locator: item.locator,
      datumIds: [],
      knowledgeType: "SOURCE_OPINION",
      originType: "SOURCE_EXTRACTED",
      freshness: "CURRENT",
    }));
  }
  return { sources, sourceVersions, evidence };
}

function deterministicProvenance(mode: "DETERMINISTIC_MISMATCH_BLOCK", question: string): ModelProvenance {
  const digest = hashValue({ mode, question });
  return { planSource: mode, synthesisSource: mode, provider: "InsightForge deterministic boundary", model: "none", generatedAt: isoNow(), promptSha256: digest, outputSha256: digest, cacheFile: null };
}

export async function runGoldenCase(options: RunGoldenCaseOptions): Promise<ResearchRun> {
  if ((options.uploadedFiles?.length ?? 0) > MAX_RUN_UPLOADS) {
    throw new Error(`SOURCE_LIMIT_EXCEEDED: a run accepts at most ${MAX_RUN_SOURCES} sources, including at most ${MAX_RUN_UPLOADS} uploaded files`);
  }
  const runId = options.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(join(options.workspaceDir, runId), { recursive: true });
  const steps = makeSteps();
  const events: ToolCallEvent[] = [];
  const createdAt = isoNow();
  const llmMode = options.llmMode ?? "cached";
  const exactGolden = options.researchQuestion === GOLDEN_RESEARCH_QUESTION;
  let activeStep: RunStep | undefined;
  let liveConfig: LlmConfig | undefined;

  try {
    activeStep = startStep(steps, "PLAN", []);
    await publishProgress(options, steps);
    if (options.failAt === "PLAN") throw new Error("Injected PLAN failure");
    let plan: ResearchPlan;
    let planCache: Awaited<ReturnType<typeof loadCachedModelPlan>> | null = null;
    if (llmMode === "cached" && exactGolden) {
      planCache = await recordTool(options, events, "cached-model-planner", "读取并校验认证模型 PLAN 缓存、提示词摘要和工具允许列表", () => loadCachedModelPlan(options.fixtureDir, options.researchQuestion));
      plan = planFromDrafts(options.researchQuestion, planCache.steps);
    } else if (llmMode === "auto") {
      const config = options.llmConfig ?? resolveLlmConfig();
      if (!config) throw new Error("Live LLM mode requires explicit API key, base URL, and model configuration; base URL must use HTTPS");
      liveConfig = config;
      const drafts = await recordTool(options, events, "llm-planner", "模型提出研究计划；程序随后校验工具允许列表", () => draftPlanSteps(config, { question: options.researchQuestion, availableInputs: ["离线搜索快照", "本地 PDF", "市场 CSV", ...(options.uploadedFiles ?? []).map((file) => `用户上传 ${file.kind}: ${file.originalFileName}`)] }));
      const valid = validatePlanSteps(drafts, PLAN_TOOL_ALLOWLIST);
      if (!valid) throw new Error("LLM plan failed deterministic allowlist and workflow-anchor validation");
      plan = planFromDrafts(options.researchQuestion, valid);
    } else {
      plan = deterministicPlan(options.researchQuestion);
    }
    finishStep(activeStep, plan, `${plan.steps.length} 个结构化步骤；计划与可执行工具合同已校验`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "COLLECT", [steps[0]!.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "COLLECT") throw new Error("Injected COLLECT failure");
    const search = await recordTool(options, events, "snapshot-search", `离线检索（明确标记缓存快照）：${options.researchQuestion}`, () => searchSnapshot(options.fixtureDir, options.researchQuestion));
    const pdfPath = join(options.fixtureDir, "market-brief.pdf");
    const pdf = await recordTool(options, events, "pdf-reader", "读取 market-brief.pdf 并保留逐页定位；来源内指令仅作材料", () => readPdfPages(pdfPath));
    const sourceVersion = options.sourceVersion ?? "v1";
    const csvPath = join(options.fixtureDir, `market_${sourceVersion}.csv`);
    const metrics = await recordTool(options, events, "csv-calculator", `读取 ${basename(csvPath)} 并执行确定性重算`, () => calculateMarketMetrics(csvPath));
    const uploadedCount = options.uploadedFiles?.length ?? 0;
    const fixedLocalSourceCount = 2;
    const webCapacity = MAX_SOURCES - fixedLocalSourceCount - uploadedCount;
    const boundedWeb = truncateSources(search.results, webCapacity);
    const sourceLimitTrace = {
      maxSources: MAX_SOURCES,
      discoveredCount: search.sourceLimitTrace.discoveredCount + fixedLocalSourceCount + uploadedCount,
      retainedCount: boundedWeb.items.length + fixedLocalSourceCount + uploadedCount,
      truncatedCount: search.sourceLimitTrace.discoveredCount - boundedWeb.items.length,
      truncated: search.sourceLimitTrace.discoveredCount > boundedWeb.items.length,
      reason: search.sourceLimitTrace.discoveredCount > boundedWeb.items.length ? "MAX_SOURCES" as const : null,
    };
    const web = webGraph({ ...search, sources: boundedWeb.items, results: boundedWeb.items });
    const pdfSourceVersionId = "source-version-pdf-brief-snapshot";
    const csvSourceVersionId = `source-version-market-csv-${sourceVersion}`;
    const sources: ResearchSource[] = [
      ...web.sources,
      { id: "source-pdf-brief", kind: "PDF", title: "合成演示材料：新能源汽车与充电证据边界", publisher: "InsightForge 合成离线资料（非权威报告）", version: "snapshot", locator: { fileName: pdf.fileName, page: 1 }, capturedAt: createdAt, excerpt: pdf.pages[0]!.text, isOfflineSnapshot: true, sourceVersionId: pdfSourceVersionId, materialRole: "SYNTHETIC_DEMO_MATERIAL", freshness: "CURRENT", customWhitelist: null },
      { id: "source-market-csv", kind: "CSV", title: `公开数据结构化演示摘录 — ${sourceVersion === "v1" ? "2024 预测输入" : "2024 最终输入"}`, publisher: "中汽协与中国充电联盟公开资料的演示性结构化摘录", version: sourceVersion, locator: { url: sourceVersion === "v1" ? "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html" : "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html", fileName: basename(csvPath), columns: ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"], rows: [2, 3] }, capturedAt: createdAt, excerpt: await readFile(csvPath, "utf8"), isOfflineSnapshot: true, sourceVersionId: csvSourceVersionId, materialRole: "SYNTHETIC_DEMO_MATERIAL", freshness: "CURRENT", customWhitelist: null },
    ];
    const sourceVersions: SourceVersion[] = [
      ...web.sourceVersions,
      { id: pdfSourceVersionId, sourceId: "source-pdf-brief", version: "snapshot", capturedAt: createdAt, sha256: await hashFile(pdfPath), locator: { fileName: pdf.fileName }, knowledgeType: "SOURCE_OPINION", upstreamSourceIds: [], isCurrent: true },
      { id: csvSourceVersionId, sourceId: "source-market-csv", version: sourceVersion, capturedAt: createdAt, sha256: await hashFile(csvPath), locator: sources.at(-1)!.locator, knowledgeType: "FACT", upstreamSourceIds: ["source-web-association", "source-web-charging"], isCurrent: true },
    ];
    const evidence: Evidence[] = [
      ...web.evidence,
      { id: "evidence-pdf-page-1", sourceId: "source-pdf-brief", type: "FACT", excerpt: pdf.pages[0]!.text, locator: { fileName: pdf.fileName, page: 1 }, datumIds: ["datum-charger-growth"], knowledgeType: "FACT", originType: "SOURCE_EXTRACTED", freshness: "CURRENT" },
      { id: "evidence-pdf-page-2", sourceId: "source-pdf-brief", type: "SOURCE_OPINION", excerpt: pdf.pages[1]!.text, locator: { fileName: pdf.fileName, page: 2 }, datumIds: [], knowledgeType: "SOURCE_OPINION", originType: "SOURCE_EXTRACTED", freshness: "CURRENT" },
      { id: "evidence-market-csv", sourceId: "source-market-csv", type: "CALCULATION", excerpt: `2024 penetration = ${metrics.penetration.toFixed(4)}%; charger growth = ${metrics.chargerGrowth.toFixed(4)}%`, locator: sources.at(-1)!.locator, datumIds: ["datum-penetration", "datum-charger-growth", "datum-adequacy-estimate"], knowledgeType: "CALCULATION", originType: "DETERMINISTIC", freshness: "CURRENT" },
    ];
    const uploadedFiles = options.uploadedFiles;
    if (uploadedFiles && uploadedFiles.length > 0) {
      const uploadGraph = await recordTool(options, events, "local-file-reader", `解析 ${uploadedFiles.length} 个已校验上传文件并保留页码/行号/单元格`, () => uploadedGraph(uploadedFiles));
      sources.push(...uploadGraph.sources);
      sourceVersions.push(...uploadGraph.sourceVersions);
      evidence.push(...uploadGraph.evidence);
    }
    const sourceLimitSummary = sourceLimitTrace.truncated ? `；MAX_SOURCES=${MAX_SOURCES} 已截断 ${sourceLimitTrace.truncatedCount} 个候选并留痕` : `；MAX_SOURCES=${MAX_SOURCES} 未触发截断`;
    finishStep(activeStep, { sourceIds: sources.map((source) => source.id), evidenceIds: evidence.map((item) => item.id), sourceVersionIds: sourceVersions.map((item) => item.id), metrics, sourceLimitTrace }, `${sources.length} 个信源、${evidence.length} 条可定位证据；${options.uploadedFiles?.length ?? 0} 个上传材料已进入 COLLECT${sourceLimitSummary}`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "SYNTHESIZE", [steps[1]!.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "SYNTHESIZE") throw new Error("Injected SYNTHESIZE failure");
    const deterministicInputs = { question: options.researchQuestion, penetration: metrics.penetration, chargerGrowth: metrics.chargerGrowth, estimatedAdequacy: metrics.estimatedAdequacy, sourceVersion };
    const seed = buildDeterministicSynthesis(deterministicInputs);
    const fit = questionFit(options.researchQuestion, evidenceCorpusText(sources, evidence, seed.data));
    const sourceSnapshotId = hashValue(sourceVersions.filter((item) => item.isCurrent));
    let synthesis: SynthesisBundle;
    let synthesisMode: SynthesisMode;
    let modelProvenance: ModelProvenance;

    if (llmMode === "cached" && exactGolden) {
      const cached = await recordTool(options, events, "cached-model-synthesizer", "读取认证模型候选缓存并校验摘要、问题域、Schema、证据 ID 与假设 ID", () => loadCachedModelSynthesis(options.fixtureDir, options.researchQuestion, evidence.map((item) => item.id), seed.assumptions.map((item) => item.id)));
      synthesis = bundleFromCachedModelDrafts(cached.drafts, { data: seed.data, assumptions: seed.assumptions, sources, evidence }, sourceSnapshotId);
      synthesisMode = "CACHED_MODEL_OUTPUT";
      modelProvenance = { planSource: "CACHED_MODEL_OUTPUT", synthesisSource: "CACHED_MODEL_OUTPUT", provider: cached.provenance.provider, model: cached.provenance.model, generatedAt: cached.provenance.generatedAt, promptSha256: cached.provenance.promptSha256, outputSha256: cached.provenance.outputSha256, cacheFile: cached.provenance.cacheFile };
    } else if (llmMode === "auto" && fit >= FIT_THRESHOLD) {
      const config = liveConfig!;
      let valid: ReturnType<typeof validateLlmDrafts> = [];
      for (let attempt = 1; attempt <= 2 && valid.length < 3; attempt += 1) {
        const drafts = await recordTool(options, events, "llm-synthesizer", `单一端点模型提出候选（有界传输尝试 ${attempt}/2）`, () => draftConclusions(config, { question: options.researchQuestion, sources, evidence, data: seed.data }));
        valid = validateLlmDrafts(drafts, evidence.map((item) => item.id));
      }
      if (valid.length < 3) throw new Error("Live model produced fewer than three schema-valid, evidence-linked candidates");
      synthesis = bundleFromLlmDrafts(valid, { data: seed.data, sources, evidence });
      synthesis.assumptions.push(...seed.assumptions);
      synthesisMode = "LIVE_SINGLE_ENDPOINT";
      modelProvenance = { planSource: "LIVE_SINGLE_ENDPOINT", synthesisSource: "LIVE_SINGLE_ENDPOINT", provider: new URL(config.baseUrl).hostname, model: config.model, generatedAt: isoNow(), promptSha256: hashValue({ question: options.researchQuestion, evidence }), outputSha256: hashValue(valid), cacheFile: null };
    } else if (llmMode === "off" && exactGolden) {
      synthesis = seed;
      synthesisMode = "DETERMINISTIC_MISMATCH_BLOCK";
      modelProvenance = deterministicProvenance("DETERMINISTIC_MISMATCH_BLOCK", options.researchQuestion);
    } else {
      synthesis = buildMismatchSynthesis({ ...deterministicInputs, sources, evidence }, seed.data);
      synthesisMode = "DETERMINISTIC_MISMATCH_BLOCK";
      modelProvenance = deterministicProvenance("DETERMINISTIC_MISMATCH_BLOCK", options.researchQuestion);
    }
    applySourceConfidence(sources, synthesis.conclusions);
    finishStep(activeStep, { synthesis, synthesisMode, evidenceFit: fit, sourceSnapshotId }, `${synthesis.conclusions.length} 条候选；${synthesisMode}；证据匹配度 ${(fit * 100).toFixed(0)}%`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "AUDIT", [steps[2]!.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "AUDIT") throw new Error("Injected AUDIT failure");
    const { findings: auditFindings, conflicts } = runDeterministicAudit(synthesis, evidence);
    const repairAttempts = auditFindings.some((item) => item.status === "REPAIRED") ? 1 : 0;
    finishStep(activeStep, { auditFindings, conflicts, repairAttempts }, `${auditFindings.length} 项规则结果；真实修正 ${repairAttempts} 轮；未解决项交人`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "DELIVER", [steps[3]!.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "DELIVER") throw new Error("Injected DELIVER failure");
    const run: ResearchRun = {
      schemaVersion: "1.0",
      id: runId,
      researchQuestion: options.researchQuestion,
      createdAt,
      updatedAt: isoNow(),
      terminalStatus: "NEEDS_REVIEW",
      synthesisMode,
      sourceDiscoveryMode: "OFFLINE_SNAPSHOT",
      authorityVerificationMode: "NOT_RUN",
      offlineMode: true,
      offlineModeLabel: "使用缓存快照",
      repairAttempts,
      sourceVersion,
      plan,
      steps,
      events,
      sourceLimitTrace,
      sources,
      sourceVersions,
      evidence,
      data: synthesis.data,
      assumptions: synthesis.assumptions,
      claims: synthesis.claims,
      evidenceGaps: synthesis.evidenceGaps,
      conclusions: synthesis.conclusions,
      candidateRevisions: synthesis.candidateRevisions,
      conflicts,
      auditFindings,
      humanDecisions: [],
      artifacts: [],
      artifactHistory: [],
      artifactVersions: [],
      evictedArtifactVersionCount: 0,
      affectedObjectIds: [],
      researchSnapshotId: sourceSnapshotId,
      uploadedFileIds: (options.uploadedFiles ?? []).map((item) => item.id),
      modelProvenance,
    };
    const currentArtifacts = await recordTool(options, events, "pptx-generator", "生成版本化 5 页可编辑 PPTX 与机器可读证据包", () => writeArtifactVersion(run, options.workspaceDir, "INITIAL_DELIVER", {
      triggerRef: run.id,
      adjustmentNote: "五阶段工作流完成后的初始交付",
    }));
    finishStep(activeStep, { artifacts: currentArtifacts, artifactVersion: run.artifactVersions.at(-1) }, `${currentArtifacts.length} 个真实文件成果已生成（v1，旧版本不覆盖）`);
    run.updatedAt = isoNow();
    researchRunSchema.parse(run);
    await persistRun(run, options.workspaceDir);
    await publishProgress(options, steps);
    return run;
  } catch (error) {
    if (activeStep) {
      activeStep.status = "failed";
      activeStep.error = errorText(error);
      activeStep.completedAt = isoNow();
      await options.onProgress?.(structuredClone(steps));
    }
    throw error;
  }
}
