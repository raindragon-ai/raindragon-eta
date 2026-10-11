/* RainDragon ETA on claude.ai.
 *
 * While you type: a band from your own similar past replies, for example
 * "Half of your similar replies took 20s–1m, 300–800 words (from 24)".
 * While Claude replies: the elapsed time next to that band.
 * After: the reply's duration and word count are saved locally (no text).
 *
 * With sharing on (default; the options page shows the notice first), each
 * send also asks RainDragon's model how long Claude's reply will be: the
 * conversation's text goes to RainDragon via background.js for the prediction
 * (not kept). The answer shows as "reply ~900 tokens" and, once enough
 * replies carry one, times the band by the user's own pace. Afterwards the
 * reply's real length goes back. Nothing is sent while typing.
 *
 * Page signals used (claude.ai test ids, checked 2026-10-08):
 *   [data-testid=chat-input]           the prompt editor
 *   [data-testid=chat-input-send]      the send button
 *   [data-testid=model-selector-dropdown]  model + effort label
 *   [data-testid=transcript-list]      the conversation
 *   [data-testid=assistant-message][data-is-streaming=true|false]
 *   [data-testid=failed-send-status-region]
 * If claude.ai renames these, the pill simply stops appearing: nothing on the
 * page is changed or blocked.
 */
