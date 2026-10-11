/* Network for the content script. Runs here, not in the page, so claude.ai's
 * page never sees these requests:
 *
 *   status    status.claude.com, cached CACHE_MS; every failure means "no
 *             known incident"
 *   predict   RainDragon's ETA API: how long Claude's reply will probably be,
 *             from the conversation's text (only with sharing on and after the
 *             user has seen the notice on the options page)
 *   outcome   the real reply length for that prediction
 *
 * On install the options page opens with the sharing notice: the extension
 * sends nothing to RainDragon until the user has continued past it. */
importScripts("lib/predict.js");

const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const API_URL = "https://inference.raindragon.ai";
const CACHE_MS = 120 * 1000;
const TIMEOUT_MS = 3000;
const PREDICT_TIMEOUT_MS = 2500;

let cache = { at: 0, incident: null };

async function currentIncident() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.incident;
  let incident = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const resp = await fetch(SUMMARY_URL, { signal: ctl.signal, credentials: "omit" });
    clearTimeout(t);
    if (resp.ok) incident = self.RainDragonEta.incidentFromSummary(await resp.json());
  } catch (e) {
    incident = null;
  }
  cache = { at: now, incident };
  return incident;
}

function stored(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// Random id for this install, so an outcome can only update its own
// prediction. Not tied to any account.
async function installId() {
  const v = await stored({ installId: "" });
  if (v.installId) return v.installId;
  const id = crypto.randomUUID();
  await new Promise((resolve) => chrome.storage.local.set({ installId: id }, resolve));
  return id;
}

async function allowed() {
  const v = await stored({ settings: {}, sharingAck: false });
  const s = v.settings || {};
  return s.enabled !== false && s.shareText !== false && v.sharingAck === true;
}

async function post(path, body, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(API_URL + path, {
      method: "POST", signal: ctl.signal, credentials: "omit",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return resp.status === 204 ? {} : await resp.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function predict(body) {
  if (!(await allowed())) return null;
  const r = await post("/v1/eta/predict", Object.assign({}, body, {
    install_id: await installId(), client: "extension", client_version: self.RainDragonEta.VERSION,
  }), PREDICT_TIMEOUT_MS);
  return r && typeof r.output_tokens === "number" ? r : null;
}

async function outcome(body) {
  if (!body || !body.prediction_id) return;
  await post("/v1/eta/outcome", Object.assign({}, body, { install_id: await installId() }), 10000);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    currentIncident().then((incident) => reply({ incident }));
    return true; // async reply
  }
  if (msg && msg.type === "predict") {
    predict(msg.body).then((r) => reply(r));
    return true;
  }
  if (msg && msg.type === "outcome") {
    outcome(msg.body);
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install" || d.reason === "update") {
    stored({ sharingAck: false }).then((v) => {
      if (!v.sharingAck) chrome.runtime.openOptionsPage();
    });
  }
});
