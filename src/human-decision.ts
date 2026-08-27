import { randomUUID } from "node:crypto";

import type { ResearchRun } from "./domain.js";

export type HumanDecisionInput =
  | { conclusionId: string; action: "CONFIRM" }
  | { conclusionId: string; action: "REJECT" }
  | { conclusionId: string; action: "EDIT"; text: string };

export function applyHumanDecision(current: ResearchRun, input: HumanDecisionInput): ResearchRun {
  const run = structuredClone(current);
  const conclusion = run.conclusions.find((candidate) => candidate.id === input.conclusionId);
  if (!conclusion) throw new Error(`Unknown conclusion ${input.conclusionId}`);
  if (input.action === "CONFIRM" && conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE") {
    throw new Error("INSUFFICIENT_EVIDENCE conclusions cannot be confirmed");
  }
  if (input.action === "CONFIRM" && conclusion.evidenceStatus === "STALE") {
    throw new Error("STALE conclusions cannot be confirmed before re-review");
  }

  const previousText = conclusion.text;
  const decidedAt = new Date().toISOString();
  if (input.action === "REJECT") {
    conclusion.reviewStatus = "REJECTED";
    conclusion.type = "AI_JUDGMENT";
    conclusion.confirmedAt = null;
    conclusion.confirmedText = null;
  } else if (input.action === "EDIT" && (conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE" || conclusion.evidenceStatus === "STALE")) {
    conclusion.text = input.text.trim();
    if (!conclusion.text) throw new Error("Edited conclusion cannot be empty");
    conclusion.reviewStatus = conclusion.evidenceStatus === "STALE" ? "NEEDS_REVIEW" : "PENDING_REVIEW";
    conclusion.type = "AI_JUDGMENT";
    conclusion.confirmedAt = null;
    conclusion.confirmedText = null;
  } else {
    if (input.action === "EDIT") conclusion.text = input.text.trim();
    if (!conclusion.text) throw new Error("Edited conclusion cannot be empty");
    conclusion.reviewStatus = "CONFIRMED";
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
  });
  run.updatedAt = decidedAt;
  run.terminalStatus = run.conclusions.every((item) => item.reviewStatus === "CONFIRMED" || item.reviewStatus === "REJECTED")
    ? "DELIVERED"
    : "NEEDS_REVIEW";
  return run;
}
