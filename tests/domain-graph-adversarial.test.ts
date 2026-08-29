import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyHumanDecision, computeResearchSnapshotId, researchRunSchema, runGoldenCase, type ResearchRun } from "../src/index.js";
import { writeArtifactVersion } from "../src/artifacts.js";

test("schema lock rejects every forged cross-object edge and current-version invariant", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-graph-matrix-"));
  const valid = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  assert.equal(researchRunSchema.safeParse(valid).success, true);
  const legacyWithoutDiscounts = structuredClone(valid);
  delete legacyWithoutDiscounts.conclusions[0]!.confidenceDiscounts;
  const explicitEmptyDiscounts = structuredClone(valid);
  explicitEmptyDiscounts.conclusions[0]!.confidenceDiscounts = [];
  assert.equal(
    computeResearchSnapshotId(legacyWithoutDiscounts),
    computeResearchSnapshotId(explicitEmptyDiscounts),
    "a legacy omitted confidence-discount list hashes like an explicit empty list",
  );

  const rejected = (label: string, mutate: (run: ResearchRun) => void, base: ResearchRun = valid) => {
    const forged = structuredClone(base);
    mutate(forged);
    assert.equal(researchRunSchema.safeParse(forged).success, false, label);
  };

  rejected("duplicate collection id", (run) => { run.sources[1]!.id = run.sources[0]!.id; });
  rejected("cached synthesis cannot claim live mode", (run) => { run.offlineMode = false; });
  rejected("cached synthesis cannot carry the live label", (run) => { run.offlineModeLabel = "在线模型生成 · 信源使用缓存快照"; });
  rejected("synthesis snapshot cannot be rewritten after outputId is committed", (run) => { run.synthesisOutput.synthesis.claims[0]!.text = "forged after hash"; });
  rejected("synthesis snapshot mode must match the run", (run) => { run.synthesisOutput.synthesisMode = "LIVE_SINGLE_ENDPOINT"; });
  rejected("research snapshot must match the current graph", (run) => { run.researchSnapshotId = "0".repeat(64); });
  rejected("insufficient claim requires a gap", (run) => { const claim = run.claims.find((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE")!; claim.evidenceGapId = null; });
  rejected("run cannot omit the synthesis state", (run) => { run.steps[2]!.state = "PLAN"; });
  rejected("step cannot consume a forged predecessor output", (run) => { run.steps[1]!.consumedOutputIds = ["forged-output"]; });
  rejected("successful step requires a SHA-256 output", (run) => { run.steps[1]!.outputId = ""; });
  rejected("step cannot consume extra outputs", (run) => { run.steps[1]!.consumedOutputIds.push(run.steps[0]!.outputId); });
  rejected("PLAN cannot consume an output", (run) => { run.steps[0]!.consumedOutputIds = ["forged-output"]; });
  rejected("non-failed terminal run requires all steps to succeed", (run) => { run.steps[4]!.status = "pending"; run.steps[4]!.consumedOutputIds = []; });
  rejected("pending step cannot claim an input", (run) => { run.terminalStatus = "FAILED"; run.steps[4]!.status = "pending"; });
  rejected("started step requires a successful predecessor", (run) => { run.terminalStatus = "FAILED"; run.steps[1]!.status = "pending"; run.steps[1]!.consumedOutputIds = []; run.steps[2]!.status = "failed"; });
  rejected("raw confirmation cannot disagree with normalized review", (run) => { run.conclusions[0]!.reviewStatus = "CONFIRMED"; });
  rejected("raw rejection cannot disagree with normalized review", (run) => { run.conclusions[0]!.reviewStatus = "REJECTED"; });
  rejected("normalized confirmation cannot hide behind pending raw review", (run) => {
    const conclusion = run.conclusions[0]!;
    conclusion.normalizedReviewStatus = "HUMAN_CONFIRMED";
    conclusion.type = "HUMAN_CONFIRMED";
    conclusion.confirmedAt = new Date().toISOString();
    conclusion.confirmedText = conclusion.text;
  });
  rejected("raw conflict cannot be normalized as supported", (run) => { run.conclusions[0]!.normalizedEvidenceStatus = "SUPPORTED"; });
  rejected("raw supported evidence cannot be normalized as conflict", (run) => { run.conclusions[1]!.normalizedEvidenceStatus = "CONFLICT"; });
  rejected("STALE evidence requires STALE freshness", (run) => { run.conclusions[1]!.evidenceStatus = "STALE"; });
  rejected("STALE freshness requires STALE evidence", (run) => { run.conclusions[1]!.freshness = "STALE"; });
  rejected("claim STALE evidence requires STALE freshness", (run) => { run.claims[1]!.evidenceStatus = "STALE"; });
  rejected("claim STALE freshness requires STALE evidence", (run) => { run.claims[1]!.freshness = "STALE"; });
  rejected("source to unknown version", (run) => { run.sources[0]!.sourceVersionId = "missing-version"; });
  rejected("version to unknown source", (run) => { run.sourceVersions[0]!.sourceId = "missing-source"; });
  const unknownUpstream = structuredClone(valid);
  unknownUpstream.sourceVersions[0]!.upstreamSourceIds = ["missing-source"];
  unknownUpstream.researchSnapshotId = computeResearchSnapshotId(unknownUpstream);
  unknownUpstream.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = unknownUpstream.researchSnapshotId;
  const unknownUpstreamResult = researchRunSchema.safeParse(unknownUpstream);
  assert.equal(unknownUpstreamResult.success, false, "source-version provenance cannot point to an unknown upstream source");
  if (!unknownUpstreamResult.success) assert.match(JSON.stringify(unknownUpstreamResult.error.issues), /upstream source/iu);
  const crossOwnedSourceVersion = structuredClone(valid);
  crossOwnedSourceVersion.sources[0]!.sourceVersionId = crossOwnedSourceVersion.sources[1]!.sourceVersionId;
  const crossOwnedSourceVersionResult = researchRunSchema.safeParse(crossOwnedSourceVersion);
  assert.equal(crossOwnedSourceVersionResult.success, false, "a source must point to its own current SourceVersion");
  if (!crossOwnedSourceVersionResult.success) assert.match(JSON.stringify(crossOwnedSourceVersionResult.error.issues), /own current SourceVersion/iu);
  const mismatchedSourceVersion = structuredClone(valid);
  const mismatchedSource = mismatchedSourceVersion.sources[0]!;
  mismatchedSourceVersion.sourceVersions.find((item) => item.id === mismatchedSource.sourceVersionId)!.version = "v2";
  mismatchedSourceVersion.researchSnapshotId = computeResearchSnapshotId(mismatchedSourceVersion);
  mismatchedSourceVersion.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = mismatchedSourceVersion.researchSnapshotId;
  const mismatchedSourceVersionResult = researchRunSchema.safeParse(mismatchedSourceVersion);
  assert.equal(mismatchedSourceVersionResult.success, false, "a source label must match its current SourceVersion label");
  if (!mismatchedSourceVersionResult.success) assert.match(JSON.stringify(mismatchedSourceVersionResult.error.issues), /version label/iu);
  const mismatchedSourceCapture = structuredClone(valid);
  mismatchedSourceCapture.sources[0]!.capturedAt = "different-capture-time";
  mismatchedSourceCapture.researchSnapshotId = computeResearchSnapshotId(mismatchedSourceCapture);
  mismatchedSourceCapture.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = mismatchedSourceCapture.researchSnapshotId;
  const mismatchedSourceCaptureResult = researchRunSchema.safeParse(mismatchedSourceCapture);
  assert.equal(mismatchedSourceCaptureResult.success, false, "a source capture time must match its current SourceVersion");
  if (!mismatchedSourceCaptureResult.success) assert.match(JSON.stringify(mismatchedSourceCaptureResult.error.issues), /capture time/iu);
  const mismatchedSourceLocator = structuredClone(valid);
  const mismatchedLocatorSource = mismatchedSourceLocator.sources.find((item) => item.locator.fileName === "market_v1.csv")!;
  mismatchedLocatorSource.locator = { ...mismatchedLocatorSource.locator, fileName: "different.csv" };
  mismatchedSourceLocator.researchSnapshotId = computeResearchSnapshotId(mismatchedSourceLocator);
  mismatchedSourceLocator.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = mismatchedSourceLocator.researchSnapshotId;
  const mismatchedSourceLocatorResult = researchRunSchema.safeParse(mismatchedSourceLocator);
  assert.equal(mismatchedSourceLocatorResult.success, false, "a source locator must match its current SourceVersion");
  if (!mismatchedSourceLocatorResult.success) assert.match(JSON.stringify(mismatchedSourceLocatorResult.error.issues), /locator/iu);
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
  const crossOwnedRevision = structuredClone(valid);
  crossOwnedRevision.conclusions[0]!.currentRevisionId = crossOwnedRevision.conclusions[1]!.currentRevisionId;
  crossOwnedRevision.researchSnapshotId = computeResearchSnapshotId(crossOwnedRevision);
  crossOwnedRevision.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = crossOwnedRevision.researchSnapshotId;
  const crossOwnedRevisionResult = researchRunSchema.safeParse(crossOwnedRevision);
  assert.equal(crossOwnedRevisionResult.success, false, "a conclusion must point to its own current CandidateRevision");
  if (!crossOwnedRevisionResult.success) assert.match(JSON.stringify(crossOwnedRevisionResult.error.issues), /own current CandidateRevision/iu);
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
  rejected("revision parent from another conclusion", (run) => {
    run.candidateRevisions[0]!.parentRevisionId = run.candidateRevisions.find((item) => item.conclusionId !== run.candidateRevisions[0]!.conclusionId)!.id;
  });
  const cyclicRevisionChain = structuredClone(valid);
  cyclicRevisionChain.candidateRevisions[0]!.parentRevisionId = cyclicRevisionChain.candidateRevisions[0]!.id;
  cyclicRevisionChain.researchSnapshotId = computeResearchSnapshotId(cyclicRevisionChain);
  cyclicRevisionChain.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = cyclicRevisionChain.researchSnapshotId;
  const cyclicRevisionChainResult = researchRunSchema.safeParse(cyclicRevisionChain);
  assert.equal(cyclicRevisionChainResult.success, false, "a revision ancestry chain cannot contain a cycle");
  if (!cyclicRevisionChainResult.success) assert.match(JSON.stringify(cyclicRevisionChainResult.error.issues), /cycle/iu);
  rejected("conclusion without one current revision", (run) => {
    for (const revision of run.candidateRevisions.filter((item) => item.conclusionId === run.conclusions[0]!.id)) revision.isCurrent = false;
  });

  const decided = applyHumanDecision(valid, { conclusionId: "conclusion-causality-gap", action: "REJECT" });
  assert.equal(researchRunSchema.safeParse(decided).success, true);
  rejected("decision to unknown conclusion", (run) => { run.humanDecisions[0]!.conclusionId = "missing-conclusion"; }, decided);
  rejected("decision to unknown revision", (run) => { run.humanDecisions[0]!.candidateRevisionId = "missing-revision"; }, decided);
  rejected("artifact version to unknown artifact", (run) => { run.artifactVersions[0]!.artifactIds = ["missing-artifact"]; });
  rejected("artifact chain without one current version", (run) => { run.artifactVersions[0]!.status = "SUPERSEDED"; });
  rejected("first artifact version cannot supersede an unknown version", (run) => { run.artifactVersions[0]!.supersedesId = "missing-version"; });
  rejected("artifact version cannot supersede itself", (run) => { run.artifactVersions[0]!.supersedesId = run.artifactVersions[0]!.id; });
  rejected("artifact eviction count cannot forge missing history", (run) => { run.evictedArtifactVersionCount = 2; });
  rejected("artifact version cannot rewrite rejected-draft overflow trace", (run) => {
    run.artifactVersions[0]!.rejectedDraftOverflowCount += 1;
  });

  const twoVersion = structuredClone(valid);
  await writeArtifactVersion(twoVersion, workspaceDir, "HUMAN_DECISION", {
    triggerRef: "schema-chain-test",
    adjustmentNote: "create a second immutable artifact version",
  });
  assert.equal(researchRunSchema.safeParse(twoVersion).success, true);
  rejected("artifact versions must stay in ascending order", (run) => { run.artifactVersions.reverse(); }, twoVersion);
  rejected("artifact version must point to its immediate predecessor", (run) => {
    run.artifactVersions[1]!.supersedesId = run.artifactVersions[1]!.id;
  }, twoVersion);

  const retainedAfterEviction = structuredClone(twoVersion);
  retainedAfterEviction.artifactVersions = retainedAfterEviction.artifactVersions.slice(1);
  retainedAfterEviction.artifactHistory = retainedAfterEviction.artifactHistory.filter((artifact) => artifact.version !== 1);
  retainedAfterEviction.evictedArtifactVersionCount = 1;
  assert.equal(researchRunSchema.safeParse(retainedAfterEviction).success, true, "a retained chain preserves the evicted predecessor reference");
  rejected("oldest retained artifact version cannot erase its evicted predecessor", (run) => {
    run.artifactVersions[0]!.supersedesId = null;
  }, retainedAfterEviction);

  const preDelivery = structuredClone(valid);
  preDelivery.artifacts = [];
  preDelivery.artifactHistory = [];
  preDelivery.artifactVersions = [];
  assert.equal(researchRunSchema.safeParse(preDelivery).success, true, "empty pre-delivery artifact chain is structurally valid");
});
