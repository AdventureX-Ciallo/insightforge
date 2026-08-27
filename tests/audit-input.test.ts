import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runDeterministicAudit } from "../src/audit.js";
import { runGoldenCase } from "../src/engine.js";

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
  assert.equal(claim.evidenceStatus, "SUPPORTED");
});

test("audit removes unknown citation IDs instead of trusting function shape", async () => {
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-audit-citation-")),
  });
  const bundle = structuredClone({ data: run.data, assumptions: run.assumptions, claims: run.claims, evidenceGaps: run.evidenceGaps, conclusions: run.conclusions, candidateRevisions: run.candidateRevisions });
  bundle.claims[0]?.evidenceIds.push("evidence-does-not-exist");
  const result = runDeterministicAudit(bundle, run.evidence);
  assert.ok(result.findings.some((item) => item.category === "MISSING_CITATION" && item.status === "REPAIRED"));
  assert.ok(!bundle.claims[0]?.evidenceIds.includes("evidence-does-not-exist"));
});
