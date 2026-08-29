import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer } from "../src/server.js";

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { run?: { id: string } };
    if (body.run) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for research run");
}

test("artifact version APIs preserve immutable delivery, source, and trigger snapshots", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-versions-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    const { runId } = await created.json() as { runId: string };
    await waitForRun(baseUrl, runId);

    const edit = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conclusionId: "conclusion-charging-growth",
        action: "EDIT",
        text: "人工修订：充电设施增长仍需区域利用率证据验证。",
        reason: "收窄判断边界",
      }),
    });
    assert.equal(edit.status, 200);
    const reject = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-causality-gap", action: "REJECT", reason: "缺少因果识别" }),
    });
    assert.equal(reject.status, 200);
    const update = await fetch(`${baseUrl}/api/runs/${runId}/source-update`, { method: "POST" });
    assert.equal(update.status, 200);

    const listed = await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions`);
    assert.equal(listed.status, 200);
    const versions = await listed.json() as Array<{
      id: string;
      version: number;
      trigger: "initial" | "human-decision" | "source-update";
      triggerRef: string;
      adjustmentNote: string;
      artifacts: Array<{ id: string; version: number }>;
      sources: Array<{ id: string; version: string }>;
      conclusions: Array<{ id: string; text: string }>;
    }>;
    assert.equal(versions.length, 4);
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4]);
    assert.deepEqual(versions.map((item) => item.trigger), ["initial", "human-decision", "human-decision", "source-update"]);
    assert.ok(versions.every((item) => item.triggerRef && item.adjustmentNote));
    assert.ok(versions.every((item) => item.artifacts.length === 4 && item.artifacts.every((artifact) => artifact.version === item.version)));
    assert.ok(versions.every((item) => item.sources.length > 0 && item.conclusions.length >= 3));
    assert.equal(versions[0]?.sources.find((item) => item.id === "source-market-csv")?.version, "v1");
    assert.equal(versions[3]?.sources.find((item) => item.id === "source-market-csv")?.version, "v2");
    assert.notEqual(
      versions[0]?.conclusions.find((item) => item.id === "conclusion-charging-growth")?.text,
      versions[1]?.conclusions.find((item) => item.id === "conclusion-charging-growth")?.text,
    );

    const v1Before = structuredClone(versions[0]);
    const detail = await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/1`);
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), v1Before);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/999`)).status, 404);

    let sixthDecisionRun: {
      humanDecisions: unknown[];
      artifactVersions: Array<{ version: number }>;
      artifactHistory: Array<{ version: number }>;
      evictedArtifactVersionCount: number;
    } | undefined;
    for (let decisionNumber = 3; decisionNumber <= 6; decisionNumber += 1) {
      const action = decisionNumber % 2 === 0 ? "EDIT" : "REJECT";
      const response = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conclusionId: "conclusion-charging-growth",
          action,
          ...(action === "EDIT" ? { text: `人工修订版本 ${decisionNumber}：缩小判断范围并等待复核。` } : {}),
          reason: `滚动窗口测试中的第 ${decisionNumber} 次人工决定`,
        }),
      });
      assert.equal(response.status, 200);
      sixthDecisionRun = (await response.json() as { run: typeof sixthDecisionRun }).run;
    }
    assert.ok(sixthDecisionRun);
    assert.equal(sixthDecisionRun.humanDecisions.length, 6);
    assert.deepEqual(sixthDecisionRun.artifactVersions.map((item) => item.version), [4, 5, 6, 7, 8]);
    assert.equal(sixthDecisionRun.artifactHistory.length, 16);
    assert.equal(sixthDecisionRun.evictedArtifactVersionCount, 3);

    const rolled = await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions`);
    const retainedVersions = await rolled.json() as Array<{ version: number }>;
    assert.deepEqual(retainedVersions.map((item) => item.version), [4, 5, 6, 7, 8]);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/1`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifacts/PPTX?version=1`)).status, 404);
    const retainedDirectories = (await readdir(join(workspaceDir, runId, "artifacts"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(retainedDirectories, ["v4", "v5", "v6", "v7", "v8"]);
  } finally {
    await app.stop();
  }
});
