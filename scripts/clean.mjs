import { rm } from "node:fs/promises";
import { join } from "node:path";

for (const target of ["dist", "public", "coverage", "coverage-detail", ".insightforge", "evidence", "test-results", "playwright-report", ".recordings", "tsconfig.tsbuildinfo", "web/tsconfig.tsbuildinfo"]) {
  await rm(join(process.cwd(), target), { recursive: true, force: true });
}
