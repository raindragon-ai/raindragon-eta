# Providers: how each surface measures a turn

Status as of 2026-10-19. "Built" means in this repo with tests; "design" means
not built yet.

## Today (Claude)

| | Claude Code plugin (`plugin/`) | claude.ai extension (`extension/content.js`) |
| :- | :- | :- |
| Turn start | `UserPromptSubmit` hook (`raindragon_eta_hook.py prompt`) writes a pending marker | Enter in `[data-testid=chat-input]` or click on `chat-input-send` |
| Turn end | `Stop` (ok) / `StopFailure` (failed) hooks | last `[data-testid=assistant-message]` goes `data-is-streaming=true` → `false`; `failed-send-status-region` = failed; a `Stop…` button click = stopped (dropped) |
| Reply length | not measured | words in the last assistant message (`innerText`, minus `.sr-only`) |
| "Similar" | prompt-size bucket + transcript-bytes bucket + effort level, falling back to broader groups until 8 turns (`predict.py`) | prompt-size bucket + on-screen conversation chars bucket + model-selector label (`lib/predict.js`) |
| History | `~/.claude/plugins/data/raindragon-eta*/` text file per turn, cap 1,000, last 300 used | `chrome.storage.local.history`, cap 1,000, last 300 used |
| Incident | `status.claude.com/api/v2/summary.json`, Claude Code + Claude API components, MAJOR only (`status.py`) | same URL via `background.js`, claude.ai + Claude API components |
| UI | `systemMessage` (user-only) + live status-line mod (`hooks/live.ts`) | shadow-DOM pill above the composer (`lib/pill.js`) |

## (a) chatgpt.com in the extension: built

Files: `extension/chatgpt_tap.js` (page world), `extension/lib/chatgpt_sse.js`
(pure parser), `extension/chatgpt.js` (content script),
`lib/predict.js:PROVIDERS`.

* **Start / end / length / model come from the stream, not the DOM.** The
  web app sends a new message as `POST /backend-api/f/conversation` (older:
  `/backend-api/conversation`) and gets a server-sent event stream back. A
  `world: "MAIN"` content script at `document_start` wraps `window.fetch`;
  for `action: "next"` requests it reads `Response.clone()` and returns the
  page's own promise untouched. The parser handles the `v1` delta encoding
  (`{"o":"add"|"append"|"patch"|"replace","p":...,"v":...}`, bare `{"v":..}`
  continuing the last path/op), the older whole-message snapshot format,
  `message_stream_complete`, `[DONE]` and `event: error`. It counts words of
  visible assistant text only (role `assistant`, recipient `all`,
  content type text, channel `final`/`commentary` when present); reasoning,
  tool calls and tool output are not counted. Word counting is incremental,
  so the text is never held.
* **Outcomes.** ok = completion marker and some words; failed = HTTP error or
  error event; stopped = `AbortError` before completion (or a click on
  `[data-testid=stop-button]`), dropped; unknown = anything else, e.g. a
  `stream_handoff` to the WebSocket transport reported for some account
  types, dropped. An abort after completion counts as ok.
* **DOM is used only to show.** `#prompt-textarea` (size while typing; the
  pill sits above its `form`), `[data-message-author-role]` (conversation
  size, characters only).
* **Per provider and per model.** chatgpt.com history is its own storage
  key (`history_chatgpt`), so claude.ai and ChatGPT never share a band.
  Within it, the first "similar" level is the model you picked (`model`
  in the request body, e.g. `auto`, `gpt-5-thinking`); that is what is
  known before sending. The resolved slug (`resolved_model_slug`) is read
  but not used as the key, because it is only known after the reply.
* **First run.** Starts at zero: "learning your pace" until 10 replies, the
  wide band until 30, as on claude.ai.
* **Sources** (all unofficial; OpenAI does not document this endpoint):
  amitxtech.com/blog/how-chatgpt-streams-its-answer,
  blog.theodormarcu.com/p/how-chatgpt-streams-responses-back,
  github.com/UnlastingR/sse-devtools-panel/pull/1,
  github.com/JDui/chatgpt-model-meter (handoff, model slugs).
