import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { outputIsInsideRepository } from "../scripts/package-path.mjs";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const FIXTURE_BYTE_RULE = /^fixtures\/\*\*\s+-text(?:\s*(?:#.*)?)?$/mu;

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
    assert.ok(paths.includes(".gitattributes"), "source archive must preserve fixture byte-stability policy");
    assert.ok(paths.includes("fixtures/golden/market-brief.pdf"));
    assert.ok(paths.includes("fixtures/golden/market_v1.csv"));
    const cacheManifest = JSON.parse(await archive.file("fixtures/golden/model-cache-manifest.json")!.async("string")) as { files: Record<string, string> };
    for (const [fileName, expectedSha256] of Object.entries(cacheManifest.files)) {
      const bytes = await archive.file(`fixtures/golden/${fileName}`)!.async("uint8array");
      assert.equal(sha256(bytes), expectedSha256, `source archive changed authenticated fixture ${fileName}`);
    }
    const packageManifest = JSON.parse(await readFile(`${archivePath}.manifest.json`, "utf8")) as {
      exclusions: { paths: string[]; directories: string[] };
    };
    assert.deepEqual(packageManifest.exclusions.paths, ["demo-assets", "docs/assets"]);
    assert.ok(packageManifest.exclusions.directories.includes(".insightforge"), "runtime settings and API keys must never enter source ZIPs");
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

test("golden fixtures are byte-stable under Windows Git autocrlf clones", async (context) => {
  const attributes = await readFile(resolve(".gitattributes"), "utf8");
  assert.match(attributes, FIXTURE_BYTE_RULE);
  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.error && "code" in gitVersion.error && gitVersion.error.code === "ENOENT") {
    context.skip("Git executable unavailable; static fixture attribute contract passed");
    return;
  }
  assert.equal(gitVersion.status, 0, gitVersion.stderr);

  const directory = await mkdtemp(join(tmpdir(), "insightforge-autocrlf-"));
  const source = join(directory, "source");
  const clone = join(directory, "clone");
  try {
    await mkdir(source);
    await cp(resolve(".gitattributes"), join(source, ".gitattributes"));
    await cp(resolve("fixtures"), join(source, "fixtures"), { recursive: true });
    await writeFile(join(source, "control.txt"), "outside\nfixtures\n", "utf8");

    const randomFixturePaths: string[] = [];
    const runNonce = randomBytes(8).toString("hex");
    for (let index = 0; index < 64; index += 1) {
      const extension = ["json", "csv", "txt", "xml", "md", "bin"][index % 6]!;
      const depth = index === 0 ? 0 : randomBytes(1)[0]! % 7;
      const segments = Array.from({ length: depth }, (_unused, segmentIndex) => [
        `ascii-${randomBytes(3).toString("hex")}`,
        `空 格-${segmentIndex}`,
        `emoji-🧪-${segmentIndex}`,
      ][(index + segmentIndex) % 3]!);
      const fileStem = [`case-${index}`, `中文-${index}`, `with space-${index}`, `emoji-🚀-${index}`][index % 4]!;
      const relativePath = index === 0
        ? join("fixtures", `direct-${runNonce}.${extension}`)
        : join("fixtures", "random", ...segments, `${fileStem}.${extension}`);
      await mkdir(join(source, relativePath, ".."), { recursive: true });
      const contents = [
        "",
        `single-${index}`,
        `row-${index}\nvalue-${randomBytes(8).toString("hex")}\n`,
        `row-${index}\r\nvalue-${randomBytes(8).toString("hex")}\r\n`,
        `mixed-${index}\nvalue\r\ntail\n`,
      ][index % 5]!;
      await writeFile(join(source, relativePath), contents, "utf8");
      randomFixturePaths.push(relativePath.replaceAll("\\", "/"));
    }

    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(git(source, "init", "--quiet").status, 0);
    assert.equal(git(source, "config", "user.email", "fixture-test@example.invalid").status, 0);
    assert.equal(git(source, "config", "user.name", "Fixture Test").status, 0);
    assert.equal(git(source, "config", "core.autocrlf", "false").status, 0);
    assert.equal(git(source, "add", ".").status, 0);
    assert.equal(git(source, "commit", "--quiet", "-m", "fixture bytes").status, 0);
    const cloned = spawnSync("git", ["-c", "core.autocrlf=true", "clone", "--quiet", source, clone], { encoding: "utf8" });
    assert.equal(cloned.status, 0, cloned.stderr);

    const listed = git(source, "-c", "core.quotepath=false", "ls-files", "-z", "fixtures");
    assert.equal(listed.status, 0, listed.stderr);
    const fixturePaths = listed.stdout.split("\0").filter(Boolean);
    const indexedFixturePaths = new Set(fixturePaths);
    for (const relativePath of randomFixturePaths) assert.ok(indexedFixturePaths.has(relativePath), `${relativePath} was not indexed`);
    for (const relativePath of fixturePaths) {
      assert.deepStrictEqual(await readFile(join(clone, relativePath)), await readFile(join(source, relativePath)), `${relativePath}; nonce=${runNonce}`);
    }
    assert.match(await readFile(join(clone, ".gitattributes"), "utf8"), FIXTURE_BYTE_RULE);
    assert.equal(await readFile(join(clone, "control.txt"), "utf8"), "outside\r\nfixtures\r\n", "control proves autocrlf conversion was active");
    for (const checkout of [source, clone]) {
      const manifest = JSON.parse(await readFile(join(checkout, "fixtures/golden/model-cache-manifest.json"), "utf8")) as { files: Record<string, string> };
      for (const [fileName, expectedSha256] of Object.entries(manifest.files)) {
        assert.equal(sha256(await readFile(join(checkout, "fixtures/golden", fileName))), expectedSha256, `${checkout}: ${fileName}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict typechecking includes unit, fuzz, and browser test sources", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(manifest.scripts.typecheck!, /tsconfig\.tests\.json/u);
  const config = JSON.parse(await readFile(resolve("tsconfig.tests.json"), "utf8")) as { include: string[] };
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts", "e2e/**/*.ts"]);
});
