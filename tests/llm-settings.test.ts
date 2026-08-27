import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer } from "../src/server.js";

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as {
      job: { status: string };
      run?: { events: Array<{ toolName: string }>; modelProvenance: { model: string; provider: string } };
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
  const observed: Array<{ authorization: string; model: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "llm.example.com") return originalFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { max_tokens: number; model: string };
    observed.push({ authorization: String((init?.headers as Record<string, string>).authorization), model: body.model });
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
    assert.match(configuredText, /•{4}-key/u);

    const settingsPath = join(workspaceDir, "settings.json");
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    assert.equal((JSON.parse(await readFile(settingsPath, "utf8")) as { llm: { apiKey: string } }).llm.apiKey, fixtureKey);
    const getText = await (await fetch(`${baseUrl}/api/settings/llm`)).text();
    assert.equal(getText.includes(fixtureKey), false);
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
    assert.ok(observed.length >= 2 && observed.every((item) => item.authorization === `Bearer ${fixtureKey}` && item.model === "api-model"));
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
