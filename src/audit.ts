import type { AuditCategory, AuditFinding, Claim, Conclusion, Datum, Evidence, SourceConflict } from "./domain.js";
import { cjkBigrams, hasSignificantTermOverlap, type SynthesisBundle } from "./synthesis.js";

export interface AuditResult {
  bundle: SynthesisBundle;
  findings: AuditFinding[];
  conflicts: SourceConflict[];
}

const FORECAST_MARKERS = /预计|预测|预期|展望|forecast|expect|outlook|project/i;
const UNIVERSALITY_MARKERS = /所有|全部|普遍|整体|一律|均/;
const SELF_DECLARED_DATA_GAP = /no\s+(?:[a-z]+\s+){0,3}dataset|不含.{0,12}数据|没有.{0,12}数据|无.{0,8}数据/i;
const ALL_CATEGORIES: AuditCategory[] = [
  "MISSING_CITATION",
  "UNSUPPORTED_CLAIM",
  "SOURCE_CONFLICT",
  "TYPE_MISMATCH",
  "MISSING_ASSUMPTION",
  "SCOPE_OVERREACH",
];

function finding(
  category: AuditFinding["category"],
  severity: AuditFinding["severity"],
  targetId: string,
  status: AuditFinding["status"],
  message: string,
  action: string,
  before: string,
  after: string,
): AuditFinding {
  return { id: `audit-${category.toLowerCase()}-${targetId}`, category, severity, targetId, status, message, action, before, after };
}

function excerptFor(evidenceIds: string[], evidence: Evidence[]): string {
  return evidenceIds.map((id) => evidence.find((item) => item.id === id)!.excerpt).join("\n");
}

function conclusionsForClaim(claimId: string, conclusions: Conclusion[]): Conclusion[] {
  return conclusions.filter((conclusion) => conclusion.claimIds.includes(claimId));
}

function metricOverlap(a: Datum, b: Datum): boolean {
  const gramsA = new Set(cjkBigrams(a.metric));
  return cjkBigrams(b.metric).some((gram) => gramsA.has(gram));
}

function setEvidenceStatus(claim: Claim, conclusions: Conclusion[], status: "SUPPORTED" | "CONFLICT" | "INSUFFICIENT_EVIDENCE") {
  claim.evidenceStatus = status;
  for (const conclusion of conclusionsForClaim(claim.id, conclusions)) {
    conclusion.evidenceStatus = status;
    conclusion.normalizedEvidenceStatus = status;
    if (status === "INSUFFICIENT_EVIDENCE") {
      conclusion.reviewStatus = "PENDING_REVIEW";
      conclusion.normalizedReviewStatus = "PENDING_REVIEW";
      conclusion.confirmedAt = null;
      conclusion.confirmedText = null;
      conclusion.type = "AI_JUDGMENT";
    }
  }
}

