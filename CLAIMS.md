# What we say about RainDragon ETA

Everything written about the product (landing page, README, store listing,
release notes, announcement) comes from this list. Each claim says how it is
measured. If it cannot be measured, it does not go in.

**Name:** RainDragon ETA (plugin id `raindragon-eta`).

**Made by:** RainDragon AI, with a link to inference.raindragon.ai, in three
places only: `/raindragon-eta:doctor` output, the extension options page and
the README. Never inside an estimate or a status warning: the estimate is the
product, and an ad in it would cost trust. Links carry
`utm_source=raindragon-eta&utm_medium=<doctor|extension|readme>` so visits
can be counted on the site; the tool itself sends nothing.

**One line:** How long turns like this one usually take you, as an honest
range from your own history.

## Claims we can make

1. **It shows a range, and the range is honest about its own size.**
   The middle-half range comes from your own similar past turns, so about
   half of your turns should land inside it.
   *Measured:* `/raindragon-eta:eval` (plugin) or the extension's options page
   replays your history in order and reports how often the range held, next
   to how wide it was. Launch target: coverage within a few points of 50%
   (80% for the wide range), reported per user in the beta (RAI-332).

2. **It tells you when it does not know yet.**
   No range before 10 turns; the wide range, marked "still learning", until
   30. *Measured:* behaviour is fixed by the rule and covered by tests; first
   run is shown in the docs.

3. **It tells you when Claude is having a major problem.**
   It reads status.claude.com and warns only during a MAJOR incident (impact
   major/critical, or a component in major outage) on Claude Code, the Claude
   API or claude.ai, not on unrelated surfaces such as the Console.
   *Measured:* on the reference corpus, turns ran 1.81x longer during major
   incidents (z=+4.5) and 0.91x during minor/degraded ones, so minor ones are
   deliberately not flagged.

4. **Failures do not skew it.**
   Failed turns, stopped turns and turns during an incident are never used.
   *Measured:* covered by tests; visible in `/raindragon-eta:doctor` counts.

5. **Your work stays on your machine.** See PRIVACY.md.

6. **On chatgpt.com it learns your ChatGPT pace separately.**
   ChatGPT replies have their own history, never mixed with Claude's, and
   start from zero: "learning your pace" until 10 replies, the wide range
   until 30. *Measured:* separate storage and the first-run rule are covered
   by tests (synthetic stream fixtures). Not yet checked on a live
   signed-in chatgpt.com page; coverage on ChatGPT is not measured. Do not
   claim any ChatGPT coverage number until the options page reports one.

7. **It tells you when ChatGPT's chat is in a major outage.**
   It reads status.openai.com and warns only when the "Conversations"
   component is in a major/full outage. *Measured:* rule covered by tests.
   Unlike claim 3, there is no slowdown evidence for OpenAI incidents yet,
   and status.openai.com's summary lists no incidents (components only), so
   say "major outage of ChatGPT conversations", not "major incident".

## Do not say

* "accurate", "precise", "predicts", "knows exactly"
* any single-number estimate ("this will take 42s")
* any accuracy percentage other than band coverage reported next to band width
* "within 2x": a rule that ignores every input and multiplies elapsed time by
  a constant maximises it, so it says nothing about quality
* that the claude.ai extension is as good as the Claude Code plugin: it has
  less to go on (no effort level, a noisier page signal)
* that the chatgpt.com range is as good as the claude.ai one, or anything
  comparing Claude's and ChatGPT's speed: the histories are separate and
  nothing compares them
* that it works with the Codex CLI or Gemini: not built yet (docs/PROVIDERS.md)
* anything about other users' speed: every range is from your own history,
  and cross-user error is not measured until the beta

## Positioning (decision needed)

Proposed: **Claude Code plugin first**, claude.ai extension second. The
plugin sees exact turn boundaries and effort; the extension infers them from
the page.

## Not measured yet (say so if asked)

* How well ranges hold for people other than the author: first measured in
  the private beta (RAI-332).
* Whether a pooled starting estimate would help new users before turn 10
  (RAI-329/334).
