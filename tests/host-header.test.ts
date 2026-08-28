import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer, isAllowedHostHeader, resolveLoopbackBindHost } from "../src/server.js";

function requestStatus(port: number, hostHeader?: string) {
  return new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/health",
      method: "GET",
      setHost: hostHeader !== undefined,
      ...(hostHeader === undefined ? {} : { headers: { host: hostHeader } }),
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("HTTP server pins Host to loopback names on the actual listening port", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-host-header-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  const port = Number(new URL(baseUrl).port);
  try {
    assert.equal(await requestStatus(port, `127.0.0.1:${port}`), 200);
    assert.equal(await requestStatus(port, `localhost:${port}`), 403);
    assert.equal(await requestStatus(port, `[::1]:${port}`), 200);
    assert.equal(await requestStatus(port, "attacker.example"), 403);
    assert.equal(await requestStatus(port, `attacker.example:${port}`), 403);
    assert.equal(await requestStatus(port, `127.0.0.1:${port + 1}`), 403);
    assert.ok([400, 403].includes(await requestStatus(port)), "Node or the application must reject a missing HTTP/1.1 Host");
  } finally {
    await app.stop();
  }
});

test("Host parser rejects malformed, credentialed, non-loopback, duplicate, and wrong-port authorities", () => {
  assert.equal(isAllowedHostHeader("localhost", 80), false);
  assert.equal(isAllowedHostHeader("127.0.0.1:4399", 4399), true);
  assert.equal(isAllowedHostHeader("[::1]:4399", 4399), true);
  const invalidHosts: Array<[string | string[] | undefined, number | undefined]> = [
    [undefined, 4399],
    [["localhost:4399", "127.0.0.1:4399"], 4399],
    ["localhost:4399", undefined],
    [" localhost:4399", 4399],
    ["localhost:4399 ", 4399],
    ["]", 4399],
    ["example.com:4399", 4399],
    ["localhost:4400", 4399],
    ["user@localhost:4399", 4399],
    [":password@localhost:4399", 4399],
    ["localhost:4399/path", 4399],
    ["localhost:4399?query=1", 4399],
    ["localhost:4399#fragment", 4399],
  ];
  for (const [host, port] of invalidHosts) assert.equal(isAllowedHostHeader(host, port), false, String(host));
});

test("localhost binding pins a DNS-validated loopback address and rejects mixed or empty answers", async () => {
  assert.equal(await resolveLoopbackBindHost("localhost", async () => [{ address: "127.0.0.1", family: 4 }]), "127.0.0.1");
  assert.equal(await resolveLoopbackBindHost("localhost", async () => [{ address: "::1", family: 6 }]), "::1");
  await assert.rejects(resolveLoopbackBindHost("localhost", async () => []), /did not resolve exclusively/u);
  await assert.rejects(resolveLoopbackBindHost("localhost", async () => [
    { address: "127.0.0.1", family: 4 },
    { address: "203.0.113.1", family: 4 },
  ]), /did not resolve exclusively/u);
  await assert.rejects(resolveLoopbackBindHost("example.com", async () => [{ address: "127.0.0.1", family: 4 }] as const), /only permits a loopback/u);
});
