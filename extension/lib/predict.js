/* RainDragon Forecast for claude.ai, chatgpt.com and gemini.google.com: duration and length bands from the user's own past replies.
 *
 * Same rules as the Claude Code plugin (plugin/scripts/raindragon_eta/predict.py):
 * a BAND (middle half by default) of similar past replies, never a single
 * number; nothing until MIN_READY good replies, then the wide 8-in-10 band
 * labelled "still learning" until CONFIDENT; failed, stopped and
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
    if (good.length < MIN_READY) return null;
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
      const s = byBand[b.coverage] || (byBand[b.coverage] = { scored: 0, hits: 0 });
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

  // "Forecast 20s–1m · 300–800 words"
  function bandLine(p) {
    let s = "Forecast " + span(duration(p.dur.low), duration(p.dur.high));
    if (p.words) s += " · " + wordsText(p.words.low, p.words.high);
    return s + (p.learning ? " · still learning" : "");
  }

  // a stopwatch reading for time that really passed: 0:12, 1:02:05
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + ss : m + ":" + ss;
  }

  // While a reply runs. long: the clock has passed the top of the range.
  function liveLine(band, elapsedMs) {
    const c = clock(elapsedMs);
    if (!band) return { text: c, long: false };
    if (elapsedMs / 1000 > band.dur.high) {
      return { text: c + " · running long · forecast was " +
               span(duration(band.dur.low), duration(band.dur.high)), long: true };
    }
    return { text: bandLine(band) + " · " + c, long: false };
  }

  // "Done in 1:12, 450 words · inside the forecast"
  function doneLine(dur, nWords, band) {
    let s = "Done in " + clock(dur * 1000) + ", " + wordsText(nWords);
    if (!band) return s;
    const range = span(duration(band.dur.low), duration(band.dur.high));
    if (dur > band.dur.high) return s + " · longer than the forecast (" + range + ")";
    if (dur < band.dur.low) return s + " · quicker than the forecast (" + range + ")";
    return s + " · inside the forecast";
  }

  function learningLine(n) {
    return "Forecast is learning your pace. Ranges start after " + MIN_READY +
      " replies (" + n + " so far).";
  }

  function incidentLine(label) {
    return "Storm warning: " + label + " has a major incident. Replies may be slower.";
  }

  // ---- status.claude.com ----

  const WEB_COMPONENTS = ["claude.ai", "claude api"];

  // Each chat site keeps its own history (its own storage key) and its own
  // status page: a ChatGPT reply never shapes a Claude band, or the reverse.
  // Within one site, "similar" still narrows by model first (see predict()).
  // status.openai.com is an incident.io page; its Statuspage-compatible
  // summary.json lists ChatGPT's chat as the "Conversations" component.
  const PROVIDERS = {
    claude: {
      id: "claude", label: "Claude", site: "claude.ai", historyKey: "history",
      statusUrl: "https://status.claude.com/api/v2/summary.json",
      statusComponents: WEB_COMPONENTS,
    },
    chatgpt: {
      id: "chatgpt", label: "ChatGPT", site: "chatgpt.com", historyKey: "history_chatgpt",
      statusUrl: "https://status.openai.com/api/v2/summary.json",
      statusComponents: ["conversations"],
    },
    // Google's Workspace status dashboard lists the Gemini app as product
    // npdyhgECDJ6tB66MxXyo; see incidentFromGoogle().
    gemini: {
      id: "gemini", label: "Gemini", site: "gemini.google.com", historyKey: "history_gemini",
      statusUrl: "https://www.google.com/appsstatus/dashboard/incidents.json",
      statusFormat: "google", statusProduct: "npdyhgECDJ6tB66MxXyo",
    },
  };
  // Only MAJOR problems count (same rule and evidence as the plugin's
  // status.py): major incidents slowed turns 1.81x, minor/degraded did not.
  const MAJOR_IMPACTS = ["major", "critical"];
  // "full_outage" is incident.io's name for it (status.openai.com).
  const MAJOR_COMPONENT_STATUS = ["major_outage", "full_outage"];

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

  // ---- www.google.com/appsstatus (Gemini) ----
  //
  // incidents.json is a flat list of incidents, past and present (checked
  // 2026-10-19: 39 entries, 4 for Gemini, all ended). Fields used: begin,
  // end, severity (low/medium/high), status_impact (SERVICE_INFORMATION /
  // SERVICE_DISRUPTION / SERVICE_OUTAGE), affected_products[].id, service_key.
  // MAJOR-only, as for Claude: an active incident on this product with
  // status_impact SERVICE_OUTAGE or severity high. "Active" = no end yet, or
  // an end in the future. No open incident has been observed in the feed, so
  // how `end` looks while open (null, missing, empty) is handled all three
  // ways. Anything unparseable means "no known incident".
  function incidentFromGoogle(list, productId, nowMs) {
    if (!Array.isArray(list) || !productId) return null;
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    for (const inc of list) {
      if (!inc || typeof inc !== "object") continue;
      const ids = (Array.isArray(inc.affected_products) ? inc.affected_products : [])
        .map((p) => p && p.id).concat([inc.service_key]);
      if (ids.indexOf(productId) < 0) continue;
      if (inc.end) {
        const e = Date.parse(inc.end);
        if (!(e > now)) continue;          // ended, or a date we cannot read
      }
      if (inc.begin) {
        const b = Date.parse(inc.begin);
        if (!(b <= now)) continue;         // not started, or unreadable
      }
      const impact = String(inc.status_impact || "").toUpperCase();
      const sev = String(inc.severity || "").toLowerCase();
      if (impact === "SERVICE_OUTAGE") return "service outage";
      if (sev === "high") return "high-severity incident";
    }
    return null;
  }

  const api = {
    VERSION, MIN_READY, CONFIDENT, MIN_GROUP, RECENT, BANDS,
    promptBucket, contextBucket, modelKey, quantile, usable, predict, evaluate, learnedCount,
    duration, words, wordsText, bandLine, clock, liveLine, doneLine, learningLine, incidentLine, incidentFromSummary, incidentFromGoogle, WEB_COMPONENTS, PROVIDERS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RainDragonEta = api;
})(typeof self !== "undefined" ? self : this);
