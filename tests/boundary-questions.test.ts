import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildBoundaryQuestions } from "../src/boundary-questions.js";
import { createInsightForgeServer } from "../src/server.js";
import { fetchForPoll } from "./http-poll.js";

async function completedRun(baseUrl: string, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetchForPoll(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { run?: Parameters<typeof buildBoundaryQuestions>[0] };
    if (body.run) return body.run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for completed run");
}

test("boundary API returns three traceable gaps and never presents an unfinished run as complete", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-boundary-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 30,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const created = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    const { runId } = await created.json() as { runId: string };
    assert.equal((await fetch(`${baseUrl}/api/runs/${runId}/boundary-questions`)).status, 409);

    const run = await completedRun(baseUrl, runId);
    const response = await fetch(`${baseUrl}/api/runs/${runId}/boundary-questions`);
    assert.equal(response.status, 200);
    const questions = await response.json() as Array<{
      question: string;
      rationale: string;
      missingEvidence: string[];
      evidenceGapIds: string[];
    }>;
    assert.equal(questions.length, 3);
    assert.ok(questions.every((item) => item.question.endsWith("？") && item.rationale && item.missingEvidence.length > 0));
    const existingGapId = run.evidenceGaps.find((item) => item.resolvedAt === null)?.id;
    assert.ok(existingGapId && questions.some((item) => item.evidenceGapIds.includes(existingGapId)));
    assert.ok(questions.flatMap((item) => item.missingEvidence).some((item) => /区域|城市/u.test(item)));
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/boundary-questions`)).status, 404);

    const changed = buildBoundaryQuestions({ ...run, researchQuestion: "中国工业机器人出口增长是否受海外认证约束？" });
    assert.notDeepEqual(changed.map((item) => item.question), questions.map((item) => item.question));
  } finally {
    await app.stop();
  }
});
