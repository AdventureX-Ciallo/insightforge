import assert from "node:assert/strict";
import test from "node:test";

import { searchLiveSingleProvider } from "../src/tools/live-source-search.js";
import { isBlockedIpAddress, parseSearchCandidates, searchSelectedEngine, validatePublicHttpUrl } from "../src/tools/search-engines.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function endlessChunkedResponse(contentType: string, chunkBytes: number) {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls > 20) throw new Error("reader failed to stop after the safety limit");
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { "content-type": contentType } }), state };
}

test("public search URL validation rejects every pre-fetch SSRF and DNS boundary", async () => {
  assert.equal(isBlockedIpAddress("not-an-ip"), true);
  assert.equal(isBlockedIpAddress("[fe80::1%en0]"), true);
  await assert.rejects(validatePublicHttpUrl("not a URL", ["www.bing.com"], publicResolver), /valid URL/u);
  await assert.rejects(validatePublicHttpUrl("https://user:pass@www.bing.com/search", ["www.bing.com"], publicResolver), /credentials/u);
  await assert.rejects(validatePublicHttpUrl("https://www.bing.com:444/search", ["www.bing.com"], publicResolver), /non-standard port/u);
  await assert.rejects(validatePublicHttpUrl("http://www.bing.com:81/search", ["www.bing.com"], publicResolver), /non-standard port/u);
  await assert.rejects(validatePublicHttpUrl("https://www.bing.com/search", ["www.bing.com"], async () => { throw new Error("DNS down"); }), /resolved safely/u);
  await assert.rejects(validatePublicHttpUrl("https://www.bing.com/search", ["www.bing.com"], async () => []), /no addresses/u);
  const http = await validatePublicHttpUrl("http://www.bing.com:80/search", ["www.bing.com"], publicResolver);
  assert.equal(http.protocol, "http:");
  const literal = await validatePublicHttpUrl("https://93.184.216.34/search", ["93.184.216.34"], publicResolver);
  assert.equal(literal.hostname, "93.184.216.34");
});

test("search candidate parsing drops malformed, credentialed, private, duplicate, self, empty, and excess links", () => {
  const requestUrl = new URL("https://www.google.com/search?q=test");
  const many = Array.from({ length: 12 }, (_, index) => `<a href="https://example.com/${index}">Result ${index}</a>`).join("");
  const html = [
    '<a href="/url?sa=U">missing google target</a>',
    '<a href="ftp://example.com/file">FTP</a>',
    '<a href="https://user:pass@example.com/secret">Credentials</a>',
    '<a href="http://127.0.0.1/private">Private</a>',
    '<a href="//example.net/report">Protocol relative</a>',
    '<a href="https://www.google.com/internal">Self host</a>',
    '<a href="https://example.net/report"><b>Duplicate</b></a>',
    '<a href="https://empty.example">   </a>',
    many,
  ].join("");
  const candidates = parseSearchCandidates(html, "google", requestUrl);
  assert.equal(candidates.length, 10);
  assert.equal(candidates[0]?.url, "https://example.net/report");
  assert.equal(candidates.filter((item) => item.url === "https://example.net/report").length, 1);
});

