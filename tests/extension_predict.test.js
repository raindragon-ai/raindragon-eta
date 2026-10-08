// node --test tests/  (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../extension/lib/predict.js");

const rec = (dur, o = {}) => Object.assign(
  { dur, ok: true, incident: false, pb: "short", cb: "small", model: "opus 5.5 medium", words: dur * 10 }, o);

test("nothing before MIN_READY good replies", () => {
  const h = Array.from({ length: T.MIN_READY - 1 }, (_, i) => rec(10 + i));
  assert.equal(T.predict(h, 50, 100, "Opus 5.5 Medium"), null);
});

test("failed, stopped-out and incident replies never count", () => {
  const h = Array.from({ length: 20 }, (_, i) => rec(10 + i, { ok: i % 2 === 0, incident: i % 3 === 0 }));
  assert.equal(T.learnedCount(h), 6);   // 10 ok, 4 of them (0,6,12,18) in an incident
});

test("band is the middle half, with a words band", () => {
  const h = Array.from({ length: 11 }, (_, i) => rec(10 + i));   // 10..20s
  const p = T.predict(h, 50, 100, "Opus 5.5 Medium", "50");
  assert.deepEqual(p.dur, { low: 12.5, high: 17.5 });
  assert.deepEqual(p.words, { low: 125, high: 175 });
  assert.equal(p.n, 11);
  assert.equal(p.group, "prompt+conversation+model");
});

test("eighty band is wider", () => {
  const h = Array.from({ length: 11 }, (_, i) => rec(10 + i));
  const half = T.predict(h, 50, 100, "Opus 5.5 Medium", "50");
  const eighty = T.predict(h, 50, 100, "Opus 5.5 Medium", "80");
  assert.ok(eighty.dur.low < half.dur.low && eighty.dur.high > half.dur.high);
});

test("falls back to broader groups for another model", () => {
  const h = Array.from({ length: 12 }, (_, i) => rec(10 + i));
  const p = T.predict(h, 50, 100, "Haiku 5.5", "50");
  assert.equal(p.group, "all");
});

test("model label is normalised", () => {
  assert.equal(T.modelKey("  Opus 5.5\n Medium "), "opus 5.5 medium");
  assert.equal(T.modelKey(""), null);
});

test("words band left out when old records have no word counts", () => {
  const h = Array.from({ length: 12 }, (_, i) => rec(10 + i, { words: undefined }));
  assert.equal(T.predict(h, 50, 100, "Opus 5.5 Medium").words, null);
});

test("text matches the Claude Code plugin's rounding", () => {
  assert.equal(T.duration(45), "45s");
  assert.equal(T.duration(95), "1m30s");
  assert.equal(T.duration(605), "10m");
  assert.equal(T.duration(3600 + 30 * 60), "1h30m");
  assert.equal(T.words(42), "42");
  assert.equal(T.words(347), "350");
  assert.equal(T.words(1260), "1.3k");
  assert.equal(T.words(2000), "2k");
});

test("band line", () => {
  const line = T.bandLine({ dur: { low: 20, high: 65 }, words: { low: 300, high: 800 }, n: 24, coverage: "50" });
  assert.equal(line, "Half of your similar replies took 20s–1m, 300–800 words (from 24)");
  const eighty = T.bandLine({ dur: { low: 5, high: 5 }, words: null, n: 10, coverage: "80" });
  assert.equal(eighty, "8 in 10 of your similar replies took 5s (from 10)");
});

test("claude.ai incident reported, Console-only incident ignored", () => {
  const consoleOnly = { incidents: [{ name: "Console errors", status: "investigating",
    components: [{ name: "Claude Console (platform.claude.com)" }] }], components: [] };
  assert.equal(T.incidentFromSummary(consoleOnly), null);
  const web = { incidents: [{ name: "Elevated errors on claude.ai", status: "identified",
    components: [{ name: "claude.ai" }] }], components: [] };
  assert.equal(T.incidentFromSummary(web), "Elevated errors on claude.ai");
  const degraded = { incidents: [], components: [{ name: "claude.ai", status: "degraded_performance" }] };
  assert.equal(T.incidentFromSummary(degraded), "claude.ai: degraded performance");
  assert.equal(T.incidentFromSummary({ incidents: [{ name: "x", status: "resolved",
    components: [{ name: "claude.ai" }] }] }), null);
});

test("one word is singular", () => {
  assert.equal(T.wordsText(1), "1 word");
  assert.equal(T.wordsText(2), "2 words");
  assert.equal(T.wordsText(1, 1), "1 word");
  assert.equal(T.wordsText(300, 800), "300–800 words");
  assert.equal(T.bandLine({ dur: { low: 2, high: 3 }, words: { low: 1, high: 1 }, n: 10, coverage: "50" }),
    "Half of your similar replies took 2s–3s, 1 word (from 10)");
});
