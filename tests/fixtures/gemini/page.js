// A SYNTHETIC gemini.google.com page, built from the markers in
// extension/lib/gemini_dom.js (SEL). Not captured from the live site: the
// structure follows the public sources named there. All text is made up.
"use strict";
const { h, doc } = require("./minidom.js");

// opts: {model: "2.5 Flash" | null, markers: false to leave out the stop
// button and aria-busy (as if Gemini renamed them)}
function page(opts = {}) {
  const markers = opts.markers !== false;
  const editor = h("div", { class: "ql-editor", contenteditable: "true" });
  const sendSlot = h("div", { class: "send-button-container" },
    h("button", { "aria-label": "Send message", "data-test-id": "send-button" }, "Send"));
  const switcher = opts.model === null ? h("div", {}) :
    h("div", { class: "input-area-switch" },
      h("span", { "data-test-id": "primary-text" }, opts.model || "2.5 Flash"));
  const composer = h("input-area-v2", {}, h("rich-textarea", {}, editor), switcher, sendSlot);
  const chat = h("div", { id: "chat-history" },
    h("div", { class: "conversation-container" },
      h("user-query", {}, h("span", { class: "cdk-visually-hidden" }, "You said"), "an earlier synthetic question"),
      h("model-response", {}, h("message-content", {}, h("p", {}, "an earlier synthetic answer here")))));
  const d = doc(chat, composer);

  let reply = null, body = null, stopBtn = null;
  return {
    d, editor, composer,
    type(s) { editor.textContent = s; },
    // what the page does after a send: user turn + an empty reply that streams
    beginReply() {
      editor.textContent = "";
      body = h("message-content", markers ? { "aria-busy": "true" } : {});
      reply = h("model-response", {}, body);
      chat.appendChild(h("div", { class: "conversation-container" },
        h("user-query", {}, "a synthetic question"), reply));
      if (markers) {
        stopBtn = h("button", { "aria-label": "Stop response", "data-test-id": "stop-button" }, "Stop");
        sendSlot.childNodes[0].remove();
        sendSlot.appendChild(stopBtn);
      }
    },
    stream(words) { body.appendChild(h("p", {}, words)); },
    thought(words) {
      body.appendChild(h("details", { class: "gemini-thought" }, h("summary", {}, "Show thinking"), h("p", {}, words)));
    },
    error() { body.appendChild(h("div", { "data-test-id": "error-message" }, "Something went wrong")); },
    endReply() {
      if (body) body.removeAttribute("aria-busy");
      if (stopBtn) {
        stopBtn.remove(); stopBtn = null;
        sendSlot.appendChild(h("button", { "aria-label": "Send message", "data-test-id": "send-button" }, "Send"));
      }
    },
    get stopButton() { return stopBtn; },
    get reply() { return reply; },
  };
}

module.exports = { page };
