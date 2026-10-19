/* RainDragon ETA on chatgpt.com: timing tap (runs in the page's own JS world).
 *
 * Wraps window.fetch so that, for a NEW message sent to the conversation
 * endpoint (POST /backend-api/conversation or /backend-api/f/conversation,
 * action "next"), it reads a COPY of the response stream (Response.clone())
 * and reports, to this extension's content script on the same tab:
 *
 *   start  {promptChars, model}          when the request is sent
 *   first  {}                            when the first reply word arrives
 *   end    {outcome, words, model}       outcome: ok | failed | stopped | unknown
 *
 * Only numbers and the model slug are posted. The prompt and reply text are
 * read in memory to count characters and words, and dropped; nothing is
 * stored here or sent off the page. The page's own request and response are
 * passed through untouched: the wrapper returns the page's original promise.
 * Regenerations and "continue" are not timed (like claude.ai, only sends are).
 */
(function () {
  "use strict";
  const S = self.RainDragonEtaSSE;
  if (!S || window.__raindragonEtaTap || typeof window.fetch !== "function") return;
  window.__raindragonEtaTap = true;

  const original = window.fetch;
  let seq = 0;

  function post(msg) {
    try { window.postMessage(Object.assign({ __raindragonEta: 1 }, msg), location.origin); } catch (e) { /* ignore */ }
  }

  function watch(id, responsePromise) {
    responsePromise.then((resp) => {
      if (!resp.ok) { post({ kind: "end", id, outcome: "failed" }); return; }
      const ct = (resp.headers && resp.headers.get("content-type")) || "";
      if (!/event-stream/i.test(ct) || !resp.body) { post({ kind: "end", id, outcome: "unknown" }); return; }
      const reader = resp.clone().body.getReader();
      const dec = new TextDecoder();
      const parser = S.createParser();
      let firstSent = false;
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          parser.end();
          const r = parser.result();
          post({ kind: "end", id, outcome: r.outcome, words: r.words, model: r.model });
          return;
        }
        parser.feed(dec.decode(value, { stream: true }));
        if (!firstSent && parser.result().firstAt !== null) { firstSent = true; post({ kind: "first", id }); }
        return pump();
      });
      pump().catch((e) => {
        // The page may abort the request after the stream has completed: that
        // is a finished reply, not a stop.
        const r = parser.result();
        if (r.outcome === "ok") { post({ kind: "end", id, outcome: "ok", words: r.words, model: r.model }); return; }
        post({ kind: "end", id, outcome: e && e.name === "AbortError" ? "stopped" : "unknown" });
      });
    }, (e) => post({ kind: "end", id, outcome: e && e.name === "AbortError" ? "stopped" : "failed" }));
  }

  window.fetch = function (input, init) {
    const result = original.apply(this, arguments);
    try {
      const rawUrl = typeof input === "string" ? input : (input && input.url) || String(input);
      const url = new URL(rawUrl, location.href);
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (url.origin === location.origin && method === "POST" && S.CONVERSATION_PATH.test(url.pathname)) {
        const info = init && typeof init.body === "string" ? S.requestInfo(init.body) : null;
        if (info && info.action === "next") {
          const id = ++seq;
          post({ kind: "start", id, promptChars: info.promptChars, model: info.model });
          watch(id, result);
        }
      }
    } catch (e) { /* never break the page */ }
    return result;
  };
})();
