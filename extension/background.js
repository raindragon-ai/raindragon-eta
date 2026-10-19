/* Status check for the content scripts. Runs here, not in the page, so the
 * request goes only to the provider's public status page and the chat site's
 * page never sees it. One cache per provider, CACHE_MS; every failure means
 * "no known incident". */
importScripts("lib/predict.js");

const CACHE_MS = 120 * 1000;
const TIMEOUT_MS = 3000;

const caches = {};

async function currentIncident(providerId) {
  const T = self.RainDragonEta;
  const prov = T.PROVIDERS[providerId] || T.PROVIDERS.claude;
  const now = Date.now();
  const cache = caches[prov.id];
  if (cache && now - cache.at < CACHE_MS) return cache.incident;
  let incident = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const resp = await fetch(prov.statusUrl, { signal: ctl.signal, credentials: "omit" });
    clearTimeout(t);
    if (resp.ok) incident = T.incidentFromSummary(await resp.json(), prov.statusComponents);
  } catch (e) {
    incident = null;
  }
  caches[prov.id] = { at: now, incident };
  return incident;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    currentIncident(msg.provider || "claude").then((incident) => reply({ incident }));
    return true; // async reply
  }
  return false;
});
