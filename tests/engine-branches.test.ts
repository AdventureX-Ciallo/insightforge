import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase, type WorkflowState } from "../src/index.js";

const question = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";
const config = { baseUrl: "https://model.example.test/v1", model: "test", apiKey: "test-secret" };

async function workspace(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("every injected workflow failure remains terminally fail-closed and non-Error progress failures are preserved", async () => {
  for (const state of ["PLAN", "SYNTHESIZE", "AUDIT", "DELIVER"] as WorkflowState[]) {
    let observed = [] as Array<{ state: string; status: string; error: string | null }>;
    await assert.rejects(runGoldenCase({
      researchQuestion: question,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir: await workspace(`insightforge-fail-${state.toLowerCase()}-`),
      llmMode: "off",
      failAt: state,
      stepDelayMs: state === "PLAN" ? 1 : 0,
      onProgress: (steps) => { observed = steps; },
    }), new RegExp(`Injected ${state} failure`, "u"));
    assert.equal(observed.find((step) => step.state === state)?.status, "failed");
    assert.ok(observed.filter((step) => step.state !== state && step.status === "pending").length >= 0);
  }

  await assert.rejects(runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await workspace("insightforge-non-error-progress-"),
    llmMode: "off",
    onProgress: () => { throw "progress rejected"; },
  }), (error: unknown) => error === "progress rejected");
});

test("v2 source selection executes the final-input branch through DELIVER", async () => {
  const run = await runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await workspace("insightforge-v2-engine-"),
    sourceVersion: "v2",
    llmMode: "off",
  });
  assert.equal(run.sourceVersion, "v2");
  assert.match(run.sources.find((item) => item.id === "source-market-csv")!.locator.url!, /gov\.cn/u);
});

test("engine rejects a run that would exceed the ten-source product boundary before reading uploads", async () => {
  const uploadedFiles = Array.from({ length: 6 }, (_value, index) => ({
    id: `upload-${index}`,
    kind: "TXT" as const,
    originalFileName: `source-${index}.txt`,
    path: `/path-that-must-not-be-read/source-${index}.txt`,
    sha256: "0".repeat(64),
    uploadedAt: "2026-08-28T00:00:00.000Z",
  }));
  await assert.rejects(runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await workspace("insightforge-source-limit-"),
    uploadedFiles,
  }), /SOURCE_LIMIT_EXCEEDED.*at most 10 sources.*at most 5 uploaded files/u);
});

test("live PLAN and SYNTHESIZE reject invalid model programs without deterministic fallback", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps: [
      { objective: "只有非法工具的计划步骤", toolName: "shell", expectedOutput: "输出" },
    ] }) } }] }), { headers: { "content-type": "application/json" } });
    await assert.rejects(runGoldenCase({ researchQuestion: question, fixtureDir: resolve("fixtures/golden"), workspaceDir: await workspace("insightforge-invalid-live-plan-"), llmMode: "auto", llmConfig: config }), /plan failed deterministic/u);

    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      const content = call === 1
        ? JSON.stringify({ steps: [
          { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
          { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
          { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
        ] })
        : JSON.stringify({ conclusions: [{ text: "唯一有效候选不能满足最小结论数量", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
    };
    await assert.rejects(runGoldenCase({ researchQuestion: question, fixtureDir: resolve("fixtures/golden"), workspaceDir: await workspace("insightforge-invalid-live-synthesis-"), llmMode: "auto", llmConfig: config }), /fewer than three/u);
    assert.equal(call, 3, "one PLAN call and two bounded SYNTHESIZE attempts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
