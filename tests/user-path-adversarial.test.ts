import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyHumanDecision, runGoldenCase, type ResearchRun, type RunStep } from "../src/index.js";
import { researchPresets } from "../src/presets.js";
import { createInsightForgeServer } from "../src/server.js";
import { searchSelectedEngine } from "../src/tools/search-engines.js";
import { fetchForPoll } from "./http-poll.js";

const goldenQuestion = researchPresets.find((preset) => preset.kind === "golden")!.question;

async function workspace(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function waitForRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetchForPoll(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { job: { status: string }; run?: ResearchRun };
    if (body.run) return body.run;
    if (body.job.status === "failed") throw new Error("Research run failed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for research run");
}

test("Path 1–6 adversarial acceptance matrix", async (context) => {
  const goldenRun = await runGoldenCase({
    researchQuestion: goldenQuestion,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await workspace("insightforge-path-golden-"),
    llmMode: "off",
  });

  await context.test("Path 1: boundary presets cannot inherit the golden answer", async () => {
    const boundaryPresets = researchPresets.filter((preset) => preset.kind === "boundary");
    assert.equal(boundaryPresets.length, 2);
    for (const preset of boundaryPresets) {
      const boundaryRun = await runGoldenCase({
        researchQuestion: preset.question,
        fixtureDir: resolve("fixtures/golden"),
        workspaceDir: await workspace(`insightforge-path-${preset.id}-`),
        llmMode: "off",
      });
      assert.equal(boundaryRun.synthesisMode, "DETERMINISTIC_MISMATCH_BLOCK");
      assert.ok(boundaryRun.conclusions.every((conclusion) => conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE"));
      assert.notDeepEqual(
        boundaryRun.conclusions.map((conclusion) => conclusion.text),
        goldenRun.conclusions.map((conclusion) => conclusion.text),
      );
    }
  });

  await context.test("Path 2: an injected node failure cannot report downstream success", async () => {
    let observed: RunStep[] = [];
    await assert.rejects(runGoldenCase({
      researchQuestion: goldenQuestion,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir: await workspace("insightforge-path-progress-failure-"),
      llmMode: "off",
      failAt: "SYNTHESIZE",
      onProgress: (steps) => { observed = steps; },
    }), /Injected SYNTHESIZE failure/u);
    const failedIndex = observed.findIndex((step) => step.state === "SYNTHESIZE");
    assert.equal(observed[failedIndex]?.status, "failed");
    assert.ok(observed.slice(failedIndex + 1).every((step) => step.status === "pending"));
  });

  await context.test("Path 3: insufficient and stale conclusions resist forged confirmation", () => {
    const insufficient = goldenRun.conclusions.find((conclusion) => conclusion.normalizedEvidenceStatus === "INSUFFICIENT_EVIDENCE");
    assert.ok(insufficient);
    assert.throws(
      () => applyHumanDecision(goldenRun, { conclusionId: insufficient.id, action: "CONFIRM" }),
      /INSUFFICIENT_EVIDENCE/u,
    );

    const staleRun = structuredClone(goldenRun);
    const stale = staleRun.conclusions.find((conclusion) => conclusion.normalizedEvidenceStatus !== "INSUFFICIENT_EVIDENCE")!;
    stale.freshness = "STALE";
    assert.throws(
      () => applyHumanDecision(staleRun, { conclusionId: stale.id, action: "CONFIRM" }),
      /STALE/u,
    );
  });

  const serverWorkspace = await workspace("insightforge-path-http-");
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir: serverWorkspace,
    stepDelayMs: 30,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: goldenQuestion }),
    });
    const { runId } = await created.json() as { runId: string };

    await context.test("Path 4: an unfinished run cannot expose boundary questions as complete", async () => {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/boundary-questions`);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "Run is not completed" });
    });

    await waitForRun(baseUrl, runId);
    await context.test("Path 5: later decisions cannot mutate V1 or fabricate a missing version", async () => {
      const beforeResponse = await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/1`);
      assert.equal(beforeResponse.status, 200);
      const v1Before = await beforeResponse.json();

      const decision = await fetch(`${baseUrl}/api/runs/${runId}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conclusionId: "conclusion-causality-gap", action: "REJECT", reason: "对抗式拒绝" }),
      });
      assert.equal(decision.status, 200);

      const afterResponse = await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/1`);
      const v1After = await afterResponse.json() as typeof v1Before;
      const { status: statusBefore, ...snapshotBefore } = v1Before as Record<string, unknown>;
      const { status: statusAfter, ...snapshotAfter } = v1After as Record<string, unknown>;
      assert.equal(statusBefore, "CURRENT");
      assert.equal(statusAfter, "SUPERSEDED");
      assert.deepEqual(snapshotAfter, snapshotBefore);
      assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/artifact-versions/999`)).status, 404);
    });
  } finally {
    await app.stop();
  }

  await context.test("Path 6: mixed public/private DNS answers are rejected during preflight", async () => {
    let fetchCalls = 0;
    await assert.rejects(searchSelectedEngine(
      "bing",
      "新能源汽车",
      async () => {
        fetchCalls += 1;
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      },
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ), /private, reserved, or loopback/u);
    assert.equal(fetchCalls, 0);
  });
});
