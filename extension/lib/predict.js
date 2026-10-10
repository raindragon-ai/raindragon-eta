/* RainDragon ETA for claude.ai: duration and length bands from the user's own past replies.
 *
 * Same rules as the Claude Code plugin (plugin/scripts/raindragon_eta/predict.py):
 * a BAND (middle half by default) of similar past replies, never a single
 * number; under MIN_READY good replies the wide 8-in-10 band of TYPICAL
 * replies of the same size from the built-in table (lib/prior.js, made by
 * tools/build_prior.py --chat), then the user's own wide band labelled
 * "still learning" until CONFIDENT; failed, stopped and
 * incident-time replies are kept out. evaluate() replays history to measure
 * how often the band held (coverage) and how wide it was.
 *
 * "Similar" narrows step by step, using the narrowest group that still has
 * MIN_GROUP replies:
 *
 *     prompt size + conversation size + model
 *     prompt size + model
 *     model
 *     all replies
 *
 * Plain script: loaded by the content script, and by node for tests.
 */
(function (root) {
  "use strict";

  const VERSION = "0.2.0";
  const MIN_READY = 10;
  const CONFIDENT = 30;
  const MIN_GROUP = 8;
  const RECENT = 300;
  const BANDS = { "50": [0.25, 0.75], "80": [0.10, 0.90] };

  // Built-in table: a global in the browser (lib/prior.js loads first), a
  // module under node. setPrior() swaps it, for tests.
  let PRIOR = root.RainDragonEtaPrior ||
    (typeof require === "function" ? (() => { try { return require("./prior.js"); } catch (e) { return null; } })() : null);
  function setPrior(p) { PRIOR = p; }

  // The built-in wide band for this size, narrowing like the user's own groups.
  function priorBand(pb, cb, learned) {
    const groups = (PRIOR && PRIOR.groups) || {};
    for (const [name, key] of [["typical prompt+conversation", pb + "/" + cb],
                               ["typical prompt", pb], ["typical", "all"]]) {
      const g = groups[key];
      if (!g) continue;
      return {
        dur: { low: g["10"], high: g["90"] },
        words: g.words ? { low: g.words["10"], high: g.words["90"] } : null,
        n: g.n, group: name, coverage: "80", learning: true, typical: true, learned,
      };
    }
    return null;
  }

  function promptBucket(chars) {
    if (chars < 200) return "short";
    if (chars < 2000) return "medium";
    return "long";
  }

  // Characters of conversation already on screen before this prompt.
  function contextBucket(chars) {
    if (chars < 20000) return "small";
    if (chars < 100000) return "medium";
    return "large";
  }

  // "Opus 5.5 Medium" -> "opus 5.5 medium". The label is all we need to tell
  // models and effort levels apart; it is never sent anywhere.
  function modelKey(label) {
    return String(label || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60) || null;
  }

  function quantile(sorted, q) {
    const n = sorted.length;
    if (n === 1) return sorted[0];
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, n - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function usable(history) {
    const out = (history || []).filter(
      (r) => r && r.ok && !r.incident && typeof r.dur === "number" && r.dur > 0
    );
    return out.slice(-RECENT);
  }

  function band(values, coverage) {
    const [loQ, hiQ] = BANDS[coverage] || BANDS["50"];
    const s = values.slice().sort((a, b) => a - b);
    return { low: quantile(s, loQ), high: quantile(s, hiQ) };
  }

  // -> null while learning, else {dur:{low,high}, words:{low,high}|null, n, group, coverage}
  function predict(history, promptChars, contextChars, model, coverage) {
    return predictBuckets(usable(history), promptBucket(promptChars),
                          contextBucket(contextChars), modelKey(model), coverage);
  }

  function predictBuckets(good, pb, cb, mk, coverage) {
    coverage = BANDS[coverage] ? coverage : "50";
    if (good.length < MIN_READY) return priorBand(pb, cb, good.length);
    const learning = good.length < CONFIDENT;
    if (learning) coverage = "80";
    const groups = [
      ["prompt+conversation+model", (r) => r.pb === pb && r.cb === cb && r.model === mk],
      ["prompt+model", (r) => r.pb === pb && r.model === mk],
      ["model", (r) => r.model === mk],
      ["all", () => true],
    ];
    for (const [name, keep] of groups) {
      const rows = good.filter(keep);
      if (rows.length >= MIN_GROUP || name === "all") {
        const words = rows.map((r) => r.words).filter((w) => typeof w === "number" && w > 0);
        return {
          dur: band(rows.map((r) => r.dur), coverage),
          words: words.length >= MIN_GROUP ? band(words, coverage) : null,
          n: rows.length,
          group: name,
          coverage,
          learning,
        };
      }
    }
    return null;
  }

  // Replay in order; each reply is scored only against the band built from the
  // replies before it. Coverage and width are reported together.
  function evaluate(history, coverage) {
    const good = (history || []).filter(
      (r) => r && r.ok && !r.incident && typeof r.dur === "number" && r.dur > 0);
    let scored = 0, hits = 0;
    const ratios = [];
    const byBand = {};
    good.forEach((r, i) => {
      const b = predictBuckets(good.slice(Math.max(0, i - RECENT), i), r.pb, r.cb, r.model, coverage);
      if (!b) return;
      scored += 1;
      const hit = b.dur.low <= r.dur && r.dur <= b.dur.high;
      if (hit) hits += 1;
      if (b.dur.low > 0) ratios.push(b.dur.high / b.dur.low);
      const key = b.typical ? "typical" : b.coverage;
      const s = byBand[key] || (byBand[key] = { scored: 0, hits: 0 });
      s.scored += 1;
      if (hit) s.hits += 1;
    });
    ratios.sort((a, b) => a - b);
    return {
      scored, hits,
      coverage: scored ? hits / scored : null,
      byBand,
      medianRatio: ratios.length ? quantile(ratios, 0.5) : null,
    };
  }

  function learnedCount(history) {
    return usable(history).length;
  }

  // ---- text ----

  function duration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return s + "s";
    if (s < 3600) {
      const m = Math.floor(s / 60), r = s % 60;
      if (m < 10 && r >= 30) return m + "m30s";
      return m + (r >= 30 && m >= 10 ? 1 : 0) + "m";
    }
    let h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return m === 0 ? h + "h" : h + "h" + String(m).padStart(2, "0") + "m";
  }

  function words(n) {
    const w = Math.round(n);
    if (w < 100) return String(w);
    if (w < 1000) return String(Math.round(w / 10) * 10);
    return (Math.round(w / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k";
  }

  // "1 word", "300–800 words"
  function wordsText(lo, hi) {
    const t = span(words(lo), words(hi === undefined ? lo : hi));
    return t + (t === "1" ? " word" : " words");
  }

  function span(lo, hi) {
    return lo === hi ? lo : lo + "–" + hi;
  }

  function bandLine(p) {
    const share = p.coverage === "80" ? "8 in 10" : "Half";
    if (p.typical) {
      let t = share + " typical Claude replies like this took " +
        span(duration(p.dur.low), duration(p.dur.high));
      if (p.words) t += ", " + wordsText(p.words.low, p.words.high);
      return t + " (yours from reply " + MIN_READY + ", " + (p.learned || 0) + " so far)";
    }
    let s = share + " of your similar replies took " +
      span(duration(p.dur.low), duration(p.dur.high));
    if (p.words) s += ", " + wordsText(p.words.low, p.words.high);
    return s + " (from " + p.n + (p.learning ? ", still learning)" : ")");
  }

  // ---- status.claude.com ----

  const WEB_COMPONENTS = ["claude.ai", "claude api"];
  // Only MAJOR problems count (same rule and evidence as the plugin's
  // status.py): major incidents slowed turns 1.81x, minor/degraded did not.
  const MAJOR_IMPACTS = ["major", "critical"];
  const MAJOR_COMPONENT_STATUS = ["major_outage"];

  function relevant(name, components) {
    const n = String(name || "").toLowerCase();
    return components.some((c) => n.startsWith(c));
  }

  function incidentFromSummary(summary, components) {
    components = components || WEB_COMPONENTS;
    for (const inc of (summary && summary.incidents) || []) {
      if (inc.status === "resolved" || inc.status === "postmortem") continue;
      if (MAJOR_IMPACTS.indexOf(String(inc.impact || "").toLowerCase()) < 0) continue;
      if ((inc.components || []).some((c) => relevant(c.name, components))) {
        return inc.name || "an active incident";
      }
    }
    for (const comp of (summary && summary.components) || []) {
      if (relevant(comp.name, components) && MAJOR_COMPONENT_STATUS.indexOf(comp.status) >= 0) {
        return comp.name + ": " + String(comp.status).replace(/_/g, " ");
      }
    }
    return null;
  }

  const api = {
    VERSION, MIN_READY, CONFIDENT, MIN_GROUP, RECENT, BANDS,
    promptBucket, contextBucket, modelKey, quantile, usable, predict, evaluate, learnedCount,
    priorBand, setPrior,
    duration, words, wordsText, bandLine, incidentFromSummary, WEB_COMPONENTS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RainDragonEta = api;
})(typeof self !== "undefined" ? self : this);