* **Untested live.** Fixtures in `tests/fixtures/chatgpt/` are hand-written
  synthetic transcripts. Nobody has run this against a signed-in
  chatgpt.com yet.

## (c) status.openai.com: built (extension)

status.openai.com is an incident.io page. Its Statuspage-compatible
`/api/v2/summary.json` (checked 2026-10-19) has `page`, `status` and a flat
`components` list, **no `incidents` key**, and omits the Codex group. So the
extension warns only when the ChatGPT "Conversations" component is
`major_outage` (or incident.io's `full_outage`), mirroring the MAJOR-only
rule. Richer sources, if needed later: `/api/v2/incidents.json` (has
incidents, impact field unverified) and the native
`/proxy/status.openai.com` (`summary.ongoing_incidents`,
`affected_components`, `structure` with groups APIs / ChatGPT / Codex), which
is undocumented. No slowdown evidence exists for OpenAI incidents yet
(CLAIMS.md claim 7).

## (b) OpenAI Codex CLI: design (clean hook exists; not built in this PR)

Codex CLI (0.163.0) has Claude-Code-style hooks, on by default
(learn.chatgpt.com/docs/hooks; developers.openai.com/codex now redirects
there):

* Locations: `~/.codex/hooks.json`, `[hooks]` in `~/.codex/config.toml`,
  repo `.codex/`, or a plugin's `hooks/hooks.json`. Non-managed hooks must be
  trusted once via `/hooks` (trust is per hash, so an update re-asks).
* Events used: `UserPromptSubmit` (start; stdin has `session_id`, `turn_id`,
  `prompt`, `model`, `transcript_path`), `Stop` (end; `turn_id`), plus
  `Interrupt` (stopped: drop). No `StopFailure` equivalent.
* Output: `{"systemMessage": "..."}` is "surfaced as a warning in the UI",
  so the range can be shown user-only. Plain stdout from
  `UserPromptSubmit` would go to the model's context, the same trap the
  Claude plugin already avoids.
* No live clock: `tui.status_line` takes built-in item ids only, no
  command (openai/codex#17827 still open). So: range at prompt, optional
  "took 1m" after. `notify` (argv JSON, `agent-turn-complete` only) is not
  needed.
* Failures: the rollout log
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` has `event_msg` →
  `task_complete` with `duration_ms`, `time_to_first_token_ms` and `error`.
  The `Stop` hook can read that line from `transcript_path` by `turn_id` to
  get Codex's own duration and mark errored turns failed.

Plan: reuse `raindragon_eta_hook.py` with a `--host codex` flag: data dir
`~/.codex/raindragon-eta/`, the similar-key is `model` + effort from
`turn_context`, status components "CLI"/"Codex API" (needs the
`/proxy/status.openai.com` source, since summary.json omits the Codex
group), install via `~/.codex/hooks.json`. Separate history from Claude
Code. Tests with synthetic hook payloads and a synthetic rollout file.

## Gemini

### (a') gemini.google.com in the extension: built

Files: `extension/lib/gemini_dom.js` (selector table + turn rules, pure),
`extension/gemini.js` (content script), `lib/predict.js:PROVIDERS.gemini`.
Tests: `tests/gemini_dom.test.js` against a synthetic DOM
(`tests/fixtures/gemini/`, a dependency-free mini DOM).

* **Stream not used.** `POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
  answers with `)]}'` then length-prefixed JSON frames (lengths in UTF-16
  units), each carrying the full reply so far deep in nested arrays
  (github.com/HanaokaYuzu/Gemini-API, `utils/parsing.py`). Undocumented and
  positional, so a tap would break silently on any layout change.
* **DOM, like claude.ai.** All selectors are in one table, `SEL` in
  `lib/gemini_dom.js`, each with its source. Turn = `<model-response>` (reply
  text in `message-content` / `.response-content`, excluding
  `details.gemini-thought` thinking and visually-hidden text). Start: Enter
  in `rich-textarea .ql-editor` or a click on `button[aria-label="Send
  message"]` / `[data-test-id=send-button]`. Streaming: the stop control
  (`button[aria-label="Stop response"]` / `[data-test-id=stop-button]`) is on
  screen, or the new reply's text is `aria-busy`. End: streaming stops and the
  new reply's word count has not changed for 1 s; the duration ends when
  streaming stopped (or at the last change, if later).
* **Outcomes.** ok = streaming seen, ended, new reply has words, no error
  marker; failed = error marker inside the new reply; stopped = a click on the
  stop control (dropped); unknown = no streaming marker ever seen (reply
  settled 5 s without one), no new reply in 2 min, an empty reply, or 30 min
  (dropped). Only ok and failed are saved.
* **Unverified selectors.** None has been checked on a live signed-in page.
  **The stop control and the error marker have no public source at all**
  (best guesses). Fail-safe direction: a wrong stop selector makes every turn
  "unknown" (nothing saved); a wrong error selector makes a failed turn
  "unknown" (an empty reply), never "ok"; a wrong input selector hides the
  pill. First thing to do with a signed-in browser: check `SEL` in DevTools.
* **Model.** The picker label `.input-area-switch [data-test-id=primary-text]`
  is the first "similar" level, read at send time and while typing. If it is
  not on the page every reply shares one bucket (`model: null`).
* **History** `history_gemini`, first run from zero. Pill above
  `input-area-v2` (else `.input-area`, else `rich-textarea`).
* Sources: gist.github.com/maciejkos/98afba3ff3443f2066e67f47bbe2ad0e,
  github.com/LayneIns/Ask-Gemini-Extension,
  github.com/yarden-carmi/Gemini-Pro-Auto-Selector.

### (b') Gemini CLI

Clean hooks exist (geminicli.com/docs/hooks/, /hooks/reference/): `"hooks"`
in `~/.gemini/settings.json` or an extension's `hooks/hooks.json`.
`BeforeAgent` (stdin: `session_id`, `prompt`, `timestamp`,
`transcript_path`) starts the clock; `AfterAgent` (`prompt_response`,
`timestamp`) ends it. Output `{"systemMessage": ...}` is "displayed
immediately to the user"; the docs do not say outright that it stays out
of model context, so verify before shipping (it must, per CLAIMS.md). No
failure event: failed/stopped turns would need the session JSON
(`~/.gemini/tmp/<hash>/chats/session-*.json`, per-message `timestamp` and
`model`). No command-backed status line (`ui.footer.items` is built-in ids
only). Older CLIs (e.g. 0.22) need `tools.enableHooks`. Same plan as
Codex: `--host gemini` on the existing hook script, separate history.

### (c') Google status: built (extension)

`https://www.google.com/appsstatus/dashboard/incidents.json` (Workspace
dashboard) is a flat JSON list of incidents, past and present (checked
2026-10-19: 39 entries, ~340 KB, 4 for Gemini, all ended, all low/medium).
The Gemini app is product "Gemini", id `npdyhgECDJ6tB66MxXyo`
(`affected_products[].id` and `service_key`). Fields used: `begin`, `end`,
`severity` (low/medium/high), `status_impact`
(SERVICE_INFORMATION/DISRUPTION/OUTAGE). MAJOR-only mapping
(`incidentFromGoogle` in `lib/predict.js`): an incident on that product that
has begun and has no `end` (null, missing or empty: no open incident has
been observed, so all three are accepted) or an `end` in the future, with
`status_impact == SERVICE_OUTAGE` or `severity == high`. Checked against the
live feed: the 2026-09-11 Gemini incident (low, SERVICE_INFORMATION) is not
flagged at any time; the one high/SERVICE_OUTAGE incident in the feed (Google
Keep) is flagged mid-incident under its own id and not after its end. No
slowdown evidence for Gemini incidents. Host permission:
`https://www.google.com/appsstatus/*`.

Gemini API on Vertex: `status.cloud.google.com/incidents.json`, product
`Z0FZJAMvEB4j3NbCJs6B` (not used). No machine-readable source for AI Studio /
the consumer Gemini API (the CLI's default backend). Note `status.gemini.com`
is a crypto exchange, not Google.
