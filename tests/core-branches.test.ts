import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runDeterministicAudit } from "../src/audit.js";
import { errorText, runGoldenCase } from "../src/engine.js";
import { applyHumanDecision, applyHumanDecisionAndPersist } from "../src/human-decision.js";
import { applySourceUpdate } from "../src/source-update.js";
import {
  buildDeterministicSynthesis,
  buildMismatchSynthesis,
  bundleFromCachedModelDrafts,
  bundleFromLlmDrafts,
  questionFit,
} from "../src/synthesis.js";

async function golden() {
  return runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-core-branches-")),
  });
}

function bundle(run: Awaited<ReturnType<typeof golden>>) {
  return structuredClone({
    data: run.data,
    assumptions: run.assumptions,
    claims: run.claims,
    evidenceGaps: run.evidenceGaps,
    conclusions: run.conclusions,
    candidateRevisions: run.candidateRevisions,
  });
}

test("audit adds machine-readable gaps, accepts two-datum scope, and leaves clean FACT text unchanged", async () => {
  const run = await golden();
  const unsupported = bundle(run);
  const unsupportedClaim = unsupported.claims.find((item) => item.id === "claim-causality-gap")!;
  const unsupportedConclusion = unsupported.conclusions.find((item) => item.id === "conclusion-causality-gap")!;
  unsupported.evidenceGaps = unsupported.evidenceGaps.filter((item) => item.claimId !== unsupportedClaim.id);
  unsupportedClaim.evidenceGapId = null;
  unsupportedConclusion.missingEvidence = [];
  const repaired = runDeterministicAudit(unsupported, run.evidence);
  assert.ok(repaired.findings.some((item) => item.category === "UNSUPPORTED_CLAIM"));
  assert.ok(unsupportedConclusion.missingEvidence.includes("与判断直接相关的量化数据"));

  const cleanClaim = structuredClone(run.claims[0]!);
  cleanClaim.id = "claim-clean-fact";
  cleanClaim.text = "2024 年历史值为 40%";
  cleanClaim.originalText = cleanClaim.text;
  cleanClaim.type = "FACT";
  cleanClaim.knowledgeType = "FACT";
  cleanClaim.originType = "DETERMINISTIC";
  cleanClaim.evidenceIds = ["evidence-clean"];
  cleanClaim.datumIds = [];
  const cleanEvidence = { ...structuredClone(run.evidence[0]!), id: "evidence-clean", excerpt: "2024 年历史值为 40%" };
  const cleanConclusion = { ...structuredClone(run.conclusions[0]!), id: "conclusion-clean", claimIds: [cleanClaim.id], text: "历史值为 40%" };
  const clean = runDeterministicAudit({ data: [], assumptions: [], claims: [cleanClaim], evidenceGaps: [], conclusions: [cleanConclusion], candidateRevisions: [] }, [cleanEvidence]);
  assert.ok(clean.findings.some((item) => item.category === "TYPE_MISMATCH" && item.status === "PASSED"));
  assert.equal(cleanClaim.knowledgeType, "FACT");

  const twoData = structuredClone(run.data.slice(0, 2));
  twoData[1]!.period = "2025";
  const broadClaim = { ...structuredClone(run.claims[0]!), id: "claim-broad", datumIds: twoData.map((item) => item.id), originType: "DETERMINISTIC" as const };
  const broadConclusion = { ...structuredClone(run.conclusions[0]!), id: "conclusion-broad", text: "所有地区均满足约束", claimIds: [broadClaim.id] };
  const broad = runDeterministicAudit({ data: twoData, assumptions: [], claims: [broadClaim], evidenceGaps: [], conclusions: [broadConclusion], candidateRevisions: [] }, run.evidence);
  assert.ok(broad.findings.some((item) => item.category === "SCOPE_OVERREACH" && item.status === "PASSED"));

  const forgedConclusion = { ...structuredClone(broadConclusion), id: "conclusion-forged-claim", claimIds: ["claim-does-not-exist"] };
  const forged = runDeterministicAudit({ data: [], assumptions: [], claims: [], evidenceGaps: [], conclusions: [forgedConclusion], candidateRevisions: [] }, []);
  assert.ok(forged.findings.some((item) => item.category === "SCOPE_OVERREACH" && item.status === "NEEDS_HUMAN"));
});

test("human review rejects stale/boundary violations, keeps stale edits pending, and reaches DELIVERED only after all decisions", async () => {
  const run = await golden();
  const conflictId = "conclusion-penetration";
  assert.throws(() => applyHumanDecision(run, { conclusionId: conflictId, action: "CONFIRM" }), /requires reason and scopeNote/u);
  assert.throws(() => applyHumanDecision(run, { conclusionId: conflictId, action: "CONFIRM", reason: "有理由" }), /requires reason and scopeNote/u);

  const staleFreshness = structuredClone(run);
  const staleOne = staleFreshness.conclusions.find((item) => item.id === "conclusion-charging-growth")!;
  staleOne.freshness = "STALE";
  assert.throws(() => applyHumanDecision(staleFreshness, { conclusionId: staleOne.id, action: "CONFIRM" }), /STALE/u);
  const editedStale = applyHumanDecision(staleFreshness, { conclusionId: staleOne.id, action: "EDIT", text: "人工编辑后仍需重新审查" });
  assert.equal(editedStale.conclusions.find((item) => item.id === staleOne.id)?.reviewStatus, "NEEDS_REVIEW");

  const staleEvidence = structuredClone(run);
  const staleTwo = staleEvidence.conclusions.find((item) => item.id === "conclusion-charging-growth")!;
  staleTwo.evidenceStatus = "STALE";
  assert.throws(() => applyHumanDecision(staleEvidence, { conclusionId: staleTwo.id, action: "CONFIRM" }), /STALE/u);

  const almostDone = structuredClone(run);
  const last = almostDone.conclusions.at(-1)!;
  for (const conclusion of almostDone.conclusions.slice(0, -1)) conclusion.normalizedReviewStatus = "HUMAN_REJECTED";
  const delivered = applyHumanDecision(almostDone, { conclusionId: last.id, action: "REJECT" });
  assert.equal(delivered.terminalStatus, "DELIVERED");
  const persistedReject = await applyHumanDecisionAndPersist(run, { conclusionId: "conclusion-charging-growth", action: "REJECT" }, await mkdtemp(join(tmpdir(), "insightforge-reject-default-note-")));
  assert.equal(persistedReject.artifactVersions.at(-1)?.trigger, "HUMAN_DECISION");
  assert.equal(errorText(new Error("typed")), "typed");
  assert.equal(errorText("untyped"), "untyped");
});

