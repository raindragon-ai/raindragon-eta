// node --test tests/  -- chatgpt_tap.js against a fake page fetch that streams a
// SYNTHETIC transcript. Checks the page gets its response untouched and the
// content script gets numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", "extension", f), "utf8");
const fixture = (n) => fs.readFileSync(path.join(__dirname, "fixtures", "chatgpt", n), "utf8");

function page(body, opts = {}) {
  const posted = [];
  const ctx = {
    location: { href: "https://chatgpt.com/c/x", origin: "https://chatgpt.com" },
    URL, TextDecoder, TextEncoder, Response, ReadableStream, Object, Date, String, Number, JSON, RegExp,
    postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),   // structured clone, as the browser does
    fetch: async () => new Response(body, {
      status: opts.status || 200, headers: { "content-type": opts.ct || "text/event-stream; charset=utf-8" } }),
  };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src("lib/chatgpt_sse.js"), ctx);
  vm.runInContext(src("chatgpt_tap.js"), ctx);
  return { ctx, posted };
}

const sendBody = (action = "next") => JSON.stringify({ action, model: "gpt-synthetic",
  messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["synthetic prompt"] } }] });

const settle = () => new Promise((r) => setTimeout(r, 30));

test("a send is timed; the page still reads its full stream", async () => {
  const { ctx, posted } = page(fixture("v1_delta_ok.sse"));
  const resp = await ctx.fetch("/backend-api/f/conversation", { method: "POST", body: sendBody() });
  assert.equal(await resp.text(), fixture("v1_delta_ok.sse"));
  await settle();
  const kinds = posted.map((m) => m.kind);
  assert.deepEqual(kinds, ["start", "first", "end"]);
  assert.deepEqual(posted[0], { __raindragonEta: 1, kind: "start", id: 1, promptChars: 16, model: "gpt-synthetic" });
  assert.equal(posted[2].outcome, "ok");
  assert.equal(posted[2].words, 6);
  // numbers and slugs only: no string longer than a model slug, nothing from the reply
  for (const m of posted) for (const v of Object.values(m))
    assert.ok(typeof v !== "string" || /^(start|first|end|ok|failed|stopped|unknown|gpt-[\w.-]+)$/.test(v), String(v));
});

test("regenerate and other endpoints are not timed", async () => {
  const { ctx, posted } = page(fixture("v1_delta_ok.sse"));
  await ctx.fetch("/backend-api/f/conversation", { method: "POST", body: sendBody("variant") });
  await ctx.fetch("/backend-api/conversations", { method: "GET" });
  await ctx.fetch("https://example.invalid/backend-api/conversation", { method: "POST", body: sendBody() });
  await settle();
  assert.equal(posted.length, 0);
});

test("HTTP error is a failed reply", async () => {
  const { ctx, posted } = page("{}", { status: 500, ct: "application/json" });
  await ctx.fetch("/backend-api/conversation", { method: "POST", body: sendBody() });
  await settle();
  assert.deepEqual(posted.map((m) => m.outcome).filter(Boolean), ["failed"]);
});

test("non-stream answer (e.g. handed off) is unknown, not recorded as ok", async () => {
  const { ctx, posted } = page("{}", { ct: "application/json" });
  await ctx.fetch("/backend-api/conversation", { method: "POST", body: sendBody() });
  await settle();
  assert.equal(posted[posted.length - 1].outcome, "unknown");
});
