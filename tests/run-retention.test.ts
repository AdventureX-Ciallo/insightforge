import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { workflowStates } from "../src/domain.js";
import { runGoldenCase } from "../src/engine.js";
import { MAX_CONCURRENT_RUNS, MAX_RETAINED_RUNS, pruneRunWorkspace } from "../src/run-retention.js";
import { createInsightForgeServer } from "../src/server.js";

const question = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

async function createRun(baseUrl: string, uploadIds?: string[]) {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ researchQuestion: question, ...(uploadIds ? { uploadIds } : {}) }),
  });
  const body = await response.json() as { runId?: string; error?: string; code?: string };
  return { response, body };
}

async function waitForTerminal(baseUrl: string, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { job: { status: string } };
    if (body.job.status !== "running") return body.job.status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`run ${runId} did not terminate`);
}

test("workspace retention keeps protected/newest runs and removes paired progress plus artifacts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "insightforge-retention-unit-"));
  const runIds = [
    ...Array.from({ length: 4 }, (_, index) => `run-${1_000_000_000_001 + index}-0000000${index + 1}`),
    "run-00000000-0000-4000-8000-000000000005",
  ];
  for (const [index, runId] of runIds.entries()) {
    const runDir = join(workspace, runId);
    await mkdir(runDir, { recursive: true });
    const snapshot = join(runDir, "run.json");
    const progress = join(workspace, `${runId}-progress.json`);
    await writeFile(snapshot, "{}\n", "utf8");
    await writeFile(progress, "{}\n", "utf8");
    const timestamp = new Date(1_700_000_000_000 + index * 1000);
    await utimes(snapshot, timestamp, timestamp);
    await utimes(progress, timestamp, timestamp);
  }
  await mkdir(join(workspace, "uploads"));
  await writeFile(join(workspace, "uploads", "keep.txt"), "keep", "utf8");

  const trace = await pruneRunWorkspace(workspace, new Set([runIds[0]!]), 3);
  assert.deepEqual(new Set(trace.retainedRunIds), new Set([runIds[0], runIds[3], runIds[4]]));
  assert.deepEqual(new Set(trace.removedRunIds), new Set([runIds[1], runIds[2]]));
  assert.equal(trace.discoveredRunCount, 5);
  assert.equal(trace.errorCount, 0);
  await access(join(workspace, "uploads", "keep.txt"));
  for (const runId of trace.removedRunIds) {
    await assert.rejects(access(join(workspace, runId)));
    await assert.rejects(access(join(workspace, `${runId}-progress.json`)));
  }

  const missing = await pruneRunWorkspace(join(workspace, "missing"), new Set(), 3);
  assert.equal(missing.errorCount, 1);
  const partialId = "run-1999999999999-0000000a";
  await mkdir(join(workspace, partialId));
  const partial = await pruneRunWorkspace(workspace, new Set(), 10);
  assert.equal(partial.errorCount, 1, "a run-like directory without progress or run.json is retained with an error trace");

  const failingWorkspace = await mkdtemp(join(tmpdir(), "insightforge-retention-failure-"));
  for (const [index, runId] of ["run-2000000000001-0000000b", "run-2000000000002-0000000c"].entries()) {
    await mkdir(join(failingWorkspace, runId));
    await writeFile(join(failingWorkspace, runId, "run.json"), "{}", "utf8");
    await writeFile(join(failingWorkspace, `${runId}-progress.json`), "{}", "utf8");
    const timestamp = new Date(1_700_000_010_000 + index * 1000);
    await utimes(join(failingWorkspace, runId, "run.json"), timestamp, timestamp);
  }
  const failed = await pruneRunWorkspace(failingWorkspace, new Set(), 1, async () => { throw new Error("injected remove failure"); });
  assert.equal(failed.errorCount, 2);
  assert.equal(failed.removedRunIds.length, 0);
  assert.equal(failed.retainedRunIds.length, 2);

  const tiedWorkspace = await mkdtemp(join(tmpdir(), "insightforge-retention-tie-"));
  const tiedRunIds = ["run-3000000000001-0000000d", "run-3000000000002-0000000e"];
  const tiedTimestamp = new Date(1_700_000_020_000);
  for (const runId of tiedRunIds) {
    await mkdir(join(tiedWorkspace, runId));
    await writeFile(join(tiedWorkspace, runId, "run.json"), "{}", "utf8");
    await utimes(join(tiedWorkspace, runId, "run.json"), tiedTimestamp, tiedTimestamp);
  }
  const tied = await pruneRunWorkspace(tiedWorkspace, new Set(), 1);
  assert.deepEqual(tied.retainedRunIds, [tiedRunIds[1]], "equal mtimes use run ID as a deterministic tie-breaker");
  assert.deepEqual(tied.removedRunIds, [tiedRunIds[0]]);
});

