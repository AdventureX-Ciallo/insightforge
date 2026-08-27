import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyHumanDecision, researchRunSchema, runGoldenCase, type ResearchRun } from "../src/index.js";

test("schema lock rejects every forged cross-object edge and current-version invariant", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-graph-matrix-"));
  const valid = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  assert.equal(researchRunSchema.safeParse(valid).success, true);

  const rejected = (label: string, mutate: (run: ResearchRun) => void, base: ResearchRun = valid) => {
    const forged = structuredClone(base);
    mutate(forged);
    assert.equal(researchRunSchema.safeParse(forged).success, false, label);
  };

  rejected("duplicate collection id", (run) => { run.sources[1]!.id = run.sources[0]!.id; });
  rejected("source to unknown version", (run) => { run.sources[0]!.sourceVersionId = "missing-version"; });
  rejected("version to unknown source", (run) => { run.sourceVersions[0]!.sourceId = "missing-source"; });
  rejected("source without one current version", (run) => {
    for (const version of run.sourceVersions.filter((item) => item.sourceId === run.sources[0]!.id)) version.isCurrent = false;
  });
  rejected("evidence to unknown source", (run) => { run.evidence[0]!.sourceId = "missing-source"; });
  rejected("evidence to unknown datum", (run) => { run.evidence[0]!.datumIds = ["missing-datum"]; });
  rejected("datum to unknown evidence", (run) => { run.data[0]!.evidenceId = "missing-evidence"; });
  rejected("datum to unknown assumption", (run) => { run.data[0]!.assumptionIds = ["missing-assumption"]; });
  rejected("datum to unknown source", (run) => { run.data[0]!.sourceIds = ["missing-source"]; });
  rejected("claim to unknown evidence", (run) => { run.claims[0]!.evidenceIds = ["missing-evidence"]; });
  rejected("claim to unknown datum", (run) => { run.claims[0]!.datumIds = ["missing-datum"]; });
  rejected("claim to unknown assumption", (run) => { run.claims[0]!.assumptionIds = ["missing-assumption"]; });
  rejected("claim to unknown evidence gap", (run) => { run.claims[0]!.evidenceGapId = "missing-gap"; });
  rejected("gap to unknown claim", (run) => { run.evidenceGaps[0]!.claimId = "missing-claim"; });
  rejected("gap to unknown evidence", (run) => { run.evidenceGaps[0]!.existingEvidenceIds = ["missing-evidence"]; });
  rejected("gap to unknown datum", (run) => { run.evidenceGaps[0]!.existingDatumIds = ["missing-datum"]; });
  rejected("conclusion to unknown claim", (run) => { run.conclusions[0]!.claimIds = ["missing-claim"]; });
  rejected("conclusion to unknown evidence", (run) => { run.conclusions[0]!.evidenceIds = ["missing-evidence"]; });
  rejected("conclusion to unknown source", (run) => { run.conclusions[0]!.sourceIds = ["missing-source"]; });
  rejected("conclusion to unknown evidence gap", (run) => { run.conclusions[0]!.evidenceGapIds = ["missing-gap"]; });
  rejected("confidence discount to unrelated source", (run) => {
    run.conclusions[0]!.confidenceDiscounts = [{ sourceId: run.sources.at(-1)!.id, weight: 0.3, explanation: "低置信度测试" }];
    run.conclusions[0]!.sourceIds = run.conclusions[0]!.sourceIds.filter((id) => id !== run.sources.at(-1)!.id);
  });
  rejected("conclusion to unknown revision", (run) => { run.conclusions[0]!.currentRevisionId = "missing-revision"; });
  rejected("insufficient conclusion without gap", (run) => {
    run.conclusions[0]!.normalizedEvidenceStatus = "INSUFFICIENT_EVIDENCE";
    run.conclusions[0]!.evidenceGapIds = [];
  });
  rejected("insufficient conclusion cannot be confirmed", (run) => {
    const conclusion = run.conclusions.find((item) => item.evidenceGapIds.length > 0)!;
    conclusion.normalizedEvidenceStatus = "INSUFFICIENT_EVIDENCE";
    conclusion.normalizedReviewStatus = "HUMAN_CONFIRMED";
    conclusion.type = "HUMAN_CONFIRMED";
    conclusion.confirmedAt = new Date().toISOString();
    conclusion.confirmedText = conclusion.text;
  });
  rejected("confirmed conclusion missing confirmation metadata", (run) => {
    const conclusion = run.conclusions[0]!;
    conclusion.normalizedReviewStatus = "HUMAN_CONFIRMED";
    conclusion.type = "AI_JUDGMENT";
    conclusion.confirmedAt = null;
    conclusion.confirmedText = null;
  });
  rejected("revision to unknown conclusion", (run) => { run.candidateRevisions[0]!.conclusionId = "missing-conclusion"; });
  rejected("revision to unknown parent", (run) => { run.candidateRevisions[0]!.parentRevisionId = "missing-parent"; });
  rejected("conclusion without one current revision", (run) => {
    for (const revision of run.candidateRevisions.filter((item) => item.conclusionId === run.conclusions[0]!.id)) revision.isCurrent = false;
  });

  const decided = applyHumanDecision(valid, { conclusionId: "conclusion-causality-gap", action: "REJECT" });
  assert.equal(researchRunSchema.safeParse(decided).success, true);
  rejected("decision to unknown conclusion", (run) => { run.humanDecisions[0]!.conclusionId = "missing-conclusion"; }, decided);
  rejected("decision to unknown revision", (run) => { run.humanDecisions[0]!.candidateRevisionId = "missing-revision"; }, decided);
  rejected("artifact version to unknown artifact", (run) => { run.artifactVersions[0]!.artifactIds = ["missing-artifact"]; });
  rejected("artifact chain without one current version", (run) => { run.artifactVersions[0]!.status = "SUPERSEDED"; });

  const preDelivery = structuredClone(valid);
  preDelivery.artifacts = [];
  preDelivery.artifactHistory = [];
  preDelivery.artifactVersions = [];
  assert.equal(researchRunSchema.safeParse(preDelivery).success, true, "empty pre-delivery artifact chain is structurally valid");
});
