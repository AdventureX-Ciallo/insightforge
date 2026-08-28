import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { workflowStates } from "../src/domain.js";
import { createInsightForgeServer } from "../src/server.js";

interface SseMessage {
  event: string;
  data?: {
    runId: string;
    status?: string;
    steps?: Array<{ state: string; status: string }>;
    event?: { toolName: string; status: string };
  };
}

function parseSseBlock(block: string): SseMessage | null {
  const lines = block.split("\n");
  if (lines.some((line) => line.startsWith(":"))) return { event: "heartbeat" };
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  return event && data ? { event, data: JSON.parse(data) as SseMessage["data"] } : null;
}

async function consumeSse(response: Response) {
  assert.ok(response.body, "SSE response must expose a real ReadableStream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    const blocks = pending.split("\n\n");
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) messages.push(parsed);
    }
    if (done) break;
  }
  return messages;
}

async function createRun(baseUrl: string, researchQuestion: string) {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ researchQuestion }),
  });
  assert.equal(response.status, 202);
  return (await response.json() as { runId: string }).runId;
}

async function waitForTerminal(baseUrl: string, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { job: { status: string }; run?: unknown };
    if (body.job.status !== "running") return body;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`run ${runId} did not terminate`);
}

async function waitForSubscriberCount(app: ReturnType<typeof createInsightForgeServer>, runId: string, count: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (app.eventSubscriberCount(runId) === count) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(app.eventSubscriberCount(runId), count);
}

test("SSE streams real steps and tools, heartbeats, terminal closure, and isolates concurrent runs", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sse-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 20,
    sseHeartbeatMs: 5,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    assert.equal((await fetch(`${baseUrl}/api/runs/missing/events`)).status, 404);
    const [firstRunId, secondRunId] = await Promise.all([
      createRun(baseUrl, "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？"),
      createRun(baseUrl, "请评估制造企业生成式 AI 采购决策中的证据缺口与适用边界？"),
    ]);
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`${baseUrl}/api/runs/${firstRunId}/events`),
      fetch(`${baseUrl}/api/runs/${secondRunId}/events`),
    ]);
    assert.equal(firstResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(firstResponse.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(firstResponse.headers.get("x-content-type-options"), "nosniff");
    const [firstMessages, secondMessages] = await Promise.all([consumeSse(firstResponse), consumeSse(secondResponse)]);

    for (const [runId, messages] of [[firstRunId, firstMessages], [secondRunId, secondMessages]] as const) {
      assert.ok(messages.some((message) => message.event === "heartbeat"), "slow live streams receive heartbeat comments");
      const dataMessages = messages.filter((message) => message.data);
      assert.ok(dataMessages.length > 0);
      assert.ok(dataMessages.every((message) => message.data?.runId === runId), "events never cross run boundaries");
      assert.ok(messages.some((message) => message.event === "tool" && message.data?.event?.status === "success"), "real tool events stream before terminal");
      const transitions = new Set(messages.flatMap((message) => message.data?.steps?.map((step) => `${step.state}:${step.status}`) ?? []));
      for (const state of workflowStates) {
        assert.ok(transitions.has(`${state}:running`), `${state} running transition is streamed`);
        assert.ok(transitions.has(`${state}:success`), `${state} success transition is streamed`);
      }
      assert.deepEqual(messages.at(-1), { event: "terminal", data: { runId, status: "completed", error: null } });
      assert.equal(app.eventSubscriberCount(runId), 0, "terminal closure removes the subscriber");
    }

    const replay = await fetch(`${baseUrl}/api/runs/${firstRunId}/events`);
    const replayMessages = await consumeSse(replay);
    assert.ok(replayMessages.some((message) => message.event === "tool"), "completed streams replay tool history");
    assert.equal(replayMessages.at(-1)?.event, "terminal");
  } finally {
    await app.stop();
  }
});

test("aborting an SSE client cleans up without cancelling or corrupting the run", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sse-abort-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 30,
    sseHeartbeatMs: 5,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const runId = await createRun(baseUrl, "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？");
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/runs/${runId}/events`, { signal: controller.signal });
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await waitForSubscriberCount(app, runId, 1);
    controller.abort();
    await assert.rejects(reader.read(), /abort/u);
    await waitForSubscriberCount(app, runId, 0);

    const terminal = await waitForTerminal(baseUrl, runId);
    assert.equal(terminal.job.status, "completed");
    assert.ok(terminal.run, "polling endpoint remains intact after stream disconnect");
  } finally {
    await app.stop();
  }
});
