import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";

import { workflowStates } from "../src/domain.js";
import {
  createInsightForgeServer,
  MAX_SSE_SUBSCRIBERS_PER_RUN,
  MAX_TOTAL_SSE_SUBSCRIBERS,
  writeSseChunk,
} from "../src/server.js";
import { fetchForPoll } from "./http-poll.js";

interface SseMessage {
  event: string;
  data?: {
    runId: string;
    status?: string;
    reason?: string;
    reconnect?: boolean;
    steps?: Array<{ state: string; status: string; error?: string | null }>;
    event?: { toolName: string; status: string; error?: string | null };
  };
}

function parseSseBlock(block: string): SseMessage | null {
  const lines = block.split("\n");
  if (lines.some((line) => line.startsWith(":"))) return { event: "heartbeat" };
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  return event && data ? { event, data: JSON.parse(data) as NonNullable<SseMessage["data"]> } : null;
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
    const response = await fetchForPoll(`${baseUrl}/api/runs/${runId}`);
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

    const persistedCurrent = JSON.parse(await readFile(join(workspaceDir, "current.json"), "utf8")) as { id: string };
    assert.ok([firstRunId, secondRunId].includes(persistedCurrent.id), "concurrent completion publishes one intact run snapshot");
    const currentApi = await (await fetch(`${baseUrl}/api/current`)).json() as { run: { id: string } };
    assert.equal(currentApi.run.id, persistedCurrent.id, "in-memory and persisted current pointers agree after concurrent completion");

    const replay = await fetch(`${baseUrl}/api/runs/${firstRunId}/events`);
    const replayMessages = await consumeSse(replay);
    assert.ok(replayMessages.some((message) => message.event === "tool"), "completed streams replay tool history");
    assert.equal(replayMessages.at(-1)?.event, "terminal");
  } finally {
    await app.stop();
  }
});

