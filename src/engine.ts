import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  evidencePackageSchema,
  researchRunSchema,
  workflowStates,
  type ArtifactRecord,
  type Evidence,
  type ResearchPlan,
  type ResearchRun,
  type ResearchSource,
  type RunStep,
  type SynthesisMode,
  type ToolCallEvent,
  type WorkflowState,
} from "./domain.js";
import { hashFile, hashValue } from "./hash.js";
import { runDeterministicAudit } from "./audit.js";
import { resolveLlmConfig, draftConclusions, validateLlmDrafts, draftPlanSteps, validatePlanSteps, PLAN_TOOL_ALLOWLIST } from "./llm.js";
import {
  FIT_THRESHOLD,
  buildDeterministicSynthesis,
  buildMismatchSynthesis,
  bundleFromLlmDrafts,
  evidenceCorpusText,
  planScope,
  questionFit,
  type SynthesisBundle,
} from "./synthesis.js";
import { calculateMarketMetrics } from "./tools/csv-calculator.js";
import { readPdfPages } from "./tools/pdf-reader.js";
import { writePptx } from "./tools/pptx-export.js";
import { searchSnapshot } from "./tools/snapshot-search.js";

export interface RunGoldenCaseOptions {
  researchQuestion: string;
  fixtureDir: string;
  workspaceDir: string;
  sourceVersion?: "v1" | "v2";
  failAt?: WorkflowState;
  runId?: string;
  stepDelayMs?: number;
  llmMode?: "auto" | "off";
  onProgress?: (steps: RunStep[]) => void | Promise<void>;
}

function isoNow() {
  return new Date().toISOString();
}

function makeSteps(): RunStep[] {
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

function startStep(steps: RunStep[], state: WorkflowState, consumedOutputIds: string[]) {
  const step = steps.find((candidate) => candidate.state === state);
  if (!step) throw new Error(`Missing workflow step ${state}`);
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
  if ((options.stepDelayMs ?? 0) > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.stepDelayMs));
  }
}