test("synthesis covers empty fit/mismatch, low/v2 data, live assumptions/gaps, and cached semantic failures", async () => {
  const run = await golden();
  assert.equal(questionFit("???", "anything"), 0);
  const mismatch = buildMismatchSynthesis({ question: "???", penetration: 1, chargerGrowth: 2, estimatedAdequacy: 3, sourceVersion: "v1", sources: [], evidence: [] }, []);
  assert.match(mismatch.conclusions[0]!.text, /目标问题/u);
  assert.match(mismatch.claims[0]!.text, /既有资料/u);
  assert.ok(mismatch.evidenceGaps.some((gap) => gap.missingItems.some((item) => item.kind === "CROSS_CHECK")));

  const v2 = buildDeterministicSynthesis({ question: "测试", penetration: 40, chargerGrowth: 20, estimatedAdequacy: 2, sourceVersion: "v2" });
  assert.match(v2.conclusions[0]!.originalAiText, /约为 40\.0%/u);
  assert.match(v2.data.find((item) => item.id === "datum-penetration")!.metric, /最终输入/u);
  assert.match(buildDeterministicSynthesis({ question: "测试", penetration: 50, chargerGrowth: 20, estimatedAdequacy: 2, sourceVersion: "v1" }).conclusions[0]!.originalAiText, /已接近一半/u);

  const live = bundleFromLlmDrafts([
    { text: "模型候选一包含显式假设与缺口", evidenceIds: [run.evidence[0]!.id], assumptions: ["利用率保持稳定"], missingEvidence: ["第二信源"] },
    { text: "模型候选二具有已知证据支撑", evidenceIds: [run.evidence[1]!.id], assumptions: [], missingEvidence: [] },
  ], { data: run.data, sources: run.sources, evidence: run.evidence });
  assert.equal(live.assumptions.length, 1);
  assert.equal(live.evidenceGaps.length, 1);
  assert.deepEqual(live.conclusions.map((item) => item.evidenceStatus), ["INSUFFICIENT_EVIDENCE", "SUPPORTED"]);

  const charger = run.data.find((item) => item.id === "datum-charger-growth")!;
  const chargerDraft = { role: "CHARGING_GROWTH" as const, text: `公共充电增速为 ${charger.value.toFixed(1)}%，仍需区域核验。`, evidenceIds: [charger.evidenceId], assumptionIds: [], evidenceStatus: "SUPPORTED" as const, missingEvidence: [] };
  await assert.throws(() => bundleFromCachedModelDrafts([chargerDraft], { data: run.data.filter((item) => item.id !== charger.id), assumptions: run.assumptions, sources: run.sources, evidence: run.evidence }, "snapshot"), /requires missing datum/u);
  await assert.throws(() => bundleFromCachedModelDrafts([{ ...chargerDraft, text: "数值与实际计算不一致" }], { data: run.data, assumptions: run.assumptions, sources: run.sources, evidence: run.evidence }, "snapshot"), /numerically inconsistent/u);
  const unknownAssumption = bundleFromCachedModelDrafts([{
    role: "CAUSALITY_GAP",
    text: "因果约束仍缺少面板数据和识别方法，当前只能标记证据不足。",
    evidenceIds: [run.evidence[0]!.id],
    assumptionIds: ["unknown-assumption"],
    evidenceStatus: "INSUFFICIENT_EVIDENCE",
    missingEvidence: ["面板指标", "区域范围", "识别方法"],
  }], { data: run.data, assumptions: run.assumptions, sources: run.sources, evidence: run.evidence }, "snapshot");
  assert.deepEqual(unknownAssumption.claims[0]?.assumptions, ["unknown-assumption"]);
  assert.deepEqual(unknownAssumption.evidenceGaps[0]?.missingItems.map((item) => item.kind), ["METRIC", "SCOPE", "METHOD"]);
});

test("source update refuses incomplete source and revision dependency chains", async () => {
  const run = await golden();
  const missingSource = structuredClone(run);
  missingSource.sources = missingSource.sources.filter((item) => item.id !== "source-market-csv");
  await assert.rejects(applySourceUpdate(missingSource, { fixtureDir: resolve("fixtures/golden"), workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-update-missing-source-")) }), /dependency chain is incomplete/u);

  const missingRevision = structuredClone(run);
  const penetration = missingRevision.conclusions.find((item) => item.id === "conclusion-penetration")!;
  missingRevision.candidateRevisions = missingRevision.candidateRevisions.filter((item) => item.id !== penetration.currentRevisionId);
  await assert.rejects(applySourceUpdate(missingRevision, { fixtureDir: resolve("fixtures/golden"), workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-update-missing-revision-")) }), /dependency chain is incomplete/u);
});
