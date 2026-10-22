/* RainDragon Forecast: the small pill shown just above a chat site's message box.
 * Shared by the claude.ai and chatgpt.com content scripts. It lives in a closed
 * shadow root, ignores the pointer, and never changes the page's own elements.
 * It starts with the RainDragon dragon (icons/mark.png: the logo without its
 * wordmark, which is unreadable at 20px), then the forecast. */
(function (root) {
  "use strict";

  function clock(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function create() {
    const host = document.createElement("div");
    host.id = "raindragon-forecast-host";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.pill{position:fixed;z-index:2147483000;max-width:min(640px,90vw);' +
      'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'padding:3px 10px;border-radius:999px;pointer-events:none;' +
      'background:rgba(240,238,230,.95);color:#3d3929;border:1px solid rgba(0,0,0,.08);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.logo{width:20px;height:20px;vertical-align:-5px;margin-right:6px}b{font-weight:600}' +
      '.warn{color:#b91c1c}.long{color:#a16207}' +
      '@media (prefers-color-scheme:dark){.pill{background:rgba(48,48,46,.95);color:#e8e6dc;' +
      'border-color:rgba(255,255,255,.1)}.warn{color:#fca5a5}.long{color:#fcd34d}}' +
      '</style><div class="pill" hidden></div>';
    const pill = shadow.querySelector(".pill");

    function logo() {
      const img = document.createElement("img");
      img.className = "logo";
      img.alt = "RainDragon Forecast";
      try { img.src = chrome.runtime.getURL("icons/mark.png"); } catch (e) { return null; }
      return img;
    }

    // box: the element to sit above (null hides). text/warn: plain strings.
    // long: the reply has run past the range, so the text turns yellow.
    // Red is kept for the incident warning only.
    function show(box, text, warn, long) {
      if (!box || (!text && !warn)) { pill.hidden = true; return; }
      if (!host.isConnected) document.documentElement.appendChild(host);
      pill.textContent = "";
      const img = logo();
      if (img) pill.appendChild(img);
      if (text) {
        const t = document.createElement("span");
        if (long) t.className = "long";
        // The name that opens the line ("Forecast 20s–1m …") is bold, as in the brand preview.
        const name = /^([A-Za-z]+)( .*)$/.exec(text);
        if (name) {
          const b = document.createElement("b");
          b.textContent = name[1];
          t.append(b, name[2]);
        } else {
          t.textContent = text;
        }
        pill.appendChild(t);
      }
      if (warn) {
        const w = document.createElement("span");
        w.className = "warn";
        w.textContent = (text ? " · " : "") + warn;
        pill.appendChild(w);
      }
      const r = box.getBoundingClientRect();
      pill.style.left = Math.max(8, r.left + 12) + "px";
      pill.style.top = Math.max(4, r.top - 32) + "px";
      pill.hidden = false;
    }
    return { show };
  }

  root.RainDragonEtaPill = { create, clock };
})(typeof self !== "undefined" ? self : this);
