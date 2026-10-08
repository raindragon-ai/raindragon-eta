# Privacy

RainDragon ETA watches how long your Claude turns take. That means it runs inside
your sessions, so here is exactly what it does with them.

## What it stores

Only on your machine:

* **Plugin:** `~/.claude/plugins/data/raindragon-eta*/` (a text file per turn and a
  few small markers).
* **Extension:** Chrome's local storage for the extension.

For each finished turn it keeps:

| Kept | Example |
| :- | :- |
| When it finished and how long it took | `"t": 1791445010, "dur": 41.2` |
| Prompt size bucket | `short`, `medium` or `long` |
| Conversation size bucket | `small`, `medium` or `large` |
| Effort level (plugin) or model label (extension) | `high`, `opus 5.5 medium` |
| Reply length in words (extension) | `350` |
| Whether it failed, or ran during a Claude incident | `"ok": true, "incident": false` |

The plugin also writes one file outside that folder, `~/.raindragon-eta/data_dir`,
holding only the path of the folder above, so the live status line can find
the turn in progress.

It does **not** keep your prompts, Claude's replies, file names, chat or
session names, project paths or anything you typed. Markers for a turn in
progress are deleted after two days. History is capped at the most recent
1,000 turns.

## What leaves your machine

One thing: a request to the public page `status.claude.com/api/v2/summary.json`
every two minutes at most, to see whether Claude has an incident. It sends
nothing about you or your work, only the request itself. Turn it off with
**Check Claude status**.

Nothing is sent to RainDragon. There is no telemetry, analytics or crash
reporting. If we ever add a way to share timing data, it will be off by
default, opt-in, and show you exactly what would be sent before anything is.

## Diagnostics

`/raindragon-eta:doctor` and **Copy diagnostics** print the version, your settings
and turn counts so you can paste them into a bug report. They contain no
content. You choose whether to share them.

## Deleting your data

* Extension: **Clear my history** in its options, or remove the extension.
* Plugin: delete `~/.claude/plugins/data/raindragon-eta*` and `~/.raindragon-eta` (and
  uninstall it if you like).
