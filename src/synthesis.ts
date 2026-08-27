import type { Claim, Conclusion, Datum, Evidence, ResearchSource } from "./domain.js";

export interface SynthesisBundle {
  data: Datum[];
  claims: Claim[];
  conclusions: Conclusion[];
}

export interface DeterministicSynthesisInputs {
  question: string;
  penetration: number;
  chargerGrowth: number;
  estimatedAdequacy: number;
  sourceVersion: "v1" | "v2";
}

const QUESTION_STOPWORDS = new Set([
  "是否", "如何", "什么", "哪些", "为什么", "怎样", "受到", "影响", "因素", "趋势",
  "增长", "变化", "情况", "方面", "问题", "研究", "分析", "判断", "以及", "可以",
  "能够", "一个", "这个", "目前", "当前", "未来", "过去", "总体", "结构",
]);

const CJK = /[\u4e00-\u9fff]/;
const LATIN_OR_NUMBER = /[a-z0-9]+/gi;

export function cjkBigrams(text: string): string[] {
  const chars = [...text].filter((ch) => CJK.test(ch));
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push((chars[i] ?? "") + (chars[i + 1] ?? ""));
  return grams;
}

export function extractQuestionTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const gram of cjkBigrams(question)) {
    if (!QUESTION_STOPWORDS.has(gram)) terms.add(gram);
  }
  for (const match of question.match(LATIN_OR_NUMBER) ?? []) {
    if (match.length >= 2) terms.add(match.toLowerCase());
  }
  return [...terms].slice(0, 12);
}

export function evidenceCorpusText(sources: ResearchSource[], evidence: Evidence[], data: Datum[]): string {
  const parts = [
    ...sources.map((source) => `${source.title} ${source.publisher} ${source.excerpt}`),
    ...evidence.map((item) => item.excerpt),
    ...data.map((item) => `${item.metric} ${item.period}`),
  ];
  return parts.join("\n");
}

export function questionFit(question: string, corpus: string): number {
  const terms = extractQuestionTerms(question);
  if (terms.length === 0) return 0;
  const matched = terms.filter((term) => corpus.toLowerCase().includes(term));
  return matched.length / terms.length;
}

export const FIT_THRESHOLD = 0.35;

export function planScope(question: string): string {
  const normalized = question.replace(/[？?。。!！\s]+/g, "").slice(0, 48);
  return `围绕「${normalized}」展开；证据范围以本轮 PLAN→COLLECT 实际检索与解析的资料为准，所有结论仅在该范围内成立。`;
}

export interface MismatchSynthesisInputs extends DeterministicSynthesisInputs {
  sources: ResearchSource[];
  evidence: Evidence[];
}

/**
 * 失配路径：问题与证据语料不相关时，诚实地报告证据不足，而不是把预写结论贴上问题前缀。
 * 已完成的确定性计算保留在 data 中（它们是真实计算），但结论不再引用它们作为支撑。
 */
