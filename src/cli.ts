import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runGoldenCase } from "./engine.js";

const QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

interface CliOptions {
  question: string;
  llmMode: "cached" | "auto";
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { question: QUESTION, llmMode: "cached" };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--question" || arg === "-q") {
      const value = argv[i + 1];
      if (!value) throw new Error("--question needs a value");
      options.question = value;
      i += 1;
    } else if (arg === "--llm") {
      options.llmMode = "auto";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export async function executeDemo(index: number, root: string, options: CliOptions) {
  const started = performance.now();
  const workspaceDir = join(root, ".insightforge", "cli-demo", `${Date.now()}-${index}`);
  await mkdir(workspaceDir, { recursive: true });
  const run = await runGoldenCase({
    researchQuestion: options.question,
    fixtureDir: join(root, "fixtures", "golden"),
    workspaceDir,
    llmMode: options.llmMode,
  });
  return {
    index,
    runId: run.id,
    terminalStatus: run.terminalStatus,
    synthesisMode: run.synthesisMode,
    steps: run.steps.map((step) => `${step.state}:${step.status}`),
    toolCalls: run.events.map((event) => event.toolName),
    conclusions: run.conclusions.map((conclusion) => ({ id: conclusion.id, status: conclusion.evidenceStatus, text: conclusion.text })),
    repairAttempts: run.repairAttempts,
    artifacts: run.artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    durationMs: Math.round(performance.now() - started),
  };
}

export async function runCli(argv: string[] = process.argv, root = process.cwd(), executor = executeDemo) {
  const command = argv[2] ?? "demo";
  if (command !== "demo" && command !== "triple") throw new Error("Usage: insightforge demo|triple [--question <q>] [--llm]");
  const options = parseArgs(argv);
  const count = command === "triple" ? 3 : 1;
  const results = [];
  for (let index = 1; index <= count; index += 1) results.push(await executor(index, root, options));
  const successful = results.every((result) => result.terminalStatus === "NEEDS_REVIEW" && result.steps.every((step) => step.endsWith(":success")));
  console.log(JSON.stringify({ successful, runs: results }, null, 2));
  if (!successful) process.exitCode = 1;
  return { successful, runs: results };
}

export function cliErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Demo failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch((error) => {
    console.error(cliErrorMessage(error));
    process.exitCode = 1;
  });
}
