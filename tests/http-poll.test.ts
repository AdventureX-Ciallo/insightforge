import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchForPoll } from "./http-poll.js";

test("polling retries two transient transport failures but preserves a persistent failure", async () => {
  let attempts = 0;
  const recovers: typeof fetch = async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("transient transport failure");
    return new Response("ok");
  };
  assert.equal((await fetchForPoll("http://127.0.0.1", undefined, recovers)).status, 200);
  assert.equal(attempts, 3);

  attempts = 0;
  const fails: typeof fetch = async () => {
    attempts += 1;
    throw new TypeError("persistent transport failure");
  };
  await assert.rejects(fetchForPoll("http://127.0.0.1", undefined, fails), /persistent transport failure/u);
  assert.equal(attempts, 3);
});

test("the test runner isolates loopback fetches from stale keep-alive sockets", async () => {
  const connections: string[] = [];
  const server = createServer((request, response) => {
    connections.push(request.headers.connection ?? "");
    response.end("ok");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`, { headers: { connection: "keep-alive" } })).status, 200);
    assert.deepEqual(connections, ["close", "keep-alive"]);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
