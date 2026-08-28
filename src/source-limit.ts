export const MAX_SOURCES = 10;

export interface SourceLimitTrace {
  maxSources: number;
  discoveredCount: number;
  retainedCount: number;
  truncatedCount: number;
  truncated: boolean;
  reason: "MAX_SOURCES" | null;
}

export function truncateSources<T>(items: readonly T[], maxSources = MAX_SOURCES) {
  const retained = items.slice(0, maxSources);
  const truncatedCount = Math.max(0, items.length - retained.length);
  return {
    items: retained,
    trace: {
      maxSources,
      discoveredCount: items.length,
      retainedCount: retained.length,
      truncatedCount,
      truncated: truncatedCount > 0,
      reason: truncatedCount > 0 ? "MAX_SOURCES" as const : null,
    } satisfies SourceLimitTrace,
  };
}
