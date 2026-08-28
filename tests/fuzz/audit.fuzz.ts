import { runDeterministicAudit } from "../../src/audit.js";
import type { Claim, Conclusion, Datum, Evidence } from "../../src/domain.js";
import type { SynthesisBundle } from "../../src/synthesis.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

function evidence(excerpt: string): Evidence {
  return { id: "evidence-1", sourceId: "source-1", type: "SOURCE_OPINION", excerpt, locator: { url: "https://example.test/source" }, datumIds: [], knowledgeType: "SOURCE_OPINION", originType: "SOURCE_EXTRACTED", freshness: "CURRENT" };
}

function datum(id: string, evidenceId: string, metric: string, value: number, period: string): Datum {
  return { id, evidenceId, metric, value, unit: "%", period, type: "CALCULATION", formula: "fuzz input", inputs: [{ label: "seed", value, unit: "%" }], assumptions: [], knowledgeType: "CALCULATION", originType: "DETERMINISTIC", freshness: "CURRENT", assumptionIds: [], sourceIds: ["source-1"], roundingRule: "none" };
}

function bundle(claim: Claim, conclusion: Conclusion, data: Datum[] = []): SynthesisBundle {
  return {
    data,
    assumptions: [],
    claims: [claim],
    evidenceGaps: [],
    conclusions: [conclusion],
    candidateRevisions: [{ id: "revision-1", conclusionId: conclusion.id, parentRevisionId: null, authorType: "AI", originType: "AI_JUDGMENT", text: conclusion.text, changeReason: "fuzz", createdAt: "2026-08-28T00:00:00.000Z", auditStatus: "PENDING", auditFindingIds: [], sourceSnapshotId: "fuzz", isCurrent: true }],
  };
}

function graph(evidenceIds: string[], datumIds: string[], type: Claim["type"] = "AI_JUDGMENT") {
  const claim: Claim = { id: "claim-1", text: "候选判断", originalText: "候选判断", type, evidenceIds, datumIds, evidenceStatus: "SUPPORTED", assumptions: [], knowledgeType: type === "FACT" ? "FACT" : "SOURCE_OPINION", originType: "AI_JUDGMENT", freshness: "CURRENT", assumptionIds: [], evidenceGapId: null };
  const conclusion: Conclusion = { id: "conclusion-1", text: "候选判断", originalAiText: "候选判断", type: "AI_JUDGMENT", claimIds: [claim.id], evidenceIds, sourceIds: ["source-1"], evidenceStatus: "SUPPORTED", reviewStatus: "PENDING_REVIEW", missingEvidence: [], confirmedAt: null, confirmedText: null, originType: "AI_JUDGMENT", normalizedEvidenceStatus: "SUPPORTED", normalizedReviewStatus: "PENDING_REVIEW", freshness: "CURRENT", currentRevisionId: "revision-1", evidenceGapIds: [] };
  return { claim, conclusion };
}

export async function runAuditFuzz(rng: SeededPrng, cases: number) {
  for (let index = 0; index < cases; index += 1) {
    const mutation = rng.int(3);
    if (mutation === 0) {
      const base = graph(["evidence-1"], []);
      const before = runDeterministicAudit(bundle(structuredClone(base.claim), structuredClone(base.conclusion)), [evidence("公开来源提供直接支撑数据")]);
      const changed = graph([`missing-${rng.token()}`], []);
      const targetBundle = bundle(changed.claim, changed.conclusion);
      const after = runDeterministicAudit(targetBundle, [evidence("公开来源提供直接支撑数据")]);
      invariant(after.bundle.claims[0]!.evidenceStatus === "INSUFFICIENT_EVIDENCE", `case=${index}: deleted citation did not downgrade AI judgment`);
      invariant(after.bundle.conclusions[0]!.reviewStatus === "PENDING_REVIEW", `case=${index}: unsupported conclusion escaped review`);
      invariant(targetBundle.claims[0]!.evidenceIds.length === 1, `case=${index}: audit mutated its input bundle`);
      invariant(JSON.stringify(before) !== JSON.stringify(after), `case=${index}: citation mutation did not change audit output`);
    } else if (mutation === 1) {
      const firstValue = 10 + rng.int(10_000) / 100;
      const secondValue = firstValue + 1 + rng.int(1_000) / 100;
      const period = `${2020 + rng.int(7)}`;
      const base = graph([], ["datum-a", "datum-b"]);
      base.claim.text = "公共充电点数量在同一期间存在来源差异";
      base.claim.originalText = base.claim.text;
      base.conclusion.text = base.claim.text;
      base.conclusion.originalAiText = base.claim.text;
      const firstBundle = bundle(base.claim, base.conclusion, [datum("datum-a", "evidence-a", "公共充电点数量", firstValue, period), datum("datum-b", "evidence-b", "公共充电点总量", secondValue, period)]);
      const first = runDeterministicAudit(firstBundle, []);
      invariant(first.conflicts.length === 1, `case=${index}: same-period different values were not preserved as a conflict`);
      invariant(first.bundle.claims[0]!.evidenceStatus === "CONFLICT", `case=${index}: conflicting data did not propagate to its claim`);
      const changed = graph([], ["datum-a", "datum-b"]);
      changed.claim.text = base.claim.text;
      changed.claim.originalText = base.claim.text;
      changed.conclusion.text = base.claim.text;
      changed.conclusion.originalAiText = base.claim.text;
      const second = runDeterministicAudit(bundle(changed.claim, changed.conclusion, [datum("datum-a", "evidence-a", "公共充电点数量", firstValue, period), datum("datum-b", "evidence-b", "公共充电点总量", secondValue + 1, period)]), []);
      invariant(JSON.stringify(first) !== JSON.stringify(second), `case=${index}: numeric mutation did not change audit output`);
    } else {
      const base = graph(["evidence-1"], [], "SOURCE_OPINION");
      const before = runDeterministicAudit(bundle(base.claim, base.conclusion), [evidence("协会发布年度观察")]);
      const changed = graph(["evidence-1"], [], "FACT");
      changed.claim.text = rng.pick(["预计明年增长", "forecast growth", "未来展望显示上升"]);
      const targetBundle = bundle(changed.claim, changed.conclusion);
      const after = runDeterministicAudit(targetBundle, [evidence("协会预测下一年度增长")]);
      invariant(after.bundle.claims[0]!.type === "FORECAST", `case=${index}: forecast language remained typed as FACT`);
      invariant(JSON.stringify(before) !== JSON.stringify(after), `case=${index}: type mutation did not change audit output`);
    }
  }
  return { cases, value: undefined };
}
