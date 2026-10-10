# RainDragon ETA

**Know roughly how long Claude will take before you wait for it.**

RainDragon ETA watches how long your own Claude turns take, then shows a time
range for each new one, based on turns like it. It also warns you when Claude
is having a major incident, so a slow reply doesn't leave you guessing.

It works in Claude Code (as a plugin) and on claude.ai (as a Chrome
extension). **Everything stays on your machine:** it never reads or stores your
prompts or Claude's replies, and it sends nothing anywhere. Its only network
request is a status check on status.claude.com, which you can turn off. See
[Privacy](#privacy).

<!-- TODO: screenshot or short GIF: the range appearing in Claude Code, then the live clock counting up -->

RainDragon ETA is an independent project by
[RainDragon AI](https://inference.raindragon.ai/?utm_source=raindragon-eta&utm_medium=readme).
It is not made, endorsed or supported by Anthropic.

## What you'll see

In Claude Code, when you send a prompt:

```
RainDragon ETA: Half of your similar turns took 40s–3m (from 57 turns)
```

On Claude Code versions that support plugin mods, the status line also shows
a live clock while the turn runs:

```
⏱ 0:42 · half took 40s–3m
```

If a turn runs past the range, it adds "longer than usual". The clock clears
when the turn ends.

On claude.ai, just above the message box:

```
RainDragon ETA · Half of your similar replies took 20s–1m, 300–800 words (from 24)
```

plus a running clock while Claude replies.

### Why a range, not a single number

Claude's response times vary a lot, so one number would usually be wrong. The
range is honest about that: by default, about half your turns finish inside
it. You can switch to a wider range that covers about 8 in 10 turns. See
[CLAIMS.md](CLAIMS.md) for exactly what we promise and what we don't.

### It starts with typical times, then learns yours

| Completed turns so far | What it shows |
| :- | :- |
| 0–9 | The wider 8-in-10 range of **typical** turns like this one (on claude.ai, also typical reply length) |
| 10–29 | Your own 8-in-10 range, marked "still learning" |
| 30+ | The range you chose (half by default) |

The typical ranges are built in, from real Claude turn timings (see
[CLAIMS.md](CLAIMS.md)), so it is useful from your first prompt. They are
wide on purpose: people's pace varies.

Turns that fail, turns you stop, and turns during a major Claude incident are
left out, so they don't skew your range.

## Privacy

* RainDragon ETA records only timings (and reply length on claude.ai), plus
  the sizes used to match similar turns. It never reads or stores your prompts
  or Claude's replies.
* History stays on your computer. Only your latest 300 completed turns are used.
* The only network request is to status.claude.com, and only if the status
  check is on. No telemetry, no analytics.

Full details: [PRIVACY.md](PRIVACY.md).

## Install

### Claude Code plugin

Requires `python3` on your PATH. No other dependencies. Works on macOS and Linux.

```bash
claude plugin marketplace add https://github.com/raindragon-ai/raindragon-eta
claude plugin install raindragon-eta@raindragon
```

To try it for one session from a checkout: `claude --plugin-dir plugin/`

### Chrome extension (claude.ai)

1. Download `raindragon-eta-extension-<version>.zip` from the
   [latest release](https://github.com/raindragon-ai/raindragon-eta/releases/latest)
   and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped `raindragon-eta-extension` folder.
4. Open claude.ai and start typing.

The extension reads claude.ai's page structure to see when a reply starts and
ends. If claude.ai changes its page, the extension may stop showing ranges
until we release an update.

## Settings

| Setting | Plugin | Extension | Default |
| :- | :-: | :-: | :- |
| On/off | ✓ | ✓ | On |
| Range: half (50%) or 8 in 10 (80%) | ✓ | ✓ | Half |
| Show actual time after each turn | ✓ | ✓ (plus length) | Off |
| Check Claude's status page for incidents | ✓ | ✓ | On |

* Plugin: run `/plugin configure raindragon-eta@raindragon`
* Extension: Extensions → RainDragon ETA → Details → Extension options
  (the options page also shows how often the range held, and has **Copy
  diagnostics** and **Clear my history**)

### Plugin commands

* `/raindragon-eta:eval`: how often the range held on your own past turns
* `/raindragon-eta:doctor`: version, settings and counts for bug reports (no
  prompts, file names or session IDs)

## Turn it off or remove it

| | Turn off (keeps history) | Remove completely |
| :- | :- | :- |
| Plugin | Set **Enabled** off, or `export RAINDRAGON_ETA_OFF=1` | `claude plugin uninstall raindragon-eta@raindragon`, then delete `~/.claude/plugins/data/raindragon-eta*` and `~/.raindragon-eta` |
| Extension | Untick **On** in its options | **Remove** it at `chrome://extensions` (Chrome deletes its history too) |

When off, nothing is shown and nothing is recorded.

## Report a bug

Run `/raindragon-eta:doctor` (plugin) or **Copy diagnostics** (extension
options) and paste the output into a
[new issue](https://github.com/raindragon-ai/raindragon-eta/issues/new), with
what you saw and what you expected.

## How it works

**Plugin:** A `UserPromptSubmit` hook starts the clock and shows the range as
a message only you see; nothing is added to Claude's context. The `Stop` hook
saves the duration; `StopFailure` marks it as failed.

**Extension:** Watches claude.ai's own reply markers (`data-is-streaming`) to
see when a reply starts and ends.

**"Similar" turns** are matched by prompt size, conversation length, and model
or effort level. If there aren't at least 8 matching turns, it widens the
match step by step until there are.

**Incidents:** Only major incidents are flagged. Minor and "degraded" periods
didn't measurably slow turns in our testing ([details](CLAIMS.md)).

## For developers

| Surface | Folder | Version |
| :- | :- | :- |
| Claude Code plugin | `plugin/` | 0.2.0 |
| Chrome extension | `extension/` | 0.2.0 |

```bash
python3 -m pytest -q tests   # plugin tests
node --test tests/           # extension tests
python3 release.py           # builds dist/*.zip and dist/SHA256SUMS
```

### Verify a download

Each release includes a `SHA256SUMS` file. In the folder with the zips:

```bash
sha256sum -c SHA256SUMS        # Linux
shasum -a 256 -c SHA256SUMS    # macOS
```

Both lines should say `OK`. Builds are reproducible: running
`python3 release.py` on the tagged commit produces identical files.

## License

[Apache-2.0](LICENSE).