export function buildMismatchSynthesis(inputs: MismatchSynthesisInputs, data: Datum[]): SynthesisBundle {
  const focus = inputs.question.replace(/[？?。!！\s]+/g, "").slice(0, 30) || "目标问题";
  const hint = inputs.sources.slice(0, 2).map((source) => `《${source.title}》`).join("、") || "既有资料";
  const evidenceIds = inputs.evidence.map((item) => item.id);
  const sourceIds = inputs.sources.map((item) => item.id);

  const sharedClaim = {
    type: "AI_JUDGMENT" as const,
    evidenceIds,
    datumIds: [],
    evidenceStatus: "INSUFFICIENT_EVIDENCE" as const,
    assumptions: [],
  };

  const claims: Claim[] = [
    {
      ...sharedClaim,
      id: "claim-fit-sources",
      text: `已检视的 ${inputs.sources.length} 个信源（主题集中于「${hint}」）与「${focus}」不匹配，不能作为本问题的依据。`,
      originalText: `已检索 ${inputs.sources.length} 个信源。`,
    },
    {
      ...sharedClaim,
      id: "claim-fit-data",
      text: "现有 CSV/PDF 资料中不包含与问题指标对应的时间序列，无法执行确定性计算或带假设的估算。",
      originalText: "已解析本地数据文件。",
    },
    {
      ...sharedClaim,
      id: "claim-fit-judgment",
      text: "在信源与数据补齐之前，针对该问题生成的任何行业判断都会缺少可追溯依据。",
      originalText: "可基于现有材料形成初步判断。",
    },
  ];

  const baseConclusion = {
    type: "AI_JUDGMENT" as const,
    sourceIds,
    reviewStatus: "PENDING_REVIEW" as const,
    confirmedAt: null,
    confirmedText: null,
  };

  const conclusions: Conclusion[] = [
    {
      ...baseConclusion,
      id: "conclusion-fit-sources",
      text: `证据不足：现有信源与「${focus}」不相关，本问题尚无可引用的一手或二手来源。`,
      originalAiText: `围绕「${focus}」的信源已具备。`,
      claimIds: ["claim-fit-sources"],
      evidenceIds,
      evidenceStatus: "INSUFFICIENT_EVIDENCE",
      missingEvidence: [`与「${focus}」直接相关的一手信源（政府/协会/公司披露）`, "信源口径与统计范围说明"],
    },
    {
      ...baseConclusion,
      id: "conclusion-fit-data",
      text: "证据不足：缺少与问题对应指标的历史数据，无法完成计算、估算或趋势判断。",
      originalAiText: "数据基础足以支撑定量判断。",
      claimIds: ["claim-fit-data"],
      evidenceIds,
      evidenceStatus: "INSUFFICIENT_EVIDENCE",
      missingEvidence: ["目标指标的时间序列数据（CSV/XLSX）", "指标定义与单位说明"],
    },
    {
      ...baseConclusion,
      id: "conclusion-fit-judgment",
      text: "证据不足：在上述缺口补齐前，本问题不应产生候选行业判断；请先上传或检索相关资料后重跑。",
      originalAiText: "可先行形成判断再补充证据。",
      claimIds: ["claim-fit-judgment"],
      evidenceIds,
      evidenceStatus: "INSUFFICIENT_EVIDENCE",
      missingEvidence: ["覆盖问题的量化证据", "可交叉验证的第二信源"],
    },
  ];

  return { data, claims, conclusions };
}

