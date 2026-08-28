import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { outputIsInsideRepository } from "./package-path.mjs";

const root = process.cwd();
const requestedOutput = process.argv[2] ?? join(root, "..", "insightforge-source.zip");
const outputPath = resolve(requestedOutput);
const manifestPath = `${outputPath}.manifest.json`;

if (outputIsInsideRepository(root, outputPath)) {
  throw new Error("Source ZIP must be written outside the repository so it cannot package itself.");
}

const excludedDirectories = new Set([
  ".git",
  ".insightforge",
  ".cache",
  ".recordings",
  "artifacts",
  "coverage",
  "coverage-detail",
  "dist",
  "evidence",
  "node_modules",
  "playwright-report",
  "runs",
  "test-results",
]);
const excludedPaths = new Set([
  "demo-assets",
  "docs/assets",
]);
const forbiddenNames = new Set([
  ".env",
  "cookies.json",
  "cookies.sqlite",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);
const excludedExtensions = new Set([".log", ".webm", ".zip"]);

function excluded(relativePath, isDirectory) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => excludedDirectories.has(segment))) return true;
  if ([...excludedPaths].some((path) => relativePath === path || relativePath.startsWith(`${path}/`))) return true;
  if (isDirectory) return false;
  const name = basename(relativePath);
  if (name === ".DS_Store") return true;
  if (name.startsWith(".env") && name !== ".env.example") return true;
  if (forbiddenNames.has(name)) return true;
  return excludedExtensions.has(extname(name).toLowerCase());
}

async function collect(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (!relativePath || relativePath.startsWith("../")) throw new Error(`Unsafe package path: ${relativePath}`);
    if (excluded(relativePath, entry.isDirectory())) continue;
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the source package: ${relativePath}`);
    if (entry.isDirectory()) await collect(absolutePath, output);
    else if (entry.isFile()) output.push({ absolutePath, relativePath, mode: metadata.mode });
  }
  return output;
}

const files = await collect(root);
const zip = new JSZip();
const stableDate = new Date("2020-01-01T00:00:00.000Z");
for (const file of files) {
  zip.file(file.relativePath, await readFile(file.absolutePath), {
    binary: true,
    date: stableDate,
    unixPermissions: file.mode & 0o777,
  });
}
const archive = await zip.generateAsync({
  type: "nodebuffer",
  platform: "UNIX",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
await writeFile(outputPath, archive, { mode: 0o600 });

let baselineCommit = "NO_GIT_BASELINE";
let dirtySummary = "unavailable";
try {
  baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--short"], { encoding: "utf8" });
  dirtySummary = `${status.split(/\r?\n/).filter(Boolean).length} changed paths; sha256=${createHash("sha256").update(status).digest("hex")}`;
} catch {
  // The package remains valid in a source-only directory without Git metadata.
}

const manifest = {
  schemaVersion: "1.0",
  archive: basename(outputPath),
  baselineCommit,
  dirtySummary,
  sizeBytes: archive.byteLength,
  sha256: createHash("sha256").update(archive).digest("hex"),
  fileCount: files.length,
  exclusions: {
    directories: [...excludedDirectories].sort(),
    paths: [...excludedPaths].sort(),
    extensions: [...excludedExtensions].sort(),
    credentialFiles: [...forbiddenNames].sort(),
    environmentFiles: ".env* except .env.example",
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, manifestPath, ...manifest }, null, 2));
