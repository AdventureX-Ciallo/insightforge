import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInsightForgeServer } from "../dist/server.js";

const root = process.cwd();
const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-smoke-"));
const app = createInsightForgeServer({
  fixtureDir: join(root, "fixtures", "golden"),
  publicDir: join(root, "public"),
  workspaceDir,
  stepDelayMs: 5,
});
const baseUrl = await app.start(0, "127.0.0.1");
try {
  const page = await fetch(baseUrl);
  const health = await fetch(`${baseUrl}/api/health`);
  if (!page.ok || !health.ok) throw new Error(`Smoke failed: page=${page.status}, health=${health.status}`);
  console.log(`Smoke passed at ${baseUrl}`);
} finally {
  await app.stop();
}
