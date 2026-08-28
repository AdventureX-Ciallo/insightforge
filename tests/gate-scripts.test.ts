import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { outputIsInsideRepository } from "../scripts/package-path.mjs";

test("test, coverage, and fuzz gates do not depend on POSIX env syntax or shell globs", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts: Record<string, string>; bin: Record<string, string>; engines: { node: string } };
  for (const name of ["test", "coverage", "fuzz", "fuzz:report"]) {
    const command = manifest.scripts[name]!;
    assert.match(command, /scripts\/test-command\.mjs/u);
    assert.doesNotMatch(command, /(?:^|\s)(?:NODE_ENV|INSIGHTFORGE_DISABLE_REQUEST_KEY)=/u);
    assert.doesNotMatch(command, /tests\/\*\.test\.ts|'src\/\*\*'/u);
  }

  const invalid = spawnSync(process.execPath, [resolve("scripts/test-command.mjs"), "unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage: node scripts\/test-command\.mjs tests\|fuzz/u);
  const c8Manifest = JSON.parse(await readFile(resolve("node_modules/c8/package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(manifest.engines.node, c8Manifest.engines.node, "project Node range must not claim versions rejected by the coverage gate dependency");
});

test("the aggregate verification gate cannot omit contract or fuzz checks", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts: Record<string, string>; bin: Record<string, string> };
  assert.match(manifest.scripts.verify!, /(?:^|&&\s*)npm run contract:check(?:\s*&&|$)/u);
  assert.match(manifest.scripts["contract:check"]!, /scripts\/contract-check\.mjs/u);
  assert.match(manifest.scripts.verify!, /(?:^|&&\s*)npm run fuzz(?:\s*&&|$)/u);
  for (const metric of ["statements", "branches", "functions", "lines"]) assert.match(manifest.scripts.coverage!, new RegExp(`--${metric} 100`, "u"));
  assert.equal(manifest.bin.insightforge, "./dist/server.js");
  for (const lifecycle of ["prestart", "predemo", "predemo:triple", "presmoke"]) assert.match(manifest.scripts[lifecycle]!, /npm run build/u);
});

test("source packaging excludes presentation assets but retains executable golden fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-package-policy-"));
  const archivePath = join(directory, "source.zip");
  try {
    const result = spawnSync(process.execPath, [resolve("scripts/package-source.mjs"), archivePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const archive = await JSZip.loadAsync(await readFile(archivePath));
    const paths = Object.keys(archive.files);
    assert.equal(paths.some((path) => path.startsWith("demo-assets/") || path.startsWith("docs/assets/")), false);
    assert.ok(paths.includes("fixtures/golden/market-brief.pdf"));
    assert.ok(paths.includes("fixtures/golden/market_v1.csv"));
    const packageManifest = JSON.parse(await readFile(`${archivePath}.manifest.json`, "utf8")) as {
      exclusions: { paths: string[] };
    };
    assert.deepEqual(packageManifest.exclusions.paths, ["demo-assets", "docs/assets"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package guard treats Windows path casing as equivalent", () => {
  assert.equal(outputIsInsideRepository("/Users/Owner/InsightForge", "/users/owner/insightforge/source.zip", "win32"), true);
  assert.equal(outputIsInsideRepository("/Users/Owner/InsightForge", "/Users/Owner/Elsewhere/source.zip", "win32"), false);
});

test("secret scan sees a gitignored .env from the filesystem, not only the Git index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-secret-scan-"));
  try {
    await mkdir(join(directory, "scripts"));
    await cp(resolve("scripts/secret-scan.mjs"), join(directory, "scripts/secret-scan.mjs"));
    await writeFile(join(directory, ".gitignore"), ".env\n", "utf8");
    await writeFile(join(directory, ".env"), "LOCAL_ONLY=placeholder\n", "utf8");
    const result = spawnSync(process.execPath, [join(directory, "scripts/secret-scan.mjs")], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env: forbidden credential file name/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clean declares every generated runtime and test directory", async () => {
  const script = await readFile(resolve("scripts/clean.mjs"), "utf8");
  for (const directory of ["dist", "coverage", "coverage-detail", ".insightforge", "evidence", "test-results", "playwright-report"]) {
    assert.match(script, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("coverage evidence is regenerated by the gate instead of committed from one machine", async () => {
  const ignore = await readFile(resolve(".gitignore"), "utf8");
  assert.match(ignore, /^coverage-detail\/$/mu);
});

test("strict typechecking includes unit, fuzz, and browser test sources", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(manifest.scripts.typecheck!, /tsconfig\.tests\.json/u);
  const config = JSON.parse(await readFile(resolve("tsconfig.tests.json"), "utf8")) as { include: string[] };
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts", "e2e/**/*.ts"]);
});
