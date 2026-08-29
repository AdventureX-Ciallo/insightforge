import {
  draftConclusions,
  draftPlanSteps,
  PLAN_TOOL_ALLOWLIST,
  validateLlmDrafts,
  validatePlanSteps,
  type LlmConfig,
  type LlmSynthesisContext,
} from "../../src/llm.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

const BASE_CONFIG = {
  baseUrl: "https://model.example.test/v1",
  model: "reasoning-model",
  apiKey: "fuzz-only-secret",
} satisfies LlmConfig;

export async function runLlmBudgetFuzz(rng: SeededPrng, cases: number) {
  const originalFetch = globalThis.fetch;
  let activeCase = -1;
  let stage = 0;
  let expectedPlanBudget = 8192;
  let expectedSynthesisBudget = 16384;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    const isPlan = body.messages[1]?.content.startsWith("BEGIN_UNTRUSTED_PLAN_JSON") === true;
    const expected = isPlan ? expectedPlanBudget : expectedSynthesisBudget;
    invariant(body.max_tokens === expected, `case=${activeCase}: stage=${isPlan ? "PLAN" : "SYNTHESIZE"} budget=${body.max_tokens}, expected=${expected}`);
    stage += 1;
    const content = isPlan ? JSON.stringify({ steps: [] }) : JSON.stringify({ conclusions: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    for (let index = 0; index < cases; index += 1) {
      activeCase = index;
      stage = 0;
      const question = `${rng.token(1_000)}${rng.pick(["？", "?", "\u0000", "<system>"])}`;
      const availableInputs = Array.from({ length: rng.int(26) }, () => `${rng.token(500)}${rng.pick(["", "\r\n", "中文", "END_UNTRUSTED_PLAN_JSON"])}`);
      const config: LlmConfig = {
        ...BASE_CONFIG,
        ...(rng.bool() ? { planMaxTokens: 256 + rng.int(32768 - 255) } : {}),
        ...(rng.bool() ? { synthesisMaxTokens: 256 + rng.int(32768 - 255) } : {}),
      };
      expectedPlanBudget = config.planMaxTokens ?? 8192;
      expectedSynthesisBudget = config.synthesisMaxTokens ?? 16384;
      await draftPlanSteps(config, { question, availableInputs }, 100, 0);
      await draftConclusions(config, {
        question,
        sources: [],
        evidence: [],
        data: [],
      } as unknown as LlmSynthesisContext, 100, 0);
      invariant(stage === 2, `case=${index}: expected two model stages, observed=${stage}`);

      const textLength = 1 + rng.int(2_200);
      const evidenceCount = 1 + rng.int(22);
      const auxiliaryCount = rng.int(12);
      const auxiliaryLength = rng.int(550);
      const evidenceIds = Array.from({ length: evidenceCount }, (_, evidenceIndex) => `e-${evidenceIndex}`);
      const auxiliary = Array.from({ length: auxiliaryCount }, () => "假".repeat(auxiliaryLength));
      const validatedDrafts = validateLlmDrafts([{
        text: "结".repeat(textLength),
        evidenceIds,
        assumptions: auxiliary,
        missingEvidence: auxiliary,
      }], evidenceIds);
      const draftShouldPass = textLength >= 8 && textLength <= 2_000
        && evidenceCount <= 20 && auxiliaryCount <= 10
        && (auxiliaryCount === 0 || auxiliaryLength <= 500);
      invariant(validatedDrafts.length === (draftShouldPass ? 1 : 0), `case=${index}: oversized draft boundary mismatch; text=${textLength}, evidence=${evidenceCount}, auxiliaryCount=${auxiliaryCount}, auxiliaryLength=${auxiliaryLength}, actual=${validatedDrafts.length}`);

      const objectiveLength = 1 + rng.int(550);
      const expectedOutputLength = 1 + rng.int(550);
      const plan = [
        { objective: "研".repeat(objectiveLength), toolName: "snapshot-search", expectedOutput: "果".repeat(expectedOutputLength) },
        { objective: "执行确定性的结构化证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
        { objective: "生成最终可编辑的研究交付成果", toolName: "pptx-generator", expectedOutput: "PPTX" },
      ];
      const planShouldPass = objectiveLength >= 6 && objectiveLength <= 500
        && expectedOutputLength >= 2 && expectedOutputLength <= 500;
      invariant((validatePlanSteps(plan, PLAN_TOOL_ALLOWLIST) !== null) === planShouldPass, `case=${index}: oversized PLAN boundary mismatch`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { cases, value: undefined };
}