test("search candidate parsing replaces out-of-range numeric entities instead of throwing", () => {
  const candidates = parseSearchCandidates(
    '<a href="https://example.com/report">Title &#65; &#55296; &#999999999999999999999999;</a>',
    "google",
    new URL("https://www.google.com/search?q=test"),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Title A � �");
});

test("selected search engine rejects query, response, redirect, content type, declared size, and actual size failures", async () => {
  await assert.rejects(searchSelectedEngine("bing", " ", async () => new Response(""), publicResolver), /2–160/u);
  await assert.rejects(searchSelectedEngine("bing", "x".repeat(161), async () => new Response(""), publicResolver), /2–160/u);
  await assert.rejects(searchSelectedEngine("bing", "valid", async () => new Response("no", { status: 503 }), publicResolver), /HTTP 503/u);
  await assert.rejects(searchSelectedEngine("bing", "valid", async () => responseWithUrl("ok", { status: 200 }, "https://evil.example/"), publicResolver), /left the selected engine/u);
  await assert.rejects(searchSelectedEngine("bing", "valid", async () => new Response("{}", { headers: { "content-type": "application/json" } }), publicResolver), /content type/u);
  await assert.rejects(searchSelectedEngine("bing", "valid", async () => new Response("", { headers: { "content-type": "text/html", "content-length": String(1024 * 1024 + 1) } }), publicResolver), /size limit/u);
  await assert.rejects(searchSelectedEngine("bing", "valid", async () => new Response(Buffer.alloc(1024 * 1024 + 1), { headers: { "content-type": "text/html" } }), publicResolver), /size limit/u);
  const sameOrigin = await searchSelectedEngine("bing", " valid ", async () => responseWithUrl("<p>none</p>", { headers: { "content-type": "text/html", "content-length": "not-a-number" } }, "https://www.bing.com/search?q=valid"), publicResolver);
  assert.equal(sameOrigin.query, "valid");
  assert.deepEqual(sameOrigin.candidates, []);
  const noContentType = await searchSelectedEngine("bing", "valid", async () => new Response(null), publicResolver);
  assert.deepEqual(noContentType.candidates, []);
});

test("single-provider live search rejects all transport envelopes and preserves optional timestamps", async () => {
  await assert.rejects(searchLiveSingleProvider(" ", async () => new Response(""), publicResolver), /2–160/u);
  await assert.rejects(searchLiveSingleProvider("x".repeat(161), async () => new Response(""), publicResolver), /2–160/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => new Response("", { status: 500 }), publicResolver), /HTTP 500/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => responseWithUrl("{}", { headers: { "content-type": "application/json" } }, "https://evil.example/api"), publicResolver), /fixed provider/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => new Response("{}", { headers: { "content-type": "text/html" } }), publicResolver), /content type/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => new Response("", { headers: { "content-type": "application/json", "content-length": String(512 * 1024 + 1) } }), publicResolver), /safety limit/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => new Response(Buffer.alloc(512 * 1024 + 1), { headers: { "content-type": "application/json" } }), publicResolver), /safety limit/u);
  await assert.rejects(searchLiveSingleProvider("valid", async () => new Response(null), publicResolver), /JSON|Unexpected end/u);
  const body = JSON.stringify({ query: { search: [{ pageid: 42, title: "Title", snippet: "<b>A</b> &quot;B&quot; &#039;C&#039; &amp; D" }] } });
  const result = await searchLiveSingleProvider(" valid ", async () => responseWithUrl(body, { headers: { "content-type": "application/json", "content-length": "not-a-number" } }, "https://zh.wikipedia.org/w/api.php"), publicResolver);
  assert.equal(result.query, "valid");
  assert.equal(result.results[0]?.publishedAt, null);
  assert.equal(result.results[0]?.excerpt, 'A "B" \'C\' & D');
});

test("search readers cancel chunked responses immediately when the byte limit is crossed", async () => {
  const selected = endlessChunkedResponse("text/html", 300 * 1024);
  await assert.rejects(
    searchSelectedEngine("bing", "valid", async () => selected.response, publicResolver),
    /size limit/u,
  );
  assert.equal(selected.state.cancelled, true);
  assert.equal(selected.state.pulls, 4, "the 1 MiB reader must stop on the first over-limit chunk");

  const live = endlessChunkedResponse("application/json", 200 * 1024);
  await assert.rejects(
    searchLiveSingleProvider("valid", async () => live.response, publicResolver),
    /safety limit/u,
  );
  assert.equal(live.state.cancelled, true);
  assert.equal(live.state.pulls, 3, "the 512 KiB reader must stop on the first over-limit chunk");
});