async function recordTool<T>(
  events: ToolCallEvent[],
  toolName: ToolCallEvent["toolName"],
  inputSummary: string,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = isoNow();
  const started = performance.now();
  try {
    const output = await action();
    events.push({
      id: randomUUID(),
      kind: "TOOL_CALL",
      toolName,
      inputSummary,
      startedAt,
      status: "success",
      outputId: hashValue(output),
      duration: Math.round(performance.now() - started),
      error: null,
    });
    return output;
  } catch (error) {
    events.push({
      id: randomUUID(),
      kind: "TOOL_CALL",
      toolName,
      inputSummary,
      startedAt,
      status: "failed",
      outputId: "",
      duration: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildPlan(question: string): ResearchPlan {
  const normalizedTopic = question.replace(/[？?。]/g, "").slice(0, 48);
  const steps: ResearchPlan["steps"] = [
    { id: "plan-search", objective: `发现与“${normalizedTopic}”相关的公开信源`, toolName: "snapshot-search", expectedOutput: "带 URL、标题和摘录的快照结果" },
    { id: "plan-pdf", objective: "读取本地行业简报并保留页码", toolName: "pdf-reader", expectedOutput: "逐页文本与精确定位" },
    { id: "plan-calc", objective: "读取市场数据文件并执行确定性重算", toolName: "csv-calculator", expectedOutput: "公式、输入、单位与行号" },
    { id: "plan-audit", objective: "检查引用、类型、冲突、假设和范围", toolName: "deterministic-audit", expectedOutput: "结构化审查与一次修正" },
    { id: "plan-deliver", objective: "交付报告、可编辑 PPTX 和证据 JSON", toolName: "pptx-generator", expectedOutput: "三个可复用成果" },
  ];
  return {
    id: hashValue({ question, steps }),
    researchQuestion: question,
    scope: planScope(question),
    steps,
  };
}

function webSources(search: Awaited<ReturnType<typeof searchSnapshot>>): { sources: ResearchSource[]; evidence: Evidence[] } {
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
  }));
  const evidence = search.results.map<Evidence>((result) => ({
    id: `evidence-${result.id}`,
    sourceId: result.id,
    type: "SOURCE_OPINION",
    excerpt: result.excerpt,
    locator: { url: result.url },
    datumIds: result.id === "source-web-association"
      ? ["datum-reported-penetration"]
      : result.id === "source-web-charging"
        ? ["datum-charger-growth", "datum-adequacy-estimate"]
        : [],
  }));
  return { sources, evidence };
}

async function artifact(path: string, kind: ArtifactRecord["kind"]): Promise<ArtifactRecord> {
  const fileStat = await stat(path);
  return { id: hashValue({ path: basename(path), sha256: await hashFile(path) }), kind, path, sha256: await hashFile(path), sizeBytes: fileStat.size };
}

export async function runGoldenCase(options: RunGoldenCaseOptions): Promise<ResearchRun> {
  const runId = options.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = join(options.workspaceDir, runId);
  const artifactDir = join(runDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const steps = makeSteps();
  const events: ToolCallEvent[] = [];
  const createdAt = isoNow();
  let activeStep: RunStep | undefined;

  try {
    activeStep = startStep(steps, "PLAN", []);
    await publishProgress(options, steps);
    if (options.failAt === "PLAN") throw new Error("Injected PLAN failure");
    let plan: ResearchPlan;
    if (options.llmMode === "auto") {
      // 模型提出（PLAN）：LLM 从研究问题生成工具计划，程序校验裁决允许列表与锚点合同；
      // 校验不通过即 PLAN 失败，与 SYNTHESIZE 的 fail-hard 边界一致，不做静默降级。
      const planConfig = resolveLlmConfig();
      if (!planConfig) throw new Error("LLM mode requires explicit API key, base URL, and model configuration");
      const planDrafts = await recordTool(events, "llm-planner", `模型提出：为研究问题生成工具计划`, () =>
        draftPlanSteps(planConfig, {
          question: options.researchQuestion,
          availableInputs: ["离线搜索快照索引（信源发现）", "本地 PDF 行业简报（带页码解析）", "市场 CSV v1/v2（确定性计算）"],
        }));
      const validPlan = validatePlanSteps(planDrafts, PLAN_TOOL_ALLOWLIST);
      if (!validPlan) throw new Error("LLM plan failed program validation (allowlist or audit/deliver anchors)");
      plan = {
        id: hashValue({ question: options.researchQuestion, steps: validPlan }),
        researchQuestion: options.researchQuestion,
        scope: planScope(options.researchQuestion),
        steps: validPlan.map((draft, index) => ({
          id: `plan-${index + 1}-${draft.toolName}`,
          objective: draft.objective,
          toolName: draft.toolName as ResearchPlan["steps"][number]["toolName"],
          expectedOutput: draft.expectedOutput,
        })),
      };
    } else {
      plan = buildPlan(options.researchQuestion);
    }
    finishStep(activeStep, plan, `${plan.steps.length} 个结构化步骤，与真实工具一一对应`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "COLLECT", [steps[0]?.outputId ?? ""]);
    await publishProgress(options, steps);
    if (options.failAt === "COLLECT") throw new Error("Injected COLLECT failure");
    const search = await recordTool(events, "snapshot-search", `离线检索：${options.researchQuestion}`, () => searchSnapshot(options.fixtureDir, options.researchQuestion));
    const pdfPath = join(options.fixtureDir, "market-brief.pdf");
    const pdf = await recordTool(events, "pdf-reader", "读取 market-brief.pdf，并保留逐页定位", () => readPdfPages(pdfPath));
    const sourceVersion = options.sourceVersion ?? "v1";
    const csvPath = join(options.fixtureDir, `market_${sourceVersion}.csv`);
    const metrics = await recordTool(events, "csv-calculator", `读取 ${basename(csvPath)} 并执行确定性重算`, () => calculateMarketMetrics(csvPath));
    const fromWeb = webSources(search);
    const sources: ResearchSource[] = [
      ...fromWeb.sources,
      {
        id: "source-pdf-brief",
        kind: "PDF",
        title: "Authority Source Snapshot: China NEV and Charging Data",
        publisher: "InsightForge offline copy of CAAM/CADA/EVCIPA public releases",
        version: "snapshot",
        locator: { fileName: pdf.fileName, page: 1 },
        capturedAt: createdAt,
        excerpt: pdf.pages[0]?.text ?? "",
        isOfflineSnapshot: true,
      },
      {
        id: "source-market-csv",
        kind: "CSV",
        title: `Official NEV/charging structured extract — ${sourceVersion === "v1" ? "2024 forecast" : "2024 final"}`,
        publisher: "中汽协与中国充电联盟公开资料（离线结构化摘录）",
        version: sourceVersion,
        locator: { url: sourceVersion === "v1" ? "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html" : "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html", fileName: basename(csvPath), columns: ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"], rows: [2, 3] },
        capturedAt: createdAt,
        excerpt: await readFile(csvPath, "utf8"),
        isOfflineSnapshot: true,
      },
    ];
    const evidence: Evidence[] = [
      ...fromWeb.evidence,
      {
        id: "evidence-pdf-page-1",
        sourceId: "source-pdf-brief",
        type: "FACT",
        excerpt: pdf.pages[0]?.text ?? "",
        locator: { fileName: pdf.fileName, page: 1 },
        datumIds: ["datum-charger-growth"],
      },
      {
        id: "evidence-pdf-page-2",
        sourceId: "source-pdf-brief",
        type: "FACT",
        excerpt: pdf.pages[1]?.text ?? "",
        locator: { fileName: pdf.fileName, page: 2 },
        datumIds: [],
      },
      {
        id: "evidence-market-csv",
        sourceId: "source-market-csv",
        type: "CALCULATION",
        excerpt: `2024 penetration = ${metrics.penetration.toFixed(4)}%; charger growth = ${metrics.chargerGrowth.toFixed(4)}%`,
        locator: { url: sourceVersion === "v1" ? "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html" : "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html", fileName: basename(csvPath), columns: ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"], rows: [2, 3] },
        datumIds: ["datum-penetration", "datum-charger-growth", "datum-adequacy-estimate"],
      },
    ];
    finishStep(activeStep, { sourceIds: sources.map((source) => source.id), evidenceIds: evidence.map((item) => item.id), metrics }, `${sources.length} 个信源，${evidence.length} 条可定位证据`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "SYNTHESIZE", [activeStep.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "SYNTHESIZE") throw new Error("Injected SYNTHESIZE failure");
    const corpus = evidenceCorpusText(sources, evidence, []);
    const fit = questionFit(options.researchQuestion, corpus);
    const deterministicInputs = {
      question: options.researchQuestion,
      penetration: metrics.penetration,
      chargerGrowth: metrics.chargerGrowth,
      estimatedAdequacy: metrics.estimatedAdequacy,
      sourceVersion,
    };
    let synthesis: SynthesisBundle = buildDeterministicSynthesis(deterministicInputs);
    let synthesisMode: SynthesisMode = "deterministic";
    if (fit < FIT_THRESHOLD) {
      synthesis = buildMismatchSynthesis({ ...deterministicInputs, sources, evidence }, synthesis.data);
      synthesisMode = "deterministic-mismatch";
    }
    if (options.llmMode === "auto") {
      const config = resolveLlmConfig();
      if (!config) throw new Error("LLM mode requires explicit API key, base URL, and model configuration");
      // 同模型有界重试（最多 2 次），不是模型 fallback：引用白名单校验具有随机性，
      // 偶尔一轮草稿不足 3 条。两次尝试都会留下真实的 llm-synthesizer 工具事件。
      let valid: ReturnType<typeof validateLlmDrafts> = [];
      for (let attempt = 1; attempt <= 2 && valid.length < 3; attempt += 1) {
        const drafts = await recordTool(events, "llm-synthesizer", `模型提出（第 ${attempt} 次）：基于 ${evidence.length} 条证据为研究问题生成候选判断`, () =>
          draftConclusions(config, { question: options.researchQuestion, sources, evidence, data: synthesis.data }));
        valid = validateLlmDrafts(drafts, evidence.map((item) => item.id));
      }
      if (valid.length < 3) throw new Error("LLM synthesis produced fewer than three schema-valid, evidence-linked conclusions");
      synthesis = bundleFromLlmDrafts(valid, { data: synthesis.data, sources, evidence });
      synthesisMode = "llm-assisted";
    }
    finishStep(activeStep, { ...synthesis, synthesisMode, evidenceFit: fit }, `${synthesis.conclusions.length} 条候选结论（综合模式：${synthesisMode}，证据匹配度 ${(fit * 100).toFixed(0)}%）`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "AUDIT", [activeStep.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "AUDIT") throw new Error("Injected AUDIT failure");
    const { findings: auditFindings, conflicts } = runDeterministicAudit(synthesis, evidence);
    const repairAttempts = auditFindings.some((item) => item.status === "REPAIRED") ? 1 : 0;
    finishStep(activeStep, { auditFindings, conflicts, repairAttempts }, `${auditFindings.length} 项结构化审查（规则读取真实输入），自动修正 ${repairAttempts} 轮`);
    await publishProgress(options, steps);

    activeStep = startStep(steps, "DELIVER", [activeStep.outputId]);
    await publishProgress(options, steps);
    if (options.failAt === "DELIVER") throw new Error("Injected DELIVER failure");
    const pptxPath = join(artifactDir, "insightforge-report.pptx");
    const jsonPath = join(artifactDir, "evidence-package.json");
    const run: ResearchRun = {
      schemaVersion: "1.0",
      id: runId,
      researchQuestion: options.researchQuestion,
      createdAt,
      updatedAt: isoNow(),
      terminalStatus: "NEEDS_REVIEW",
      synthesisMode,
      offlineMode: true,
      offlineModeLabel: "使用缓存快照",
      repairAttempts,
      sourceVersion,
      plan,
      steps,
      events,
      sources,
      evidence,
      data: synthesis.data,
      claims: synthesis.claims,
      conclusions: synthesis.conclusions,
      conflicts,
      auditFindings,
      humanDecisions: [],
      artifacts: [],
      affectedObjectIds: [],
    };
    await recordTool(events, "pptx-generator", "生成 5 页可编辑 PowerPoint，保留来源与审查状态", () => writePptx(run, pptxPath));
    const evidencePackage = {
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
      artifacts: [{ kind: "PPTX", fileName: basename(pptxPath) }],
    };
    evidencePackageSchema.parse(evidencePackage);
    await writeFile(jsonPath, `${JSON.stringify(evidencePackage, null, 2)}\n`, "utf8");
    run.artifacts = [await artifact(pptxPath, "PPTX"), await artifact(jsonPath, "EVIDENCE_JSON")];
    finishStep(activeStep, { artifacts: run.artifacts }, `${run.artifacts.length} 个真实文件成果已生成`);
    await publishProgress(options, steps);
    run.updatedAt = isoNow();
    researchRunSchema.parse(run);
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    return run;
  } catch (error) {
    if (activeStep) {
      activeStep.status = "failed";
      activeStep.error = error instanceof Error ? error.message : String(error);
      activeStep.completedAt = isoNow();
      await options.onProgress?.(structuredClone(steps));
    }
    throw error;
  }
}
