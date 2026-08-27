import { randomUUID } from "node:crypto";

import { persistRun, writeArtifactVersion } from "./artifacts.js";
import { researchRunSchema, type ResearchRun } from "./domain.js";

interface DecisionContext {
  reason?: string;
  scopeNote?: string;
}

export type HumanDecisionInput =
  | ({ conclusionId: string; action: "CONFIRM" } & DecisionContext)
  | ({ conclusionId: string; action: "REJECT" } & DecisionContext)
  | ({ conclusionId: string; action: "EDIT"; text: string } & DecisionContext);

function needsExplicitBoundary(run: ResearchRun, conclusionId: string) {
  const conclusion = run.conclusions.find((item) => item.id === conclusionId)!;
  const claims = run.claims.filter((claim) => conclusion.claimIds.includes(claim.id));
  return conclusion.normalizedEvidenceStatus === "CONFLICT"
    || claims.some((claim) => claim.knowledgeType === "ESTIMATE" || claim.knowledgeType === "FORECAST");
}

/**
 * EDIT 只创建 HUMAN_EDITED 候选修订，永不隐式确认。CONFIRM 是独立动作；
 * 冲突、估算和预测必须由人记录判断理由与适用范围。
 */
export function applyHumanDecision(current: ResearchRun, input: HumanDecisionInput): ResearchRun {
  const run = structuredClone(current);
  const conclusion = run.conclusions.find((candidate) => candidate.id === input.conclusionId);
  if (!conclusion) throw new Error(`Unknown conclusion ${input.conclusionId}`);
  if (input.action === "CONFIRM" && (conclusion.normalizedEvidenceStatus === "INSUFFICIENT_EVIDENCE" || conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE")) {
    throw new Error("INSUFFICIENT_EVIDENCE conclusions cannot be confirmed");
  }
  if (input.action === "CONFIRM" && (conclusion.freshness === "STALE" || conclusion.evidenceStatus === "STALE")) {
    throw new Error("STALE conclusions cannot be confirmed before re-review");
  }
  if (input.action === "CONFIRM" && needsExplicitBoundary(run, conclusion.id) && (!input.reason?.trim() || !input.scopeNote?.trim())) {
    throw new Error("Conflict, estimate, or forecast confirmation requires reason and scopeNote");
  }

  const previousText = conclusion.text;
  const decidedAt = new Date().toISOString();
  let decisionRevisionId = conclusion.currentRevisionId;

  if (input.action === "EDIT") {
    const text = input.text.trim();
    if (!text) throw new Error("Edited conclusion cannot be empty");
    const currentRevision = run.candidateRevisions.find((item) => item.id === conclusion.currentRevisionId);
    if (currentRevision) currentRevision.isCurrent = false;
    decisionRevisionId = `revision-human-${randomUUID()}`;
    run.candidateRevisions.push({
      id: decisionRevisionId,
      conclusionId: conclusion.id,
      parentRevisionId: conclusion.currentRevisionId,
      authorType: "HUMAN",
      originType: "HUMAN_EDITED",
      text,
      changeReason: input.reason?.trim() || "人工编辑候选文本；尚未确认",
      createdAt: decidedAt,
      auditStatus: "PENDING",
      auditFindingIds: [],
      sourceSnapshotId: run.researchSnapshotId,
      isCurrent: true,
    });
    conclusion.text = text;
    conclusion.currentRevisionId = decisionRevisionId;
    conclusion.originType = "HUMAN_EDITED";
    conclusion.reviewStatus = conclusion.freshness === "STALE" ? "NEEDS_REVIEW" : "PENDING_REVIEW";
    conclusion.normalizedReviewStatus = conclusion.freshness === "STALE" ? "NEEDS_REVIEW" : "PENDING_REVIEW";
    conclusion.type = "AI_JUDGMENT";
    conclusion.confirmedAt = null;
    conclusion.confirmedText = null;
  } else if (input.action === "REJECT") {
    conclusion.reviewStatus = "REJECTED";
    conclusion.normalizedReviewStatus = "HUMAN_REJECTED";
    conclusion.type = "AI_JUDGMENT";
    conclusion.confirmedAt = null;
    conclusion.confirmedText = null;
  } else {
    conclusion.reviewStatus = "CONFIRMED";
    conclusion.normalizedReviewStatus = "HUMAN_CONFIRMED";
    conclusion.type = "HUMAN_CONFIRMED";
    conclusion.confirmedAt = decidedAt;
    conclusion.confirmedText = conclusion.text;
  }

  run.humanDecisions.push({
    id: randomUUID(),
    conclusionId: conclusion.id,
    action: input.action,
    decidedAt,
    previousText,
    resultingText: conclusion.text,
    candidateRevisionId: decisionRevisionId,
    decisionReason: input.reason?.trim() || null,
    scopeNote: input.scopeNote?.trim() || null,
    invalidatedAt: null,
    invalidationReason: null,
    sourceUpdateId: null,
  });
  run.updatedAt = decidedAt;
  run.terminalStatus = run.conclusions.every((item) => item.normalizedReviewStatus === "HUMAN_CONFIRMED" || item.normalizedReviewStatus === "HUMAN_REJECTED") ? "DELIVERED" : "NEEDS_REVIEW";
  return run;
}

/** 产品服务入口：人工动作与新 ArtifactVersion 在同一请求中完成并持久化。 */
export async function applyHumanDecisionAndPersist(current: ResearchRun, input: HumanDecisionInput, workspaceDir: string): Promise<ResearchRun> {
  const run = applyHumanDecision(current, input);
  const decision = run.humanDecisions.at(-1)!;
  const adjustmentNote = input.action === "EDIT"
    ? `人工编辑：${decision.decisionReason ?? "更新候选结论文本，保留 AI 原文"}`
    : `人工${input.action === "CONFIRM" ? "确认" : "驳回"}：${decision.decisionReason ?? "用户完成显式裁决"}`;
  await writeArtifactVersion(run, workspaceDir, input.action === "EDIT" ? "HUMAN_EDIT" : "HUMAN_DECISION", {
    triggerRef: decision.id,
    adjustmentNote,
  });
  researchRunSchema.parse(run);
  await persistRun(run, workspaceDir);
  return run;
}
