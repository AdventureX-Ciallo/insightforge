import type {
  Assumption,
  CandidateRevision,
  Claim,
  Conclusion,
  Datum,
  Evidence,
  EvidenceGap,
  ResearchSource,
} from "./domain.js";

export interface SynthesisBundle {
  data: Datum[];
  assumptions: Assumption[];
  claims: Claim[];
  evidenceGaps: EvidenceGap[];
  conclusions: Conclusion[];
  candidateRevisions: CandidateRevision[];
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
const SEMANTIC_STOP_BIGRAMS = new Set([
  "结论", "判断", "证据", "数据", "来源", "材料", "研究", "分析", "显示", "表明", "认为", "需要", "目前", "当前", "相关", "情况", "方面", "进行", "可以", "可能", "已经", "仍然", "存在",
]);

export function cjkBigrams(text: string): string[] {
  const chars = [...text].filter((ch) => CJK.test(ch));
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i]! + chars[i + 1]!);
  return grams;
}

export function significantTerms(text: string): string[] {
  const terms = new Set(cjkBigrams(text).filter((term) => !SEMANTIC_STOP_BIGRAMS.has(term)));
  for (const match of text.match(LATIN_OR_NUMBER) ?? []) {
    if (match.length >= 3 && !/^\d+$/u.test(match)) terms.add(match.toLowerCase());
  }
  return [...terms];
}

export function hasSignificantTermOverlap(left: string, right: string) {
  const leftTerms = new Set(significantTerms(left));
  return significantTerms(right).some((term) => leftTerms.has(term));
}

function datumValuePatterns(datum: Datum) {
  return [...new Set([String(datum.value), datum.value.toFixed(1), datum.value.toFixed(2)])]
    .map((value) => new RegExp(`(^|[^\\d.])${value.replace(".", "\\.")}(?=$|[^\\d.])`, "u"));
}

export function datumIsRelevantToText(datum: Datum, text: string) {
  return hasSignificantTermOverlap(text, datum.metric) || datumValuePatterns(datum).some((pattern) => pattern.test(text));
}

export function extractQuestionTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const gram of cjkBigrams(question)) {
    if (!QUESTION_STOPWORDS.has(gram)) terms.add(gram);
  }
  for (const match of question.match(LATIN_OR_NUMBER) ?? []) {
    if (match.length >= 2) terms.add(match.toLowerCase());
  }
  return [...terms];
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

export interface MismatchSynthesisInputs {
  question: string;
  sources: ResearchSource[];
  evidence: Evidence[];
}

/**
 * 失配路径：问题与证据语料不相关时，诚实地报告证据不足，而不是把预写结论贴上问题前缀。
 * 黄金行业的确定性计算不得进入失配任务；data 只记录问题与本轮语料的匹配率。
 */
