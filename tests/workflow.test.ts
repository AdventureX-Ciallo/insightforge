import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runGoldenCase } from "../src/index.js";
import { hashValue } from "../src/hash.js";
import type { ResearchRun } from "../src/domain.js";

test("a new research task runs the five-state chain with real tools and validated model stages", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-workflow-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });

  assert.deepEqual(
    run.steps.map((step) => step.state),
    ["PLAN", "COLLECT", "SYNTHESIZE", "AUDIT", "DELIVER"],
  );
  assert.ok(run.steps.every((step) => step.status === "success"));
  assert.equal(run.terminalStatus, "NEEDS_REVIEW");

  const toolEvents = run.events.filter((event) => event.kind === "TOOL_CALL");
  assert.deepEqual(toolEvents.map((event) => event.toolName), [
    "cached-model-planner",
    "snapshot-search",
    "pdf-reader",
    "csv-calculator",
    "cached-model-synthesizer",
    "pptx-generator",
  ]);
  assert.equal(run.synthesisMode, "CACHED_MODEL_OUTPUT");
  assert.equal(run.offlineMode, true);
  assert.equal(run.offlineModeLabel, "使用缓存快照");
  assert.equal(run.modelProvenance.synthesisSource, "CACHED_MODEL_OUTPUT");
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(run.modelProvenance.planPromptSha256, digest(await readFile(resolve("fixtures/golden/model-plan-prompt.txt"))));
  assert.equal(run.modelProvenance.synthesisPromptSha256, digest(await readFile(resolve("fixtures/golden/model-synthesis-prompt.txt"))));
  assert.equal(run.modelProvenance.promptSha256, run.modelProvenance.synthesisPromptSha256);
  for (const event of toolEvents) {
    assert.equal(event.status, "success");
    assert.ok(event.inputSummary.length > 0);
    assert.ok(event.startedAt.length > 0);
    assert.ok(event.outputId.length > 0);
    assert.ok(event.duration >= 0);
    assert.equal(event.error, null);
  }

  const [plan, collect, synthesize, audit, deliver] = run.steps;
  assert.ok(plan && collect && synthesize && audit && deliver);
  assert.ok(collect.consumedOutputIds.includes(plan.outputId));
  assert.ok(synthesize.consumedOutputIds.includes(collect.outputId));
  assert.ok(audit.consumedOutputIds.includes(synthesize.outputId));
  assert.ok(deliver.consumedOutputIds.includes(audit.outputId));
  assert.equal(synthesize.outputId, hashValue(run.synthesisOutput), "SYNTHESIZE outputId must be reproducible from the persisted immutable stage snapshot");
  assert.notDeepEqual(run.synthesisOutput.synthesis.candidateRevisions, run.candidateRevisions, "AUDIT results belong to the current graph, not the committed SYNTHESIZE snapshot");
  const persisted = JSON.parse(await readFile(join(workspaceDir, run.id, "run.json"), "utf8")) as ResearchRun;
  assert.equal(persisted.steps[2]?.outputId, hashValue(persisted.synthesisOutput));
});
