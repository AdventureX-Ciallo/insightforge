import type { ResearchRun } from "../../src/domain.js";
import { applyHumanDecision, HumanDecisionConflictError } from "../../src/human-decision.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

export async function runHumanDecisionFuzz(rng: SeededPrng, cases: number, baseline: ResearchRun) {
  const conclusionId = baseline.conclusions[0]!.id;
  for (let index = 0; index < cases; index += 1) {
    const finalRun = applyHumanDecision(baseline, { conclusionId, action: "REJECT" });
    const beforeReplay = JSON.stringify(finalRun);
    const replayAction = rng.pick(["CONFIRM", "REJECT"] as const);
    let replayError: unknown;
    try {
      applyHumanDecision(finalRun, { conclusionId, action: replayAction });
    } catch (error) {
      replayError = error;
    }
    invariant(replayError instanceof HumanDecisionConflictError, `case=${index}: REJECT->${replayAction} escaped the final-decision guard`);
    invariant(JSON.stringify(finalRun) === beforeReplay, `case=${index}: rejected replay mutated the final run`);

    const reopened = applyHumanDecision(finalRun, {
      conclusionId,
      action: "EDIT",
      text: `人工重新审阅 ${rng.token(24)}`,
      reason: `fuzz-${index}`,
    });
    invariant(reopened.conclusions.find((item) => item.id === conclusionId)?.normalizedReviewStatus === "PENDING_REVIEW", `case=${index}: EDIT did not reopen review`);
    const reconsidered = applyHumanDecision(reopened, { conclusionId, action: "REJECT" });
    invariant(reconsidered.humanDecisions.length === finalRun.humanDecisions.length + 2, `case=${index}: reopened decision ledger count is wrong`);
  }
  return { cases, value: undefined };
}
