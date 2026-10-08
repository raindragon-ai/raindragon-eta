/* Turn ETA for claude.ai: duration and length bands from the user's own past replies.
 *
 * Same rules as the Claude Code plugin (plugin/scripts/turn_eta/predict.py):
 * a BAND (middle half by default) of similar past replies, never a single
 * number; nothing until MIN_READY good replies; failed, stopped and
 * incident-time replies are kept out.
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

  const MIN_READY = 10;
  const MIN_GROUP = 8;
  const RECENT = 300;
  const BANDS = { "50": [0.25, 0.75], "80": [0.10, 0.90] };

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
    coverage = BANDS[coverage] ? coverage : "50";
    const good = usable(history);
    if (good.length < MIN_READY) return null;
    const pb = promptBucket(promptChars);
    const cb = contextBucket(contextChars);
    const mk = modelKey(model);
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
        };
      }
    }
    return null;
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
    let s = share + " of your similar replies took " +
      span(duration(p.dur.low), duration(p.dur.high));
    if (p.words) s += ", " + wordsText(p.words.low, p.words.high);
    return s + " (from " + p.n + ")";
  }

  // ---- status.claude.com ----

  const WEB_COMPONENTS = ["claude.ai", "claude api"];
  const OK = ["operational", "under_maintenance"];

  function relevant(name, components) {
    const n = String(name || "").toLowerCase();
    return components.some((c) => n.startsWith(c));
  }

  function incidentFromSummary(summary, components) {
    components = components || WEB_COMPONENTS;
    for (const inc of (summary && summary.incidents) || []) {
      if (inc.status === "resolved" || inc.status === "postmortem") continue;
      if ((inc.components || []).some((c) => relevant(c.name, components))) {
        return inc.name || "an active incident";
      }
    }
    for (const comp of (summary && summary.components) || []) {
      if (relevant(comp.name, components) && OK.indexOf(comp.status) < 0) {
        return comp.name + ": " + String(comp.status).replace(/_/g, " ");
      }
    }
    return null;
  }

  const api = {
    MIN_READY, MIN_GROUP, RECENT, BANDS,
    promptBucket, contextBucket, modelKey, quantile, usable, predict, learnedCount,
    duration, words, wordsText, bandLine, incidentFromSummary, WEB_COMPONENTS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TurnEta = api;
})(typeof self !== "undefined" ? self : this);
