import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_SOURCES, truncateSources } from "../source-limit.js";

const indexSchema = z.object({
  mode: z.literal("offline-snapshot"),
  capturedAt: z.string(),
  sources: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string().url(),
    publisher: z.string(),
    publishedAt: z.string(),
    excerpt: z.string(),
    contentType: z.literal("SOURCE_OPINION"),
  })),
});

export async function searchSnapshot(fixtureDir: string, query: string) {
  const parsed = indexSchema.parse(JSON.parse(await readFile(join(fixtureDir, "search-index.json"), "utf8")));
  const limited = truncateSources(parsed.sources, MAX_SOURCES);
  return { ...parsed, sources: limited.items, query, results: limited.items, sourceLimitTrace: limited.trace };
}
