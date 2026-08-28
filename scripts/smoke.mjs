import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInsightForgeServer, defaultServerPaths } from "../dist/server.js";

const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-smoke-"));
const originalCwd = process.cwd();
const runtime = defaultServerPaths();
process.chdir(workspaceDir);
const app = createInsightForgeServer({
  fixtureDir: runtime.fixtureDir,
  publicDir: runtime.publicDir,
  workspaceDir,
  stepDelayMs: 5,
});
const baseUrl = await app.start(0, "127.0.0.1");
try {
  const page = await fetch(baseUrl);
  const health = await fetch(`${baseUrl}/api/health`);
  if (!page.ok || !health.ok) throw new Error(`Smoke failed: page=${page.status}, health=${health.status}`);
  const requestKey = (await (await fetch(`${baseUrl}/api/request-key`)).json()).requestKey;
  const created = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-insightforge-request-key": requestKey },
    body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
  });
  if (created.status !== 202) throw new Error(`Smoke run creation failed: ${created.status}`);
  const { runId } = await created.json();
  let completed = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const body = await (await fetch(`${baseUrl}/api/runs/${runId}`)).json();
    if (body.job?.status === "failed") throw new Error("Smoke research run failed");
    if (body.job?.status === "completed" && body.run) {
      completed = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (!completed) throw new Error("Smoke research run timed out");
  console.log(`Smoke passed from non-project cwd at ${baseUrl}`);
} finally {
  await app.stop();
  process.chdir(originalCwd);
}
