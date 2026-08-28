import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import type { ModelProvenance } from "../src/domain.js";
import { createInsightForgeServer } from "../src/server.js";

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as {
      job: { status: string };
      run?: {
        id: string;
        events: Array<{ toolName: string }>;
        modelProvenance: ModelProvenance;
        synthesisMode: string;
        offlineMode: boolean;
        offlineModeLabel: string;
        sourceVersion: "v1" | "v2";
        claims: Array<{ id: string; datumIds: string[]; evidenceStatus: string; freshness: string }>;
        conclusions: Array<{
          id: string;
          claimIds: string[];
          text: string;
          evidenceStatus: string;
          reviewStatus: string;
          freshness: string;
        }>;
        humanDecisions: Array<{ conclusionId: string; action: string; invalidatedAt: string | null }>;
        artifactVersions: Array<{ version: number; trigger: string; status: string }>;
        affectedObjectIds: string[];
      };
    };
    if (body.run) return body.run;
    if (body.job.status === "failed") throw new Error("Configured LLM run failed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for configured LLM run");
}

test("LLM settings are masked, persisted 0600, preferred over env, and used by the next run", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-llm-settings-"));
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    enabled: process.env.INSIGHTFORGE_LLM,
    baseUrl: process.env.INSIGHTFORGE_LLM_BASE_URL,
    model: process.env.INSIGHTFORGE_LLM_MODEL,
    apiKey: process.env.INSIGHTFORGE_LLM_API_KEY,
  };
  process.env.INSIGHTFORGE_LLM = "1";
  process.env.INSIGHTFORGE_LLM_BASE_URL = "https://env.example.com/v1";
  process.env.INSIGHTFORGE_LLM_MODEL = "env-model";
  process.env.INSIGHTFORGE_LLM_API_KEY = "env--key";
  const observed: Array<{ authorization: string; model: string; maxTokens: number; promptSha256: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "llm.example.com") return originalFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { max_tokens: number; model: string; messages: Array<{ role: string; content: string }> };
    observed.push({
      authorization: String((init?.headers as Record<string, string>).authorization),
      model: body.model,
      maxTokens: body.max_tokens,
      promptSha256: createHash("sha256").update(JSON.stringify(body.messages)).digest("hex"),
    });
    const content = body.max_tokens === 2048
      ? JSON.stringify({ steps: [
        { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
        { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
        { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
      ] })
      : JSON.stringify({ conclusions: [
        { text: "模型候选：两类渗透率口径不同，不能静默合并。", evidenceIds: ["evidence-source-web-association", "evidence-market-csv"], assumptions: [], missingEvidence: [] },
        { text: "模型候选：公共充电增速不能直接代表区域有效供给。", evidenceIds: ["evidence-source-web-charging", "evidence-market-csv"], assumptions: [], missingEvidence: [] },
        { text: "模型候选：盈利判断仍缺少运营商成本与利用率数据。", evidenceIds: ["evidence-pdf-page-2"], assumptions: [], missingEvidence: ["运营商成本数据"] },
      ] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const initial = await fetch(`${baseUrl}/api/settings/llm`);
    assert.equal(initial.status, 200);
    assert.equal(((await initial.json()) as { source: string }).source, "environment");

    const invalid = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:8080/v1", model: "bad", apiKey: "bad-secret" }),
    });
    assert.equal(invalid.status, 400);

    const fixtureKey = "not-a-key";
    const configured = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://llm.example.com/v1/", model: "api-model", apiKey: fixtureKey }),
    });
    assert.equal(configured.status, 200);
    const configuredText = await configured.text();
    assert.equal(configuredText.includes(fixtureKey), false);
    assert.equal(configuredText.includes("llm.example.com"), false);
    assert.equal(configuredText.includes("api-model"), false);
    assert.match(configuredText, /•{4}-key/u);

    const settingsPath = join(workspaceDir, "settings.json");
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    assert.equal((JSON.parse(await readFile(settingsPath, "utf8")) as { llm: { apiKey: string } }).llm.apiKey, fixtureKey);
    const getText = await (await fetch(`${baseUrl}/api/settings/llm`)).text();
    assert.equal(getText.includes(fixtureKey), false);
    assert.equal(getText.includes("llm.example.com"), false);
    assert.equal(getText.includes("api-model"), false);
    assert.match(getText, /"source":"api"/u);

    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    const { runId } = await created.json() as { runId: string };
    const run = await waitForRun(baseUrl, runId);
    assert.ok(run.events.some((item) => item.toolName === "llm-planner"));
    assert.ok(run.events.some((item) => item.toolName === "llm-synthesizer"));
    assert.deepEqual(run.modelProvenance, { ...run.modelProvenance, model: "api-model", provider: "llm.example.com" });
    const observedPlan = observed.find((item) => item.maxTokens === 2048);
    const observedSynthesis = observed.find((item) => item.maxTokens === 4096);
    assert.ok(observedPlan && observedSynthesis);
    assert.equal(run.modelProvenance.planPromptSha256, observedPlan.promptSha256);
    assert.equal(run.modelProvenance.synthesisPromptSha256, observedSynthesis.promptSha256);
    assert.equal(run.modelProvenance.promptSha256, observedSynthesis.promptSha256, "legacy promptSha256 aliases the exact SYNTHESIZE messages that produced outputSha256");
    assert.equal(run.synthesisMode, "LIVE_SINGLE_ENDPOINT");
    assert.deepEqual(run.modelProvenance.dataDisclosure?.stages, ["PLAN", "SYNTHESIZE"]);
    assert.equal(run.modelProvenance.dataDisclosure?.externalTransfer, true);
    assert.ok(run.modelProvenance.dataDisclosure?.omittedFields.includes("fullSourceUrls"));
    assert.match(run.modelProvenance.routingNotice ?? "", /字段已最小化/u);
    assert.equal(run.offlineMode, false);
    assert.equal(run.offlineModeLabel, "在线模型生成 · 信源使用缓存快照");
    assert.ok(observed.length >= 2 && observed.every((item) => item.authorization === `Bearer ${fixtureKey}` && item.model === "api-model"));

    const pptxResponse = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX`);
    assert.equal(pptxResponse.status, 200);
    const pptx = await JSZip.loadAsync(await pptxResponse.arrayBuffer());
    const coverXml = await pptx.file("ppt/slides/slide1.xml")!.async("string");
    assert.match(coverXml, /在线模型生成 · 信源使用缓存快照/u);
    assert.doesNotMatch(coverXml, /离线黄金案例/u);

    const affectedConclusion = run.conclusions.find((item) => item.text.includes("渗透率"));
    assert.ok(affectedConclusion);
    const affectedClaim = run.claims.find((item) => affectedConclusion.claimIds.includes(item.id));
    assert.ok(affectedClaim);
    assert.notEqual(affectedClaim.id, "claim-penetration", "live model IDs are not the cached golden IDs");
    assert.notEqual(affectedConclusion.id, "conclusion-penetration", "live model IDs are not the cached golden IDs");
    const unaffectedBefore = run.conclusions.find((item) => item.id !== affectedConclusion.id && !item.claimIds.some((id) => run.claims.find((claim) => claim.id === id)?.datumIds.includes("datum-penetration")));
    assert.ok(unaffectedBefore);

    const confirmed = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conclusionId: affectedConclusion.id,
        action: "CONFIRM",
        reason: "确认当前两种统计口径存在差异，不把任一数值静默选为唯一真值。",
        scopeNote: "仅适用于 2024 年中国市场及本轮列明口径。",
      }),
    });
    assert.equal(confirmed.status, 200);

    const sourceUpdate = await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" });
    assert.equal(sourceUpdate.status, 200, "the backend owns and persists the live-run v1→v2 dependency update");
    const updated = (await sourceUpdate.json() as { run: typeof run }).run;
    const affectedAfter = updated.conclusions.find((item) => item.id === affectedConclusion.id);
    assert.equal(updated.sourceVersion, "v2");
    assert.equal(affectedAfter?.evidenceStatus, "STALE");
    assert.equal(affectedAfter?.freshness, "STALE");
    assert.equal(affectedAfter?.reviewStatus, "NEEDS_REVIEW");
    assert.ok(updated.affectedObjectIds.includes(affectedClaim.id));
    assert.ok(updated.affectedObjectIds.includes(affectedConclusion.id));
    assert.deepEqual(updated.conclusions.find((item) => item.id === unaffectedBefore.id), unaffectedBefore);
    assert.ok(updated.humanDecisions.find((item) => item.conclusionId === affectedConclusion.id && item.action === "CONFIRM")?.invalidatedAt);
    assert.equal(updated.humanDecisions.at(-1)?.action, "REVOKE_ON_SOURCE_UPDATE");
    assert.equal(updated.artifactVersions.at(-1)?.trigger, "SOURCE_UPDATE");
    assert.equal(updated.artifactVersions.at(-1)?.status, "CURRENT");

    await app.stop();
    const restarted = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
    const restartedBaseUrl = await restarted.start(0, "127.0.0.1");
    try {
      const recoveredResponse = await fetch(`${restartedBaseUrl}/api/runs/${runId}`);
      assert.equal(recoveredResponse.status, 200);
      const recovered = (await recoveredResponse.json() as { run: typeof run }).run;
      assert.equal(recovered.sourceVersion, "v2");
      assert.equal(recovered.conclusions.find((item) => item.id === affectedConclusion.id)?.freshness, "STALE");
      assert.ok(recovered.affectedObjectIds.includes(affectedConclusion.id));
      assert.equal(recovered.artifactVersions.at(-1)?.trigger, "SOURCE_UPDATE");
      const current = (await (await fetch(`${restartedBaseUrl}/api/current`)).json() as { run: typeof run }).run;
      assert.equal(current.id, runId);
      assert.equal(current.sourceVersion, "v2");
    } finally {
      await restarted.stop();
    }
  } finally {
    await app.stop();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      INSIGHTFORGE_LLM: originalEnv.enabled,
      INSIGHTFORGE_LLM_BASE_URL: originalEnv.baseUrl,
      INSIGHTFORGE_LLM_MODEL: originalEnv.model,
      INSIGHTFORGE_LLM_API_KEY: originalEnv.apiKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