test("server restart converts a persisted in-flight job into an explicit failed recovery record", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-progress-recovery-"));
  const runId = "run-00000000-0000-4000-8000-000000000099";
  const digest = "a".repeat(64);
  const steps = workflowStates.map((state, index) => ({
    state,
    status: index === 0 ? "success" : index === 1 ? "running" : "pending",
    outputId: index === 0 ? digest : "",
    consumedOutputIds: index === 1 ? [digest] : [],
    startedAt: index < 2 ? new Date().toISOString() : null,
    completedAt: index === 0 ? new Date().toISOString() : null,
    error: null,
    summary: index === 0 ? "persisted PLAN" : "",
  }));
  await writeFile(join(workspaceDir, `${runId}-progress.json`), `${JSON.stringify({ runId, status: "running", steps, error: null, events: [] })}\n`, "utf8");
  const completedWithoutRunId = "run-00000000-0000-4000-8000-000000000100";
  await writeFile(join(workspaceDir, `${completedWithoutRunId}-progress.json`), `${JSON.stringify({ runId: completedWithoutRunId, status: "completed", steps, error: null, events: [] })}\n`, "utf8");
  const malformedId = "run-00000000-0000-4000-8000-000000000101";
  await writeFile(join(workspaceDir, `${malformedId}-progress.json`), "{bad json\n", "utf8");
  const fileId = "run-00000000-0000-4000-8000-000000000102";
  const embeddedId = "run-00000000-0000-4000-8000-000000000103";
  await writeFile(join(workspaceDir, `${fileId}-progress.json`), `${JSON.stringify({ runId: embeddedId, status: "failed", steps, error: "already failed", events: [] })}\n`, "utf8");
  const seedWorkspace = await mkdtemp(join(tmpdir(), "insightforge-progress-seed-"));
  const validRun = await runGoldenCase({ researchQuestion: question, fixtureDir: resolve("fixtures/golden"), workspaceDir: seedWorkspace });
  const mismatchedRunId = "run-00000000-0000-4000-8000-000000000104";
  await writeFile(join(workspaceDir, `${mismatchedRunId}-progress.json`), `${JSON.stringify({
    runId: mismatchedRunId,
    status: "completed",
    steps: validRun.steps,
    error: null,
    events: validRun.events,
    run: validRun,
  })}\n`, "utf8");
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir, stepDelayMs: 0 });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { job: { status: string } }).job.status, "failed");
    const recovered = JSON.parse(await readFile(join(workspaceDir, `${runId}-progress.json`), "utf8")) as { status: string; error: string; steps: Array<{ status: string; error: string | null }> };
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error, /interrupted by process restart/u);
    assert.equal(recovered.steps[1]?.status, "failed");
    assert.match(recovered.steps[1]?.error ?? "", /interrupted/u);
    for (const ignoredId of [completedWithoutRunId, malformedId, fileId, embeddedId, mismatchedRunId]) {
      assert.equal((await fetch(`${baseUrl}/api/runs/${ignoredId}`)).status, 404, `invalid recovery record ${ignoredId} stays unavailable`);
    }
  } finally {
    await app.stop();
  }
});

