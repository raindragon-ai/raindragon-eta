/* Status check for the content script. Runs here, not in the page, so the
 * request goes only to status.claude.com and claude.ai's page never sees it.
 * Cached CACHE_MS; every failure means "no known incident". */
importScripts("lib/predict.js");

const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const CACHE_MS = 120 * 1000;
const TIMEOUT_MS = 3000;

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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    currentIncident().then((incident) => reply({ incident }));
    return true; // async reply
  }
  return false;
});
