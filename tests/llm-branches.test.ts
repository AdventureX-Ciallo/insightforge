import assert from "node:assert/strict";
import test from "node:test";

import { draftConclusions, draftPlanSteps, resolveLlmConfig } from "../src/llm.js";

const config = { baseUrl: "https://model.example.test/v1", model: "test-model", apiKey: "test-secret" };
const planContext = { question: "一个足够长的研究问题", availableInputs: ["本地 PDF", "结构化 CSV"] };
const synthesisContext = {
  question: "一个足够长的研究问题",
  sources: [
    { id: "s1", title: "Source 1", publisher: "P1" },
    { id: "s2", title: "Source 2", publisher: "P2" },
  ],
  evidence: [
    { id: "e1", type: "FACT", locator: { url: "https://example.test/e1" }, excerpt: "url evidence" },
    { id: "e2", type: "FACT", locator: { fileName: "brief.pdf", page: 2, rows: [3, 4] }, excerpt: "file evidence" },
    { id: "e3", type: "FACT", locator: {}, excerpt: "unlocated evidence" },
  ],
  data: [
    { id: "d1", metric: "rate", value: 1, unit: "%", period: "2026", type: "RATIO", formula: "a/b" },
    { id: "d2", metric: "count", value: 2, unit: "items", period: "2026", type: "COUNT" },
  ],
} as never;

async function withFetch(fetcher: typeof fetch, action: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await action(); } finally { globalThis.fetch = original; }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("LLM config resolution rejects partial, malformed, HTTP, and credentialed endpoints", () => {
  assert.equal(resolveLlmConfig({}), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: " k ", INSIGHTFORGE_LLM_BASE_URL: "bad", INSIGHTFORGE_LLM_MODEL: " m " }), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "k", INSIGHTFORGE_LLM_BASE_URL: "http://model.test", INSIGHTFORGE_LLM_MODEL: "m" }), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "k", INSIGHTFORGE_LLM_BASE_URL: "https://user@model.test", INSIGHTFORGE_LLM_MODEL: "m" }), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "k", INSIGHTFORGE_LLM_BASE_URL: "https://:pass@model.test", INSIGHTFORGE_LLM_MODEL: "m" }), null);
  assert.deepEqual(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: " k ", INSIGHTFORGE_LLM_BASE_URL: " https://model.test/v1 ", INSIGHTFORGE_LLM_MODEL: " m " }), { apiKey: "k", baseUrl: "https://model.test/v1", model: "m" });
});

test("LLM transport does not retry 4xx and retries 429, 5xx, network, and non-Error failures exactly once", async () => {
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls += 1; return jsonResponse({}, 400); }, () => draftPlanSteps(config, planContext, 100, 0)), /returned 400/u);
  assert.equal(calls, 1);

  for (const first of [429, 500]) {
    calls = 0;
    const steps = await withFetch(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({}, first)
        : jsonResponse({ choices: [{ message: { content: JSON.stringify({ steps: [{ objective: "long enough objective", toolName: "snapshot-search", expectedOutput: "ok" }] }) } }] });
    }, () => draftPlanSteps(config, planContext, 100, 0));
    assert.equal(steps.length, 1);
    assert.equal(calls, 2);
  }

  calls = 0;
  await assert.rejects(withFetch(async () => { calls += 1; throw new Error("network reset"); }, () => draftPlanSteps(config, planContext, 100, 0)), /network reset/u);
  assert.equal(calls, 2);

  await assert.rejects(withFetch(async () => { throw "reset"; }, () => draftPlanSteps(config, planContext, 100, 0)), /failed after transport retry/u);
});

test("LLM response validation rejects empty/missing arrays and normalizes hostile draft field types", async () => {
  await assert.rejects(withFetch(async () => jsonResponse({ choices: [] }), () => draftConclusions(config, synthesisContext, 100, 0)), /no message content/u);
  await assert.rejects(withFetch(async () => jsonResponse({ choices: [{ message: { content: "{}" } }] }), () => draftConclusions(config, synthesisContext, 100, 0)), /missing the conclusions array/u);
  const rawDrafts = [{ text: "  valid conclusion text  ", evidenceIds: ["e1", 7], assumptions: ["a", 7], missingEvidence: ["gap", 7] }, { text: 7, evidenceIds: 7, assumptions: null, missingEvidence: {} }];
  let posted = "";
  const drafts = await withFetch(async (_input, init) => {
    posted = String(init?.body);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ conclusions: rawDrafts }) } }] });
  }, () => draftConclusions(config, synthesisContext, 100, 0));
  assert.deepEqual(drafts, [
    { text: "valid conclusion text", evidenceIds: ["e1"], assumptions: ["a"], missingEvidence: ["gap"] },
    { text: "", evidenceIds: [], assumptions: [], missingEvidence: [] },
  ]);
  assert.match(posted, /brief\.pdf p\.2 rows 3,4/u);
  assert.match(posted, /公式 a\/b/u);

  await assert.rejects(withFetch(async () => jsonResponse({ choices: [] }), () => draftPlanSteps(config, planContext, 100, 0)), /no message content/u);
  await assert.rejects(withFetch(async () => jsonResponse({ choices: [{ message: { content: "{}" } }] }), () => draftPlanSteps(config, planContext, 100, 0)), /missing the steps array/u);
  const steps = await withFetch(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ steps: [{ objective: 7, toolName: null, expectedOutput: {} }, { objective: "  objective  ", toolName: " tool ", expectedOutput: " output " }] }) } }] }), () => draftPlanSteps(config, planContext, 100, 0));
  assert.deepEqual(steps, [
    { objective: "", toolName: "", expectedOutput: "" },
    { objective: "objective", toolName: "tool", expectedOutput: "output" },
  ]);
});
