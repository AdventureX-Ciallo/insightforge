import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer } from "../src/server.js";

async function waitForRun(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const body = await fetch(`${baseUrl}/api/runs/${runId}`).then((response) => response.json()) as { run?: { id: string } };
    if (body.run) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("run timeout");
}

test("STALE conclusion can be revalidated against v2 without losing decision history", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-revalidate-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    }).then((response) => response.json()) as { runId: string };
    await waitForRun(baseUrl, created.runId);
    const confirmation = await fetch(`${baseUrl}/api/runs/${created.runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conclusionId: "conclusion-penetration", action: "CONFIRM", reason: "确认口径冲突", scopeNote: "仅当前来源口径" }),
    });
    assert.equal(confirmation.status, 200);
    const update = await fetch(`${baseUrl}/api/runs/${created.runId}/source-update`, { method: "POST" });
    assert.equal(update.status, 200);
    const stale = (await update.json() as { run: { conclusions: Array<{ id: string; freshness: string }>; humanDecisions: Array<{ action: string; invalidatedAt: string | null }> } }).run;
    assert.equal(stale.conclusions.find((item) => item.id === "conclusion-penetration")?.freshness, "STALE");
    assert.ok(stale.humanDecisions.some((item) => item.action === "CONFIRM" && item.invalidatedAt));

    const response = await fetch(`${baseUrl}/api/runs/${created.runId}/conclusions/conclusion-penetration/revalidate`, { method: "POST" });
    assert.equal(response.status, 200);
    const run = (await response.json() as { run: { conclusions: Array<{ id: string; freshness: string; evidenceStatus: string; reviewStatus: string; normalizedReviewStatus: string; confirmedAt: string | null }>; claims: Array<{ id: string; freshness: string }>; humanDecisions: unknown[]; artifactVersions: Array<{ trigger: string }> } }).run;
    const conclusion = run.conclusions.find((item) => item.id === "conclusion-penetration");
    assert.equal(conclusion?.freshness, "CURRENT");
    assert.equal(conclusion?.evidenceStatus, "CONFLICT");
    assert.equal(conclusion?.reviewStatus, "PENDING_REVIEW");
    assert.equal(conclusion?.normalizedReviewStatus, "PENDING_REVIEW");
    assert.equal(conclusion?.confirmedAt, null);
    assert.equal(run.claims.find((item) => item.id === "claim-penetration")?.freshness, "CURRENT");
    assert.equal(run.humanDecisions.length, stale.humanDecisions.length);
    assert.equal(run.artifactVersions.at(-1)?.trigger, "REVALIDATION");

    const persisted = JSON.parse(await readFile(join(workspaceDir, created.runId, "run.json"), "utf8")) as typeof run;
    assert.equal(persisted.conclusions.find((item) => item.id === "conclusion-penetration")?.freshness, "CURRENT");
    assert.equal((await fetch(`${baseUrl}/api/runs/${created.runId}/conclusions/conclusion-penetration/revalidate`, { method: "POST" })).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/runs/${created.runId}/conclusions/missing/revalidate`, { method: "POST" })).status, 404);
  } finally {
    await app.stop();
  }
});
