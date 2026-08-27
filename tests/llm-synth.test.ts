import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runGoldenCase } from "../src/engine.js";
import { resolveLlmConfig, validateLlmDrafts, type LlmDraft } from "../src/llm.js";

test("llm config resolves only with all explicit single-endpoint fields", () => {
  assert.equal(resolveLlmConfig({}), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "" }), null);
  assert.equal(resolveLlmConfig({ DEEPSEEK_API_KEY: "not-used" }), null);
  assert.equal(resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "sk-x" }), null);

  const explicit = resolveLlmConfig({ INSIGHTFORGE_LLM_API_KEY: "sk-x", INSIGHTFORGE_LLM_BASE_URL: "https://api.example.test/v1", INSIGHTFORGE_LLM_MODEL: "m1" });
  assert.deepEqual(explicit, { baseUrl: "https://api.example.test/v1", model: "m1", apiKey: "sk-x" });
});

test("program validation drops drafts with unknown evidence references", () => {
  const drafts: LlmDraft[] = [
    { text: "引用真实证据的判断。", evidenceIds: ["evidence-market-csv", "evidence-fake"], assumptions: [], missingEvidence: [] },
    { text: "只引用真实证据的判断。", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] },
    { text: "全部引用都是编造的。", evidenceIds: ["evidence-hallucinated"], assumptions: [], missingEvidence: [] },
    { text: "短", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] },
    { text: "", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] },
  ];
  const valid = validateLlmDrafts(drafts, ["evidence-market-csv", "evidence-pdf-page-1"]);
  assert.equal(valid.length, 1);
  // 任意未知引用都会让整条草稿失败；不做模糊修复或部分放行。
  assert.deepEqual(valid[0]?.evidenceIds, ["evidence-market-csv"]);
  assert.equal(valid[0]?.text, "只引用真实证据的判断。");
});

test("llm drafts never exceed five conclusions after validation", () => {
  const drafts: LlmDraft[] = Array.from({ length: 8 }, (_, index) => ({
    text: `候选判断 ${index + 1}，引用真实证据。`,
    evidenceIds: ["evidence-market-csv"],
    assumptions: [],
    missingEvidence: [],
  }));
  assert.equal(validateLlmDrafts(drafts, ["evidence-market-csv"]).length, 5);
});

test("explicit LLM mode fails closed when configuration is absent instead of falling back", async () => {
  const keys = ["INSIGHTFORGE_LLM_API_KEY", "INSIGHTFORGE_LLM_BASE_URL", "INSIGHTFORGE_LLM_MODEL"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => { delete process.env[key]; });
  try {
    await assert.rejects(
      runGoldenCase({
        researchQuestion: "验证显式模型模式失败时不会自动降级",
        fixtureDir: resolve("fixtures/golden"),
        workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-llm-failclosed-")),
        llmMode: "auto",
      }),
      /requires explicit API key, base URL, and model/i,
    );
  } finally {
    keys.forEach((key) => {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
});
