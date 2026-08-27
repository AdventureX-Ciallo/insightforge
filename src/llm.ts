import type { Datum, Evidence, ResearchSource } from "./domain.js";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmDraft {
  text: string;
  evidenceIds: string[];
  assumptions: string[];
  missingEvidence: string[];
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.INSIGHTFORGE_LLM_API_KEY?.trim();
  const baseUrl = env.INSIGHTFORGE_LLM_BASE_URL?.trim();
  const model = env.INSIGHTFORGE_LLM_MODEL?.trim();
  if (!apiKey || !baseUrl || !model) return null;
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return null;
  return { baseUrl, model, apiKey };
}

export interface LlmSynthesisContext {
  question: string;
  sources: ResearchSource[];
  evidence: Evidence[];
  data: Datum[];
}

export interface PlanStepDraft {
  objective: string;
  toolName: string;
  expectedOutput: string;
}

export const PLAN_TOOL_ALLOWLIST = [
  "snapshot-search",
  "pdf-reader",
  "csv-calculator",
  "llm-synthesizer",
  "deterministic-audit",
  "pptx-generator",
] as const;

export interface LlmPlanContext {
  question: string;
  availableInputs: string[];
}

const PLAN_SYSTEM_PROMPT = [
  "你是研究规划器，负责把一个研究问题拆成可执行的工具计划（模型提出），计划是否可执行由确定性规则裁决（程序校验）。",
  "硬性约束：",
  `1. toolName 只能从允许列表选择：${PLAN_TOOL_ALLOWLIST.join("、")}。`,
  "2. 输出 3-7 个步骤，每步包含 objective（做什么）、toolName（用哪个工具）、expectedOutput（产出什么）。",
  "3. 必须包含一个 deterministic-audit 审查步骤和一个 pptx-generator 交付步骤，且交付在最后。",
  "4. 计划要贴合研究问题：明确该问题需要哪些信源、数据与计算，不要输出与问题无关的通用步骤。",
  '5. 只输出 JSON：{"steps":[{"objective":"...","toolName":"...","expectedOutput":"..."}]}',
].join("\n");

function compactContext(context: LlmSynthesisContext): string {
  const evidenceLines = context.evidence.map((item) => {
    const locator = item.locator.url ?? `${item.locator.fileName ?? ""}${item.locator.page ? ` p.${item.locator.page}` : ""}${item.locator.rows ? ` rows ${item.locator.rows.join(",")}` : ""}`;
    return `- ${item.id} [${item.type}] (${locator}): ${item.excerpt.slice(0, 220)}`;
  });
  const dataLines = context.data.map((item) =>
    `- datum ${item.id}: ${item.metric} = ${item.value}${item.unit}（${item.period}，${item.type}${item.formula ? `，公式 ${item.formula}` : ""}）`);
  const sourceLines = context.sources.map((item) => `- source ${item.id}: ${item.title} / ${item.publisher}`);
  return [`研究问题：${context.question}`, "信源：", ...sourceLines, "证据（只能引用下列 evidenceId）：", ...evidenceLines, "已计算数据：", ...dataLines].join("\n");
}

const SYSTEM_PROMPT = [
  "你是行业研究助理，负责从给定证据中提出候选判断（模型提出），最终裁决由人和确定性规则负责（程序校验）。",
  "硬性约束：",
  "1. 只能引用输入中列出的 evidenceId，不得编造新 id、新数字或新来源。",
  "2. 提出 3-5 条候选结论；每条给出支撑它的 evidenceIds。",
  "3. 使用了估算或假设的，必须在 assumptions 中写明；证据不足的方面，把缺口写进 missingEvidence，不要硬下结论。",
  "4. 区分事实与判断：你输出的所有内容都只会被标记为 AI_JUDGMENT，不得自称已证实。",
  '5. 只输出 JSON：{"conclusions":[{"text":"...","evidenceIds":["..."],"assumptions":["..."],"missingEvidence":["..."]}]}',
].join("\n");

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * 同一模型、同一请求的传输层重试（最多 2 次）：仅覆盖连接被远端切断
 * （fetch reject，如 terminated/reset）与 429/5xx；4xx 鉴权类错误立即抛出。
 * 这不是模型 fallback——不换端点、不换模型、不降级。
 */
