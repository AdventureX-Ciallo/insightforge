import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import test from "node:test";

import { createInsightForgeServer } from "../src/server.js";

async function withServer(handler: (baseUrl: string) => Promise<void>) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "csrf-test-"));
  const app = createInsightForgeServer({ fixtureDir: resolve("fixtures/golden"), publicDir: resolve("public"), workspaceDir });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    await handler(baseUrl);
  } finally {
    await app.stop();
  }
}

test("requests with a non-loopback Host header are rejected (DNS rebinding, #3)", async () => {
  await withServer(async (baseUrl) => {
    const port = new URL(baseUrl).port;
    const status = await new Promise<number>((resolveStatus, rejectRequest) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/current", headers: { host: "attacker.example" }, method: "GET" },
        (res) => { res.resume(); resolveStatus(res.statusCode ?? 0); },
      );
      req.on("error", rejectRequest);
      req.end();
    });
    assert.equal(status, 403);

    const loopbackStatus = await new Promise<number>((resolveStatus, rejectRequest) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/health", headers: { host: `127.0.0.1:${port}` }, method: "GET" },
        (res) => { res.resume(); resolveStatus(res.statusCode ?? 0); },
      );
      req.on("error", rejectRequest);
      req.end();
    });
    assert.equal(loopbackStatus, 200);

    const ipv6Status = await new Promise<number>((resolveStatus, rejectRequest) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/health", headers: { host: `[::1]:${port}` }, method: "GET" },
        (res) => { res.resume(); resolveStatus(res.statusCode ?? 0); },
      );
      req.on("error", rejectRequest);
      req.end();
    });
    assert.equal(ipv6Status, 200);
  });
});

test("cross-origin browser requests are rejected before any route logic runs (#2)", async () => {
  await withServer(async (baseUrl) => {
    const evil = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body: '{"researchQuestion":"中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？"}',
    });
    assert.equal(evil.status, 403);
    assert.match((await evil.json() as { error: string }).error, /Cross-origin/u);

    const crossSite = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    assert.equal(crossSite.status, 403);
    assert.match((await crossSite.json() as { error: string }).error, /Cross-site/u);

    // 同源 Origin 与本机 Origin 放行；无 Origin（curl/测试/联调脚本）放行。
    const sameOrigin = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
    });
    assert.equal(sameOrigin.status, 202);

    const noOrigin = await fetch(baseUrl + "/api/health", { method: "GET" });
    assert.equal(noOrigin.status, 200);
  });
});

test("opt-in CSRF token mode enforces the per-process token on state-changing requests (#2)", async () => {
  process.env.INSIGHTFORGE_CSRF = "1";
  try {
    await withServer(async (baseUrl) => {
      const tokenResponse = await fetch(baseUrl + "/api/csrf");
      assert.equal(tokenResponse.status, 200);
      const { token, required } = await tokenResponse.json() as { token: string; required: boolean };
      assert.ok(required);
      assert.match(token, /^[0-9a-f-]{36}$/u);

      const blocked = await fetch(baseUrl + "/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
      });
      assert.equal(blocked.status, 403);
      assert.match((await blocked.json() as { error: string }).error, /CSRF/u);

      const allowed = await fetch(baseUrl + "/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-insightforge-csrf": token },
        body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
      });
      assert.equal(allowed.status, 202);

      const wrongToken = await fetch(baseUrl + "/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-insightforge-csrf": "00000000-0000-4000-8000-000000000000" },
        body: JSON.stringify({ researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？" }),
      });
      assert.equal(wrongToken.status, 403);
    });
  } finally {
    delete process.env.INSIGHTFORGE_CSRF;
  }
});
