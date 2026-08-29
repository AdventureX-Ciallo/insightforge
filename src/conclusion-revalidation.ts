import { randomUUID } from "node:crypto";

import { persistRun, writeArtifactVersion } from "./artifacts.js";
import { researchRunSchema, type Claim, type ResearchRun } from "./domain.js";
import { DomainError } from "./domain-error.js";
import { hashValue } from "./hash.js";

function restoredClaimStatus(run: ResearchRun, claim: Claim): Claim["evidenceStatus"] {
  if (claim.evidenceGapId) return "INSUFFICIENT_EVIDENCE";
  const datumIds = new Set(claim.datumIds);
  if (run.conflicts.some((conflict) => conflict.datumIds.some((id) => datumIds.has(id)))) return "CONFLICT";
  return "SUPPORTED";
}

export async function revalidateConclusionAndPersist(
  current: ResearchRun,
  conclusionId: string,
  workspaceDir: string,
): Promise<ResearchRun> {
  const run = structuredClone(researchRunSchema.parse(current));
  const conclusion = run.conclusions.find((item) => item.id === conclusionId);
  if (!conclusion) throw new DomainError(404, "CONCLUSION_NOT_FOUND", `Unknown conclusion ${conclusionId}`);
  if (conclusion.freshness !== "STALE" || conclusion.evidenceStatus !== "STALE") {
    throw new DomainError(409, "CONCLUSION_NOT_STALE", "仅 STALE 结论需要基于当前来源重新复核");
  }

  const claims = run.claims.filter((claim) => conclusion.claimIds.includes(claim.id));
  const evidence = run.evidence.filter((item) => claims.some((claim) => claim.evidenceIds.includes(item.id)));
  const data = run.data.filter((item) => claims.some((claim) => claim.datumIds.includes(item.id)));
  const sources = run.sources.filter((item) => conclusion.sourceIds.includes(item.id));
  if (claims.length === 0 || evidence.length === 0 || [...evidence, ...data, ...sources].some((item) => item.freshness !== "CURRENT")) {
    throw new DomainError(409, "REVALIDATION_BLOCKED", "当前来源或证据路径尚未更新完整，结论继续保持 STALE");
  }

  for (const claim of claims) {
    claim.freshness = "CURRENT";
    claim.evidenceStatus = restoredClaimStatus(run, claim);
    claim.text = claim.text.replace(/原候选判断已失效，需结合其既有证据重新审查。?$/u, "已基于 v2 证据路径完成复核，仍需人工最终判断。");
  }

  const now = new Date().toISOString();
  const previousRevision = run.candidateRevisions.find((item) => item.id === conclusion.currentRevisionId);
  if (previousRevision) previousRevision.isCurrent = false;
  const revisionId = `revision-revalidate-${randomUUID()}`;
  conclusion.freshness = "CURRENT";
  conclusion.evidenceStatus = conclusion.normalizedEvidenceStatus;
  conclusion.reviewStatus = "PENDING_REVIEW";
  conclusion.normalizedReviewStatus = "PENDING_REVIEW";
  conclusion.confirmedAt = null;
  conclusion.confirmedText = null;
  conclusion.type = "AI_JUDGMENT";
  conclusion.originType = "DETERMINISTIC";
  conclusion.text = conclusion.text.replace(/旧候选判断和人工确认均已失效，需结合原证据路径重新审查。?$/u, "已基于 v2 证据路径完成复核，当前为待人工确认候选。");
  conclusion.currentRevisionId = revisionId;
  run.candidateRevisions.push({
    id: revisionId,
    conclusionId,
    parentRevisionId: previousRevision?.id ?? null,
    authorType: "SYSTEM",
    originType: "DETERMINISTIC",
    text: conclusion.text,
    changeReason: "基于当前 v2 来源、证据和确定性计算重新复核；不自动确认",
    createdAt: now,
    auditStatus: "PENDING",
    auditFindingIds: [],
    sourceSnapshotId: hashValue(run.sourceVersions.filter((item) => item.isCurrent)),
    isCurrent: true,
  });
  run.updatedAt = now;
  run.terminalStatus = "NEEDS_REVIEW";
  run.affectedObjectIds = [...new Set([...run.affectedObjectIds, ...claims.map((item) => item.id), conclusionId, revisionId])];
  const triggerRef = `revalidation-${randomUUID()}`;
  await writeArtifactVersion(run, workspaceDir, "REVALIDATION", {
    triggerRef,
    adjustmentNote: `结论 ${conclusionId} 已基于 v2 证据路径复核，恢复为待人工判断`,
  });
  researchRunSchema.parse(run);
  await persistRun(run, workspaceDir);
  return run;
}
