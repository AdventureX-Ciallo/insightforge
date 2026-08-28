import { rm } from "node:fs/promises";
import { join } from "node:path";

for (const directory of ["dist", "coverage", "coverage-detail", ".insightforge", "evidence", "test-results", "playwright-report", ".recordings"]) {
  await rm(join(process.cwd(), directory), { recursive: true, force: true });
}
