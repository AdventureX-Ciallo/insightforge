import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase } from "../src/index.js";

test("a LIVE_SINGLE_ENDPOINT run never carries offline cache labels (#4)", async () => {
  const originalFetch = globalThis.fetch;
  let sawLiveCall = false;
  // 桩掉传输层：从提示里回显真实 evidenceId，确保草稿通过程序校验；模型阶段仍在引擎内真实走完。
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    sawLiveCall = true;
    const body = String(init?.body ?? "");
    const payload = body.includes("研究规划器")
      ? { steps: [
          { objective: "检索与研究问题相关的权威信源", toolName: "snapshot-search", expectedOutput: "带定位的候选信源" },
          { objective: "读取本地行业 PDF 并保留页码", toolName: "pdf-reader", expectedOutput: "逐页文本" },
          { objective: "读取市场数据并确定性重算", toolName: "csv-calculator", expectedOutput: "公式与行号" },
          { objective: "对候选结论执行六规则审查", toolName: "deterministic-audit", expectedOutput: "结构化审查" },
          { objective: "生成交付成果", toolName: "pptx-generator", expectedOutput: "五页可编辑 PPTX" },
        ] }
      : (() => {
          const ids = [...body.matchAll(/evidence-[a-z0-9-]+/gu)].map((m) => m[0]);
          const unique = [...new Set(ids)].slice(0, 4);
          return { conclusions: unique.map((id) => ({
            text: `基于证据 ${id} 的候选判断：口径需人工核对后再确认，不自称已证实。`,
            evidenceIds: [id],
            assumptions: [],
            missingEvidence: [],
          })) };
        })();
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const run = await runGoldenCase({
      researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir: await mkdtemp(join(tmpdir(), "provenance-")),
      llmMode: "auto",
      llmConfig: { baseUrl: "https://example.invalid/v1", model: "test-model", apiKey: "sk-test" },
    });
    assert.ok(sawLiveCall, "stubbed transport must have been used");
    assert.equal(run.synthesisMode, "LIVE_SINGLE_ENDPOINT");
    assert.equal(run.offlineMode, false);
    assert.equal(run.offlineModeLabel, "在线单一端点模型");
    assert.ok(run.conclusions.length >= 3);
    assert.ok(run.conclusions.every((item) => !item.text.includes("缓存")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline modes keep the honest cache snapshot label (#4)", async () => {
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "provenance-off-")),
    llmMode: "cached",
  });
  assert.equal(run.synthesisMode, "CACHED_MODEL_OUTPUT");
  assert.equal(run.offlineMode, true);
  assert.equal(run.offlineModeLabel, "使用缓存快照");
});
