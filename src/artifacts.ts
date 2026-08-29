import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  evidencePackageSchema,
  MAX_ARTIFACT_VERSIONS,
  computeResearchSnapshotId,
  researchRunSchema,
  type ArtifactRecord,
  type ArtifactVersion,
  type ResearchRun,
} from "./domain.js";
import { atomicWriteJson } from "./atomic-file.js";
import { hashFile, hashValue } from "./hash.js";
import { writePptx } from "./tools/pptx-export.js";
import { writeMarkdownReport, writePdfReport } from "./tools/report-export.js";
function assertInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error("Artifact path is outside the allowed workspace");
}
function packageFor(run: ResearchRun) {
  return evidencePackageSchema.parse({
    schemaVersion: run.schemaVersion,
    researchQuestion: run.researchQuestion,
    synthesisMode: run.synthesisMode,
    sourceDiscoveryMode: run.sourceDiscoveryMode,
    authorityVerificationMode: run.authorityVerificationMode,
    offlineMode: run.offlineMode,
    offlineModeLabel: run.offlineModeLabel,
    sourceLimitTrace: run.sourceLimitTrace,
    sources: run.sources,
    sourceVersions: run.sourceVersions,
    evidence: run.evidence,
    data: run.data,
    assumptions: run.assumptions,
    claims: run.claims,
    evidenceGaps: run.evidenceGaps,
    conclusions: run.conclusions,
    candidateRevisions: run.candidateRevisions,
    rejectedDrafts: run.rejectedDrafts,
    rejectedDraftOverflowCount: run.rejectedDraftOverflowCount,
    auditFindings: run.auditFindings,
    humanDecisions: run.humanDecisions,
    artifactVersions: run.artifactVersions,
    researchSnapshotId: run.researchSnapshotId,
    modelProvenance: run.modelProvenance,
    artifacts: [...run.artifacts, ...run.artifactHistory].map((item) => ({ kind: item.kind, fileName: item.fileName })),
  });
}
async function record(readPath: string, kind: ArtifactRecord["kind"], version: number, id: string, publishedPath = readPath): Promise<ArtifactRecord> {
  const info = await stat(readPath);
  return { id, kind, path: publishedPath, sha256: await hashFile(readPath), sizeBytes: info.size, fileName: basename(publishedPath), version };
}
/** 每次可见状态变化均新增不可覆盖版本；run.artifacts 当前版本在前，历史版本随后保留。 */
export async function writeArtifactVersion(
  run: ResearchRun,
  workspaceDir: string,
  trigger: ArtifactVersion["trigger"],
  context: { triggerRef: string; adjustmentNote: string },
): Promise<ArtifactRecord[]> {
  const version = Math.max(0, ...run.artifactVersions.map((item) => item.version)) + 1;
  const artifactsRoot = join(resolve(workspaceDir), run.id, "artifacts");
  const versionDir = join(artifactsRoot, `v${version}`);
  const stagingDir = join(artifactsRoot, `.v${version}-${randomUUID()}.staging`);
  assertInside(workspaceDir, versionDir);
  assertInside(workspaceDir, stagingDir);
  await mkdir(artifactsRoot, { recursive: true });
  try {
    await stat(versionDir);
    throw new Error(`Artifact version target v${version} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(stagingDir);
  const nextRun = structuredClone(run);
  for (const item of nextRun.artifactVersions) if (item.status === "CURRENT") item.status = "SUPERSEDED";
  const previous = [...nextRun.artifactVersions].sort((a, b) => b.version - a.version)[0] ?? null;
  nextRun.researchSnapshotId = computeResearchSnapshotId(nextRun);
  const pptxPath = join(versionDir, "insightforge-report.pptx");
  const jsonPath = join(versionDir, "evidence-package.json");
  const markdownPath = join(versionDir, "insightforge-report.md");
  const pdfPath = join(versionDir, "insightforge-report.pdf");
  const stagingPptxPath = join(stagingDir, basename(pptxPath));
  const stagingJsonPath = join(stagingDir, basename(jsonPath));
  const stagingMarkdownPath = join(stagingDir, basename(markdownPath));
  const stagingPdfPath = join(stagingDir, basename(pdfPath));
  const pptxId = hashValue({ runId: run.id, version, kind: "PPTX" });
  const jsonId = hashValue({ runId: run.id, version, kind: "EVIDENCE_JSON" });
  const markdownId = hashValue({ runId: run.id, version, kind: "REPORT_MD" });
  const pdfId = hashValue({ runId: run.id, version, kind: "REPORT_PDF" });
  const artifactVersion: ArtifactVersion = {
    id: hashValue({ runId: run.id, version, trigger, researchSnapshotId: nextRun.researchSnapshotId }),
    researchSnapshotId: nextRun.researchSnapshotId,
    version,
    createdAt: new Date().toISOString(),
    trigger,
    triggerRef: context.triggerRef,
    adjustmentNote: context.adjustmentNote,
    artifactIds: [pptxId, jsonId, markdownId, pdfId],
    sources: structuredClone(nextRun.sources),
    evidence: structuredClone(nextRun.evidence),
    conclusions: structuredClone(nextRun.conclusions),
    rejectedDrafts: structuredClone(nextRun.rejectedDrafts),
    rejectedDraftOverflowCount: nextRun.rejectedDraftOverflowCount,
    status: "CURRENT",
    supersedesId: previous?.id ?? null,
  };
  nextRun.artifactVersions.push(artifactVersion);
  const evictedVersions = nextRun.artifactVersions.sort((left, right) => left.version - right.version).splice(0, Math.max(0, nextRun.artifactVersions.length - MAX_ARTIFACT_VERSIONS));
  const evictedVersionNumbers = new Set(evictedVersions.map((item) => item.version));
  nextRun.evictedArtifactVersionCount += evictedVersions.length;
  // 当前版本先以最终稳定路径进入包；字节在同目录 staging 中生成并核验，避免 JSON 自哈希递归。
  const historical = [...nextRun.artifacts, ...nextRun.artifactHistory].filter((item) => !evictedVersionNumbers.has(item.version));
  nextRun.artifactHistory = historical;
  nextRun.artifacts = [
    { id: pptxId, kind: "PPTX", path: pptxPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(pptxPath), version },
    { id: jsonId, kind: "EVIDENCE_JSON", path: jsonPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(jsonPath), version },
    { id: markdownId, kind: "REPORT_MD", path: markdownPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(markdownPath), version },
    { id: pdfId, kind: "REPORT_PDF", path: pdfPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(pdfPath), version },
  ];
  try {
    await writePptx(nextRun, stagingPptxPath);
    await writeMarkdownReport(nextRun, stagingMarkdownPath);
    await writePdfReport(nextRun, stagingPdfPath);
    await writeFile(stagingJsonPath, `${JSON.stringify(packageFor(nextRun), null, 2)}\n`, "utf8");
    const current = [
      await record(stagingPptxPath, "PPTX", version, pptxId, pptxPath),
      await record(stagingJsonPath, "EVIDENCE_JSON", version, jsonId, jsonPath),
      await record(stagingMarkdownPath, "REPORT_MD", version, markdownId, markdownPath),
      await record(stagingPdfPath, "REPORT_PDF", version, pdfId, pdfPath),
    ];
    nextRun.artifacts = current;
    await rename(stagingDir, versionDir);
    run.researchSnapshotId = nextRun.researchSnapshotId;
    run.artifactVersions = nextRun.artifactVersions;
    run.evictedArtifactVersionCount = nextRun.evictedArtifactVersionCount;
    run.artifactHistory = nextRun.artifactHistory;
    run.artifacts = current;
    return current;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
export async function persistRun(run: ResearchRun, workspaceDir: string, updateCurrent = true) {
  const runDir = join(resolve(workspaceDir), run.id);
  assertInside(workspaceDir, runDir);
  await mkdir(runDir, { recursive: true });
  await atomicWriteJson(join(runDir, "run.json"), run);
  if (updateCurrent) await atomicWriteJson(join(resolve(workspaceDir), "current.json"), run);
  const artifactsDir = join(runDir, "artifacts");
  let entries;
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const retained = new Set(run.artifactVersions.map((version) => `v${version.version}`));
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^v[1-9]\d*$/u.test(entry.name) || retained.has(entry.name)) continue;
    const evictedDir = join(artifactsDir, entry.name);
    assertInside(workspaceDir, evictedDir);
    try {
      await rm(evictedDir, { recursive: true, force: true });
    } catch {
      // The run/current snapshots are already atomically published. Garbage collection is
      // therefore best-effort: a cleanup failure must not make callers retry a committed mutation.
    }
  }
}

export class PersistedRunRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedRunRecoveryError";
  }
}

interface RunCandidate {
  path: string;
  modifiedAt: number;
  run: ResearchRun;
}

async function loadRunCandidate(path: string): Promise<RunCandidate | null> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { path, modifiedAt: info.mtimeMs, run: researchRunSchema.parse(JSON.parse(raw) as unknown) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PersistedRunRecoveryError(`Persisted run state is invalid: ${path}`);
  }
}

/** Restore the newest schema-valid run snapshot and repair a missing/corrupt current.json. */
export async function loadPersistedRun(workspaceDir: string): Promise<ResearchRun | null> {
  const root = resolve(workspaceDir);
  const currentPath = join(root, "current.json");
  const candidates: RunCandidate[] = [];
  let currentInvalid = false;
  try {
    const current = await loadRunCandidate(currentPath);
    if (current) candidates.push(current);
  } catch {
    currentInvalid = true;
  }

  let invalidRunSnapshot = false;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const candidate = await loadRunCandidate(join(root, entry.name, "run.json"));
      if (candidate) candidates.push(candidate);
    } catch {
      invalidRunSnapshot = true;
    }
  }

  if (candidates.length === 0) {
    if (currentInvalid || invalidRunSnapshot) {
      throw new PersistedRunRecoveryError("Persisted run state is corrupt and no valid run snapshot can be recovered");
    }
    return null;
  }
  const selected = candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]!;
  if (selected.path !== currentPath) await atomicWriteJson(currentPath, selected.run);
  return selected.run;
}
