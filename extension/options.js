const DEFAULTS = { band: "50", checkStatus: true, showResult: false };
const $ = (id) => document.getElementById(id);

function flash(text) {
  $("saved").textContent = text;
  setTimeout(() => { $("saved").textContent = ""; }, 1500);
}

chrome.storage.local.get({ settings: DEFAULTS, history: [] }, (v) => {
  const s = Object.assign({}, DEFAULTS, v.settings);
  $("band").value = s.band;
  $("showResult").checked = !!s.showResult;
  $("checkStatus").checked = !!s.checkStatus;
  $("count").textContent = v.history.length + " replies saved on this device (durations and word counts only).";
});

function save() {
  chrome.storage.local.set({ settings: {
    band: $("band").value, showResult: $("showResult").checked, checkStatus: $("checkStatus").checked,
  } }, () => flash("Saved"));
}
["band", "showResult", "checkStatus"].forEach((id) => $(id).addEventListener("change", save));

$("clear").addEventListener("click", () => {
  chrome.storage.local.set({ history: [] }, () => {
    $("count").textContent = "0 replies saved on this device.";
    flash("Cleared");
  });
});
