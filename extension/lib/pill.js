/* RainDragon ETA: the small pill shown just above a chat site's message box.
 * Shared by the claude.ai and chatgpt.com content scripts. It lives in a closed
 * shadow root, ignores the pointer, and never changes the page's own elements. */
(function (root) {
  "use strict";

  function clock(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function create() {
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

    // box: the element to sit above (null hides). text/warn: plain strings.
    function show(box, text, warn) {
      if (!box || (!text && !warn)) { pill.hidden = true; return; }
      if (!host.isConnected) document.documentElement.appendChild(host);
      pill.textContent = "";
      if (text) pill.appendChild(document.createTextNode("RainDragon ETA · " + text));
      if (warn) {
        const w = document.createElement("span");
        w.className = "warn";
        w.textContent = (text ? " · " : "RainDragon ETA · ") + warn;
        pill.appendChild(w);
      }
      const r = box.getBoundingClientRect();
      pill.style.left = Math.max(8, r.left + 12) + "px";
      pill.style.top = Math.max(4, r.top - 26) + "px";
      pill.hidden = false;
    }
    return { show };
  }

  root.RainDragonEtaPill = { create, clock };
})(typeof self !== "undefined" ? self : this);