export function buildMismatchSynthesis(inputs: MismatchSynthesisInputs): SynthesisBundle {
  const focus = inputs.question.replace(/[？?。!！\s]+/g, "").slice(0, 30) || "目标问题";
  const hint = inputs.sources.slice(0, 2).map((source) => `《${source.title}》`).join("、") || "既有资料";
  // 失配材料不能为了“覆盖率”被伪造为支撑路径；只在 Claim 文本中说明已检查范围，
  // 结论走独立 EvidenceGap 路径。
  const evidenceIds: string[] = [];
  const sourceIds: string[] = [];
  const terms = extractQuestionTerms(inputs.question);
  const corpus = evidenceCorpusText(inputs.sources, inputs.evidence, []).toLowerCase();
  const matchedTerms = terms.filter((term) => corpus.includes(term)).length;
  const fitPercent = terms.length === 0 ? 0 : Number(((matchedTerms / terms.length) * 100).toFixed(2));
  const anchorEvidence = inputs.evidence[0];
  const data: Datum[] = anchorEvidence ? [{
    id: "datum-question-evidence-fit",
    evidenceId: anchorEvidence.id,
    metric: "研究问题与当前资料语料的词项匹配率",
    value: fitPercent,
    unit: "%",
    period: "本轮研究快照",
    type: "CALCULATION",
    formula: "totalQuestionTerms === 0 ? 0 : matchedQuestionTerms / totalQuestionTerms * 100",
    inputs: [
      { label: "matchedQuestionTerms", value: matchedTerms, unit: "terms" },
      { label: "totalQuestionTerms", value: terms.length, unit: "terms" },
    ],
    assumptions: [],
    knowledgeType: "CALCULATION",
    originType: "DETERMINISTIC",
    freshness: "CURRENT",
    assumptionIds: [],
    sourceIds: inputs.sources.map((source) => source.id),
    roundingRule: "四舍五入保留两位小数",
  }] : [];

  const sharedClaim = {
    type: "AI_JUDGMENT" as const,
    evidenceIds,
    datumIds: [],
    evidenceStatus: "INSUFFICIENT_EVIDENCE" as const,
    assumptions: [],
    knowledgeType: "SOURCE_OPINION" as const,
    originType: "DETERMINISTIC" as const,
    freshness: "CURRENT" as const,
    assumptionIds: [],
  };

  const claims: Claim[] = [
    {
      ...sharedClaim,
      id: "claim-fit-sources",
      text: `已检视的 ${inputs.sources.length} 个信源（主题集中于「${hint}」）与「${focus}」不匹配，不能作为本问题的依据。`,
      originalText: `已检索 ${inputs.sources.length} 个信源。`,
      evidenceGapId: "gap-fit-sources",
    },
    {
      ...sharedClaim,
      id: "claim-fit-data",
      text: "现有 CSV/PDF 资料中不包含与问题指标对应的时间序列，无法执行确定性计算或带假设的估算。",
      originalText: "已解析本地数据文件。",
      evidenceGapId: "gap-fit-data",
    },
    {
      ...sharedClaim,
      id: "claim-fit-judgment",
      text: "在信源与数据补齐之前，针对该问题生成的任何行业判断都会缺少可追溯依据。",
      originalText: "可基于现有材料形成初步判断。",
      evidenceGapId: "gap-fit-judgment",
    },
  ];

  const baseConclusion = {
    type: "AI_JUDGMENT" as const,
    sourceIds,
    reviewStatus: "PENDING_REVIEW" as const,
    confirmedAt: null,
    confirmedText: null,
    originType: "DETERMINISTIC" as const,
    normalizedEvidenceStatus: "INSUFFICIENT_EVIDENCE" as const,
    normalizedReviewStatus: "PENDING_REVIEW" as const,
    freshness: "CURRENT" as const,
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
      currentRevisionId: "revision-fit-sources",
      evidenceGapIds: ["gap-fit-sources"],
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
      currentRevisionId: "revision-fit-data",
      evidenceGapIds: ["gap-fit-data"],
    },
    {
      ...baseConclusion,
      id: "conclusion-fit-judgment",
      text: "证据不足：在上述缺口补齐前，本问题不应产生候选行业判断；请先上传或检索相关资料后重跑。",
      originalAiText: "可先行形成判断再补充证据。",
      claimIds: ["claim-fit-judgment"],
      evidenceIds,
      evidenceStatus: "INSUFFICIENT_EVIDENCE",
      missingEvidence: ["覆盖问题的量化证据", "可交叉验证的第二信源", "独立方法或样本的稳健性检验"],
      currentRevisionId: "revision-fit-judgment",
      evidenceGapIds: ["gap-fit-judgment"],
    },
  ];

  const createdAt = new Date().toISOString();
  const evidenceGaps: EvidenceGap[] = conclusions.map((conclusion) => ({
    id: conclusion.evidenceGapIds[0]!,
    claimId: conclusion.claimIds[0]!,
    existingEvidenceIds: [],
    existingDatumIds: [],
    missingItems: conclusion.missingEvidence.map((description, index) => ({
      kind: index === 0 ? "SOURCE" : index === 1 ? "METRIC" : "CROSS_CHECK",
      description,
      requiredScope: focus,
    })),
    blockingReason: "本轮收集资料与研究问题不匹配，不能形成可追溯行业判断。",
    blockedAction: "CONFIRM",
    createdAt,
    resolvedAt: null,
    resolutionEvidenceIds: [],
  }));
  const candidateRevisions: CandidateRevision[] = conclusions.map((conclusion) => ({
    id: conclusion.currentRevisionId,
    conclusionId: conclusion.id,
    parentRevisionId: null,
    authorType: "SYSTEM",
    originType: "DETERMINISTIC",
    text: conclusion.text,
    changeReason: "确定性问题失配阻断，不是行业结论",
    createdAt,
    auditStatus: "NEEDS_REVIEW",
    auditFindingIds: [],
    sourceSnapshotId: "mismatch-no-compatible-cache",
    isCurrent: true,
  }));
  return { data, assumptions: [], claims, evidenceGaps, conclusions, candidateRevisions };
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
      knowledgeType: "FACT",
      originType: "SOURCE_EXTRACTED",
      freshness: "CURRENT",
      assumptionIds: [],
      sourceIds: ["source-web-association"],
      roundingRule: null,
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
      knowledgeType: "CALCULATION",
      originType: "DETERMINISTIC",
      freshness: "CURRENT",
      assumptionIds: [],
      sourceIds: ["source-market-csv"],
      roundingRule: "展示保留 1 位小数；内部保留 IEEE-754 计算值",
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
      knowledgeType: "CALCULATION",
      originType: "DETERMINISTIC",
      freshness: "CURRENT",
      assumptionIds: [],
      sourceIds: ["source-market-csv", "source-web-charging"],
      roundingRule: "展示保留 1 位小数；内部保留 IEEE-754 计算值",
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
      knowledgeType: "ESTIMATE",
      originType: "DETERMINISTIC",
      freshness: "CURRENT",
      assumptionIds: [],
      sourceIds: ["source-market-csv", "source-web-charging"],
      roundingRule: "展示保留 2 位小数；内部保留 IEEE-754 计算值",
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
      knowledgeType: "CALCULATION",
      originType: "DETERMINISTIC",
      freshness: "CURRENT",
      assumptionIds: [],
      evidenceGapId: null,
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
      knowledgeType: "ESTIMATE",
      originType: "DETERMINISTIC",
      freshness: "CURRENT",
      assumptionIds: [],
      evidenceGapId: null,
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
      knowledgeType: "FORECAST",
      originType: "SOURCE_EXTRACTED",
      freshness: "CURRENT",
      assumptionIds: [],
      evidenceGapId: null,
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
      knowledgeType: "SOURCE_OPINION",
      originType: "AI_JUDGMENT",
      freshness: "CURRENT",
      assumptionIds: [],
      evidenceGapId: "gap-profitability",
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
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: "SUPPORTED",
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: "revision-penetration",
      evidenceGapIds: [],
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
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: "SUPPORTED",
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: "revision-charging",
      evidenceGapIds: [],
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
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: "SUPPORTED",
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: "revision-outlook",
      evidenceGapIds: [],
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
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: "SUPPORTED",
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: "revision-profitability",
      evidenceGapIds: ["gap-profitability"],
    },
  ];

  const createdAt = new Date().toISOString();
  const assumptions: Assumption[] = [{
    id: "assumption-utilization-gap",
    text: "15% 利用率折损仅用于演示情景，不代表全国或地区实际利用率。",
    value: 15,
    unit: "%",
    range: "0%–100%",
    owner: "DEMO_PARAMETER",
    evidenceStatus: "INSUFFICIENT_EVIDENCE",
    sourceIds: [],
    freshness: "CURRENT",
  }];
  const evidenceGaps: EvidenceGap[] = [{
    id: "gap-profitability",
    claimId: "claim-profitability",
    existingEvidenceIds: ["evidence-pdf-page-2"],
    existingDatumIds: [],
    missingItems: [
      { kind: "METRIC", description: "运营商收入、成本和盈利数据", requiredScope: "全国及地区/运营商分层" },
      { kind: "METHOD", description: "能够区分基础设施扩张与其他因素的分析方法", requiredScope: "2023–2025" },
      { kind: "CROSS_CHECK", description: "至少一个独立来源的交叉验证", requiredScope: null },
    ],
    blockingReason: "当前合成演示 PDF 明确不含盈利数据，不能支撑全称盈利判断。",
    blockedAction: "CONFIRM",
    createdAt,
    resolvedAt: null,
    resolutionEvidenceIds: [],
  }];
  const candidateRevisions: CandidateRevision[] = conclusions.map((conclusion) => ({
    id: conclusion.currentRevisionId,
    conclusionId: conclusion.id,
    parentRevisionId: null,
    authorType: "SYSTEM",
    originType: "DETERMINISTIC",
    text: conclusion.text,
    changeReason: "历史确定性合成草稿（仅作为数据建模种子，不作为默认模型候选）",
    createdAt,
    auditStatus: "PENDING",
    auditFindingIds: [],
    sourceSnapshotId: sourceVersion,
    isCurrent: true,
  }));
  return { data, assumptions, claims, evidenceGaps, conclusions, candidateRevisions };
}

