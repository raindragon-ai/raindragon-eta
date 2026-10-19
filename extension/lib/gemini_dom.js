/* RainDragon ETA on gemini.google.com: page markers and turn tracking.
 *
 * Gemini's own stream (StreamGenerate, length-prefixed positional JSON) is
 * undocumented and would break silently on any layout change, so this reads
 * page markers instead, the way the claude.ai script does:
 *
 *   turn start  you press Enter in the prompt box or click Send
 *   streaming   the stop control is on screen, or the new reply is aria-busy
 *   turn end    streaming stops and the new reply's text has not changed
 *               for SETTLE_MS
 *   outcome     ok      streaming seen, ended, new reply has words, no error
 *               failed  an error marker inside the new reply
 *               stopped you clicked the stop control (not saved)
 *               unknown anything else (not saved): no streaming marker ever
 *                       seen, no new reply element, no words, timed out
 *
 * EVERY SELECTOR BELOW IS UNVERIFIED on a live signed-in page: the author
 * cannot log in to gemini.google.com from the build machine. They come from
 * public extensions and notes (sources per entry). If one is wrong the
 * failure is silent and safe: no pill (input), or every turn ends "unknown"
 * and nothing is recorded (stop/reply), or one model bucket (model).
 * Each entry is a selector list; the first match wins.
 *
 * Only lengths and word counts are read from the page. No text is kept,
 * stored or sent. Plain script: loaded by the content script, and by node for
 * tests (against a synthetic DOM).
 */
