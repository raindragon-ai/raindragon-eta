# RainDragon ETA

How long turns like this one usually take you, as a range from your own
history, and a heads-up when Claude (or, on chatgpt.com, ChatGPT) has a major
incident.

Made by [RainDragon AI](https://inference.raindragon.ai/?utm_source=raindragon-eta&utm_medium=readme).

| Surface | Folder | Version |
| :- | :- | :- |
| Claude Code plugin | `plugin/` | 0.2.0 |
| Chrome extension for claude.ai and chatgpt.com | `extension/` | 0.2.0 |
| Codex CLI and Gemini CLI hooks (same script as the plugin, untested live) | `plugin/scripts/` | 0.2.0 |

See [CLAIMS.md](CLAIMS.md) for what we say about it and what we do not, and
[PRIVACY.md](PRIVACY.md) for what it stores.

## What you see

In Claude Code, when you send a prompt:

```
RainDragon ETA: Half of your similar turns took 40s–3m (from 57 turns)
```

On Claude Code versions that support plugin mods, the status line also shows
a live clock next to the range while the turn runs, cleared when it ends:

```
⏱ 0:42 · half took 40s–3m
```

with "longer than usual" once a turn runs past the range. Older versions get
the message above only.

On claude.ai, just above the message box, for both time and length:

```
RainDragon ETA · Half of your similar replies took 20s–1m, 300–800 words (from 24)
```

and a running clock while Claude replies. chatgpt.com shows the same pill
above its message box, from a separate ChatGPT history that starts at zero
(the first-run table below applies to it on its own). It is a **range**, never a single
number: about half of your turns land inside the middle-half range.

**First run.** It has nothing to go on until it has seen your turns:

| Your good turns so far | What it shows |
| :- | :- |
| 0–9 | "learning your pace", once per session (claude.ai: while you type) |
| 10–29 | the wider 8-in-10 range, marked "still learning" |
| 30+ | the range you chose (middle half by default) |

Failed turns, turns you stop, and turns during a major Claude incident are
never counted. Minor and "degraded" periods are not flagged: they did not
slow turns down when measured.

## Install

### Claude Code plugin

Needs `python3` on your PATH. No other dependencies.

```bash
claude plugin marketplace add <repo URL or path>
claude plugin install raindragon-eta@raindragon
```

Or for one session from a checkout: `claude --plugin-dir plugin/`.

Options (`/plugin configure raindragon-eta@raindragon`): **Enabled**, band width
`50` or `80`, show the actual time after each turn, check Claude status.

Commands:

* `/raindragon-eta:eval`: how often the range held on your own past turns.
* `/raindragon-eta:doctor`: version, settings and counts, for a bug report. It holds
  no prompts, file names or session ids.

### Chrome extension

1. Download `raindragon-eta-extension-<version>.zip` from the release and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the unzipped `raindragon-eta-extension` folder.
3. Open claude.ai or chatgpt.com and start typing.

Options (Extensions → RainDragon ETA → Details → Extension options): **On**, band
width, show the actual time and length after each reply, check Claude and
ChatGPT status, how often the range held (per site), **Copy diagnostics**,
**Clear my history** (both sites).

### Codex CLI and Gemini CLI

The plugin's hook script also runs as a hook in OpenAI's Codex CLI and
Google's Gemini CLI, with a separate history for each. Clone this repository
and point the CLI's hooks at
`plugin/scripts/raindragon_eta_hook.py <event> --host codex|gemini`.
[docs/INSTALL_CLI.md](docs/INSTALL_CLI.md) has the exact `~/.codex/hooks.json`
(or `config.toml`) and `~/.gemini/settings.json` entries, Codex's one-time
trust step in `/hooks`, and Gemini's `tools.enableHooks` gate on 0.22.x.

There is no live clock in either CLI (neither status line runs a command):
you get the range when you send a prompt. Codex turns get no incident
warning; Gemini turns are flagged only during an open Gemini OUTAGE on
Google's Workspace status dashboard. Built and tested with synthetic hook
payloads; not yet run against a signed-in Codex or Gemini CLI.

### Verify a download

Each release has a `SHA256SUMS` file. In the folder with the zips:

```bash
sha256sum -c SHA256SUMS        # Linux
shasum -a 256 -c SHA256SUMS    # macOS
```

Both lines must say `OK`. The zips are reproducible: `python3 release.py`
on the tagged commit builds the same bytes.

## Turn it off, or remove it

| | Turn off (keeps history) | Remove completely |
| :- | :- | :- |
| Plugin | set **Enabled** off, or `export RAINDRAGON_ETA_OFF=1` | `claude plugin uninstall raindragon-eta@raindragon`, then delete `~/.claude/plugins/data/raindragon-eta*` and `~/.raindragon-eta` |
| Codex / Gemini CLI | `"enabled": false` in `~/.codex/raindragon-eta/settings.json` or `~/.gemini/raindragon-eta/settings.json`, or `RAINDRAGON_ETA_OFF=1` | delete the hook entries, then `~/.codex/raindragon-eta` or `~/.gemini/raindragon-eta` |
| Extension | untick **On** in its options | **Remove** on `chrome://extensions` (Chrome deletes its stored history with it) |

Off means nothing is shown and nothing is recorded.

## Report a bug

Run `/raindragon-eta:doctor` (plugin) or **Copy diagnostics** (extension options)
and paste the output into the report, with what you saw and what you
expected. The output names the version, so we know which build you have.

## How it works

Plugin: a `UserPromptSubmit` hook starts the clock and shows the range as a
user-only message (nothing is added to Claude's context); `Stop` saves the
duration; `StopFailure` saves it as failed. Extension: reads claude.ai's own
page markers (`assistant-message` with `data-is-streaming`) to see when a
reply starts and ends; it never stores the text. On chatgpt.com it reads a
copy of the page's own conversation stream to see when a reply starts and
ends, how many words it has and which model answered; the text is counted
and dropped, never stored. Each site keeps its own history. Codex CLI and Gemini CLI: the same script, run with `--host codex` or
`--host gemini` from those CLIs' own hooks (`UserPromptSubmit`/`Stop`/
`Interrupt`, and `BeforeAgent`/`AfterAgent`), with a separate history each.
See [docs/PROVIDERS.md](docs/PROVIDERS.md) for how each surface measures a
turn, and the plan for gemini.google.com.

"Similar" narrows by prompt size, conversation size and effort or model, and
falls back to broader groups until one has at least 8 turns. Only your most
recent 300 good turns are used.

## Develop

```bash
python3 -m pytest -q tests   # plugin
node --test tests/           # extension (chatgpt.com: synthetic SSE fixtures in tests/fixtures/chatgpt/)
python3 release.py           # dist/*.zip + dist/SHA256SUMS
```
