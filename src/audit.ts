import type { AuditCategory, AuditFinding, Claim, Conclusion, Datum, Evidence, SourceConflict } from "./domain.js";
import { cjkBigrams, type SynthesisBundle } from "./synthesis.js";

export interface AuditResult {
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

/**
 * 确定性规则审计只读取显式结构化图。模型负责提出候选，程序负责引用白名单、
 * 类型、冲突、假设、范围和确认边界。所有可自动动作在这一轮内完成，不递归重跑。
 */
export function runDeterministicAudit(bundle: SynthesisBundle, evidence: Evidence[]): AuditResult {
  const findings: AuditFinding[] = [];
  const conflicts: SourceConflict[] = [];
  const { claims, conclusions, data, assumptions, evidenceGaps, candidateRevisions } = bundle;
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
    const hasGraphGap = evidenceGaps.some((gap) => gap.claimId === claim.id && gap.resolvedAt === null);
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
    if (!hasGraphGap) {
      const conclusion = conclusionsForClaim(claim.id, conclusions)[0];
      if (conclusion) {
        conclusion.missingEvidence = [...new Set([...conclusion.missingEvidence, "与判断直接相关的量化数据", "可交叉验证的一手来源"] )];
      }
    }
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
      findings.push(finding("SOURCE_CONFLICT", "warning", a.id, "NEEDS_HUMAN", `相近指标出现不同数值（${a.value} vs ${b.value}）。`, "保留双值并请求人工裁决", String(a.value), `${a.value} / ${b.value}`));
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

  return { findings, conflicts };
}
