import type { AuditFinding, Claim, Conclusion, Datum, Evidence, SourceConflict } from "./domain.js";
import { cjkBigrams, type SynthesisBundle } from "./synthesis.js";

export interface AuditResult {
  findings: AuditFinding[];
  conflicts: SourceConflict[];
}

const FORECAST_MARKERS = /预计|预测|预期|展望|forecast|expect|outlook|project/i;
const UNIVERSALITY_MARKERS = /所有|全部|普遍|整体|一律|均/;
const SELF_DECLARED_DATA_GAP = /no\s+(?:[a-z]+\s+){0,3}dataset|不含.{0,12}数据|没有.{0,12}数据|无.{0,8}数据/i;

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
  return evidenceIds
    .map((id) => evidence.find((item) => item.id === id)?.excerpt ?? "")
    .join("\n");
}

function conclusionsForClaim(claimId: string, conclusions: Conclusion[]): Conclusion[] {
  return conclusions.filter((conclusion) => conclusion.claimIds.includes(claimId));
}

function metricOverlap(a: Datum, b: Datum): boolean {
  const gramsA = new Set(cjkBigrams(a.metric));
  return cjkBigrams(b.metric).some((gram) => gramsA.has(gram));
}

/**
 * 确定性规则审计：只读结构化输入，不依赖隐藏上下文；单次修复内完成全部 REPAIRED 动作，
 * 无法自动修复的标记 NEEDS_HUMAN。规则发现的问题来自数据本身——同样规则作用于不同数据
 * 会产生不同结论，而不是回放固定剧本。
 */
