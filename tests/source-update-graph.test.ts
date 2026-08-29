import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applySourceUpdate, runGoldenCase } from "../src/index.js";

const GOLDEN_QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

function installLiveModelStub() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = body.messages.some((message) => message.content.startsWith("BEGIN_UNTRUSTED_PLAN_JSON"))
      ? JSON.stringify({ steps: [
        { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
        { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
        { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
      ] })
      : JSON.stringify({ conclusions: [
        {
          text: "模型候选：market 表中的 charger growth 字段在来源更新后应重新审查。",
          evidenceIds: ["evidence-market-csv"],
          assumptions: [],
          missingEvidence: [],
        },
        {
          text: "模型候选：该结构化市场表可以辅助判断，但仍缺少区域交叉验证。",
          evidenceIds: ["evidence-market-csv"],
          assumptions: [],
          missingEvidence: ["区域口径的交叉验证"],
        },
        {
          text: "模型候选：公共充电点同比增长 31.3%，但该增速不能代表实际利用率。",
          evidenceIds: ["evidence-market-csv", "evidence-source-web-charging"],
          assumptions: [],
          missingEvidence: [],
        },
        {
          text: "模型候选：盈利能力仍缺少运营商收入、成本和利用率数据。",
          evidenceIds: ["evidence-pdf-page-2"],
          assumptions: [],
          missingEvidence: ["运营商收入与成本数据"],
        },
      ] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("live source update preserves each conclusion's evidence semantics and only invalidates changed dependencies", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-graph-"));
  const restoreFetch = installLiveModelStub();
  let run;
  try {
    run = await runGoldenCase({
      researchQuestion: GOLDEN_QUESTION,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir,
      llmMode: "auto",
      llmConfig: { baseUrl: "https://model.example.invalid/v1", model: "fixture-model", apiKey: "fixture-key" },
    });
  } finally {
    restoreFetch();
  }

  const supported = run.conclusions.find((item) => item.originalAiText.includes("来源更新后"));
  const insufficient = run.conclusions.find((item) => item.originalAiText.includes("区域交叉验证"));
  const charging = run.conclusions.find((item) => item.originalAiText.includes("实际利用率"));
  const profitability = run.conclusions.find((item) => item.originalAiText.includes("盈利能力"));
  assert.ok(supported && insufficient && charging && profitability);
  assert.equal(supported.normalizedEvidenceStatus, "SUPPORTED");
  assert.equal(insufficient.normalizedEvidenceStatus, "INSUFFICIENT_EVIDENCE");
  assert.ok(insufficient.evidenceGapIds.length > 0);

  const unaffectedBefore = new Map([charging, profitability].map((item) => [item.id, structuredClone(item)]));
  const updated = await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir });
  const supportedAfter = updated.conclusions.find((item) => item.id === supported.id)!;
  const insufficientAfter = updated.conclusions.find((item) => item.id === insufficient.id)!;

  assert.equal(supportedAfter.evidenceStatus, "STALE");
  assert.equal(supportedAfter.normalizedEvidenceStatus, "SUPPORTED", "freshness invalidation must not invent a source conflict");
  assert.equal(insufficientAfter.evidenceStatus, "STALE");
  assert.equal(insufficientAfter.normalizedEvidenceStatus, "INSUFFICIENT_EVIDENCE", "a source update must not erase an existing evidence gap");
  assert.deepEqual(insufficientAfter.evidenceGapIds, insufficient.evidenceGapIds);

  for (const conclusion of [supportedAfter, insufficientAfter]) {
    const claim = updated.claims.find((item) => conclusion.claimIds.includes(item.id))!;
    assert.doesNotMatch(claim.text, /47\.6/u, "updated text may only mention facts present in that claim's evidence path");
    assert.ok(updated.affectedObjectIds.includes(claim.id));
    assert.ok(updated.affectedObjectIds.includes(conclusion.id));
  }

  for (const [id, before] of unaffectedBefore) {
    const after = updated.conclusions.find((item) => item.id === id)!;
    assert.deepEqual(after, before, `unrelated conclusion ${id} must remain byte-for-byte unchanged`);
    assert.equal(updated.affectedObjectIds.includes(id), false);
  }
});