export function buildDeterministicSynthesis(inputs: DeterministicSynthesisInputs): SynthesisBundle {
  const { penetration, chargerGrowth, estimatedAdequacy, sourceVersion } = inputs;
  const versionLabel = sourceVersion === "v1" ? "预测输入" : "最终输入";

  const data: Datum[] = [
    {
      id: "datum-reported-penetration",
      evidenceId: "evidence-source-web-association",
      metric: "2024 新能源乘用车国内零售渗透率（乘联分会口径）",
      value: 47.6,
      unit: "%",
      period: "2024",
      type: "FACT",
      formula: null,
      inputs: [],
      assumptions: ["来源采用乘用车国内零售口径，不含商用车与出口"],
    },
    {
      id: "datum-penetration",
      evidenceId: "evidence-market-csv",
      metric: `2024 新能源汽车${sourceVersion === "v1" ? "份额（预测输入重算）" : "新车销量占比（最终输入重算）"}`,
      value: penetration,
      unit: "%",
      period: "2024",
      type: "CALCULATION",
      formula: "nev_sales_million / total_auto_sales_million * 100",
      inputs: sourceVersion === "v1"
        ? [{ label: "新能源汽车预测销量", value: 11.5, unit: "百万辆" }, { label: "汽车预测总销量", value: 31, unit: "百万辆" }]
        : [{ label: "新能源汽车最终销量", value: 12.866, unit: "百万辆" }, { label: "汽车最终总销量", value: 31.436, unit: "百万辆" }],
      assumptions: [],
    },
    {
      id: "datum-charger-growth",
      evidenceId: "evidence-market-csv",
      metric: "公共充电点同比增长",
      value: chargerGrowth,
      unit: "%",
      period: "2023–2024",
      type: "CALCULATION",
      formula: "(chargers_2024 - chargers_2023) / chargers_2023 * 100",
      inputs: [
        { label: "2024 公共充电桩", value: 3.579, unit: "百万台" },
        { label: "2023 公共充电桩", value: 2.726, unit: "百万台" },
      ],
      assumptions: [],
    },
    {
      id: "datum-adequacy-estimate",
      evidenceId: "evidence-market-csv",
      metric: "风险调整后可有效服务充电点",
      value: estimatedAdequacy,
      unit: "百万个",
      period: "2024",
      type: "ESTIMATE",
      formula: "public_chargers_million * (1 - utilization_gap_assumption)",
      inputs: [{ label: "公共充电桩", value: 3.579, unit: "百万台" }, { label: "利用率折损", value: 15, unit: "%" }],
      assumptions: [],
    },
  ];

  const claims: Claim[] = [
    {
      id: "claim-penetration",
      text: `中汽协${versionLabel}重算的全汽车销量份额为 ${penetration.toFixed(1)}%，与乘联分会乘用车国内零售口径 47.6% 存在差异。`,
      originalText: `2024 新能源汽车份额约为 ${penetration.toFixed(1)}%。`,
      type: "CALCULATION",
      evidenceIds: ["evidence-market-csv", "evidence-source-web-association"],
      datumIds: ["datum-penetration", "datum-reported-penetration"],
      evidenceStatus: "SUPPORTED",
      assumptions: [],
    },
    {
      id: "claim-charging",
      text: `公共充电点同比增长 ${chargerGrowth.toFixed(1)}%，但按 15% 利用率折损后，有效规模估算为 ${estimatedAdequacy.toFixed(2)} 百万个。`,
      originalText: `公共充电点同比增长 ${chargerGrowth.toFixed(1)}%，有效供给足以覆盖需求。`,
      type: "ESTIMATE",
      evidenceIds: ["evidence-market-csv", "evidence-source-web-charging", "evidence-pdf-page-1"],
      datumIds: ["datum-charger-growth", "datum-adequacy-estimate"],
      evidenceStatus: "SUPPORTED",
      assumptions: [],
    },
    {
      // 确定性抽取器把来源的预测句当作事实抽取；AUDIT 的 TYPE_MISMATCH 规则会基于原文标记纠正为 FORECAST。
      id: "claim-outlook",
      text: "乘联分会预测 2025 年新能源乘用车零售 1330 万辆、渗透率 57%。",
      originalText: "乘联分会预测 2025 年新能源乘用车零售 1330 万辆、渗透率 57%。",
      type: "FACT",
      evidenceIds: ["evidence-source-web-outlook"],
      datumIds: [],
      evidenceStatus: "SUPPORTED",
      assumptions: [],
    },
    {
      id: "claim-profitability",
      text: "充电基础设施扩张将在 2025 年显著提升所有运营商盈利能力。",
      originalText: "充电基础设施扩张将在 2025 年显著提升所有运营商盈利能力。",
      type: "AI_JUDGMENT",
      evidenceIds: ["evidence-pdf-page-2"],
      datumIds: [],
      evidenceStatus: "SUPPORTED",
      assumptions: [],
    },
  ];

  const penetrationSummary = penetration >= 45 ? "已接近一半" : `约为 ${penetration.toFixed(1)}%`;

  const conclusions: Conclusion[] = [
    {
      id: "conclusion-penetration",
      text: `2024 新能源汽车份额按中汽协口径重算为 ${penetration.toFixed(1)}%，与乘联分会乘用车零售渗透率 47.6% 存在口径冲突，下判断前需先统一统计口径。`,
      originalAiText: `2024 新能源渗透率${penetrationSummary}。`,
      type: "AI_JUDGMENT",
      claimIds: ["claim-penetration"],
      evidenceIds: ["evidence-market-csv", "evidence-source-web-association"],
      sourceIds: ["source-market-csv", "source-web-association"],
      evidenceStatus: "SUPPORTED",
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: [],
      confirmedAt: null,
      confirmedText: null,
    },
    {
      id: "conclusion-charging",
      text: "公共充电点增长快于销量基数变化，但地理与利用率错配使名义供给不能直接等同于有效供给。",
      originalAiText: "公共充电点增长足以消除基础设施约束。",
      type: "AI_JUDGMENT",
      claimIds: ["claim-charging"],
      evidenceIds: ["evidence-market-csv", "evidence-source-web-charging", "evidence-pdf-page-1"],
      sourceIds: ["source-market-csv", "source-web-charging", "source-pdf-brief"],
      evidenceStatus: "SUPPORTED",
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: [],
      confirmedAt: null,
      confirmedText: null,
    },
    {
      id: "conclusion-outlook",
      text: "协会对 2025 年渗透率仍有上行预测，但该预测不能被呈现为已经发生的事实。",
      originalAiText: "协会预计 2025 年新能源乘用车渗透率将继续上升。",
      type: "AI_JUDGMENT",
      claimIds: ["claim-outlook"],
      evidenceIds: ["evidence-source-web-outlook"],
      sourceIds: ["source-web-outlook"],
      evidenceStatus: "SUPPORTED",
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: [],
      confirmedAt: null,
      confirmedText: null,
    },
    {
      id: "conclusion-profitability",
      text: "基础设施扩张将在 2025 年普遍提升充电运营商盈利能力。",
      originalAiText: "基础设施扩张将在 2025 年普遍提升充电运营商盈利能力。",
      type: "AI_JUDGMENT",
      claimIds: ["claim-profitability"],
      evidenceIds: ["evidence-pdf-page-2"],
      sourceIds: ["source-pdf-brief"],
      evidenceStatus: "SUPPORTED",
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: [],
      confirmedAt: null,
      confirmedText: null,
    },
  ];

  return { data, claims, conclusions };
}

