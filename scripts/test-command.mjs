import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
const forwarded = process.argv.slice(3);
let childArguments;

if (mode === "tests") {
  const testDirectory = join(root, "tests");
  const fetchIsolation = join(testDirectory, "install-fetch-isolation.ts");
  const testFiles = (await readdir(testDirectory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(testDirectory, name));
  if (testFiles.length === 0) throw new Error("No test files were discovered");
  childArguments = ["--import", "tsx", "--import", fetchIsolation, "--test", "--test-concurrency=1", ...forwarded, ...testFiles];
} else if (mode === "fuzz") {
  childArguments = ["--import", "tsx", join(root, "tests", "fuzz", "run-fuzz.ts"), ...forwarded];
} else {
  throw new Error("Usage: node scripts/test-command.mjs tests|fuzz [arguments]");
}

const child = spawn(process.execPath, childArguments, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    INSIGHTFORGE_DISABLE_REQUEST_KEY: "1",
  },
});

const result = await new Promise((resolveResult, rejectResult) => {
  child.once("error", rejectResult);
  child.once("exit", (code, signal) => resolveResult({ code, signal }));
});
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code ?? 1;
