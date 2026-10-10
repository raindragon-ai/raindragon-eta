// node --test tests/  (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../extension/lib/predict.js");

const rec = (dur, o = {}) => Object.assign(
  { dur, ok: true, incident: false, pb: "short", cb: "small", model: "opus 5.5 medium", words: dur * 10 }, o);

const REAL_PRIOR = require("../extension/lib/prior.js");
const PRIOR = { groups: {
  all: { n: 500, 10: 3, 25: 5, 75: 10, 90: 16, words: { 10: 40, 25: 80, 75: 200, 90: 290 } },
  short: { n: 400, 10: 3, 25: 4, 75: 9, 90: 15, words: { 10: 39, 25: 70, 75: 190, 90: 280 } },
  "short/small": { n: 170, 10: 2.5, 25: 4, 75: 8, 90: 14, words: { 10: 30, 25: 60, 75: 180, 90: 290 } },
} };
test.beforeEach(() => T.setPrior(PRIOR));

test("typical band before MIN_READY good replies", () => {
  const h = Array.from({ length: T.MIN_READY - 1 }, (_, i) => rec(10 + i));
  const p = T.predict(h, 50, 100, "Opus 5.5 Medium", "50");
  assert.equal(p.typical, true);
  assert.equal(p.coverage, "80");
  assert.deepEqual(p.dur, { low: 2.5, high: 14 });
  assert.equal(p.group, "typical prompt+conversation");
  assert.equal(T.bandLine(p),
    "8 in 10 typical Claude replies like this took 3s–14s, 30–290 words (yours from reply 10, 9 so far)");
});

test("typical band narrows like the user's own", () => {
  assert.equal(T.predict([], 50, 50000, null).group, "typical prompt");   // short/medium not shipped
  assert.equal(T.predict([], 5000, 0, null).group, "typical");            // long not shipped
});

test("no band without a built-in table", () => {
  T.setPrior(null);
  assert.equal(T.predict([rec(10)], 50, 100, "Opus 5.5 Medium"), null);
});

test("shipped built-in table is sane and loaded by the page before predict.js", () => {
  const g = REAL_PRIOR.groups;
  assert.ok(g.all);
  for (const v of Object.values(g)) {
    assert.ok(v.n >= 30);
    assert.ok(0 < v["10"] && v["10"] <= v["25"] && v["25"] <= v["75"] && v["75"] <= v["90"]);
    assert.ok(v.words["10"] <= v.words["90"]);
  }
  const js = require("../extension/manifest.json").content_scripts[0].js;
  assert.ok(js.indexOf("lib/prior.js") >= 0 && js.indexOf("lib/prior.js") < js.indexOf("lib/predict.js"));
  const html = require("node:fs").readFileSync(require.resolve("../extension/options.html"), "utf8");
  assert.ok(html.indexOf("lib/prior.js") >= 0 && html.indexOf("lib/prior.js") < html.indexOf("lib/predict.js"));
});

test("failed, stopped-out and incident replies never count", () => {
  const h = Array.from({ length: 20 }, (_, i) => rec(10 + i, { ok: i % 2 === 0, incident: i % 3 === 0 }));
  assert.equal(T.learnedCount(h), 6);   // 10 ok, 4 of them (0,6,12,18) in an incident
});

test("band is the middle half, with a words band", () => {
  const h = Array.from({ length: 31 }, (_, i) => rec(10 + i));   // 10..40s
  const p = T.predict(h, 50, 100, "Opus 5.5 Medium", "50");
  assert.deepEqual(p.dur, { low: 17.5, high: 32.5 });
  assert.deepEqual(p.words, { low: 175, high: 325 });
  assert.equal(p.n, 31);
  assert.equal(p.learning, false);
  assert.equal(p.group, "prompt+conversation+model");
});

test("under CONFIDENT replies the band is the wide one, labelled learning", () => {
  const h = Array.from({ length: T.CONFIDENT - 1 }, (_, i) => rec(10 + i));
  const p = T.predict(h, 50, 100, "Opus 5.5 Medium", "50");
  assert.equal(p.coverage, "80");
  assert.equal(p.learning, true);
  assert.match(T.bandLine(p), /^8 in 10 of your similar replies took .*, still learning\)$/);
});

test("eighty band is wider", () => {
  const h = Array.from({ length: 31 }, (_, i) => rec(10 + i));
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
  const web = { incidents: [{ name: "Elevated errors on claude.ai", status: "identified", impact: "major",
    components: [{ name: "claude.ai" }] }], components: [] };
  assert.equal(T.incidentFromSummary(web), "Elevated errors on claude.ai");
  const minor = { incidents: [{ name: "Slow claude.ai", status: "identified", impact: "minor",
    components: [{ name: "claude.ai" }] }], components: [] };
  assert.equal(T.incidentFromSummary(minor), null);
  const degraded = { incidents: [], components: [{ name: "claude.ai", status: "degraded_performance" }] };
  assert.equal(T.incidentFromSummary(degraded), null);
  const down = { incidents: [], components: [{ name: "claude.ai", status: "major_outage" }] };
  assert.equal(T.incidentFromSummary(down), "claude.ai: major outage");
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

test("evaluate scores each reply only from earlier ones", () => {
  const h = Array.from({ length: 60 }, (_, i) => rec(10 + (i % 7)));
  const e = T.evaluate(h, "50");
  assert.equal(e.scored, 60);
  assert.equal(e.byBand.typical.scored, T.MIN_READY);
  assert.equal(e.byBand["80"].scored, T.CONFIDENT - T.MIN_READY);
  assert.ok(e.coverage >= 0 && e.coverage <= 1 && e.medianRatio >= 1);
  assert.equal(T.evaluate([], "50").coverage, null);
});

test("version matches the manifest", () => {
  const m = require("../extension/manifest.json");
  assert.equal(m.version, T.VERSION);
});

test("options page names the maker with a safe outbound link", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "../extension/options.html"), "utf8");
  const a = html.match(/<a [^>]*href="([^"]+)"[^>]*>RainDragon AI<\/a>/);
  assert.ok(a, "Made by RainDragon AI link");
  assert.ok(a[1].startsWith("https://inference.raindragon.ai/?utm_source=raindragon-eta&utm_medium=extension"));
  assert.match(a[0], /rel="noopener"/);
});