export function bundleFromLlmDrafts(
  drafts: Array<{ text: string; evidenceIds: string[]; assumptions: string[]; missingEvidence: string[] }>,
  collected: { data: Datum[]; sources: ResearchSource[]; evidence: Evidence[] },
): SynthesisBundle {
  const claims: Claim[] = [];
  const conclusions: Conclusion[] = [];
  const assumptions: Assumption[] = [];
  const evidenceGaps: EvidenceGap[] = [];
  const candidateRevisions: CandidateRevision[] = [];
  const createdAt = new Date().toISOString();
  drafts.forEach((draft, index) => {
    const claimId = `claim-llm-${index + 1}`;
    const conclusionId = `conclusion-llm-${index + 1}`;
    const revisionId = `revision-llm-${index + 1}`;
    const assumptionIds = draft.assumptions.map((text, assumptionIndex) => {
      const id = `assumption-llm-${index + 1}-${assumptionIndex + 1}`;
      assumptions.push({ id, text, value: null, unit: null, range: null, owner: "AI", evidenceStatus: "INSUFFICIENT_EVIDENCE", sourceIds: [], freshness: "CURRENT" });
      return id;
    });
    const datumIds = collected.data
      .filter((datum) => draft.evidenceIds.includes(datum.evidenceId) && datumIsRelevantToText(datum, draft.text))
      .map((datum) => datum.id);
    const linkedData = collected.data.filter((datum) => datumIds.includes(datum.id));
    const hasConflict = linkedData.some((left, leftIndex) => linkedData.slice(leftIndex + 1).some((right) =>
      left.period === right.period
      && left.evidenceId !== right.evidenceId
      && Math.abs(left.value - right.value) >= 1e-9
      && hasSignificantTermOverlap(left.metric, right.metric)));
    const evidenceStatus = draft.missingEvidence.length > 0
      ? "INSUFFICIENT_EVIDENCE" as const
      : hasConflict ? "CONFLICT" as const : "SUPPORTED" as const;
    const evidenceGapId = evidenceStatus === "INSUFFICIENT_EVIDENCE" ? `gap-llm-${index + 1}` : null;
    claims.push({
      id: claimId,
      text: draft.text,
      originalText: draft.text,
      type: "AI_JUDGMENT",
      evidenceIds: draft.evidenceIds,
      datumIds,
      evidenceStatus,
      assumptions: draft.assumptions,
      knowledgeType: "SOURCE_OPINION",
      originType: "AI_JUDGMENT",
      freshness: "CURRENT",
      assumptionIds,
      evidenceGapId,
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
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: evidenceStatus,
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: revisionId,
      evidenceGapIds: evidenceGapId ? [evidenceGapId] : [],
    });
    if (evidenceGapId) {
      evidenceGaps.push({
        id: evidenceGapId,
        claimId,
        existingEvidenceIds: draft.evidenceIds,
        existingDatumIds: datumIds,
        missingItems: draft.missingEvidence.map((description) => ({ kind: "CROSS_CHECK", description, requiredScope: null })),
        blockingReason: "模型候选明确声明证据缺口，程序阻止确认。",
        blockedAction: "CONFIRM",
        createdAt,
        resolvedAt: null,
        resolutionEvidenceIds: [],
      });
    }
    candidateRevisions.push({
      id: revisionId,
      conclusionId,
      parentRevisionId: null,
      authorType: "AI",
      originType: "AI_JUDGMENT",
      text: draft.text,
      changeReason: "实时单端点模型生成，经 Schema 与引用白名单校验",
      createdAt,
      auditStatus: "PENDING",
      auditFindingIds: [],
      sourceSnapshotId: "live-single-endpoint",
      isCurrent: true,
    });
  });
  return { data: collected.data, assumptions, claims, evidenceGaps, conclusions, candidateRevisions };
}