(function (root) {
  "use strict";

  const SEL = {
    // The prompt editor (Quill inside a <rich-textarea> custom element).
    // Source: gist.github.com/maciejkos/98afba3ff3443f2066e67f47bbe2ad0e,
    // github.com/LayneIns/Ask-Gemini-Extension.
    input: 'rich-textarea .ql-editor, rich-textarea [contenteditable="true"]',
    // Where the pill sits: the composer around the editor, else the editor.
    // Source: same; `input-area-v2` is the composer element name in those notes.
    composer: "input-area-v2, .input-area, rich-textarea",
    // Send button. Source: LayneIns/Ask-Gemini-Extension (aria-label),
    // maciejkos gist (data-test-id).
    send: 'button[aria-label="Send message"], [data-test-id="send-button"]',
    // Stop control while Gemini is answering. NO PUBLIC SOURCE CONFIRMS THIS
    // (docs/PROVIDERS.md): best guesses by analogy with the send button.
    // Check in DevTools first. If wrong, every turn ends "unknown".
    stop: 'button[aria-label="Stop response"], [data-test-id="stop-button"]',
    // One assistant reply. Source: maciejkos gist, Ask-Gemini-Extension.
    reply: "model-response",
    // The reply's visible text inside a <model-response>. Source: same.
    replyText: "message-content, .response-content",
    // Inside replyText but not reply words: the collapsible thinking block,
    // screen-reader-only text, hidden nodes. Source: maciejkos gist
    // (gemini-thought); the hidden classes are Angular CDK / common a11y.
    notWords: 'details.gemini-thought, .cdk-visually-hidden, .sr-only, [aria-hidden="true"], [hidden]',
    // Second streaming marker (on the reply text while it grows). Unverified.
    busy: '[aria-busy="true"]',
    // Error shown in place of a reply. NO PUBLIC SOURCE: placeholder. If it
    // never matches, a failed reply has no words and ends "unknown" (dropped),
    // which is the safe direction.
    error: '[data-test-id="error-message"], .response-error',
    // Model picker label (+ thinking level). Source:
    // github.com/yarden-carmi/Gemini-Pro-Auto-Selector. Missing: one bucket.
    model: '.input-area-switch [data-test-id="primary-text"], [data-test-id="bard-mode-menu-button"] [data-test-id="primary-text"]',
    // Messages on screen, for conversation size (characters only).
    messages: "user-query, model-response",
  };

  const SETTLE_MS = 1000;          // text unchanged this long after streaming stops
  const NO_MARKER_MS = 5000;       // reply settled without any streaming marker: unknown
  const NO_REPLY_MS = 120 * 1000;  // no streaming and no new reply: unknown
  const MAX_TURN_MS = 30 * 60 * 1000;

  const BLOCK = /^(p|div|li|ul|ol|h[1-6]|pre|blockquote|table|tr|td|th|br|section|article|header|footer)$/i;

  function first(doc, list) {
    return doc.querySelector(list);
  }

  function text(el) {
    return el ? String(el.textContent || "") : "";
  }

  function countWords(s) {
    const m = (s || "").match(/\S+/g);
    return m ? m.length : 0;
  }

  // Words in the reply's visible text, skipping thinking and hidden subtrees.
  // Text nodes are joined, with a space at block boundaries, so "a<b>b</b>"
  // is one word and "<p>a</p><p>b</p>" two.
  function replyWords(reply) {
    if (!reply) return 0;
    const box = reply.querySelector(SEL.replyText);
    if (!box) return 0;
    const parts = [];
    (function walk(node) {
      for (const c of node.childNodes || []) {
        if (c.nodeType === 3) { parts.push(c.nodeValue || ""); continue; }
        if (c.nodeType !== 1) continue;
        if (c.matches && c.matches(SEL.notWords)) continue;
        const block = BLOCK.test(c.tagName || "");
        if (block) parts.push(" ");
        walk(c);
        if (block) parts.push(" ");
      }
    })(box);
    return countWords(parts.join(""));
  }

  function promptChars(doc) {
    return text(first(doc, SEL.input)).trim().length;
  }

  function contextChars(doc) {
    let n = 0;
    for (const el of doc.querySelectorAll(SEL.messages)) n += text(el).length;
    return n;
  }

  // "" when the picker label is not on the page: every reply then shares one bucket.
  function modelLabel(doc) {
    return text(first(doc, SEL.model)).replace(/\s+/g, " ").trim();
  }

  function lastReply(doc) {
    const all = doc.querySelectorAll(SEL.reply);
    return all.length ? all[all.length - 1] : null;
  }

  function composer(doc) {
    const input = first(doc, SEL.input);
    if (!input) return null;
    for (const s of SEL.composer.split(",")) {      // in order of preference
      const box = input.closest(s.trim());
      if (box) return box;
    }
    return input;
  }

  // One turn, from send to end. step() returns null while running, then once
  // {outcome, words, dur, first} with dur/first in seconds.
  function createTurn(doc, now) {
    const t = {
      start: now, before: lastReply(doc), sawStreaming: false, stopped: false,
      el: null, words: 0, changedAt: now, streamEndAt: null, firstAt: null, done: false,
    };

    function end(outcome, at) {
      t.done = true;
      const r = { outcome, words: outcome === "ok" ? t.words : 0, dur: (at - t.start) / 1000 };
      if (outcome === "ok" && t.firstAt) r.first = (t.firstAt - t.start) / 1000;
      return r;
    }

    function step(nowMs) {
      if (t.done) return null;
      if (nowMs - t.start > MAX_TURN_MS) return end("unknown", nowMs);
      const el = lastReply(doc);
      const isNew = !!el && el !== t.before;
      if (isNew) {
        if (el !== t.el) { t.el = el; t.words = -1; }
        const w = replyWords(el);
        if (w !== t.words) { t.words = w; t.changedAt = nowMs; }
        if (w > 0 && !t.firstAt) t.firstAt = nowMs;
      }
      const streaming = !!first(doc, SEL.stop) || (isNew && !!el.querySelector(SEL.busy));
      if (streaming) { t.sawStreaming = true; t.streamEndAt = null; return null; }
      if (!t.sawStreaming) {
        if (isNew && t.words > 0 && nowMs - t.changedAt >= NO_MARKER_MS) return end("unknown", nowMs);
        if (!isNew && nowMs - t.start > NO_REPLY_MS) return end("unknown", nowMs);
        return null;
      }
      if (t.streamEndAt === null) t.streamEndAt = nowMs;
      if (t.stopped) return end("stopped", nowMs);
      if (!isNew) return end("unknown", nowMs);
      if (el.querySelector(SEL.error)) return end("failed", nowMs);
      if (nowMs - Math.max(t.changedAt, t.streamEndAt) < SETTLE_MS) return null;
      if (t.words <= 0) return end("unknown", nowMs);
      return end("ok", Math.max(t.streamEndAt, t.changedAt));
    }

    return { step, stop() { t.stopped = true; }, get start() { return t.start; } };
  }

  // The history record for a finished turn, or null: only ok and failed are
  // saved; stopped and unknown never are. Same fields as claude.ai's records.
  function toRecord(r, p, tSec) {
    if (!r || (r.outcome !== "ok" && r.outcome !== "failed")) return null;
    if (!(r.dur > 0) || r.dur * 1000 > MAX_TURN_MS) return null;
    const ok = r.outcome === "ok";
    const rec = { t: tSec, dur: Math.round(r.dur * 100) / 100,
                  pb: p.pb, cb: p.cb, model: p.model, ok, incident: !!p.incident };
    if (ok) {
      rec.words = r.words;
      if (r.first) rec.first = Math.round(r.first * 100) / 100;
    }
    return rec;
  }

  const api = {
    SEL, SETTLE_MS, NO_MARKER_MS, NO_REPLY_MS, MAX_TURN_MS,
    replyWords, promptChars, contextChars, modelLabel, lastReply, composer, createTurn, toRecord,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RainDragonEtaGemini = api;
})(typeof self !== "undefined" ? self : this);
