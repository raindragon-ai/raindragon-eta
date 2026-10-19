# Privacy

RainDragon ETA watches how long your Claude turns (and, with the extension,
your ChatGPT replies on chatgpt.com) take. That means it runs inside
your sessions, so here is exactly what it does with them.

## What it stores

Only on your machine:

* **Plugin:** `~/.claude/plugins/data/raindragon-eta*/` (a text file per turn and a
  few small markers).
* **Extension:** Chrome's local storage for the extension. claude.ai and
  chatgpt.com replies are kept in two separate lists, plus the name of the
  ChatGPT model you last sent with (for example `gpt-5-thinking`) so it can
  estimate while you type.

For each finished turn it keeps:

| Kept | Example |
| :- | :- |
| When it finished and how long it took | `"t": 1791445010, "dur": 41.2` |
| Prompt size bucket | `short`, `medium` or `long` |
| Conversation size bucket | `small`, `medium` or `large` |
| Effort level (plugin) or model label (extension) | `high`, `opus 5.5 medium`, `gpt-5-thinking` |
| Reply length in words (extension) | `350` |
| Whether it failed, or ran during a Claude incident | `"ok": true, "incident": false` |

The plugin also writes one file outside that folder, `~/.raindragon-eta/data_dir`,
holding only the path of the folder above, so the live status line can find
the turn in progress.

## What the extension reads on chatgpt.com

To time a ChatGPT reply, a small script runs in the chatgpt.com page and
reads a **copy** of the page's own reply stream (`/backend-api/conversation`)
when you send a new message. In memory it counts your message's characters
and the reply's words, and notes the model name, when the first word
arrived, and whether the reply finished, failed or was stopped. Only those
numbers and the model name are passed to the extension; the text is dropped
as soon as it is counted. It does not change, delay or block the page's
request or reply. It also reads the length (not the text) of the messages on
screen, to bucket conversation size.

It does **not** keep your prompts, Claude's or ChatGPT's replies, file names, chat or
session names, project paths or anything you typed. Markers for a turn in
progress are deleted after two days. History is capped at the most recent
1,000 turns.

## What leaves your machine

One thing: a request to a public status page every two minutes at most, to
see whether there is an incident: `status.claude.com/api/v2/summary.json`
for Claude (plugin, and the extension on claude.ai), and
`status.openai.com/api/v2/summary.json` for the extension on chatgpt.com.
It sends nothing about you or your work, only the request itself. Turn it
off with **Check Claude status** (plugin) or **Check Claude and ChatGPT
status** (extension).

Nothing is sent to RainDragon. There is no telemetry, analytics or crash
reporting. If we ever add a way to share timing data, it will be off by
default, opt-in, and show you exactly what would be sent before anything is.

## Diagnostics

`/raindragon-eta:doctor` and **Copy diagnostics** print the version, your settings
and turn counts so you can paste them into a bug report. They contain no
content. You choose whether to share them.

## Deleting your data

* Extension: **Clear my history** in its options (clears both claude.ai and
  chatgpt.com), or remove the extension.
* Plugin: delete `~/.claude/plugins/data/raindragon-eta*` and `~/.raindragon-eta` (and
  uninstall it if you like).