test("HTTP run admission caps concurrency and retains only the newest ten jobs on memory and disk", async () => {
  const concurrentWorkspace = await mkdtemp(join(tmpdir(), "insightforge-run-cap-"));
  const concurrentApp = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir: concurrentWorkspace,
    stepDelayMs: 40,
  });
  const concurrentUrl = await concurrentApp.start(0, "127.0.0.1");
  try {
    const missingUpload = await createRun(concurrentUrl, ["00000000-0000-4000-8000-000000000000"]);
    assert.equal(missingUpload.response.status, 404);
    assert.equal(missingUpload.body.error, "Upload not found");
    assert.equal(concurrentApp.activeRunCount(), 0, "failed upload verification releases the reserved run slot");
    assert.equal(concurrentApp.jobCount(), 0, "failed upload verification removes the reserved job");

    const [first, second] = await Promise.all([createRun(concurrentUrl), createRun(concurrentUrl)]);
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);
    assert.equal(concurrentApp.activeRunCount(), MAX_CONCURRENT_RUNS);
    const rejected = await createRun(concurrentUrl);
    assert.equal(rejected.response.status, 429);
    assert.equal(rejected.response.headers.get("retry-after"), "1");
    assert.equal(rejected.body.code, "RUN_CAPACITY_EXCEEDED");
    assert.match(rejected.body.error ?? "", /At most 2 research runs/u);
    await Promise.all([waitForTerminal(concurrentUrl, first.body.runId!), waitForTerminal(concurrentUrl, second.body.runId!)]);
    assert.equal(concurrentApp.activeRunCount(), 0);
    const currentApi = await (await fetch(`${concurrentUrl}/api/current`)).json() as { run: { id: string } };
    const currentDisk = JSON.parse(await readFile(join(concurrentWorkspace, "current.json"), "utf8")) as { id: string };
    assert.equal(currentApi.run.id, currentDisk.id, "concurrent completion publishes one identical in-memory and persisted current run");
    assert.ok([first.body.runId, second.body.runId].includes(currentApi.run.id));
    const admitted = await createRun(concurrentUrl);
    assert.equal(admitted.response.status, 202);
    await waitForTerminal(concurrentUrl, admitted.body.runId!);
  } finally {
    await concurrentApp.stop();
  }

  const retainedWorkspace = await mkdtemp(join(tmpdir(), "insightforge-job-retention-"));
  const retainedApp = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir: retainedWorkspace, stepDelayMs: 0 });
  const retainedUrl = await retainedApp.start(0, "127.0.0.1");
  const runIds: string[] = [];
  try {
    for (let index = 0; index < MAX_RETAINED_RUNS + 2; index += 1) {
      const created = await createRun(retainedUrl);
      assert.equal(created.response.status, 202);
      runIds.push(created.body.runId!);
      assert.equal(await waitForTerminal(retainedUrl, created.body.runId!), "completed");
    }
    const deadline = Date.now() + 5_000;
    while (retainedApp.jobCount() > MAX_RETAINED_RUNS && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(retainedApp.jobCount(), MAX_RETAINED_RUNS);
    assert.equal((await fetch(`${retainedUrl}/api/runs/${runIds[0]}`)).status, 404);
    assert.equal((await fetch(`${retainedUrl}/api/runs/${runIds.at(-1)}`)).status, 200);
    await assert.rejects(stat(join(retainedWorkspace, runIds[0]!)));
    await assert.rejects(stat(join(retainedWorkspace, `${runIds[0]}-progress.json`)));
    const current = JSON.parse(await readFile(join(retainedWorkspace, "current.json"), "utf8")) as { id: string };
    assert.equal(current.id, runIds.at(-1));
  } finally {
    await retainedApp.stop();
  }

  const failureWorkspace = await mkdtemp(join(tmpdir(), "insightforge-current-retention-"));
  const failureFixtures = join(failureWorkspace, "fixtures");
  await cp(resolve("fixtures/golden"), failureFixtures, { recursive: true });
  const failureApp = createInsightForgeServer({ fixtureDir: failureFixtures, publicDir: resolve("public"), workspaceDir: failureWorkspace, stepDelayMs: 0 });
  const failureUrl = await failureApp.start(0, "127.0.0.1");
  try {
    const successful = await createRun(failureUrl);
    assert.equal(successful.response.status, 202);
    assert.equal(await waitForTerminal(failureUrl, successful.body.runId!), "completed");
    await rm(join(failureFixtures, "model-cache-manifest.json"));
    for (let index = 0; index < MAX_RETAINED_RUNS; index += 1) {
      const failedRun = await createRun(failureUrl);
      assert.equal(failedRun.response.status, 202);
      assert.equal(await waitForTerminal(failureUrl, failedRun.body.runId!), "failed");
    }
    assert.equal((await fetch(`${failureUrl}/api/runs/${successful.body.runId}`)).status, 200, "the current successful run remains protected while failed jobs are trimmed");
    assert.equal(failureApp.jobCount(), MAX_RETAINED_RUNS);
  } finally {
    await failureApp.stop();
  }
});
