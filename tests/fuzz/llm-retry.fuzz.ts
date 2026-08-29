import {
  draftConclusions,
  draftPlanSteps,
  type LlmConfig,
  type LlmSynthesisContext,
} from "../../src/llm.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

type Stage = "PLAN" | "SYNTHESIZE";
type Outcome = "success" | "400" | "429" | "500" | "network" | "non-error"
  | "outer-json" | "missing-choice" | "empty" | "whitespace" | "malformed"
  | "length" | "missing-array" | "null-json";

const OUTCOMES: readonly Outcome[] = [
  "success", "400", "429", "500", "network", "non-error", "outer-json",
  "missing-choice", "empty", "whitespace", "malformed", "length",
  "missing-array", "null-json",
];

function responseFor(outcome: Outcome, stage: Stage, responseCanary: string): Response {
  if (outcome === "network") throw new Error("seeded network reset");
  if (outcome === "non-error") throw "seeded non-Error reset";
  if (outcome === "400" || outcome === "429" || outcome === "500") {
    return new Response("{}", { status: Number(outcome), headers: { "content-type": "application/json" } });
  }
  if (outcome === "outer-json") {
    return new Response(responseCanary, { headers: { "content-type": "application/json" } });
  }
  if (outcome === "missing-choice") return jsonResponse({ choices: [] });
  if (outcome === "empty") return jsonResponse({ choices: [{ message: { content: "" } }] });
  if (outcome === "whitespace") return jsonResponse({ choices: [{ message: { content: " \t\n\u00a0\u2003\u200b" } }] });
  if (outcome === "malformed") return jsonResponse({ choices: [{ message: { content: `{"${responseCanary}":[` } }] });
  if (outcome === "missing-array") return jsonResponse({ choices: [{ message: { content: "{}" } }] });
  if (outcome === "null-json") return jsonResponse({ choices: [{ message: { content: "null" } }] });

  const content = stage === "PLAN"
    ? JSON.stringify({ steps: [{ objective: "随机测试中的完整研究步骤", toolName: "snapshot-search", expectedOutput: "候选信源" }] })
    : JSON.stringify({ conclusions: [{ text: "随机测试中的完整候选判断", evidenceIds: ["e1"], assumptions: [], missingEvidence: [] }] });
  return jsonResponse({ choices: [{ finish_reason: outcome === "length" ? "length" : "stop", message: { content } }] });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function shouldSucceed(first: Outcome, second: Outcome) {
  return first === "success" || (first !== "400" && second === "success");
}

function expectedCalls(first: Outcome) {
  return first === "success" || first === "400" ? 1 : 2;
}

function expectedErrorFragment(stage: Stage, outcome: Outcome) {
  if (outcome === "400" || outcome === "429" || outcome === "500") return `returned ${outcome}`;
  if (outcome === "network") return "transport request failed";
  if (outcome === "non-error") return "non-Error rejection";
  if (outcome === "outer-json") return "invalid JSON response envelope";
  if (outcome === "missing-choice" || outcome === "empty") return "no message content";
  if (outcome === "whitespace" || outcome === "malformed") return "message content is not valid JSON";
  if (outcome === "length") return "response was truncated";
  if (outcome === "missing-array" || outcome === "null-json") return stage === "PLAN" ? "missing the steps array" : "missing the conclusions array";
  throw new Error(`No failure category for ${outcome}`);
}

export async function runLlmRetryFuzz(rng: SeededPrng, cases: number) {
  const originalFetch = globalThis.fetch;
  try {
    for (let index = 0; index < cases; index += 1) {
      const stage = rng.pick<Stage>(["PLAN", "SYNTHESIZE"]);
      const first = rng.pick(OUTCOMES);
      const second = rng.pick(OUTCOMES);
      const responseCanary = `untrusted-${rng.token(32)}`;
      const originalBaseUrl = `https://${rng.token(12)}.example.test/v1`;
      const originalApiKey = `fuzz-key-${rng.token(24)}`;
      const config: LlmConfig = { baseUrl: originalBaseUrl, model: `model-${rng.token(12)}`, apiKey: originalApiKey };
      const observations: Array<{ url: string; authorization: string | null; body: string }> = [];

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        observations.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        });
        const outcome = observations.length === 1 ? first : second;
        if (observations.length === 1) {
          config.baseUrl = "https://mutated.example.test/v1";
          config.apiKey = "mutated-key";
          config.model = "mutated-model";
        }
        return responseFor(outcome, stage, `${responseCanary}:${originalApiKey}`);
      }) as typeof fetch;

      let succeeded = false;
      let errorText = "";
      try {
        if (stage === "PLAN") {
          await draftPlanSteps(config, { question: `随机研究问题-${rng.token(100)}`, availableInputs: [rng.token(100)] }, 100, 0);
        } else {
          await draftConclusions(config, {
            question: `随机研究问题-${rng.token(100)}`,
            sources: [],
            evidence: [{ id: "e1", type: "FACT", excerpt: "随机证据", locator: {} }],
            data: [],
          } as unknown as LlmSynthesisContext, 100, 0);
        }
        succeeded = true;
      } catch (error) {
        errorText = error instanceof Error ? error.message : String(error);
      }

      const expectedCount = expectedCalls(first);
      invariant(observations.length === expectedCount, `case=${index} stage=${stage} sequence=${first}->${second}: calls=${observations.length}, expected=${expectedCount}`);
      invariant(observations.length <= 2, `case=${index}: retry amplification exceeded two attempts`);
      invariant(succeeded === shouldSucceed(first, second), `case=${index} stage=${stage} sequence=${first}->${second}: success=${succeeded}`);
      const expectedUrl = `${originalBaseUrl}/chat/completions`;
      for (const observation of observations) {
        invariant(observation.url === expectedUrl, `case=${index}: endpoint changed during retry`);
        invariant(observation.authorization === `Bearer ${originalApiKey}`, `case=${index}: authorization changed during retry`);
        invariant(observation.body === observations[0]!.body, `case=${index}: serialized request changed during retry`);
      }
      if (!succeeded) {
        const finalOutcome = first === "400" ? first : second;
        invariant(errorText.includes(expectedErrorFragment(stage, finalOutcome)), `case=${index} stage=${stage} sequence=${first}->${second}: wrong final error category=${errorText}`);
        invariant(!errorText.includes(responseCanary), `case=${index}: untrusted response text leaked into error`);
        invariant(!errorText.includes(originalApiKey), `case=${index}: API key leaked into error`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { cases, value: undefined };
}