export function runDeterministicAudit(bundle: SynthesisBundle, evidence: Evidence[]): AuditResult {
  const findings: AuditFinding[] = [];
  const conflicts: SourceConflict[] = [];
  const { claims, conclusions, data } = bundle;
  const knownEvidenceIds = new Set(evidence.map((item) => item.id));

  // R1 引用完整性：悬空引用移除；来源自述缺数据 → 引用缺失。
  for (const claim of claims) {
    const valid = claim.evidenceIds.filter((id) => knownEvidenceIds.has(id));
    if (valid.length !== claim.evidenceIds.length) {
      const before = claim.evidenceIds.join(",");
      const dropped = claim.evidenceIds.length - valid.length;
      claim.evidenceIds = valid;
      findings.push(finding("MISSING_CITATION", "warning", claim.id, "REPAIRED", `Claim 引用了 ${dropped} 个不存在的证据。`, "移除悬空引用", before, valid.join(",")));
    }
    if (SELF_DECLARED_DATA_GAP.test(excerptFor(claim.evidenceIds, evidence))) {
      findings.push(finding("MISSING_CITATION", "warning", claim.id, "REPAIRED", "被引用来源自身声明缺少对应数据集。", "降级为证据不足并列出缺口", "引用定性边界说明", "移出支撑引用并降级"));
    }
  }

  // R6 范围越界：原文使用全称量词，但支撑数据不足两条（基于 originalText/originalAiText，修复前文本）。
  for (const conclusion of conclusions) {
    if (!UNIVERSALITY_MARKERS.test(conclusion.originalAiText)) continue;
    const claimData = conclusion.claimIds
      .flatMap((claimId) => claims.find((claim) => claim.id === claimId)?.datumIds ?? [])
      .flatMap((datumId) => (data.find((datum) => datum.id === datumId) ? [datumId] : []));
    if (claimData.length < 2) {
      findings.push(finding("SCOPE_OVERREACH", "critical", conclusion.id, "NEEDS_HUMAN", "结论使用了全称量词，但支撑它的量化数据不足两条。", "请求人工处理", conclusion.originalAiText, "待人工裁决"));
    }
  }

  // R5 类型纠正：来源的预测/展望句被抽取为 FACT → 纠正为 FORECAST。
  for (const claim of claims) {
    if (claim.type !== "FACT") continue;
    if (!FORECAST_MARKERS.test(excerptFor(claim.evidenceIds, evidence))) continue;
    claim.type = "FORECAST";
    findings.push(finding("TYPE_MISMATCH", "warning", claim.id, "REPAIRED", "来源的预测表述不能标记为事实。", "改为 FORECAST 类型", "FACT", "FORECAST"));
  }

  // R4 假设补全：估算类数据缺少假设声明 → 从其自身输入参数派生并标注为演示参数。
  for (const datum of data) {
    if (datum.type !== "ESTIMATE" || datum.assumptions.length > 0) continue;
    const parameters = datum.inputs.slice(1);
    if (parameters.length === 0) continue;
    const assumption = `${parameters.map((input) => `${input.label}取 ${input.value}${input.unit}`).join("、")}，为演示参数，尚缺行业来源支撑`;
    datum.assumptions = [assumption];
    for (const claim of claims) {
      if (claim.datumIds.includes(datum.id)) claim.assumptions = [...new Set([...claim.assumptions, assumption])];
    }
    findings.push(finding("MISSING_ASSUMPTION", "warning", datum.id, "REPAIRED", "估算缺少假设声明。", "补充估算假设", "无假设", assumption));
  }

  // R2 无支撑判断：AI_JUDGMENT 且没有任何量化数据支撑 → 降级为证据不足并阻断确认。
  for (const claim of claims) {
    if (claim.type !== "AI_JUDGMENT" || claim.datumIds.length > 0 || claim.evidenceStatus === "INSUFFICIENT_EVIDENCE") continue;
    claim.evidenceStatus = "INSUFFICIENT_EVIDENCE";
    claim.text = `证据不足：现有材料无法支撑「${claim.originalText}」。`;
    findings.push(finding("UNSUPPORTED_CLAIM", "critical", claim.id, "REPAIRED", "AI 判断没有任何量化数据支撑。", "降级为证据不足并阻止确认", claim.originalText, claim.text));
    for (const conclusion of conclusionsForClaim(claim.id, conclusions)) {
      conclusion.evidenceStatus = "INSUFFICIENT_EVIDENCE";
      conclusion.text = `证据不足：无法就「${conclusion.originalAiText}」下结论，待补数据后重审。`;
      conclusion.missingEvidence = [
        ...conclusion.missingEvidence,
        ...["与该判断直接相关的量化数据", "可定位的一手信源"].filter((gap) => !conclusion.missingEvidence.includes(gap)),
      ];
      findings.push(finding("UNSUPPORTED_CLAIM", "critical", conclusion.id, "REPAIRED", "结论依赖无数据支撑的 AI 判断。", "降级为证据不足并列出缺口", conclusion.originalAiText, conclusion.text));
    }
  }

  // R3 来源冲突：同一期间、指标语义重叠但数值不同 → 保留双值，标记候选解释，交人裁决。
  for (let i = 0; i < data.length; i += 1) {
    for (let j = i + 1; j < data.length; j += 1) {
      const a = data[i];
      const b = data[j];
      if (!a || !b) continue;
      if (a.period !== b.period || a.evidenceId === b.evidenceId || !metricOverlap(a, b)) continue;
      if (Math.abs(a.value - b.value) < 1e-9) continue;
      const conflictId = `conflict-${a.id}-${b.id}`;
      conflicts.push({
        id: conflictId,
        metric: `${a.metric} / ${b.metric}`,
        datumIds: [a.id, b.id],
        explanation: `同一期间「${a.metric}」与「${b.metric}」分别给出 ${a.value}${a.unit} 与 ${b.value}${b.unit}，差异可能来自统计口径、范围或定义；双值均保留，候选解释待人工裁决。`,
        explanationStatus: "CANDIDATE_EXPLANATION",
      });
      findings.push(finding("SOURCE_CONFLICT", "warning", a.id, "NEEDS_HUMAN", `两个来源对同一期间指标给出不同数值（${a.value} vs ${b.value}）。`, "保留双值并请求人工裁决", String(a.value), `${a.value} / ${b.value}`));
      const conflictingDatums = new Set([a.id, b.id]);
      for (const claim of claims) {
        if (!claim.datumIds.some((datumId) => conflictingDatums.has(datumId)) || claim.evidenceStatus === "INSUFFICIENT_EVIDENCE") continue;
        claim.evidenceStatus = "CONFLICT";
        for (const conclusion of conclusionsForClaim(claim.id, conclusions)) {
          if (conclusion.evidenceStatus !== "INSUFFICIENT_EVIDENCE") conclusion.evidenceStatus = "CONFLICT";
        }
      }
    }
  }

  return { findings, conflicts };
}
