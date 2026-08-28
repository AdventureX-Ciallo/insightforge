import { defineConfig } from "playwright/test";

const e2ePort = Number(process.env.PORT ?? 4399);
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1 || e2ePort > 65_535) throw new Error("PORT must be a valid TCP port for Playwright");
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: e2eBaseUrl,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && node scripts/start-e2e.mjs",
    url: `${e2eBaseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