export interface CachedModelDraft {
  role: "PENETRATION_CONFLICT" | "CHARGING_GROWTH" | "ADEQUACY_ESTIMATE" | "CAUSALITY_GAP";
  text: string;
  evidenceIds: string[];
  assumptionIds: string[];
  evidenceStatus: "SUPPORTED" | "CONFLICT" | "INSUFFICIENT_EVIDENCE";
  missingEvidence: string[];
}

const MODEL_ROLE_CONTRACT: Record<CachedModelDraft["role"], {
  claimId: string;
  conclusionId: string;
  revisionId: string;
  datumIds: string[];
  knowledgeType: Claim["knowledgeType"];
}> = {
  PENETRATION_CONFLICT: { claimId: "claim-penetration", conclusionId: "conclusion-penetration", revisionId: "revision-penetration", datumIds: ["datum-penetration", "datum-reported-penetration"], knowledgeType: "CALCULATION" },
  CHARGING_GROWTH: { claimId: "claim-charging-growth", conclusionId: "conclusion-charging-growth", revisionId: "revision-charging-growth", datumIds: ["datum-charger-growth"], knowledgeType: "CALCULATION" },
  ADEQUACY_ESTIMATE: { claimId: "claim-adequacy-estimate", conclusionId: "conclusion-adequacy-estimate", revisionId: "revision-adequacy-estimate", datumIds: ["datum-adequacy-estimate"], knowledgeType: "ESTIMATE" },
  CAUSALITY_GAP: { claimId: "claim-causality-gap", conclusionId: "conclusion-causality-gap", revisionId: "revision-causality-gap", datumIds: [], knowledgeType: "SOURCE_OPINION" },
};

