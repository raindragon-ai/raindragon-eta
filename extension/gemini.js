/* RainDragon ETA on gemini.google.com (content script).
 *
 * While you type: a band from your own similar past Gemini replies.
 * While Gemini replies: the elapsed time next to that band.
 * After: the reply's duration and word count are saved locally (no text), in
 * a history kept apart from claude.ai's and chatgpt.com's.
 *
 * Page markers and the turn rules live in lib/gemini_dom.js (one selector
 * table, all unverified on a live page). If they do not match, the pill
 * simply stops appearing or nothing is recorded: nothing on the page is
 * changed or blocked.
 */
(function () {
  "use strict";
  const T = self.RainDragonEta;
  const G = self.RainDragonEtaGemini;
  const PROV = T.PROVIDERS.gemini;
  const PILL = self.RainDragonEtaPill;
  const TICK_MS = 250;
  const HISTORY_CAP = 1000;
  const DEFAULTS = { enabled: true, band: "50", checkStatus: true, showResult: false };

  let settings = Object.assign({}, DEFAULTS);
  let history = [];
  let pending = null;     // {turn, pb, cb, model, incident, band}
  let lastResult = null;
  let incident = null;
  let ctxCache = { at: 0, chars: 0 };

  function load() {
    chrome.storage.local.get({ settings: DEFAULTS, [PROV.historyKey]: [] }, (v) => {
      history = Array.isArray(v[PROV.historyKey]) ? v[PROV.historyKey] : [];
      settings = Object.assign({}, DEFAULTS, v.settings || {});
    });
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings) settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
    if (ch[PROV.historyKey]) {
      const h = ch[PROV.historyKey].newValue;
      history = Array.isArray(h) ? h : [];
    }
  });

  function save(rec) {
    history = history.concat([rec]).slice(-HISTORY_CAP);
    try { chrome.storage.local.set({ [PROV.historyKey]: history }); } catch (e) { /* extension reloaded */ }
  }

  function refreshStatus() {
    if (!settings.checkStatus) { incident = null; return; }
    try {
      chrome.runtime.sendMessage({ type: "status", provider: PROV.id }, (r) => {
        incident = chrome.runtime.lastError ? null : (r && r.incident) || null;
      });
    } catch (e) { incident = null; }
  }

  function contextChars(fresh) {
    const now = Date.now();
    if (fresh || now - ctxCache.at > 2000) ctxCache = { at: now, chars: G.contextChars(document) };
    return ctxCache.chars;
  }

  // ---------- turns ----------

  function onSend() {
    if (!settings.enabled) return;     // kill switch: show nothing, record nothing
    const now = Date.now();
    if (pending && now - pending.turn.start < 1500) return;   // Enter + click for one send
    const pc = G.promptChars(document);
    if (pc === 0) return;
    const cc = contextChars(true);
    const model = G.modelLabel(document);
    pending = {
      turn: G.createTurn(document, now),
      pb: T.promptBucket(pc), cb: T.contextBucket(cc), model: T.modelKey(model),
      incident: !!incident,
      band: T.predict(history, pc, cc, model, settings.band),
    };
    lastResult = null;
  }

  function track() {
    const p = pending;
    if (!p) return;
    const r = p.turn.step(Date.now());
    if (!r) return;
    pending = null;
    const rec = G.toRecord(r, p, Math.floor(Date.now() / 1000));
    if (!rec) return;                  // stopped or unknown: never saved
    save(rec);
    if (rec.ok && settings.showResult) {
      let text = "Took " + T.duration(rec.dur) + ", " + T.wordsText(rec.words);
      if (p.band) text += " · " + T.bandLine(p.band);
      lastResult = { text, until: Date.now() + 15000 };
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (e.target && e.target.closest && e.target.closest(G.SEL.input)) onSend();
  }, true);

  document.addEventListener("pointerdown", (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (pending && t.closest(G.SEL.stop)) { pending.turn.stop(); return; }
    if (t.closest(G.SEL.send)) onSend();
  }, true);

  // ---------- the pill ----------

  const pill = PILL.create();

  function message() {
    const warn = incident ? PROV.label + ' status: "' + incident + '". Replies may be slower.' : "";
    if (pending) {
      const parts = [PILL.clock(Date.now() - pending.turn.start)];
      if (pending.band) parts.push(T.bandLine(pending.band));
      return { text: parts.join(" · "), warn };
    }
    if (lastResult && Date.now() < lastResult.until) return { text: lastResult.text, warn };
    const pc = G.promptChars(document);
    if (pc === 0) return { text: "", warn };
    const b = T.predict(history, pc, contextChars(false), G.modelLabel(document), settings.band);
    if (b) return { text: T.bandLine(b), warn };
    return { text: "Learning your pace: estimates start after " + T.MIN_READY +
             " replies (" + T.learnedCount(history) + " so far)", warn };
  }

  function render() {
    const m = settings.enabled ? message() : { text: "", warn: "" };
    pill.show(G.composer(document), m.text, m.warn);
  }

  load();
  refreshStatus();
  setInterval(refreshStatus, 120 * 1000);
  setInterval(() => {
    try { track(); render(); } catch (e) { /* never break the page */ }
  }, TICK_MS);
})();
