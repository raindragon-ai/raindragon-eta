/* RainDragon Forecast on chatgpt.com (content script, isolated world).
 *
 * While you type: a band from your own similar past ChatGPT replies.
 * While ChatGPT replies: the elapsed time next to that band.
 * After: the reply's duration and word count are saved locally (no text), in
 * a history kept apart from claude.ai's.
 *
 * Turn start/end, prompt size, reply length and model come from
 * chatgpt_tap.js, which reads a copy of the conversation stream in the page
 * (numbers only). The page is read only for:
 *   #prompt-textarea                      the message box (size while typing; where the pill goes)
 *   [data-message-author-role]            messages on screen (conversation size, characters only)
 *   [data-testid=stop-button]             you stopped the reply: not recorded
 * Selectors checked against public descriptions of chatgpt.com, 2026-10;
 * NOT yet checked on a live signed-in page. If they change, the pill simply
 * stops appearing: nothing on the page is changed or blocked.
 */
(function () {
  "use strict";
  const T = self.RainDragonEta;
  const PROV = T.PROVIDERS.chatgpt;
  const PILL = self.RainDragonEtaPill;
  const SEL = {
    input: "#prompt-textarea",
    messages: "[data-message-author-role]",
    stop: '[data-testid="stop-button"]',
  };
  const TICK_MS = 250;
  const MAX_TURN_MS = 30 * 60 * 1000;
  const HISTORY_CAP = 1000;
  const MODEL_KEY = "chatgpt_model";   // last model you sent with, to estimate while typing
  const DEFAULTS = { enabled: true, band: "50", checkStatus: true, showResult: false };

  let settings = Object.assign({}, DEFAULTS);
  let history = [];
  let lastModel = null;
  let pending = null;
  let lastResult = null;
  let incident = null;
  let ctxCache = { at: 0, chars: 0 };

  function load() {
    const want = { settings: DEFAULTS, [PROV.historyKey]: [], [MODEL_KEY]: null };
    chrome.storage.local.get(want, (v) => {
      history = Array.isArray(v[PROV.historyKey]) ? v[PROV.historyKey] : [];
      settings = Object.assign({}, DEFAULTS, v.settings || {});
      lastModel = typeof v[MODEL_KEY] === "string" ? v[MODEL_KEY] : null;
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

  function rememberModel(m) {
    if (!m || m === lastModel) return;
    lastModel = m;
    try { chrome.storage.local.set({ [MODEL_KEY]: m }); } catch (e) { /* extension reloaded */ }
  }

  function refreshStatus() {
    if (!settings.checkStatus) { incident = null; return; }
    try {
      chrome.runtime.sendMessage({ type: "status", provider: PROV.id }, (r) => {
        incident = chrome.runtime.lastError ? null : (r && r.incident) || null;
      });
    } catch (e) { incident = null; }
  }

  const $ = (s) => document.querySelector(s);

  function promptChars() {
    const el = $(SEL.input);
    if (!el) return 0;
    return ("value" in el && typeof el.value === "string" ? el.value : el.innerText).trim().length;
  }

  function contextChars(fresh) {
    const now = Date.now();
    if (fresh || now - ctxCache.at > 2000) {
      let n = 0;
      for (const el of document.querySelectorAll(SEL.messages)) n += el.innerText.length;
      ctxCache = { at: now, chars: n };
    }
    return ctxCache.chars;
  }

  // ---------- turns, from the tap ----------

  const num = (x) => typeof x === "number" && isFinite(x) && x >= 0 ? x : 0;
  const slug = (x) => typeof x === "string" ? x.slice(0, 60) : null;

  function onStart(d) {
    if (!settings.enabled) { pending = null; return; }   // kill switch: show nothing, record nothing
    const pc = num(d.promptChars);
    const cc = contextChars(true);
    const model = slug(d.model);
    rememberModel(model);
    pending = {
      id: d.id, start: Date.now(), firstAt: null, stopped: false,
      pb: T.promptBucket(pc), cb: T.contextBucket(cc), model: T.modelKey(model),
      incident: !!incident,
      band: T.predict(history, pc, cc, model, settings.band),
    };
    lastResult = null;
  }

  function onEnd(d) {
    const p = pending;
    if (!p || p.id !== d.id) return;
    pending = null;
    if (p.stopped || d.outcome === "stopped" || d.outcome === "unknown") return;
    const dur = (Date.now() - p.start) / 1000;
    if (dur <= 0 || dur * 1000 > MAX_TURN_MS) return;
    const ok = d.outcome === "ok";
    const rec = { t: Math.floor(Date.now() / 1000), dur: Math.round(dur * 100) / 100,
                  pb: p.pb, cb: p.cb, model: p.model, ok, incident: p.incident };
    if (ok) {
      rec.words = num(d.words);
      if (p.firstAt) rec.first = Math.round((p.firstAt - p.start) / 10) / 100;
    }
    save(rec);
    if (ok && settings.showResult) {
      const text = T.doneLine(dur, rec.words, p.band);
      lastResult = { text, until: Date.now() + 15000 };
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__raindragonEta !== 1 || typeof d.id !== "number") return;
    if (d.kind === "start") onStart(d);
    else if (d.kind === "first") { if (pending && pending.id === d.id && !pending.firstAt) pending.firstAt = Date.now(); }
    else if (d.kind === "end") onEnd(d);
  });

  document.addEventListener("pointerdown", (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (pending && t && t.closest(SEL.stop)) pending.stopped = true;
  }, true);

  // ---------- the pill ----------

  const pill = PILL.create();

  function message() {
    const warn = incident ? T.incidentLine(PROV.label) : "";
    if (pending) {
      if (Date.now() - pending.start > MAX_TURN_MS) { pending = null; return { text: "", warn }; }
      const live = T.liveLine(pending.band, Date.now() - pending.start);
      return { text: live.text, warn, long: live.long };
    }
    if (lastResult && Date.now() < lastResult.until) return { text: lastResult.text, warn };
    const pc = promptChars();
    if (pc === 0) return { text: "", warn };
    const b = T.predict(history, pc, contextChars(false), lastModel, settings.band);
    if (b) return { text: T.bandLine(b), warn };
    return { text: T.learningLine(T.learnedCount(history)), warn };
  }

  function render() {
    const input = $(SEL.input);
    const box = input && (input.closest("form") || input);
    const m = settings.enabled ? message() : { text: "", warn: "" };
    pill.show(box, m.text, m.warn, m.long);
  }

  load();
  refreshStatus();
  setInterval(refreshStatus, 120 * 1000);
  setInterval(() => {
    try { render(); } catch (e) { /* never break the page */ }
  }, TICK_MS);
})();