async function postChatCompletion(config: LlmConfig, body: unknown, timeoutMs: number): Promise<ChatCompletionResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (response.ok) return (await response.json()) as ChatCompletionResponse;
      const error = new Error(`LLM endpoint returned ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw lastError instanceof Error ? lastError : new Error("LLM request failed after transport retry");
}

/**
 * 调用 OpenAI 兼容接口生成候选判断草稿。本函数不做可信校验——草稿必须经过
 * validateLlmDrafts 过滤（引用白名单、条数、文本长度）后才能进入证据链。
 */
export async function draftConclusions(config: LlmConfig, context: LlmSynthesisContext, timeoutMs = 90_000): Promise<LlmDraft[]> {
  const payload = await postChatCompletion(config, {
    model: config.model,
    temperature: 0.2,
    // 推理型模型会先消耗思考 token 再输出 content；预算不足会在 content 为空时被截断。
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: compactContext(context) },
    ],
  }, timeoutMs);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response has no message content (model may have exhausted max_tokens on reasoning before emitting content)");
  const parsed = JSON.parse(content) as { conclusions?: unknown };
  if (!Array.isArray(parsed.conclusions)) throw new Error("LLM response is missing the conclusions array");
  return parsed.conclusions.map((item) => {
    const draft = item as Partial<LlmDraft>;
    return {
      text: typeof draft.text === "string" ? draft.text.trim() : "",
      evidenceIds: Array.isArray(draft.evidenceIds) ? draft.evidenceIds.filter((id): id is string => typeof id === "string") : [],
      assumptions: Array.isArray(draft.assumptions) ? draft.assumptions.filter((v): v is string => typeof v === "string") : [],
      missingEvidence: Array.isArray(draft.missingEvidence) ? draft.missingEvidence.filter((v): v is string => typeof v === "string") : [],
    };
  });
}

/**
 * 程序校验：evidenceId 必须全部存在于本轮 COLLECT 产物（未知引用整条丢弃，不做模糊匹配），
 * 文本过短或引用为空的草稿同样丢弃。
 */
export function validateLlmDrafts(drafts: LlmDraft[], knownEvidenceIds: string[]): LlmDraft[] {
  const known = new Set(knownEvidenceIds);
  return drafts
    .filter((draft) => draft.text.length >= 8 && draft.evidenceIds.length > 0)
    .filter((draft) => draft.evidenceIds.every((id) => known.has(id)))
    .slice(0, 5);
}

/**
 * 模型提出（PLAN）：调用同一 OpenAI 兼容端点生成研究计划草稿。
 * 与 draftConclusions 一样不做可信校验——必须经 validatePlanSteps 裁决。
 */
export async function draftPlanSteps(config: LlmConfig, context: LlmPlanContext, timeoutMs = 90_000): Promise<PlanStepDraft[]> {
  const payload = await postChatCompletion(config, {
    model: config.model,
    temperature: 0.2,
    // 推理型模型会先消耗思考 token 再输出 content；预算不足会在 content 为空时被截断。
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `研究问题：${context.question}`,
          "当前环境可用的输入：",
          ...context.availableInputs.map((input) => `- ${input}`),
        ].join("\n"),
      },
    ],
  }, timeoutMs);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response has no message content (model may have exhausted max_tokens on reasoning before emitting content)");
  const parsed = JSON.parse(content) as { steps?: unknown };
  if (!Array.isArray(parsed.steps)) throw new Error("LLM response is missing the steps array");
  return parsed.steps.map((item) => {
    const draft = item as Partial<PlanStepDraft>;
    return {
      objective: typeof draft.objective === "string" ? draft.objective.trim() : "",
      toolName: typeof draft.toolName === "string" ? draft.toolName.trim() : "",
      expectedOutput: typeof draft.expectedOutput === "string" ? draft.expectedOutput.trim() : "",
    };
  });
}

/**
 * 程序校验（PLAN）：工具必须在允许列表内、步骤数 3-7、objective 非空，
 * 且必须恰好包含一个 deterministic-audit 和一个最后的 pptx-generator（流水线合同锚点）。
 * 任一锚点缺失即判整份计划不可执行，返回 null——不做部分采纳。
 */
export function validatePlanSteps(drafts: PlanStepDraft[], allowlist: readonly string[]): PlanStepDraft[] | null {
  const allowed = new Set(allowlist);
  const valid = drafts
    .filter((draft) => allowed.has(draft.toolName) && draft.objective.length >= 6 && draft.expectedOutput.length >= 2)
    .slice(0, 7);
  if (valid.length < 3) return null;
  const auditCount = valid.filter((draft) => draft.toolName === "deterministic-audit").length;
  const deliverCount = valid.filter((draft) => draft.toolName === "pptx-generator").length;
  if (auditCount !== 1 || deliverCount !== 1) return null;
  if (valid[valid.length - 1]?.toolName !== "pptx-generator") return null;
  const auditIndex = valid.findIndex((draft) => draft.toolName === "deterministic-audit");
  if (auditIndex === -1 || auditIndex > valid.length - 2) return null;
  return valid;
}