(function () {
  "use strict";
  const T = self.RainDragonEta;
  const SEL = {
    input: '[data-testid="chat-input"]',
    send: '[data-testid="chat-input-send"]',
    model: '[data-testid="model-selector-dropdown"]',
    transcript: '[data-testid="transcript-list"]',
    reply: '[data-testid="assistant-message"]',
    failed: '[data-testid="failed-send-status-region"]',
  };
  const TICK_MS = 250;
  const MAX_TURN_MS = 30 * 60 * 1000;   // longer than this is a tab left open
  const HISTORY_CAP = 1000;
  const DEFAULTS = { enabled: true, band: "50", checkStatus: true, showResult: false,
                     shareText: true };
  const HEAD_CHARS = 48000, TAIL_CHARS = 16000;   // the model reads the head

  let settings = Object.assign({}, DEFAULTS);
  let history = [];
  let pending = null;     // the reply in progress
  let lastResult = null;  // {text, until}
  let incident = null;
  let ctxCache = { at: 0, chars: 0 };

  // ---------- storage ----------

  function load() {
    chrome.storage.local.get({ history: [], settings: DEFAULTS }, (v) => {
      history = Array.isArray(v.history) ? v.history : [];
      settings = Object.assign({}, DEFAULTS, v.settings || {});
    });
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings) settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
    if (ch.history) history = Array.isArray(ch.history.newValue) ? ch.history.newValue : [];
  });

  function save(rec) {
    history = history.concat([rec]).slice(-HISTORY_CAP);
    try { chrome.storage.local.set({ history }); } catch (e) { /* extension reloaded */ }
  }

  function refreshStatus() {
    if (!settings.checkStatus) { incident = null; return; }
    try {
      chrome.runtime.sendMessage({ type: "status" }, (r) => {
        incident = chrome.runtime.lastError ? null : (r && r.incident) || null;
      });
    } catch (e) { incident = null; }
  }

  // ---------- page reading ----------

  const $ = (s) => document.querySelector(s);

  function promptChars() {
    const el = $(SEL.input);
    return el ? el.innerText.trim().length : 0;
  }

  function contextChars(fresh) {
    const now = Date.now();
    if (fresh || now - ctxCache.at > 2000) {
      const el = $(SEL.transcript);
      ctxCache = { at: now, chars: el ? el.innerText.length : 0 };
    }
    return ctxCache.chars;
  }

  function modelLabel() {
    const el = $(SEL.model);
    return el ? el.innerText : "";
  }

  function lastReply() {
    const all = document.querySelectorAll(SEL.reply);
    return all.length ? all[all.length - 1] : null;
  }

  function promptText() {
    const el = $(SEL.input);
    return el ? el.innerText.trim() : "";
  }

  // Training format: the conversation, oldest first, then the new prompt.
  function conversationText(prompt) {
    const el = $(SEL.transcript);
    let t = ((el ? el.innerText : "") + " " + prompt).trim();
    if (t.length > HEAD_CHARS + TAIL_CHARS) t = t.slice(0, HEAD_CHARS) + " " + t.slice(-TAIL_CHARS);
    return t;
  }

  function askPrediction(p, prompt, cc, model) {
    if (!settings.shareText) return;
    const body = {
      model: T.modelId(model), text: conversationText(prompt),
      prompt_tokens: Math.max(1, Math.floor((cc + prompt.length) / 4)),
      cached_tokens: Math.floor(cc / 4),
      turn_idx: document.querySelectorAll(SEL.reply).length,
    };
    try {
      chrome.runtime.sendMessage({ type: "predict", body }, (r) => {
        if (chrome.runtime.lastError || !r || pending !== p) return;
        p.pred = r.output_tokens;
        p.pid = r.prediction_id;
        const b = T.predictedBand(history, p.pred, settings.band);
        if (b) p.band = b;
      });
    } catch (e) { /* extension reloaded */ }
  }

  // Characters Claude wrote, without the screen-reader heading.
  function replyChars(el) {
    if (!el) return 0;
    let n = (el.innerText || "").length;
    for (const sr of el.querySelectorAll(".sr-only")) n -= (sr.innerText || "").length;
    return Math.max(0, n);
  }

  function countWords(text) {
    const m = (text || "").match(/\S+/g);
    return m ? m.length : 0;
  }

  // Each reply carries a screen-reader-only heading ("Claude responded: ..."):
  // its words are not part of the reply.
  function wordCount(el) {
    if (!el) return 0;
    let n = countWords(el.innerText);
    for (const sr of el.querySelectorAll(".sr-only")) n -= countWords(sr.innerText);
    return Math.max(0, n);
  }

  // ---------- turn tracking ----------

  function onSend() {
    if (!settings.enabled) return;     // kill switch: show nothing, record nothing
    const now = Date.now();
    if (pending && now - pending.start < 1500) return;   // Enter + click for one send
    const pc = promptChars();
    if (pc === 0) return;
    const cc = contextChars(true);
    const model = modelLabel();
    const prompt = promptText();
    pending = {
      start: now, before: lastReply(), el: null, sawStreaming: false, firstAt: null,
      pb: T.promptBucket(pc), cb: T.contextBucket(cc), model: T.modelKey(model),
      incident: !!incident, stopped: false,
      band: T.predict(history, pc, cc, model, settings.band),
      pred: null, pid: null,
    };
    lastResult = null;
    askPrediction(pending, prompt, cc, model);
  }

  function finish(ok) {
    const p = pending;
    pending = null;
    if (!p || p.stopped) return;           // stopped by the user: not a real duration
    const dur = (Date.now() - p.start) / 1000;
    if (dur <= 0 || dur * 1000 > MAX_TURN_MS) return;
    const rec = { t: Math.floor(Date.now() / 1000), dur: Math.round(dur * 100) / 100,
                  pb: p.pb, cb: p.cb, model: p.model, ok, incident: p.incident };
    if (ok) {
      rec.words = wordCount(p.el);
      if (p.firstAt) rec.first = Math.round((p.firstAt - p.start) / 10) / 100;
    }
    if (p.pred) rec.pred = p.pred;
    save(rec);
    if (p.pid) {
      try {
        chrome.runtime.sendMessage({ type: "outcome", body: {
          prediction_id: p.pid, duration_ms: Math.round(dur * 1000), failed: !ok,
          output_tokens: ok ? Math.max(1, Math.round(replyChars(p.el) / 4)) : null } });
      } catch (e) { /* extension reloaded */ }
    }
    if (ok && settings.showResult) {
      let text = "Took " + T.duration(dur) + ", " + T.wordsText(rec.words);
      if (p.band) text += " · " + T.bandLine(p.band);
      lastResult = { text, until: Date.now() + 15000 };
    }
  }

  function track() {
    const p = pending;
    if (!p) return;
    if (Date.now() - p.start > MAX_TURN_MS) { pending = null; return; }
    const failed = $(SEL.failed);
    if (failed && failed.innerText.trim()) { finish(false); return; }
    const el = lastReply();
    if (!el || el === p.before && el.getAttribute("data-is-streaming") !== "true") return;
    p.el = el;
    const streaming = el.getAttribute("data-is-streaming") === "true";
    if (!p.firstAt && wordCount(el) > 0) p.firstAt = Date.now();
    if (streaming) { p.sawStreaming = true; return; }
    if (p.sawStreaming || wordCount(el) > 0) finish(true);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (e.target && e.target.closest && e.target.closest(SEL.input)) onSend();
  }, true);

  document.addEventListener("pointerdown", (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest(SEL.send)) { onSend(); return; }
    const b = t.closest("button[aria-label]");
    if (pending && b && /^stop/i.test(b.getAttribute("aria-label"))) pending.stopped = true;
  }, true);

  // ---------- the pill ----------

  const host = document.createElement("div");
  host.id = "raindragon-eta-host";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.pill{position:fixed;z-index:2147483000;max-width:min(640px,90vw);' +
    'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'padding:3px 10px;border-radius:999px;pointer-events:none;' +
    'background:rgba(240,238,230,.95);color:#3d3929;border:1px solid rgba(0,0,0,.08);' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.warn{color:#9a3412}' +
    '@media (prefers-color-scheme:dark){.pill{background:rgba(48,48,46,.95);color:#e8e6dc;' +
    'border-color:rgba(255,255,255,.1)}.warn{color:#fdba74}}' +
    '</style><div class="pill" hidden></div>';
  const pill = shadow.querySelector(".pill");

  function clock(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function message() {
    const warn = incident ? 'Claude status: "' + incident + '". Replies may be slower.' : "";
    if (pending) {
      const parts = [clock(Date.now() - pending.start)];
      if (pending.pred) parts.push("reply " + T.tokensText(pending.pred));
      if (pending.band) parts.push(T.bandLine(pending.band));
      return { text: parts.join(" · "), warn };
    }
    if (lastResult && Date.now() < lastResult.until) return { text: lastResult.text, warn };
    const pc = promptChars();
    if (pc === 0) return { text: "", warn };
    const b = T.predict(history, pc, contextChars(false), modelLabel(), settings.band);
    if (b) return { text: T.bandLine(b), warn };
    return { text: "Learning your pace: estimates start after " + T.MIN_READY +
             " replies (" + T.learnedCount(history) + " so far)", warn };
  }

  function render() {
    const input = $(SEL.input);
    const box = input && (input.closest("fieldset") || input);
    const m = settings.enabled ? message() : { text: "", warn: "" };
    if (!box || (!m.text && !m.warn)) { pill.hidden = true; return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    pill.textContent = "";
    if (m.text) pill.appendChild(document.createTextNode("RainDragon ETA · " + m.text));
    if (m.warn) {
      const w = document.createElement("span");
      w.className = "warn";
      w.textContent = (m.text ? " · " : "RainDragon ETA · ") + m.warn;
      pill.appendChild(w);
    }
    const r = box.getBoundingClientRect();
    pill.style.left = Math.max(8, r.left + 12) + "px";
    pill.style.top = Math.max(4, r.top - 26) + "px";
    pill.hidden = false;
  }

  load();
  refreshStatus();
  setInterval(refreshStatus, 120 * 1000);
  setInterval(() => {
    try { track(); render(); } catch (e) { /* never break the page */ }
  }, TICK_MS);
})();
