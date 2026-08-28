import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  evidencePackageSchema,
  type ArtifactRecord,
  type ArtifactVersion,
  type ResearchRun,
} from "./domain.js";
import { hashFile, hashValue } from "./hash.js";
import { writePptx } from "./tools/pptx-export.js";
import { writeMarkdownReport, writePdfReport } from "./tools/report-export.js";

function assertInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error("Artifact path is outside the allowed workspace");
}

export function computeResearchSnapshotId(run: ResearchRun): string {
  return hashValue({
    researchQuestion: run.researchQuestion,
    sourceVersions: run.sourceVersions,
    evidence: run.evidence,
    data: run.data,
    assumptions: run.assumptions,
    claims: run.claims,
    evidenceGaps: run.evidenceGaps,
    conclusions: run.conclusions,
    candidateRevisions: run.candidateRevisions,
    auditFindings: run.auditFindings,
    humanDecisions: run.humanDecisions,
  });
}

function packageFor(run: ResearchRun) {
  return evidencePackageSchema.parse({
    schemaVersion: run.schemaVersion,
    researchQuestion: run.researchQuestion,
    synthesisMode: run.synthesisMode,
    sourceDiscoveryMode: run.sourceDiscoveryMode,
    authorityVerificationMode: run.authorityVerificationMode,
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
    auditFindings: run.auditFindings,
    humanDecisions: run.humanDecisions,
    artifactVersions: run.artifactVersions,
    researchSnapshotId: run.researchSnapshotId,
    modelProvenance: run.modelProvenance,
    artifacts: [...run.artifacts, ...run.artifactHistory].map((item) => ({ kind: item.kind, fileName: item.fileName })),
  });
}

async function record(path: string, kind: ArtifactRecord["kind"], version: number, id: string): Promise<ArtifactRecord> {
  const info = await stat(path);
  return { id, kind, path, sha256: await hashFile(path), sizeBytes: info.size, fileName: basename(path), version };
}

/** 每次可见状态变化均新增不可覆盖版本；run.artifacts 当前版本在前，历史版本随后保留。 */
export async function writeArtifactVersion(
  run: ResearchRun,
  workspaceDir: string,
  trigger: ArtifactVersion["trigger"],
  context: { triggerRef: string; adjustmentNote: string },
): Promise<ArtifactRecord[]> {
  const version = Math.max(0, ...run.artifactVersions.map((item) => item.version)) + 1;
  const versionDir = join(resolve(workspaceDir), run.id, "artifacts", `v${version}`);
  assertInside(workspaceDir, versionDir);
  await mkdir(versionDir, { recursive: true });

  for (const item of run.artifactVersions) if (item.status === "CURRENT") item.status = "SUPERSEDED";
  const previous = [...run.artifactVersions].sort((a, b) => b.version - a.version)[0] ?? null;
  run.researchSnapshotId = computeResearchSnapshotId(run);
  const pptxPath = join(versionDir, "insightforge-report.pptx");
  const jsonPath = join(versionDir, "evidence-package.json");
  const markdownPath = join(versionDir, "insightforge-report.md");
  const pdfPath = join(versionDir, "insightforge-report.pdf");
  const pptxId = hashValue({ runId: run.id, version, kind: "PPTX" });
  const jsonId = hashValue({ runId: run.id, version, kind: "EVIDENCE_JSON" });
  const markdownId = hashValue({ runId: run.id, version, kind: "REPORT_MD" });
  const pdfId = hashValue({ runId: run.id, version, kind: "REPORT_PDF" });
  const artifactVersion: ArtifactVersion = {
    id: hashValue({ runId: run.id, version, trigger, researchSnapshotId: run.researchSnapshotId }),
    researchSnapshotId: run.researchSnapshotId,
    version,
    createdAt: new Date().toISOString(),
    trigger,
    triggerRef: context.triggerRef,
    adjustmentNote: context.adjustmentNote,
    artifactIds: [pptxId, jsonId, markdownId, pdfId],
    sources: structuredClone(run.sources),
    evidence: structuredClone(run.evidence),
    conclusions: structuredClone(run.conclusions),
    status: "CURRENT",
    supersedesId: previous?.id ?? null,
  };
  run.artifactVersions.push(artifactVersion);

  await writePptx(run, pptxPath);
  // 当前版本先以稳定文件名进入包；文件字节哈希由外层 ArtifactRecord 记录，避免 JSON 自哈希递归。
  const historical = [...run.artifacts, ...run.artifactHistory];
  run.artifactHistory = historical;
  run.artifacts = [
    { id: pptxId, kind: "PPTX", path: pptxPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(pptxPath), version },
    { id: jsonId, kind: "EVIDENCE_JSON", path: jsonPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(jsonPath), version },
    { id: markdownId, kind: "REPORT_MD", path: markdownPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(markdownPath), version },
    { id: pdfId, kind: "REPORT_PDF", path: pdfPath, sha256: "0".repeat(64), sizeBytes: 1, fileName: basename(pdfPath), version },
  ];
  await writeMarkdownReport(run, markdownPath);
  await writePdfReport(run, pdfPath);
  await writeFile(jsonPath, `${JSON.stringify(packageFor(run), null, 2)}\n`, "utf8");
  const current = [
    await record(pptxPath, "PPTX", version, pptxId),
    await record(jsonPath, "EVIDENCE_JSON", version, jsonId),
    await record(markdownPath, "REPORT_MD", version, markdownId),
    await record(pdfPath, "REPORT_PDF", version, pdfId),
  ];
  run.artifacts = current;
  return current;
}

export async function persistRun(run: ResearchRun, workspaceDir: string) {
  const runDir = join(resolve(workspaceDir), run.id);
  assertInside(workspaceDir, runDir);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(join(resolve(workspaceDir), "current.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}