function ensureEvidenceGap(
  claim: Claim,
  conclusions: Conclusion[],
  evidenceGaps: SynthesisBundle["evidenceGaps"],
  missingItems: string[],
  blockingReason: string,
) {
  let gap = evidenceGaps.find((item) => item.claimId === claim.id && item.resolvedAt === null);
  if (!gap) {
    const baseId = `gap-audit-${claim.id}`;
    let gapId = baseId;
    let suffix = 2;
    while (evidenceGaps.some((item) => item.id === gapId)) {
      gapId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    gap = {
      id: gapId,
      claimId: claim.id,
      existingEvidenceIds: [...claim.evidenceIds],
      existingDatumIds: [...claim.datumIds],
      missingItems: missingItems.map((description) => ({ kind: "CROSS_CHECK", description, requiredScope: null })),
      blockingReason,
      blockedAction: "CONFIRM",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolutionEvidenceIds: [],
    };
    evidenceGaps.push(gap);
  }
  claim.evidenceGapId = gap.id;
  for (const conclusion of conclusionsForClaim(claim.id, conclusions)) {
    conclusion.evidenceGapIds = [...new Set([...conclusion.evidenceGapIds, gap.id])];
    conclusion.missingEvidence = [...new Set([...conclusion.missingEvidence, ...missingItems])];
  }
}

export function contradictsPercentageDatum(text: string, data: Datum[]) {
  const percentageData = data.filter((datum) => datum.unit.includes("%"));
  if (percentageData.length === 0) return false;
  const claims = [...text.matchAll(/(?<!\d)(-?\d{1,12}(?:\.\d{1,6})?)\s*%(?!\d)/gu)];
  return claims.some((match) => {
    const claimed = Number(match[1]);
    const prefix = text.slice(Math.max(0, match.index! - 10), match.index).replace(/\s+/gu, "");
    if (/远低于|大幅低于/u.test(prefix)) return percentageData.every((datum) => datum.value > claimed * 0.8);
    if (/远高于|大幅高于/u.test(prefix)) return percentageData.every((datum) => datum.value < claimed * 1.2);
    if (/不低于|至少/u.test(prefix)) return percentageData.every((datum) => datum.value < claimed);
    if (/不高于|至多/u.test(prefix)) return percentageData.every((datum) => datum.value > claimed);
    if (/高于|大于|超过/u.test(prefix)) return percentageData.every((datum) => datum.value < claimed);
    if (/低于|小于|不足|不到/u.test(prefix)) return percentageData.every((datum) => datum.value > claimed);
    return percentageData.every((datum) => Math.abs(datum.value - claimed) > Math.max(0.2, Math.abs(datum.value) * 0.02));
  });
}

/**
 * 确定性规则审计只读取显式结构化图。模型负责提出候选，程序负责引用白名单、
 * 类型、冲突、假设、范围和确认边界。所有可自动动作在这一轮内完成，不递归重跑。
 */
export function runDeterministicAudit(bundle: SynthesisBundle, evidence: Evidence[]): AuditResult {
  const auditedBundle = structuredClone(bundle);
  const findings: AuditFinding[] = [];
  const conflicts: SourceConflict[] = [];
  const { claims, conclusions, data, assumptions, evidenceGaps, candidateRevisions } = auditedBundle;
  const knownEvidenceIds = new Set(evidence.map((item) => item.id));
  const knownDatumIds = new Set(data.map((item) => item.id));

  // R1：不存在的证据 ID 永不进入图；移除后若已无支撑则 fail-closed。
  for (const claim of claims) {
    const valid = claim.evidenceIds.filter((id) => knownEvidenceIds.has(id));
    if (valid.length === claim.evidenceIds.length) continue;
    const before = claim.evidenceIds.join(",");
    claim.evidenceIds = valid;
    const removed = before.split(",").length - valid.length;
    findings.push(finding("MISSING_CITATION", "warning", claim.id, "REPAIRED", `移除 ${removed} 个不存在的证据引用。`, "移除悬空引用并重新判定支撑", before, valid.join(",")));
  }

  // R2：AI 候选必须有真实引用或可重算数据；来源自述“无数据”只能证明边界，不能反向支撑正向断言。
  for (const claim of claims) {
    const validEvidence = claim.evidenceIds.filter((id) => knownEvidenceIds.has(id));
    const validData = claim.datumIds.filter((id) => knownDatumIds.has(id));
    const onlyGapMaterial = validEvidence.length > 0 && validEvidence.every((id) => {
      const excerpt = evidence.find((item) => item.id === id)!.excerpt;
      return SELF_DECLARED_DATA_GAP.test(excerpt);
    });
    const unsupported = claim.originType === "AI_JUDGMENT" && validData.length === 0 && (validEvidence.length === 0 || onlyGapMaterial);
    if (!unsupported) continue;

    if (claim.evidenceStatus !== "INSUFFICIENT_EVIDENCE") {
      const before = claim.text;
      claim.text = `证据不足：现有材料无法支撑「${claim.originalText}」。`;
      setEvidenceStatus(claim, conclusions, "INSUFFICIENT_EVIDENCE");
      findings.push(finding("UNSUPPORTED_CLAIM", "critical", claim.id, "REPAIRED", "AI 判断没有有效证据或可重算数据支撑。", "降级为证据不足并阻止确认", before, claim.text));
    } else {
      findings.push(finding("UNSUPPORTED_CLAIM", "info", claim.id, "PASSED", "无支撑候选已由证据缺口对象显式阻断。", "保持证据不足", claim.text, claim.text));
    }
    ensureEvidenceGap(
      claim,
      conclusions,
      evidenceGaps,
      ["与判断直接相关的量化数据", "可交叉验证的一手来源"],
      "AI 候选没有有效证据或可重算数据支撑，程序已 fail-closed 阻止确认。",
    );
  }

  // R2b：真实 ID 不等于语义支撑。AI 候选须与其摘录/Datum 有显著词项交集，且百分比措辞不能反向描述链接值。
  for (const claim of claims) {
    if (claim.originType !== "AI_JUDGMENT" || claim.evidenceStatus !== "SUPPORTED") continue;
    const citedEvidence = claim.evidenceIds
      .filter((id) => knownEvidenceIds.has(id))
      .map((id) => evidence.find((item) => item.id === id)!.excerpt);
    const citedData = claim.datumIds
      .filter((id) => knownDatumIds.has(id))
      .map((id) => data.find((item) => item.id === id)!);
    const supportText = [...citedEvidence, ...citedData.map((datum) => datum.metric)].join("\n");
    const reasons: string[] = [];
    if (!hasSignificantTermOverlap(claim.text, supportText)) reasons.push("判断与引用材料没有显著词项交集");
    if (contradictsPercentageDatum(claim.text, citedData)) reasons.push("判断中的百分比措辞与引用 Datum 不一致");
    if (reasons.length === 0) continue;
    const before = `${claim.evidenceStatus}: ${claim.text}`;
    setEvidenceStatus(claim, conclusions, "INSUFFICIENT_EVIDENCE");
    ensureEvidenceGap(
      claim,
      conclusions,
      evidenceGaps,
      ["证明结论措辞与引用数据语义一致的直接证据"],
      "候选判断与其引用证据缺少可验证的语义一致性，程序已阻止确认。",
    );
    findings.push(finding(
      "UNSUPPORTED_CLAIM",
      "warning",
      claim.id,
      "NEEDS_HUMAN",
      `${reasons.join("；")}。真实引用 ID 不能替代语义一致性检查。`,
      "降级为证据不足并请求人工核对结论措辞与原始依据",
      before,
      `INSUFFICIENT_EVIDENCE: ${claim.text}`,
    ));
  }

  // R3：同一期间、相似指标而数值不同，保留双值和候选解释，不取平均。
  for (let i = 0; i < data.length; i += 1) {
    for (let j = i + 1; j < data.length; j += 1) {
      const a = data[i];
      const b = data[j];
      if (!a || !b || a.period !== b.period || a.evidenceId === b.evidenceId || !metricOverlap(a, b) || Math.abs(a.value - b.value) < 1e-9) continue;
      conflicts.push({
        id: `conflict-${a.id}-${b.id}`,
        metric: `${a.metric} / ${b.metric}`,
        datumIds: [a.id, b.id],
        explanation: `同一期间两项来源值分别为 ${a.value}${a.unit} 与 ${b.value}${b.unit}；差异可能来自车辆对象、分母、地域或交易口径。双值均保留，候选解释待人工裁决。`,
        explanationStatus: "CANDIDATE_EXPLANATION",
      });
      findings.push(finding("SOURCE_CONFLICT", "warning", `conflict-${a.id}-${b.id}`, "NEEDS_HUMAN", `相近指标出现不同数值（${a.value} vs ${b.value}）。`, "保留双值并请求人工裁决", String(a.value), `${a.value} / ${b.value}`));
      const ids = new Set([a.id, b.id]);
      for (const claim of claims) {
        if (claim.datumIds.some((id) => ids.has(id)) && claim.evidenceStatus !== "INSUFFICIENT_EVIDENCE") setEvidenceStatus(claim, conclusions, "CONFLICT");
      }
    }
  }

  // R4：只链接 PLAN/SYNTHESIZE 前已经存在的 Assumption，不根据输入临时编造假设。
  for (const datum of data) {
    if (datum.knowledgeType !== "ESTIMATE" || datum.assumptionIds.length > 0) continue;
    const linked = assumptions.find((item) => item.owner === "DEMO_PARAMETER" && item.freshness === "CURRENT");
    if (!linked) {
      findings.push(finding("MISSING_ASSUMPTION", "critical", datum.id, "NEEDS_HUMAN", "估算没有可链接的显式假设对象。", "请求人工补充假设", "无假设 ID", "待人工处理"));
      continue;
    }
    datum.assumptionIds = [linked.id];
    datum.assumptions = [linked.text];
    for (const claim of claims) {
      if (!claim.datumIds.includes(datum.id)) continue;
      claim.assumptionIds = [...new Set([...claim.assumptionIds, linked.id])];
      claim.assumptions = [...new Set([...claim.assumptions, linked.text])];
    }
    findings.push(finding("MISSING_ASSUMPTION", "warning", datum.id, "REPAIRED", "估算未链接已声明的假设对象。", "链接既有 Assumption，不编造新假设", "assumptionIds=[]", `assumptionIds=[${linked.id}]`));
  }

  // R5：预测语言不能保存为事实类型。
  for (const claim of claims) {
    if (claim.knowledgeType !== "FACT" && claim.type !== "FACT") continue;
    if (!FORECAST_MARKERS.test(`${claim.text}\n${excerptFor(claim.evidenceIds, evidence)}`)) continue;
    const before = `${claim.knowledgeType}/${claim.type}`;
    claim.knowledgeType = "FORECAST";
    claim.type = "FORECAST";
    findings.push(finding("TYPE_MISMATCH", "warning", claim.id, "REPAIRED", "预测表述不能标记为 FACT。", "纠正为 FORECAST", before, "FORECAST/FORECAST"));
  }

  // R6：全称/普遍性判断至少需要两个独立量化对象，否则只能交人裁决。
  for (const conclusion of conclusions) {
    if (!UNIVERSALITY_MARKERS.test(conclusion.text)) continue;
    const claimData = conclusion.claimIds.flatMap((id) => claims.find((claim) => claim.id === id)?.datumIds ?? []).filter((id) => knownDatumIds.has(id));
    if (new Set(claimData).size >= 2) continue;
    conclusion.normalizedReviewStatus = "NEEDS_REVIEW";
    conclusion.reviewStatus = "NEEDS_REVIEW";
    findings.push(finding("SCOPE_OVERREACH", "critical", conclusion.id, "NEEDS_HUMAN", "全称判断缺少足够的独立量化支撑。", "请求人工缩小范围或补证据", conclusion.text, "待人工裁决"));
  }

  // 六类规则都留下机器可读执行证据；PASSED 不是问题，不触发修复。
  for (const category of ALL_CATEGORIES) {
    if (findings.some((item) => item.category === category)) continue;
    findings.push(finding(category, "info", "run", "PASSED", `${category} 检查通过，未发现需处理的问题。`, "无动作", "通过", "通过"));
  }

  for (const revision of candidateRevisions) {
    const related = findings.filter((item) => {
      const conclusion = conclusions.find((entry) => entry.id === revision.conclusionId);
      return item.targetId === revision.conclusionId || conclusion?.claimIds.some((id) => id === item.targetId) || false;
    });
    revision.auditFindingIds = related.map((item) => item.id);
    revision.auditStatus = related.some((item) => item.status === "NEEDS_HUMAN") ? "NEEDS_REVIEW" : "PASSED";
  }

  return { bundle: auditedBundle, findings, conflicts };
}
