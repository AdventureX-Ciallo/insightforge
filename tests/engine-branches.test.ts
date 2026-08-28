import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase, workflowStates, type WorkflowState } from "../src/index.js";

const question = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";
const config = { baseUrl: "https://model.example.test/v1", model: "test", apiKey: "test-secret" };

async function workspace(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("every injected workflow failure remains terminally fail-closed and non-Error progress failures are preserved", async () => {
  for (const state of workflowStates as readonly WorkflowState[]) {
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
    const failedIndex = workflowStates.indexOf(state);
    assert.deepEqual(observed.map((step) => step.status), workflowStates.map((_step, index) => index < failedIndex ? "success" : index === failedIndex ? "failed" : "pending"));
  }

  let failureProgressCalls = 0;
  await assert.rejects(runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await workspace("insightforge-failure-progress-root-"),
    llmMode: "off",
    failAt: "PLAN",
    onProgress: () => { failureProgressCalls += 1; if (failureProgressCalls === 2) throw new Error("secondary progress failure"); },
  }), /Injected PLAN failure/u);

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
  assert.equal(run.synthesisMode, "DETERMINISTIC_GOLDEN_RULES");
  assert.match(run.sources.find((item) => item.id === "source-market-csv")!.locator.url!, /gov\.cn/u);
});

test("default cached mode rejects a fresh golden v2 run early with the supported update path", async () => {
  const workspaceDir = await workspace("insightforge-cached-v2-boundary-");
  await assert.rejects(runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    sourceVersion: "v2",
  }), /cached model output is scoped to golden source v1.*applySourceUpdate/iu);
  assert.deepEqual(await readdir(workspaceDir), []);
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

test("COLLECT truncates an eleventh total source and persists the MAX_SOURCES trace", async () => {
  const fixtureDir = await workspace("insightforge-eleventh-source-fixture-");
  await cp(resolve("fixtures/golden"), fixtureDir, { recursive: true });
  const indexPath = join(fixtureDir, "search-index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as { sources: Array<Record<string, unknown>> };
  for (let number = 4; number <= 9; number += 1) {
    index.sources.push({
      id: `source-web-extra-${number}`,
      title: `额外候选信源 ${number}`,
      url: `https://example.com/source-${number}`,
      publisher: "截断测试来源",
      publishedAt: "2026-08-28",
      excerpt: `用于验证第 ${number} 个网页候选的硬上限。`,
      contentType: "SOURCE_OPINION",
    });
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const run = await runGoldenCase({
    researchQuestion: "验证十一条候选信源是否被安全截断并留下机器记录？",
    fixtureDir,
    workspaceDir: await workspace("insightforge-eleventh-source-run-"),
    llmMode: "off",
  });

  assert.equal(run.sources.length, 10);
  assert.deepEqual(run.sourceLimitTrace, {
    maxSources: 10,
    discoveredCount: 11,
    retainedCount: 10,
    truncatedCount: 1,
    truncated: true,
    reason: "MAX_SOURCES",
  });
  assert.match(run.steps.find((step) => step.state === "COLLECT")!.summary, /MAX_SOURCES=10 已截断 1 个候选并留痕/u);
  assert.equal(run.sources.some((source) => source.id === "source-web-extra-9"), false);
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
