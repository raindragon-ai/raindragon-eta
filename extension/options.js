const T = self.RainDragonEta;
const DEFAULTS = { enabled: true, band: "50", checkStatus: true, showResult: false };
const $ = (id) => document.getElementById(id);
// claude.ai, chatgpt.com, gemini.google.com: separate histories. Only the sites this build has a
// content script for are listed (the Web Store build is claude.ai only).
const BUILD_SITES = (chrome.runtime.getManifest().content_scripts || []).flatMap((c) => c.matches);
const PROVS = Object.values(T.PROVIDERS)
  .filter((p) => BUILD_SITES.some((u) => u.startsWith("https://" + p.site + "/")));
let state = { settings: DEFAULTS, histories: {} };

function flash(text) {
  $("saved").textContent = text;
  setTimeout(() => { $("saved").textContent = ""; }, 1500);
}

function pct(x) { return Math.round(x * 100) + "%"; }

function evalLine(h, band) {
  const good = T.learnedCount(h);
  const e = T.evaluate(h, band);
  if (!e.scored) return "not enough replies yet to check the forecast (" + good + " of " + T.MIN_READY + ").";
  const parts = Object.keys(e.byBand).sort().reverse().map((k) => {
    const b = e.byBand[k];
    return pct(b.hits / b.scored) + " of " + b.scored + " finished inside the " +
      (k === "80" ? "8-in-10 range (aim 80%)" : "middle-half range (aim 50%)");
  });
  return "how often the forecast held on your own replies: " + parts.join("; ") +
    ". Typical range: the top is " + e.medianRatio.toFixed(1) + "x the bottom.";
}

function render() {
  const s = state.settings;
  $("version").textContent = "v" + T.VERSION;
  $("enabled").checked = !!s.enabled;
  $("band").value = s.band;
  $("showResult").checked = !!s.showResult;
  $("checkStatus").checked = !!s.checkStatus;
  $("count").textContent = "";
  $("eval").textContent = "";
  for (const p of PROVS) {
    const h = state.histories[p.id] || [];
    const div = document.createElement("div");
    div.textContent = p.site + ": " + h.length + " replies saved on this device (" + T.learnedCount(h) +
      " used for forecasts; durations and word counts only); " + evalLine(h, s.band);
    $("count").appendChild(div);
  }
}

function diagnostics() {
  const per = {};
  for (const p of PROVS) {
    const h = state.histories[p.id] || [], good = T.learnedCount(h), e = T.evaluate(h, state.settings.band);
    per[p.id] = {
      replies_recorded: h.length, replies_used: good,
      replies_failed: h.filter((r) => !r.ok).length,
      replies_in_incident: h.filter((r) => r.ok && r.incident).length,
      phase: good < T.MIN_READY ? "learning (no band yet)" : good < T.CONFIDENT ? "learning (wide band)" : "ready",
      coverage: e.coverage, scored: e.scored, median_ratio: e.medianRatio,
    };
  }
  return JSON.stringify({
    name: "raindragon-forecast-extension", version: T.VERSION, settings: state.settings,
    sites: per,
    browser: navigator.userAgent.replace(/\s*\(.*?\)\s*/g, " ").trim(),
  }, null, 2);
}

const want = { settings: DEFAULTS };
for (const p of PROVS) want[p.historyKey] = [];
chrome.storage.local.get(want, (v) => {
  const histories = {};
  for (const p of PROVS) histories[p.id] = Array.isArray(v[p.historyKey]) ? v[p.historyKey] : [];
  state = { settings: Object.assign({}, DEFAULTS, v.settings), histories };
  render();
});

function save() {
  state.settings = {
    enabled: $("enabled").checked, band: $("band").value,
    showResult: $("showResult").checked, checkStatus: $("checkStatus").checked,
  };
  chrome.storage.local.set({ settings: state.settings }, () => { render(); flash("Saved"); });
}
["enabled", "band", "showResult", "checkStatus"].forEach((id) => $(id).addEventListener("change", save));

$("copy").addEventListener("click", () => {
  navigator.clipboard.writeText(diagnostics()).then(() => flash("Copied"), () => flash("Copy failed"));
});

$("clear").addEventListener("click", () => {
  const empty = { chatgpt_model: null };
  for (const p of PROVS) empty[p.historyKey] = [];
  chrome.storage.local.set(empty, () => { state.histories = {}; render(); flash("Cleared"); });
});
