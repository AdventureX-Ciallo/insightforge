import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { contradictsPercentageDatum, runDeterministicAudit } from "../src/audit.js";
import { runGoldenCase } from "../src/engine.js";
import { bundleFromLlmDrafts } from "../src/synthesis.js";

test("audit outcome changes when structured supporting evidence is added", async () => {
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-audit-input-")),
  });
  const bundle = structuredClone({
    data: run.data,
    assumptions: run.assumptions,
    claims: run.claims,
    evidenceGaps: run.evidenceGaps,
    conclusions: run.conclusions,
    candidateRevisions: run.candidateRevisions,
  });
  const claim = bundle.claims.find((item) => item.id === "claim-causality-gap");
  const conclusion = bundle.conclusions.find((item) => item.id === "conclusion-causality-gap");
  assert.ok(claim && conclusion);
  claim.evidenceIds.push("evidence-regional-panel");
  claim.evidenceStatus = "SUPPORTED";
  claim.evidenceGapId = null;
  conclusion.evidenceIds.push("evidence-regional-panel");
  conclusion.evidenceStatus = "SUPPORTED";
  conclusion.normalizedEvidenceStatus = "SUPPORTED";
  conclusion.evidenceGapIds = [];
  bundle.evidenceGaps = bundle.evidenceGaps.filter((item) => item.claimId !== claim.id);
  const evidence = [...run.evidence, {
    id: "evidence-regional-panel",
    sourceId: "source-web-association",
    type: "FACT" as const,
    excerpt: "地区面板数据同时包含公共充电供给、家充、销量、利用率和控制变量，可用于检验约束关系。",
    locator: { url: "https://www.cada.cn/Trends/info_91_10118.html" },
    datumIds: [],
    knowledgeType: "FACT" as const,
    originType: "SOURCE_EXTRACTED" as const,
    freshness: "CURRENT" as const,
  }];
  const result = runDeterministicAudit(bundle, evidence);
  assert.ok(!result.findings.some((item) => item.category === "UNSUPPORTED_CLAIM" && item.targetId === claim.id && item.status === "REPAIRED"));
  assert.equal(result.bundle.claims.find((item) => item.id === claim.id)?.evidenceStatus, "SUPPORTED");
});

test("audit removes unknown citation IDs instead of trusting function shape", async () => {
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-audit-citation-")),
  });
  const bundle = structuredClone({ data: run.data, assumptions: run.assumptions, claims: run.claims, evidenceGaps: run.evidenceGaps, conclusions: run.conclusions, candidateRevisions: run.candidateRevisions });
  bundle.claims[0]?.evidenceIds.push("evidence-does-not-exist");
  const beforeAudit = structuredClone(bundle);
  const result = runDeterministicAudit(bundle, run.evidence);
  assert.ok(result.findings.some((item) => item.category === "MISSING_CITATION" && item.status === "REPAIRED"));
  assert.deepEqual(bundle, beforeAudit, "AUDIT must not mutate the committed SYNTHESIZE bundle");
  assert.ok(!result.bundle.claims[0]?.evidenceIds.includes("evidence-does-not-exist"));
});

test("audit requests human handling when an estimate has no pre-existing assumption to link", async () => {
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-audit-missing-assumption-")),
  });
  const bundle = structuredClone({ data: run.data, assumptions: [], claims: run.claims, evidenceGaps: run.evidenceGaps, conclusions: run.conclusions, candidateRevisions: run.candidateRevisions });
  const estimate = bundle.data.find((item) => item.knowledgeType === "ESTIMATE");
  assert.ok(estimate);
  estimate.assumptionIds = [];
  estimate.assumptions = [];

  const result = runDeterministicAudit(bundle, run.evidence);
  assert.ok(result.findings.some((item) => item.category === "MISSING_ASSUMPTION" && item.targetId === estimate.id && item.status === "NEEDS_HUMAN" && item.severity === "critical"));
  assert.deepEqual(result.bundle.data.find((item) => item.id === estimate.id)?.assumptionIds, []);
});

