const T = self.RainDragonEta;
const DEFAULTS = { enabled: true, band: "50", checkStatus: true, showResult: false };
const $ = (id) => document.getElementById(id);
let state = { settings: DEFAULTS, history: [] };

function flash(text) {
  $("saved").textContent = text;
  setTimeout(() => { $("saved").textContent = ""; }, 1500);
}

function pct(x) { return Math.round(x * 100) + "%"; }

function render() {
  const s = state.settings, h = state.history;
  $("version").textContent = "v" + T.VERSION;
  $("enabled").checked = !!s.enabled;
  $("band").value = s.band;
  $("showResult").checked = !!s.showResult;
  $("checkStatus").checked = !!s.checkStatus;
  const good = T.learnedCount(h);
  $("count").textContent = h.length + " replies saved on this device (" + good +
    " used for estimates; durations and word counts only).";
  const e = T.evaluate(h, s.band);
  if (!e.scored) {
    $("eval").textContent = "Accuracy check: not enough replies yet (" + good + " of " + T.MIN_READY + ").";
    return;
  }
  const parts = Object.keys(e.byBand).sort().reverse().map((k) => {
    const b = e.byBand[k];
    return pct(b.hits / b.scored) + " of " + b.scored + " landed in the " +
      (k === "typical" ? "typical band of your first replies (target 80%)"
        : k === "80" ? "8-in-10 band (target 80%)" : "middle-half band (target 50%)");
  });
  $("eval").textContent = "How often the band held on your own replies: " + parts.join("; ") +
    ". Usual width: top is " + e.medianRatio.toFixed(1) + "x the bottom.";
}

function diagnostics() {
  const h = state.history, good = T.learnedCount(h), e = T.evaluate(h, state.settings.band);
  return JSON.stringify({
    name: "raindragon-eta-extension", version: T.VERSION, settings: state.settings,
    replies_recorded: h.length, replies_used: good,
    replies_failed: h.filter((r) => !r.ok).length,
    replies_in_incident: h.filter((r) => r.ok && r.incident).length,
    phase: good < T.MIN_READY ? "learning (typical band)" : good < T.CONFIDENT ? "learning (wide band)" : "ready",
    coverage: e.coverage, scored: e.scored, median_ratio: e.medianRatio,
    browser: navigator.userAgent.replace(/\s*\(.*?\)\s*/g, " ").trim(),
  }, null, 2);
}

chrome.storage.local.get({ settings: DEFAULTS, history: [] }, (v) => {
  state = { settings: Object.assign({}, DEFAULTS, v.settings), history: v.history || [] };
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
  chrome.storage.local.set({ history: [] }, () => { state.history = []; render(); flash("Cleared"); });
});
