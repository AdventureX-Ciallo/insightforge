import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { runApiFuzz } from "./api.fuzz.js";
import { runAuditFuzz } from "./audit.fuzz.js";
import { runEngineFuzz } from "./engine.fuzz.js";
import { runSuite, type FuzzSuiteResult, invariant } from "./harness.js";
import { runSsrfFuzz } from "./ssrf.fuzz.js";
import { runStructureFuzz } from "./structure.fuzz.js";
import { runUploadFuzz } from "./upload.fuzz.js";

const CASES = {
  engine: 30,
  structure: 172_000,
  api: 5_000,
  audit: 100_000,
  upload: 165_000,
  ssrf: 100_000,
} as const;

async function sourceLines(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await sourceLines(path);
    else if (entry.isFile() && extname(entry.name) === ".ts") count += (await readFile(path, "utf8")).split("\n").length - 1;
  }
  return count;
}

function argumentsFrom(argv: string[]) {
  let seed = 0x1f08_2826;
  let json = false;
  let reportPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--json") json = true;
    else if (value.startsWith("--seed=")) seed = Number(value.slice(7));
    else if (value === "--report") reportPath = argv[++index];
    else if (value.startsWith("--report=")) reportPath = value.slice(9);
    else throw new Error(`Unknown fuzz option: ${value}`);
  }
  invariant(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff, "Fuzz seed must be a uint32");
  return { seed: seed >>> 0, json, reportPath };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results: FuzzSuiteResult[] = [];

  const engine = await runSuite(options.seed, "engine-random-walk", (rng) => runEngineFuzz(rng, CASES.engine), ["injected failures propagate", "terminal status remains one of three", "step consumption chain remains intact"]);
  results.push(engine.result);
  const structure = await runSuite(options.seed, "research-run-structure", (rng) => runStructureFuzz(rng, CASES.structure, engine.value), ["legal ResearchRun values parse", "recursive malformed and type-polluted values fail closed", "at least 6,000 single-edge mutations of complete valid graphs fail closed"]);
  results.push(structure.result);
  const api = await runSuite(options.seed, "http-api", (rng) => runApiFuzz(rng, CASES.api), ["random methods, paths, encodings, NUL and bodies never return 5xx", "server remains healthy"]);
  results.push(api.result);
  const audit = await runSuite(options.seed, "audit-mutation", (rng) => runAuditFuzz(rng, CASES.audit), ["unsupported AI judgment downgrades", "same-period different values conflict", "input mutation changes audit output"]);
  results.push(audit.result);
  const upload = await runSuite(options.seed, "upload-whitelist", (rng) => runUploadFuzz(rng, CASES.upload, resolve(".insightforge", "fuzz")), ["non-whitelist and traversal inputs reject", "random byte failures stay typed", "successful persistence is mode 0600"]);
  results.push(upload.result);
  const ssrf = await runSuite(options.seed, "ssrf-prefetch", (rng) => runSsrfFuzz(rng, CASES.ssrf), ["reserved, loopback and malformed targets reject", "fetch count remains zero"]);
  results.push(ssrf.result);

  const lines = await sourceLines(resolve("src"));
  const targetCases = Math.max(500_000, lines * 100);
  const totalCases = results.reduce((sum, result) => sum + result.cases, 0);
  invariant(totalCases >= targetCases, `executed ${totalCases} cases, below ${targetCases} target for ${lines} source lines`);
  const report = {
    schemaVersion: "1.0",
    seed: options.seed,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    sourceLines: lines,
    casesPerSourceLine: totalCases / lines,
    targetCases,
    totalCases,
    passed: true,
    suites: results,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath) {
    const path = resolve(options.reportPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rendered, { encoding: "utf8", mode: 0o600 });
  }
  if (options.json) process.stdout.write(rendered);
  else {
    process.stdout.write(`FUZZ PASS seed=${report.seed} cases=${report.totalCases} sourceLines=${report.sourceLines} casesPerLine=${report.casesPerSourceLine.toFixed(2)} durationMs=${report.durationMs}\n`);
    for (const suite of results) process.stdout.write(`- ${suite.name}: ${suite.cases} cases, ${suite.durationMs} ms, seed=${suite.seed}\n`);
  }
}

await main();
