import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { cliErrorMessage, executeDemo, parseArgs, runCli } from "../src/cli.js";

function result(index: number, terminalStatus = "NEEDS_REVIEW", steps = ["PLAN:success"]) {
  return {
    index,
    runId: `run-${index}`,
    terminalStatus,
    synthesisMode: "PROGRAM_VALIDATED_CACHED_MODEL",
    steps,
    toolCalls: [],
    conclusions: [],
    repairAttempts: 0,
    artifacts: [],
    durationMs: 1,
  };
}

test("CLI parses every supported option and rejects missing or unknown arguments", () => {
  assert.deepEqual(parseArgs(["node", "cli", "demo"]), {
    question: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    llmMode: "cached",
  });
  assert.deepEqual(parseArgs(["node", "cli", "demo", "--question", "一个足够长的研究问题", "--llm"]), {
    question: "一个足够长的研究问题",
    llmMode: "auto",
  });
  assert.equal(parseArgs(["node", "cli", "demo", "-q", "另一个足够长的研究问题"]).question, "另一个足够长的研究问题");
  assert.throws(() => parseArgs(["node", "cli", "demo", "--question"]), /needs a value/u);
  assert.throws(() => parseArgs(["node", "cli", "demo", "--unknown"]), /Unknown option/u);
  assert.equal(cliErrorMessage(new Error("specific")), "specific");
  assert.equal(cliErrorMessage("not an Error"), "Demo failed");
});

test("CLI demo/triple execution reports success and fails closed on bad terminal states or steps", async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  console.log = (value?: unknown) => { logged.push(String(value)); };
  try {
    process.exitCode = undefined;
    const demo = await runCli(["node", "cli"], "/tmp/cli-root", async (index) => result(index) as never);
    assert.equal(demo.successful, true);
    assert.equal(demo.runs.length, 1);

    const triple = await runCli(["node", "cli", "triple"], "/tmp/cli-root", async (index) => result(index) as never);
    assert.equal(triple.successful, true);
    assert.deepEqual(triple.runs.map((item) => item.index), [1, 2, 3]);

    const terminalFailure = await runCli(["node", "cli", "demo"], "/tmp/cli-root", async (index) => result(index, "FAILED") as never);
    assert.equal(terminalFailure.successful, false);
    assert.equal(process.exitCode, 1);

    process.exitCode = undefined;
    const stepFailure = await runCli(["node", "cli", "demo"], "/tmp/cli-root", async (index) => result(index, "NEEDS_REVIEW", ["PLAN:failed"]) as never);
    assert.equal(stepFailure.successful, false);
    assert.equal(process.exitCode, 1);
    assert.ok(logged.every((value) => JSON.parse(value).runs.length >= 1));
    await assert.rejects(runCli(["node", "cli", "invalid"], "/tmp/cli-root", async (index) => result(index) as never), /Usage/u);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
});

test("CLI real executor returns the owner-facing run summary and direct entrypoint rejects unknown commands", async () => {
  const summary = await executeDemo(1, resolve("."), {
    question: "这个自定义研究问题用于验证 CLI 是否真实执行完整流程并产生可观察结果",
    llmMode: "cached",
  });
  assert.equal(summary.index, 1);
  assert.equal(summary.terminalStatus, "NEEDS_REVIEW");
  assert.ok(summary.steps.every((step) => step.endsWith(":success")));
  assert.ok(summary.durationMs >= 0);

  const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "invalid"], {
    cwd: resolve("."),
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage: insightforge/u);
});
