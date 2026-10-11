# Privacy

RainDragon ETA watches how long your Claude turns take and, with sharing on,
asks RainDragon's model how long Claude's reply will be. That means it runs
inside your sessions and sends their text to RainDragon, so here is exactly
what it does with them.

## What is sent to RainDragon, and what is kept

**Only with "Share text" on.** It is on by default. The Claude Code plugin says
so on your first prompt; the extension shows a notice on its options page when
installed and sends nothing until you continue past it.

Each time you send a prompt, to `inference.raindragon.ai/v1/eta/predict`:

| Sent | Why |
| :- | :- |
| The conversation's text: your messages and Claude's text replies, oldest first, plus the new prompt (very long conversations: the first 48,000 and last 16,000 characters) | The model predicts the reply's length from it |
| The Claude model name, e.g. `claude-opus-5-5` | Reply length depends on the model |
| Conversation size, tokens already seen, number of earlier replies | Model inputs |
| A random install id, the client (plugin or extension) and its version | So the outcome below can only update your own prediction |

After the turn, to `/v1/eta/outcome`: the prediction's id, the reply's real
length in tokens (extension: estimated from its characters) and the turn's
duration.

**The text is used for the prediction and not kept.** RainDragon keeps only
the numbers, to check and improve the model: the model name, sizes, the
prediction, the reply's real length and duration, the install id, client and
version. None of it is tied to an account, email or name: only to the random
install id. Tool calls and tool
results (file contents Claude read, command output) are not part of the text
in Claude Code; on claude.ai the text is what the conversation shows on screen.

Nothing is sent while you type, and nothing is sent with sharing off or with
RainDragon ETA turned off.

## What it stores on your machine

Locally:

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
| RainDragon's predicted reply length, if there was one | `"pred": 900` |

The plugin also writes one file outside that folder, `~/.raindragon-eta/data_dir`,
holding only the path of the folder above, so the live status line can find
the turn in progress.

Locally it does **not** keep your prompts, Claude's replies, file names, chat or
session names, project paths or anything you typed. The plugin keeps a random
install id (`install_id`) and, briefly, outcomes waiting to be sent (`outbox/`). Markers for a turn in
progress are deleted after two days. History is capped at the most recent
1,000 turns.

## What else leaves your machine

A request to the public page `status.claude.com/api/v2/summary.json` every two
minutes at most, to see whether Claude has an incident. It sends nothing about
you or your work, only the request itself. Turn it off with **Check Claude
status**.

There is no analytics or crash reporting.

## Diagnostics

`/raindragon-eta:doctor` and **Copy diagnostics** print the version, your settings
and turn counts so you can paste them into a bug report. They contain no
content. You choose whether to share them.

## Turning sharing off

* Plugin: `/config`, RainDragon ETA, **Share text** off.
* Extension: options page, untick **Share text with RainDragon**.

## Deleting your data

* Extension: **Clear my history** in its options, or remove the extension.
* Plugin: delete `~/.claude/plugins/data/raindragon-eta*` and `~/.raindragon-eta` (and
  uninstall it if you like).
