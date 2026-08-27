import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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
  return { ...parsed, query, results: parsed.sources };
}