test("semantic audit rejects unrelated or numerically contradictory AI claims without auto-linking every datum", () => {
  const penetration = {
    id: "datum-penetration",
    evidenceId: "evidence-market",
    metric: "2024 新能源乘用车零售渗透率",
    value: 47.6,
    unit: "%",
    period: "2024",
    type: "FACT",
    formula: null,
    inputs: [],
    assumptions: [],
    knowledgeType: "FACT",
    originType: "SOURCE_EXTRACTED",
    freshness: "CURRENT",
    assumptionIds: [],
    sourceIds: ["source-market"],
    roundingRule: null,
  } as const;
  const charging = { ...penetration, id: "datum-charging", metric: "公共充电点同比增长", value: 31.3 } as const;
  const evidence = [{
    id: "evidence-market",
    sourceId: "source-market",
    type: "FACT",
    excerpt: "2024 new-energy passenger-car retail penetration was 47.6 percent.",
    locator: { url: "https://example.test/market" },
    datumIds: [penetration.id, charging.id],
    knowledgeType: "FACT",
    originType: "SOURCE_EXTRACTED",
    freshness: "CURRENT",
  }] as const;
  const bundle = bundleFromLlmDrafts([
    { text: "2024 年新能源乘用车渗透率远低于 50%，仅为 10%。", evidenceIds: ["evidence-market"], assumptions: [], missingEvidence: [] },
    { text: "2024 年新能源乘用车零售渗透率为 47.6%。", evidenceIds: ["evidence-market"], assumptions: [], missingEvidence: [] },
    { text: "该企业的盈利能力将显著提升。", evidenceIds: ["evidence-market"], assumptions: [], missingEvidence: [] },
  ], { data: [penetration, charging], sources: [{ id: "source-market" }], evidence } as never);

  assert.deepEqual(bundle.claims[0]?.datumIds, [penetration.id], "citing one evidence object no longer inherits unrelated data from the same file");
  assert.deepEqual(bundle.claims[1]?.datumIds, [penetration.id]);
  assert.deepEqual(bundle.claims[2]?.datumIds, []);
  bundle.evidenceGaps.push({
    id: "gap-audit-claim-llm-3",
    claimId: "claim-llm-3",
    existingEvidenceIds: ["evidence-market"],
    existingDatumIds: [],
    missingItems: [{ kind: "CROSS_CHECK", description: "已解决的历史缺口", requiredScope: null }],
    blockingReason: "历史审查记录",
    blockedAction: "CONFIRM",
    createdAt: "2026-08-28T00:00:00.000Z",
    resolvedAt: "2026-08-28T01:00:00.000Z",
    resolutionEvidenceIds: ["evidence-market"],
  });
  const result = runDeterministicAudit(bundle, evidence as never);
  assert.equal(result.bundle.claims[0]?.evidenceStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.bundle.claims[1]?.evidenceStatus, "SUPPORTED");
  assert.equal(result.bundle.claims[2]?.evidenceStatus, "INSUFFICIENT_EVIDENCE");
  const semanticFindings = result.findings.filter((item) => item.category === "UNSUPPORTED_CLAIM" && item.status === "NEEDS_HUMAN");
  assert.equal(semanticFindings.length, 2);
  assert.match(semanticFindings.find((item) => item.targetId === "claim-llm-1")?.message ?? "", /百分比措辞与引用 Datum 不一致/u);
  assert.match(semanticFindings.find((item) => item.targetId === "claim-llm-3")?.message ?? "", /没有显著词项交集/u);
  assert.ok(result.bundle.conclusions[0]?.missingEvidence.includes("证明结论措辞与引用数据语义一致的直接证据"));
  assert.equal(result.bundle.claims[2]?.evidenceGapId, "gap-audit-claim-llm-3-2", "a reopened gap must not overwrite immutable resolved history");
  assert.equal(result.bundle.candidateRevisions[0]?.auditStatus, "NEEDS_REVIEW");
});

test("percentage contradiction rules distinguish exact values, thresholds, and strong comparative language", () => {
  const datum = { value: 47.6, unit: "%" } as never;
  assert.equal(contradictsPercentageDatum("没有百分比", [datum]), false);
  assert.equal(contradictsPercentageDatum("数值为 47.6%", []), false);
  assert.equal(contradictsPercentageDatum("渗透率远低于 50%", [datum]), true);
  assert.equal(contradictsPercentageDatum("渗透率远低于 80%", [datum]), false);
  assert.equal(contradictsPercentageDatum("渗透率远高于 40%", [datum]), true);
  assert.equal(contradictsPercentageDatum("渗透率远高于 30%", [datum]), false);
  assert.equal(contradictsPercentageDatum("渗透率至少 50%", [datum]), true);
  assert.equal(contradictsPercentageDatum("渗透率超过 40%", [datum]), false);
  assert.equal(contradictsPercentageDatum("渗透率不高于 40%", [datum]), true);
  assert.equal(contradictsPercentageDatum("渗透率低于 50%", [datum]), false);
  assert.equal(contradictsPercentageDatum("渗透率为 10%", [datum]), true);
  assert.equal(contradictsPercentageDatum("渗透率为 47.6%", [datum]), false);
  assert.equal(contradictsPercentageDatum(`${"9".repeat(20)}%`, [datum]), false, "oversized numeric tokens are not treated as bounded comparisons");
});
