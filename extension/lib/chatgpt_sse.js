/* RainDragon ETA: read chatgpt.com's conversation stream for TIMING and LENGTH only.
 *
 * chatgpt.com answers POST /backend-api/conversation (newer builds:
 * /backend-api/f/conversation) with a server-sent event stream. The format is
 * not documented by OpenAI; this parser follows what the web app sends as of
 * 2026-10 and degrades to "nothing recorded" on anything it does not know:
 *
 *   event: delta_encoding / data: "v1"
 *   event: delta / data: {"o":"add","p":"","v":{"message":{author.role, content, metadata.model_slug, ...}}}
 *   event: delta / data: {"o":"append","p":"/message/content/parts/0","v":"text"}
 *   event: delta / data: {"v":"more text"}                (same path and op as before)
 *   event: delta / data: {"o":"patch","v":[{p,o,v}, ...]}  (several ops at once)
 *   data: {"type":"message_stream_complete", ...}
 *   data: [DONE]
 * Older builds send whole-message snapshots instead: data: {"message":{...}}.
 *
 * What it keeps: a running WORD COUNT of the visible assistant reply, when the
 * first word arrived, the model slug, and whether the stream completed or
 * reported an error. The reply text itself is never stored: each chunk is
 * counted and dropped. Reasoning ("thoughts"), tool and system messages are
 * not counted.
 *
 * Pure: no DOM, no network. Loaded in the page (by chatgpt_tap.js) and by node
 * for tests.
 */
(function (root) {
  "use strict";

  // Word counter that sees text in pieces: a word split across two chunks is
  // still one word. Matches /\S+/g on the joined text.
  function WordCounter() {
    this.n = 0;
    this.inWord = false;
  }
  WordCounter.prototype.add = function (s) {
    s = String(s || "");
    for (let i = 0; i < s.length; i++) {
      const space = /\s/.test(s[i]);
      if (!space && !this.inWord) this.n += 1;
      this.inWord = !space;
    }
  };
  WordCounter.prototype.reset = function () { this.n = 0; this.inWord = false; };

  function isVisibleAssistant(msg) {
    if (!msg || !msg.author || msg.author.role !== "assistant") return false;
    const ct = msg.content && msg.content.content_type;
    if (ct && ct !== "text" && ct !== "multimodal_text") return false;
    if (msg.recipient && msg.recipient !== "all") return false;   // tool calls
    // channel, when present: "final" and "commentary" are shown; others
    // (e.g. "analysis") are reasoning.
    if (msg.channel && msg.channel !== "final" && msg.channel !== "commentary") return false;
    return true;
  }

  function textOf(msg) {
    const parts = (msg && msg.content && msg.content.parts) || [];
    return parts.filter((p) => typeof p === "string").join("\n");
  }

  // createParser(now) -> {feed(chunk), end(), result()}
  //   now: () => ms timestamp (injectable for tests)
  function createParser(now) {
    now = now || (() => Date.now());
    let buf = "";
    let event = "", data = [];
    let current = null;        // {visible: bool} for the message being streamed
    let lastPath = "", lastOp = "";
    const words = new WordCounter();
    const st = { firstAt: null, model: null, complete: false, finished: false, error: false };

    function countText(s) {
      if (!current || !current.visible || !s) return;
      words.add(s);
      if (st.firstAt === null && words.n > 0) st.firstAt = now();
    }

    function startMessage(msg) {
      const visible = isVisibleAssistant(msg);
      const md = (msg && msg.metadata) || {};
      const slug = md.resolved_model_slug || md.model_slug;
      if (slug && visible) st.model = String(slug);
      // A snapshot of the same message carries its full text so far: recount.
      // A new visible message adds to the turn's count.
      if (visible && current && current.visible && current.id === msg.id) words.reset();
      current = { id: msg && msg.id, visible };
      if (msg && msg.status === "finished_successfully" && visible) st.finished = true;
      countText(textOf(msg));
    }

    function applyOp(op) {
      if (!op || typeof op !== "object") return;
      const p = op.p !== undefined ? op.p : lastPath;
      const o = op.o !== undefined ? op.o : lastOp;
      lastPath = p; lastOp = o;
      const v = op.v;
      if (o === "patch" && Array.isArray(v)) { v.forEach(applyOp); return; }
      if (p === "" && o === "add" && v && v.message) { startMessage(v.message); return; }
      if (/^\/message\/content\/parts\/\d+$/.test(p) && o === "append" && typeof v === "string") {
        countText(v); return;
      }
      if (/^\/message\/content\/parts\/\d+$/.test(p) && o === "replace" && typeof v === "string") {
        if (current && current.visible) { words.reset(); countText(v); }
        return;
      }
      if (p === "/message/status" && v === "finished_successfully" && current && current.visible) {
        st.finished = true;
      }
      if (p === "/message/metadata" && v && typeof v === "object" && current && current.visible) {
        const slug = v.resolved_model_slug || v.model_slug;
        if (slug) st.model = String(slug);
      }
    }

    function dispatch() {
      const raw = data.join("\n");
      const ev = event;
      event = ""; data = [];
      if (!raw) return;
      if (raw === "[DONE]") { st.complete = true; return; }
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      if (ev === "delta_encoding") return;
      if (ev === "error" || (obj && typeof obj === "object" && obj.error)) { st.error = true; return; }
      if (obj && obj.type === "message_stream_complete") { st.complete = true; return; }
      if (ev === "delta") { applyOp(obj); return; }
      if (obj && obj.message) { startMessage(obj.message); return; }   // snapshot format
      if (obj && (obj.o !== undefined || obj.v !== undefined)) applyOp(obj);
    }

    function line(l) {
      if (l === "") { dispatch(); return; }
      if (l[0] === ":") return;                        // comment / keep-alive
      const i = l.indexOf(":");
      const field = i < 0 ? l : l.slice(0, i);
      let value = i < 0 ? "" : l.slice(i + 1);
      if (value[0] === " ") value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }

    return {
      feed(chunk) {
        buf += String(chunk || "");
        let k;
        while ((k = buf.search(/\r\n|\r|\n/)) >= 0) {
          const m = buf.match(/\r\n|\r|\n/);
          line(buf.slice(0, k));
          buf = buf.slice(k + m[0].length);
        }
      },
      end() {
        if (buf) { line(buf); buf = ""; }
        dispatch();
      },
      // ok: completed, no error, some reply text. failed: the stream said so.
      // Anything else (handed off, empty, cut short) is unknown: not recorded.
      result() {
        const ok = !st.error && (st.complete || st.finished) && words.n > 0;
        return {
          outcome: st.error ? "failed" : ok ? "ok" : "unknown",
          words: words.n,
          firstAt: st.firstAt,
          model: st.model,
        };
      },
    };
  }

  // Character count of the user's new message in a conversation request body,
  // plus the model picked and the action. Only numbers and the model slug
  // leave this function, never the text.
  function requestInfo(bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch (e) { return null; }
    if (!body || typeof body !== "object") return null;
    let chars = 0;
    for (const m of body.messages || []) {
      if (m && m.author && m.author.role === "user") chars += textOf(m).length;
    }
    return {
      action: typeof body.action === "string" ? body.action : null,
      model: typeof body.model === "string" ? body.model.slice(0, 60) : null,
      promptChars: chars,
    };
  }

  const CONVERSATION_PATH = /^\/backend-api\/(?:f\/)?conversation\/?$/;

  const api = { WordCounter, createParser, requestInfo, CONVERSATION_PATH };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RainDragonEtaSSE = api;
})(typeof self !== "undefined" ? self : this);