test("SSE failure frames redact internal paths exactly like polling", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sse-redaction-"));
  const fixtureDir = join(workspaceDir, "fixtures");
  await cp(resolve("fixtures/golden"), fixtureDir, { recursive: true });
  const app = createInsightForgeServer({
    fixtureDir,
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 20,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    await rm(join(fixtureDir, "market_v1.csv"));
    const runId = await createRun(baseUrl, "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？");
    const messages = await consumeSse(await fetch(`${baseUrl}/api/runs/${runId}/events`));
    const failedSteps = messages.flatMap((message) => message.data?.steps ?? []).filter((step) => step.status === "failed");
    const failedTools = messages.map((message) => message.data?.event).filter((event) => event?.status === "failed");
    assert.ok(failedSteps.length > 0);
    assert.ok(failedSteps.every((step) => step.error === "Step failed"));
    assert.ok(failedTools.every((event) => event?.error === "Tool failed"));
    assert.doesNotMatch(JSON.stringify(messages), /ENOENT|insightforge-sse-redaction/iu);
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

test("SSE admission enforces per-run/global caps and idle streams reconnect without affecting jobs", async () => {
  const capacityWorkspace = await mkdtemp(join(tmpdir(), "insightforge-sse-capacity-"));
  const capacityApp = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir: capacityWorkspace,
    stepDelayMs: 200,
    sseHeartbeatMs: 10_000,
    sseIdleTimeoutMs: 10_000,
  });
  const capacityUrl = await capacityApp.start(0, "127.0.0.1");
  const controllers: AbortController[] = [];
  const openHeldStream = async (runId: string) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${capacityUrl}/api/runs/${runId}/events`, { signal: controller.signal });
    return response;
  };
  try {
    assert.equal(capacityApp.totalEventSubscriberCount(), 0);
    const [firstRunId, secondRunId] = await Promise.all([
      createRun(capacityUrl, "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？"),
      createRun(capacityUrl, "请评估制造企业生成式 AI 采购决策中的证据缺口与适用边界？"),
    ]);
    const firstStreams = await Promise.all(Array.from({ length: MAX_SSE_SUBSCRIBERS_PER_RUN }, () => openHeldStream(firstRunId)));
    assert.ok(firstStreams.every((response) => response.status === 200));
    await waitForSubscriberCount(capacityApp, firstRunId, MAX_SSE_SUBSCRIBERS_PER_RUN);

    const perRunRejected = await fetch(`${capacityUrl}/api/runs/${firstRunId}/events`);
    assert.equal(perRunRejected.status, 429);
    assert.equal(perRunRejected.headers.get("retry-after"), "1");
    assert.deepEqual(await perRunRejected.json(), {
      error: "SSE subscriber capacity reached; retry after an existing stream closes",
      code: "SSE_CAPACITY_EXCEEDED",
      maxSubscribersPerRun: MAX_SSE_SUBSCRIBERS_PER_RUN,
      maxTotalSubscribers: MAX_TOTAL_SSE_SUBSCRIBERS,
    });

    const remainingGlobalSlots = MAX_TOTAL_SSE_SUBSCRIBERS - MAX_SSE_SUBSCRIBERS_PER_RUN;
    const secondStreams = await Promise.all(Array.from({ length: remainingGlobalSlots }, () => openHeldStream(secondRunId)));
    assert.ok(secondStreams.every((response) => response.status === 200));
    assert.equal(capacityApp.totalEventSubscriberCount(), MAX_TOTAL_SSE_SUBSCRIBERS);
    const globalRejected = await fetch(`${capacityUrl}/api/runs/${secondRunId}/events`);
    assert.equal(globalRejected.status, 429);
    assert.equal((await globalRejected.json() as { code: string }).code, "SSE_CAPACITY_EXCEEDED");
    for (const controller of controllers) controller.abort();
    await waitForSubscriberCount(capacityApp, firstRunId, 0);
    await waitForSubscriberCount(capacityApp, secondRunId, 0);
    assert.equal(capacityApp.totalEventSubscriberCount(), 0);
    assert.equal((await waitForTerminal(capacityUrl, firstRunId)).job.status, "completed");
    assert.equal((await waitForTerminal(capacityUrl, secondRunId)).job.status, "completed");
  } finally {
    for (const controller of controllers) controller.abort();
    await capacityApp.stop();
  }

  const idleWorkspace = await mkdtemp(join(tmpdir(), "insightforge-sse-idle-"));
  const idleApp = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir: idleWorkspace,
    stepDelayMs: 100,
    sseHeartbeatMs: 5,
    sseIdleTimeoutMs: 20,
  });
  const idleUrl = await idleApp.start(0, "127.0.0.1");
  try {
    const runId = await createRun(idleUrl, "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？");
    const messages = await consumeSse(await fetch(`${idleUrl}/api/runs/${runId}/events`));
    assert.ok(messages.some((message) => message.event === "heartbeat"), "heartbeats do not reset the business-event idle timer");
    assert.deepEqual(messages.at(-1), { event: "stream-end", data: { runId, reason: "idle-timeout", reconnect: true } });
    await waitForSubscriberCount(idleApp, runId, 0);
    assert.equal((await waitForTerminal(idleUrl, runId)).job.status, "completed", "closing an idle stream never cancels the background run");
  } finally {
    await idleApp.stop();
  }
});

test("every SSE disconnect race is isolated from the research job and HTTP process", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-sse-race-"));
  let mode: "normal" | "initial" | "publish" | "heartbeat" | "toolReplay" = "normal";
  let stepWrites = 0;
  const failTransport = (response: ServerResponse) => {
    response.emit("error", new Error(`injected ${mode} SSE failure`));
    response.destroy();
    return false;
  };
  const sseWriter = (response: ServerResponse, chunk: string) => {
    if (mode === "initial") return failTransport(response);
    if (mode === "heartbeat" && chunk.startsWith(":")) return failTransport(response);
    if (mode === "toolReplay" && chunk.startsWith("event: tool")) return failTransport(response);
    if (mode === "publish" && chunk.startsWith("event: step") && ++stepWrites === 2) return failTransport(response);
    return writeSseChunk(response, chunk);
  };
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 40,
    sseHeartbeatMs: 5,
    sseWriter,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  const question = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";
  const expectBrokenStream = async (runId: string) => {
    await assert.rejects(async () => {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/events`);
      await response.text();
    });
  };
  try {
    mode = "initial";
    const initialRunId = await createRun(baseUrl, question);
    await expectBrokenStream(initialRunId);
    assert.equal((await waitForTerminal(baseUrl, initialRunId)).job.status, "completed");

    mode = "publish";
    stepWrites = 0;
    const publishRunId = await createRun(baseUrl, question);
    await expectBrokenStream(publishRunId);
    assert.equal((await waitForTerminal(baseUrl, publishRunId)).job.status, "completed");
    await waitForSubscriberCount(app, publishRunId, 0);

    mode = "heartbeat";
    const heartbeatRunId = await createRun(baseUrl, question);
    await expectBrokenStream(heartbeatRunId);
    assert.equal((await waitForTerminal(baseUrl, heartbeatRunId)).job.status, "completed");
    await waitForSubscriberCount(app, heartbeatRunId, 0);

    mode = "normal";
    const replayRunId = await createRun(baseUrl, question);
    assert.equal((await waitForTerminal(baseUrl, replayRunId)).job.status, "completed");
    mode = "toolReplay";
    await expectBrokenStream(replayRunId);
    assert.equal((await waitForTerminal(baseUrl, replayRunId)).job.status, "completed");
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200, "server remains available after all injected stream failures");
  } finally {
    await app.stop();
  }
});
