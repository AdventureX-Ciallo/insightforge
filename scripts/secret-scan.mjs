import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const excludedDirectories = new Set([".git", ".insightforge", "node_modules", "dist", "evidence", "test-results", "playwright-report", ".cache", ".recordings"]);

async function walk(directory, root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, root, output);
    else if (entry.isFile()) output.push(relative(root, path));
  }
  return output;
}

let files;
try {
  files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  files = await walk(process.cwd(), process.cwd());
}
const binaryExtensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".xlsx", ".pptx", ".zip", ".webm"]);
const forbiddenNames = new Set([".env", "cookies.json", "cookies.sqlite", "credentials.json", "id_rsa", "id_ed25519"]);
const patterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { name: "assigned secret", pattern: /\b(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[^\s"']{12,}/i },
];
const findings = [];
for (const file of files) {
  if (forbiddenNames.has(basename(file)) && file !== ".env.example") findings.push(`${file}: forbidden credential file name`);
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  let text;
  try { text = await readFile(file, "utf8"); } catch { continue; }
  for (const candidate of patterns) if (candidate.pattern.test(text)) findings.push(`${file}: ${candidate.name}`);
}
if (findings.length) {
  console.error(`Secret scan failed:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${files.length} tracked/untracked files, credential files and common token shapes checked).`);
}