/**
 * 将经过摘要、Schema、问题域、引用 ID 与假设 ID 校验的模型缓存接入证据图。
 * ID 和关系由程序分配；模型只能提出文本和已知对象引用，不能自造图结构。
 */
export function bundleFromCachedModelDrafts(
  drafts: CachedModelDraft[],
  collected: { data: Datum[]; assumptions: Assumption[]; sources: ResearchSource[]; evidence: Evidence[] },
  sourceSnapshotId: string,
): SynthesisBundle {
  const createdAt = new Date().toISOString();
  const claims: Claim[] = [];
  const conclusions: Conclusion[] = [];
  const evidenceGaps: EvidenceGap[] = [];
  const candidateRevisions: CandidateRevision[] = [];
  for (const draft of drafts) {
    const contract = MODEL_ROLE_CONTRACT[draft.role];
    const datumIds = contract.datumIds.filter((id) => collected.data.some((datum) => datum.id === id));
    const requiredNumbers = draft.role === "PENETRATION_CONFLICT"
      ? ["datum-penetration", "datum-reported-penetration"]
      : draft.role === "CHARGING_GROWTH"
        ? ["datum-charger-growth"]
        : draft.role === "ADEQUACY_ESTIMATE"
          ? ["datum-adequacy-estimate"]
          : [];
    for (const datumId of requiredNumbers) {
      const datum = collected.data.find((item) => item.id === datumId);
      if (!datum) throw new Error(`Cached model role ${draft.role} requires missing datum ${datumId}`);
      const rendered = datumId === "datum-adequacy-estimate" ? datum.value.toFixed(2) : datum.value.toFixed(1);
      const escaped = rendered.replace(".", "\\.");
      const mentioned = new RegExp(`(^|[^\\d.])${escaped}(?=$|[^\\d.])`, "u").test(draft.text);
      const negated = new RegExp(`(?:NOT|不是|并非|不等于|≠)[^。；;,.%]{0,12}${escaped}`, "iu").test(draft.text);
      if (!mentioned || negated) throw new Error(`Cached model role ${draft.role} is numerically inconsistent with ${datumId}`);
    }
    const evidenceGapId = draft.evidenceStatus === "INSUFFICIENT_EVIDENCE" ? `gap-${draft.role.toLowerCase().replaceAll("_", "-")}` : null;
    claims.push({
      id: contract.claimId,
      text: draft.text,
      originalText: draft.text,
      type: "AI_JUDGMENT",
      evidenceIds: draft.evidenceIds,
      datumIds,
      evidenceStatus: draft.evidenceStatus,
      assumptions: draft.assumptionIds.map((id) => collected.assumptions.find((item) => item.id === id)?.text ?? id),
      knowledgeType: contract.knowledgeType,
      originType: "AI_JUDGMENT",
      freshness: "CURRENT",
      assumptionIds: draft.assumptionIds,
      evidenceGapId,
    });
    conclusions.push({
      id: contract.conclusionId,
      text: draft.text,
      originalAiText: draft.text,
      type: "AI_JUDGMENT",
      claimIds: [contract.claimId],
      evidenceIds: draft.evidenceIds,
      sourceIds: sourceIdsForEvidence(draft.evidenceIds, collected.sources, collected.evidence),
      evidenceStatus: draft.evidenceStatus,
      reviewStatus: "PENDING_REVIEW",
      missingEvidence: draft.missingEvidence,
      confirmedAt: null,
      confirmedText: null,
      originType: "AI_JUDGMENT",
      normalizedEvidenceStatus: draft.evidenceStatus,
      normalizedReviewStatus: "PENDING_REVIEW",
      freshness: "CURRENT",
      currentRevisionId: contract.revisionId,
      evidenceGapIds: evidenceGapId ? [evidenceGapId] : [],
    });
    if (evidenceGapId) {
      evidenceGaps.push({
        id: evidenceGapId,
        claimId: contract.claimId,
        existingEvidenceIds: draft.evidenceIds,
        existingDatumIds: datumIds,
        missingItems: draft.missingEvidence.map((description, index) => ({
          kind: index === 0 ? "METRIC" : index === 1 ? "SCOPE" : "METHOD",
          description,
          requiredScope: "中国新能源乘用车与公共充电基础设施",
        })),
        blockingReason: "现有描述性证据不足以支持单一因果约束判断。",
        blockedAction: "CONFIRM",
        createdAt,
        resolvedAt: null,
        resolutionEvidenceIds: [],
      });
    }
    candidateRevisions.push({
      id: contract.revisionId,
      conclusionId: contract.conclusionId,
      parentRevisionId: null,
      authorType: "AI",
      originType: "AI_JUDGMENT",
      text: draft.text,
      changeReason: "认证模型缓存输出，经完整性与证据引用合同校验",
      createdAt,
      auditStatus: "PENDING",
      auditFindingIds: [],
      sourceSnapshotId,
      isCurrent: true,
    });
  }
  return { data: collected.data, assumptions: collected.assumptions, claims, evidenceGaps, conclusions, candidateRevisions };
}

function sourceIdsForEvidence(evidenceIds: string[], sources: ResearchSource[], evidence: Evidence[]): string[] {
  // LLM 草稿只引用 evidenceId；sourceId 由证据→数据→信源的确定关系回填，不信任模型自报来源。
  const owners = new Set(evidence.filter((item) => evidenceIds.includes(item.id)).map((item) => item.sourceId));
  const known = new Set(sources.map((source) => source.id));
  const resolved = [...owners].filter((id) => known.has(id));
  return resolved;
}
