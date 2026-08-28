import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createInsightForgeServer } from "../dist/server.js";

const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-e2e-"));
const port = Number(process.env.PORT ?? 4399);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port for E2E");
const app = createInsightForgeServer({
  fixtureDir: resolve("dist/fixtures/golden"),
  publicDir: resolve("dist/public"),
  workspaceDir,
  stepDelayMs: 35,
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.stop().catch(() => undefined);
  await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void stop().finally(() => process.exit(0)));
}

try {
  await app.start(port, "127.0.0.1");
} catch (error) {
  await stop();
  throw error;
}

await new Promise(() => undefined);
