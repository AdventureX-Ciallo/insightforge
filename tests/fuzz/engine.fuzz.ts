import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { terminalStatuses, workflowStates, type ResearchRun, type RunStep, type WorkflowState } from "../../src/domain.js";
import { runGoldenCase } from "../../src/engine.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

const GOLDEN = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";
const QUESTION_PARTS = ["制造业 AI 采购", "光伏供应链", "新能源车充电", "机器人出口", "工业软件替代"] as const;

function assertConsumptionChain(steps: RunStep[]) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (index === 0) {
      invariant(step.consumedOutputIds.length === 0, "PLAN must consume no prior output");
      continue;
    }
    if (step.status === "pending") continue;
    invariant(step.consumedOutputIds.length === 1, `${step.state} must consume exactly one prior output`);
    invariant(step.consumedOutputIds[0] === steps[index - 1]!.outputId, `${step.state} consumption chain is broken`);
  }
}

export async function runEngineFuzz(rng: SeededPrng, cases: number) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-fuzz-engine-"));
  let baseline: ResearchRun | undefined;
  const scheduledFailures: Array<WorkflowState | undefined> = [undefined, ...workflowStates];
  for (let index = 0; index < cases; index += 1) {
    const failAt = index < scheduledFailures.length ? scheduledFailures[index] : rng.pick(scheduledFailures);
    const question = index === 0 || rng.int(5) === 0
      ? GOLDEN
      : `请研究${rng.pick(QUESTION_PARTS)}的${rng.token(12)}证据边界与风险？`;
    const sourceVersion = rng.bool() ? "v1" as const : "v2" as const;
    let observed: RunStep[] = [];
    try {
      const run = await runGoldenCase({
        researchQuestion: question,
        fixtureDir: resolve("fixtures/golden"),
        workspaceDir,
        runId: `fuzz-engine-${index}-${rng.token(8)}`,
        sourceVersion,
        ...(failAt === undefined ? {} : { failAt }),
        llmMode: "off",
        stepDelayMs: 0,
        onProgress: (steps) => { observed = steps; },
      });
      invariant(failAt === undefined, `case=${index}: injected ${failAt} failure did not propagate`);
      invariant(terminalStatuses.includes(run.terminalStatus), `case=${index}: terminal status escaped the three-state contract`);
      invariant(run.steps.every((step) => step.status === "success"), `case=${index}: successful run contains a non-success step`);
      assertConsumptionChain(run.steps);
      baseline ??= run;
    } catch (error) {
      invariant(failAt !== undefined, `case=${index}: non-injected run failed: ${String(error)}`);
      invariant(String(error).includes(`Injected ${failAt} failure`), `case=${index}: failure did not preserve its injected cause`);
      const failedIndex = workflowStates.indexOf(failAt);
      invariant(observed[failedIndex]?.status === "failed", `case=${index}: failed node was not published as failed`);
      invariant(observed.slice(failedIndex + 1).every((step) => step.status === "pending"), `case=${index}: downstream node advanced after failure`);
      assertConsumptionChain(observed);
    }
  }
  invariant(baseline, "engine fuzz did not produce a valid ResearchRun baseline");
  return { cases, value: baseline };
}
