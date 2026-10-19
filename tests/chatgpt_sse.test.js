// node --test tests/  -- chatgpt.com stream parser, on SYNTHETIC transcripts
// (tests/fixtures/chatgpt/*.sse are hand-written; no real conversation).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../extension/lib/chatgpt_sse.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "chatgpt", name), "utf8");

// Feed in random-sized pieces: the network splits lines and words anywhere.
function run(text, seed) {
  let t = 1000;
  const p = S.createParser(() => (t += 10));
  let x = seed || 7, i = 0;
  while (i < text.length) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const n = 1 + (x % 23);
    p.feed(text.slice(i, i + n));
    i += n;
  }
  p.end();
  return p.result();
}

test("v1 delta stream: counts only the visible reply, across chunk splits", () => {
  for (const seed of [1, 2, 3, 99]) {
    const r = run(fixture("v1_delta_ok.sse"), seed);
    assert.equal(r.outcome, "ok");
    assert.equal(r.words, 6);   // Alpha bravo charlie delta echo foxtrot.
    assert.equal(r.model, "gpt-synthetic-thinking");   // resolved slug wins
    assert.ok(r.firstAt > 1000);
  }
});

test("whole-stream feed equals piecewise feed", () => {
  const p = S.createParser(() => 1);
  p.feed(fixture("v1_delta_ok.sse")); p.end();
  assert.equal(p.result().words, run(fixture("v1_delta_ok.sse")).words);
});

test("snapshot format recounts the same message instead of adding", () => {
  const r = run(fixture("snapshot_ok.sse"));
  assert.deepEqual([r.outcome, r.words, r.model], ["ok", 4, "gpt-synthetic-mini"]);
});

test("error event marks the reply failed", () => {
  assert.equal(run(fixture("error.sse")).outcome, "failed");
});

test("a stream cut short is unknown, never ok", () => {
  const r = run(fixture("cut_short.sse"));
  assert.equal(r.outcome, "unknown");
});

test("tool calls and tool output are not counted as reply words", () => {
  const r = run(fixture("tool_call.sse"));
  assert.deepEqual([r.outcome, r.words], ["ok", 3]);
});

test("empty stream is unknown (e.g. handed off elsewhere)", () => {
  const p = S.createParser(); p.feed("data: [DONE]\n\n"); p.end();
  assert.equal(p.result().outcome, "unknown");
});

test("word counter matches /\\S+/ on the joined text", () => {
  const pieces = ["  he", "llo  wor", "ld\n", "x", " y "];
  const c = new S.WordCounter();
  pieces.forEach((s) => c.add(s));
  assert.equal(c.n, pieces.join("").match(/\S+/g).length);
});

test("request body gives only sizes, model and action", () => {
  const body = JSON.stringify({
    action: "next", model: "gpt-synthetic",
    messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["twelve chars"] } }],
  });
  assert.deepEqual(S.requestInfo(body), { action: "next", model: "gpt-synthetic", promptChars: 12 });
  assert.equal(S.requestInfo("not json"), null);
});

test("conversation endpoint paths", () => {
  for (const ok of ["/backend-api/conversation", "/backend-api/f/conversation"]) assert.ok(S.CONVERSATION_PATH.test(ok));
  for (const no of ["/backend-api/conversation/abc", "/backend-api/conversations", "/backend-api/f/conversation/prepare"])
    assert.ok(!S.CONVERSATION_PATH.test(no), no);
});
