import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MAX_CONCURRENT_RUNS = 2;
export const MAX_RETAINED_RUNS = 10;

const RUN_ID_SOURCE = String.raw`run-(?:\d+-[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})`;
const RUN_ID_PATTERN = new RegExp(`^${RUN_ID_SOURCE}$`, "iu");
const PROGRESS_PATTERN = new RegExp(`^(${RUN_ID_SOURCE})-progress\\.json$`, "iu");

export function progressFileRunId(fileName: string) {
  return fileName.match(PROGRESS_PATTERN)?.[1] ?? null;
}

export interface RunRetentionTrace {
  maxRetainedRuns: number;
  discoveredRunCount: number;
  retainedRunIds: string[];
  removedRunIds: string[];
  errorCount: number;
}

export type RunPathRemover = (path: string, options: { recursive: true; force: true }) => Promise<unknown>;

async function modifiedAt(path: string) {
  try {
    return { value: (await stat(path)).mtimeMs, error: false };
  } catch {
    return { value: 0, error: true };
  }
}

export async function pruneRunWorkspace(
  workspaceDir: string,
  protectedRunIds: ReadonlySet<string>,
  maxRetainedRuns = MAX_RETAINED_RUNS,
  removePath: RunPathRemover = rm,
): Promise<RunRetentionTrace> {
  const root = resolve(workspaceDir);
  const runIds = new Set<string>();
  let errorCount = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { maxRetainedRuns, discoveredRunCount: 0, retainedRunIds: [], removedRunIds: [], errorCount: 1 };
  }
  for (const entry of entries) {
    if (entry.isDirectory() && RUN_ID_PATTERN.test(entry.name)) runIds.add(entry.name);
    const progress = entry.isFile() ? progressFileRunId(entry.name) : null;
    if (progress) runIds.add(progress);
  }

  const candidates: Array<{ runId: string; modifiedAt: number }> = [];
  for (const runId of runIds) {
    const [progress, snapshot] = await Promise.all([
      modifiedAt(join(root, `${runId}-progress.json`)),
      modifiedAt(join(root, runId, "run.json")),
    ]);
    if (progress.error && snapshot.error) errorCount += 1;
    candidates.push({ runId, modifiedAt: Math.max(progress.value, snapshot.value) });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || right.runId.localeCompare(left.runId));

  const protectedCount = candidates.filter(({ runId }) => protectedRunIds.has(runId)).length;
  let availableSlots = Math.max(0, maxRetainedRuns - protectedCount);
  const retainedRunIds: string[] = [];
  const removedRunIds: string[] = [];
  for (const candidate of candidates) {
    if (protectedRunIds.has(candidate.runId) || availableSlots > 0) {
      retainedRunIds.push(candidate.runId);
      if (!protectedRunIds.has(candidate.runId)) availableSlots -= 1;
      continue;
    }
    let removed = true;
    for (const path of [join(root, `${candidate.runId}-progress.json`), join(root, candidate.runId)]) {
      try {
        await removePath(path, { recursive: true, force: true });
      } catch {
        removed = false;
        errorCount += 1;
      }
    }
    if (removed) removedRunIds.push(candidate.runId);
    else retainedRunIds.push(candidate.runId);
  }
  return { maxRetainedRuns, discoveredRunCount: candidates.length, retainedRunIds, removedRunIds, errorCount };
}
