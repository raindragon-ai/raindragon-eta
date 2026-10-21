# RainDragon Forecast in Codex CLI and Gemini CLI

The Claude Code plugin's hook script also runs as a hook in OpenAI's Codex
CLI (`--host codex`) and Google's Gemini CLI (`--host gemini`). It shows the
same thing: at the start of each turn, the range your similar past turns took,
learned from your own history in that CLI only.

Status as of 2026-10-19: built and covered by tests with synthetic hook
payloads. **Not yet run against a signed-in Codex or Gemini CLI.** If
something looks off, `doctor` (below) prints counts you can paste into a bug
report.

What you need: Python 3.8+ as `python3`, and a copy of this repository. The
examples assume it is at `~/raindragon-forecast`; use your own absolute path.

```sh
git clone https://github.com/raindragon-ai/raindragon-forecast ~/raindragon-forecast
```

## Codex CLI

Docs: <https://learn.chatgpt.com/docs/hooks> (checked 2026-10-19; it replaces
developers.openai.com/codex/hooks). Hooks are on by default.

Add the hooks to `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [{"type": "command", "timeout": 5,
                  "command": "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py prompt --host codex"}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "timeout": 5,
                  "command": "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py stop --host codex"}]}
    ],
    "Interrupt": [
      {"hooks": [{"type": "command", "timeout": 3,
                  "command": "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py interrupt --host codex"}]}
    ]
  }
}
```

Or the same inline in `~/.codex/config.toml`:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py prompt --host codex"
timeout = 5

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py stop --host codex"
timeout = 5

[[hooks.Interrupt]]
[[hooks.Interrupt.hooks]]
type = "command"
command = "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py interrupt --host codex"
timeout = 3
```

Use one of the two, not both (Codex merges them and warns).

**One-time trust step.** Codex skips hooks you have not reviewed. Start
`codex`, run `/hooks`, review the three RainDragon Forecast hooks and trust them.
Trust is tied to the hook's hash, so if you change a command (or the path),
Codex asks again.

What you see: Codex shows the range as a warning line when you send a prompt
(the hook's `systemMessage`, which the docs describe as "surfaced as a
warning in the UI"). The script never prints plain text, which Codex would
add to the model's context.

How it times a turn:

| | Codex CLI |
| :- | :- |
| Start | `UserPromptSubmit`, keyed by `turn_id` |
| End | `Stop` with the same `turn_id` |
| Stopped by you | `Interrupt`: the turn is dropped, never recorded |
| Failed | Codex runs no `Stop` hook when a turn ends in an error. At your next prompt in that session, the script reads that turn's `task_complete` line in the session's rollout log (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, the hook's `transcript_path`) and, if it has an `error`, saves the turn as failed with Codex's own `duration_ms` and the error kind (for example `server_overloaded`). Failed turns never enter a range. |
| "Similar" | prompt size, rollout size, and the `model` from the hook payload |

Limits:

* **No live clock.** Codex's status line (`tui.status_line`) takes built-in
  items only, not a command (openai/codex#17827, open), so there is no
  running timer like the Claude Code status line. You get the range at the
  prompt, and with `show_result` a "done in 1:00" line at the end.
* **No incident warnings.** status.openai.com's documented summary omits
  the Codex components; the feed that has them is undocumented, so Codex
  turns are never flagged.
* A turn that another `Stop` hook sends back for more work is timed only to
  the first `Stop`.
* The last turn of a session, if it errored, is never settled (there is no
  next prompt to settle it).

## Gemini CLI

Docs: <https://geminicli.com/docs/hooks/> and
<https://geminicli.com/docs/hooks/reference/> (checked 2026-10-19).

Add to `~/.gemini/settings.json` (merge with what is there):

```json
{
  "hooks": {
    "BeforeAgent": [
      {"hooks": [{"name": "raindragon-forecast-start", "type": "command", "timeout": 5000,
                  "command": "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py prompt --host gemini"}]}
    ],
    "AfterAgent": [
      {"hooks": [{"name": "raindragon-forecast-stop", "type": "command", "timeout": 5000,
                  "command": "python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py stop --host gemini"}]}
    ]
  }
}
```

(Gemini timeouts are in milliseconds.) `/hooks panel` lists them;
`/hooks disable raindragon-forecast-start` turns one off.

**Version gate.** On Gemini CLI 0.22.x hooks are off unless you also set

```json
{ "tools": { "enableHooks": true } }
```

and on 0.22.0 a hook's `systemMessage` only goes to the debug log, so you
would see nothing (checked in the v0.22.0 source). Current releases have
hooks on by default (`hooksConfig.enabled`) and show the message.

**Does the range reach the model?** No. The docs say `systemMessage` is
"displayed immediately to the user in the terminal" but do not say it stays
out of the model's context, so we checked the source (google-gemini/gemini-cli
at 3be3d44, 0.66.0-nightly): a `BeforeAgent` hook's `systemMessage` is
emitted only as a UI event (`coreEvents.emitHookSystemMessage`, rendered as
an info line in `AppContainer.tsx`); the request sent to the model changes
only for `additionalContext`, which this script never returns. The code
comment reads "show to user in transcript mode (not to agent)".

How it times a turn:

| | Gemini CLI |
| :- | :- |
| Start | `BeforeAgent` (fires once per prompt) |
| End | `AfterAgent` for the same session |
| Failed | an `AfterAgent` with an empty reply (Gemini passes `[no response text]`) is saved as failed. A turn that errors or that you cancel fires no `AfterAgent`; it is dropped at your next prompt. |
| "Similar" | prompt size and session-file size. The hook payload names no model, so there is no model level. |

Incident warnings: the script reads Google's Workspace status dashboard
(`www.google.com/appsstatus/dashboard/incidents.json`), product "Gemini"
(id `npdyhgECDJ6tB66MxXyo`), and warns only for an open incident with impact
`SERVICE_OUTAGE` or severity `high`, the same MAJOR-only rule as for Claude.
That product is the Gemini app; Google publishes no machine-readable status
for the Gemini API that the CLI uses, so a warning means "Google reports a
Gemini outage", not that the CLI's backend is down. Turn it off with
`"check_status": false` (below).

## Settings, data, removal

Each CLI keeps its own history, never mixed with Claude Code's or each
other's:

| | Folder |
| :- | :- |
| Codex CLI | `~/.codex/raindragon-forecast/` |
| Gemini CLI | `~/.gemini/raindragon-forecast/` |

Settings go in `settings.json` in that folder (Gemini runs hooks in a
sanitized environment, so a file is the reliable place):

```json
{ "band": "50", "show_result": false, "check_status": true }
```

`band` is `"50"` (middle half, default) or `"80"`. `"mark": "rd"` or
`"mark": "none"` replaces the ☊☋ symbol if your terminal shows boxes.
`RAINDRAGON_FORECAST_OFF=1` in the environment also turns it off (the old
`RAINDRAGON_ETA_OFF=1` still works).

Upgrading from RainDragon ETA: update the hook entries above to the new path
and names. The first run copies your old `~/.codex/raindragon-eta` or
`~/.gemini/raindragon-eta` history and settings into the new folder.

Check it is working (counts only, no content):

```sh
python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py doctor --host codex
python3 ~/raindragon-forecast/plugin/scripts/raindragon_eta_hook.py doctor --host gemini
```

Remove: delete the hook entries, then the folder above.
