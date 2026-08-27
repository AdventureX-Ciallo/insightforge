import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase } from "../src/index.js";
import { createInsightForgeServer } from "../src/server.js";

test("presets API exposes exactly one golden and two honest boundary cases", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-presets-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const response = await fetch(`${baseUrl}/api/presets`);
    assert.equal(response.status, 200);
    const presets = await response.json() as Array<{ id: string; question: string; kind: "golden" | "boundary"; description: string }>;
    assert.equal(presets.length, 3);
    assert.equal(new Set(presets.map((item) => item.id)).size, 3);
    assert.deepEqual(presets.map((item) => item.kind), ["golden", "boundary", "boundary"]);
    assert.ok(presets.every((item) => item.question.length >= 8 && item.description.length > 0));

    const boundaryRuns = await Promise.all(presets.filter((item) => item.kind === "boundary").map(async (preset) => runGoldenCase({
      researchQuestion: preset.question,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir: join(workspaceDir, preset.id),
      llmMode: "off",
    })));
    assert.ok(boundaryRuns.every((run) => run.synthesisMode === "DETERMINISTIC_MISMATCH_BLOCK"));
    assert.ok(boundaryRuns.every((run) => run.conclusions.every((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE" && item.evidenceGapIds.length > 0)));
    assert.notDeepEqual(boundaryRuns[0]?.conclusions.map((item) => item.text), boundaryRuns[1]?.conclusions.map((item) => item.text));
  } finally {
    await app.stop();
  }
});