export function bundleFromLlmDrafts(
  drafts: Array<{ text: string; evidenceIds: string[]; assumptions: string[]; missingEvidence: string[] }>,
  collected: { data: Datum[]; sources: ResearchSource[]; evidence: Evidence[] },
): SynthesisBundle {
  const claims: Claim[] = [];
  const conclusions: Conclusion[] = [];
  drafts.forEach((draft, index) => {
    const claimId = `claim-llm-${index + 1}`;
    const conclusionId = `conclusion-llm-${index + 1}`;
    const datumIds = collected.data.filter((datum) => draft.evidenceIds.includes(datum.evidenceId)).map((datum) => datum.id);
    const evidenceStatus = draft.missingEvidence.length > 0 ? "INSUFFICIENT_EVIDENCE" as const : "SUPPORTED" as const;
    claims.push({
      id: claimId,
      text: draft.text,
      originalText: draft.text,
      type: "AI_JUDGMENT",
      evidenceIds: draft.evidenceIds,
      datumIds,
      evidenceStatus,
      assumptions: draft.assumptions,
    });
    conclusions.push({
      id: conclusionId,
      text: draft.text,
      originalAiText: draft.text,
      type: "AI_JUDGMENT",
      claimIds: [claimId],
      evidenceIds: draft.evidenceIds,
      sourceIds: sourceIdsForEvidence(draft.evidenceIds, collected.sources, collected.evidence),
      evidenceStatus,
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: draft.missingEvidence,
      confirmedAt: null,
      confirmedText: null,
    });
  });
  return { data: collected.data, claims, conclusions };
}

function sourceIdsForEvidence(evidenceIds: string[], sources: ResearchSource[], evidence: Evidence[]): string[] {
  // LLM 草稿只引用 evidenceId；sourceId 由证据→数据→信源的确定关系回填，不信任模型自报来源。
  const owners = new Set(evidence.filter((item) => evidenceIds.includes(item.id)).map((item) => item.sourceId));
  const known = new Set(sources.map((source) => source.id));
  const resolved = [...owners].filter((id) => known.has(id));
  return resolved;
}
