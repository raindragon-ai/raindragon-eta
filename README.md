# Turn ETA

Shows, when you send a prompt, how long turns like it have usually taken
you, and warns when Claude is having an incident. Two surfaces:

| Surface | Where | State |
| :- | :- | :- |
| Claude Code plugin | `plugin/` | working, v0.1.0 |
| Chrome extension for claude.ai | `extension/` | working, v0.1.0 |

"Turn ETA" is a working name until the product name is decided (RAI-327).

## What it says, and what it will not say

It shows a **band**, not a single number: "Half of your similar turns took
40s–3m (from 57 turns)". A point estimate of turn duration is not accurate
enough to claim, so we don't show one. What we can stand behind:

* **It knows when it does not know.** The band is the middle half (or
  middle 8 in 10, if you choose) of your own similar turns, so about that
  share of turns land inside it.
* **It knows when the provider is down.** It reads status.claude.com and
  says so when Claude Code or the Claude API has an active incident.
  Incidents on other surfaces (for example the Console) are ignored.
* **Failures do not skew it.** Turns that failed, and turns that ran during
  an incident, are saved but never used for the band.

Until it has seen 10 good turns it shows nothing except, once per session,
that it is still learning.

## Install (Claude Code)

Needs `python3` on your PATH (no other dependencies).

```bash
claude --plugin-dir /path/to/src/turn-eta/plugin
```

Options (in `/config` once installed): band width `50` or `80`, show the
actual time after each turn (off by default), check Claude status (on by
default).

## How it works

* `UserPromptSubmit` hook: starts the clock, looks up similar past turns
  and shows the band as a user-only message (`systemMessage`). Nothing is
  added to Claude's context.
* `Stop` hook: stops the clock and appends the turn to local history.
* `StopFailure` hook: saves the turn as failed.
* An interrupted turn (Esc) never reaches `Stop`, so it is not recorded.

"Similar" narrows by prompt size, conversation size and effort level, and
falls back to broader groups until one has at least 8 turns. Only the most
recent 300 good turns are used.

## Install (Chrome extension)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder.
3. Open claude.ai and start typing: the estimate shows just above the message box.

Options (right-click the icon, **Options**): band width `50` or `80`, show the
actual time and length after each reply, check Claude status, clear history.

On claude.ai the band covers both time and length: "Half of your similar
replies took 20s–1m, 300–800 words (from 24)". "Similar" narrows by prompt
size, conversation size and the model/effort label shown in the model picker.
A reply you stop, or one that fails to send, is not recorded.

## Privacy

Everything stays on your machine: the plugin in `~/.claude/plugins/data/<plugin>/`, the extension in Chrome's local extension storage.
History keeps only the duration, reply word count (extension), coarse size
buckets, effort level or model label and whether the turn failed: no prompt text, file names or session ids.
Per-session markers for the turn in progress are removed after two days. The
only network request is the status check, which you can turn off.

## Tests

```bash
python3 -m pytest -q tests   # plugin
node --test tests/           # extension
```
