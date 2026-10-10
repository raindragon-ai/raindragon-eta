"""Build the built-in starting ranges (plugin/scripts/raindragon_eta/prior.json)
from Claude Code transcripts.

Claude Code writes a `turn_duration` record after every finished turn. For
each one we take its duration, the size of the prompt that started it and how
big the transcript was at that point, bucketed the same way the plugin buckets
live turns. Only those numbers are used; the output holds quantiles per bucket
and nothing else (no text, paths or ids).

    python3 tools/build_prior.py ~/.claude/projects [more dirs...] > prior.json
    python3 tools/build_prior.py --check ~/.claude/projects   # holdout coverage

    python3 tools/build_prior.py --chat ~/.claude/projects > extension/lib/prior.js
    python3 tools/build_prior.py --chat --check ~/.claude/projects

--chat builds the extension's table instead: only turns where Claude answered
in text without using a tool (the closest thing to a claude.ai reply), with
reply length in words, and conversation size as the characters of prompts
and replies before it (what the extension measures on the page). Text is
only measured, never kept.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin", "scripts"))
from raindragon_eta import predict  # noqa: E402

SKIP_PREFIXES = ("<command-name>", "<local-command", "<bash-", "/raindragon-eta:")


def _prompt_chars(msg) -> int | None:
    c = (msg or {}).get("content")
    if isinstance(c, str):
        text = c
    elif isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return None
        text = "".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    else:
        return None
    if not text or text.lstrip().startswith(SKIP_PREFIXES) or text.startswith("[Request interrupted"):
        return None
    return len(text)


def turns(path: str):
    """Yield one dict per finished turn: t, dur, prompt_chars, transcript_bytes,
    visible_chars (prompts + reply text before it), tools (used any), words."""
    offset = 0
    prompt = None   # (chars, bytes before it, visible chars before it)
    failed = tools = False
    words = visible = 0
    with open(path, "rb") as f:
        for raw in f:
            start = offset
            offset += len(raw)
            try:
                r = json.loads(raw)
            except ValueError:
                continue
            if r.get("isSidechain") or r.get("isMeta"):
                continue
            if r.get("type") == "user":
                pc = _prompt_chars(r.get("message"))
                if pc is not None:
                    prompt, failed, tools, words = (pc, start, visible), False, False, 0
                    visible += pc
            elif r.get("type") == "assistant":
                failed = failed or bool(r.get("isApiErrorMessage"))
                for x in (r.get("message") or {}).get("content") or []:
                    if isinstance(x, dict) and x.get("type") == "tool_use":
                        tools = True
                    elif isinstance(x, dict) and x.get("type") == "text":
                        words += len(x.get("text", "").split())
                        visible += len(x.get("text", ""))
            elif r.get("type") == "system" and r.get("subtype") == "turn_duration":
                ms = r.get("durationMs")
                if prompt and not failed and isinstance(ms, (int, float)) and ms > 0:
                    yield {"t": r.get("timestamp") or "", "dur": ms / 1000.0,
                           "prompt_chars": prompt[0], "transcript_bytes": prompt[1],
                           "visible_chars": prompt[2], "tools": tools, "words": words}
                prompt = None


def chat_context_bucket(chars: int) -> str:
    # same thresholds as contextBucket() in extension/lib/predict.js
    return "small" if chars < 20000 else "medium" if chars < 100000 else "large"


def collect(dirs, chat=False):
    out = []
    for d in dirs:
        for root, _, files in os.walk(os.path.expanduser(d)):
            for name in files:
                if not name.endswith(".jsonl"):
                    continue
                for t in turns(os.path.join(root, name)):
                    if chat:
                        if t["tools"] or t["words"] <= 0:
                            continue
                        cb = chat_context_bucket(t["visible_chars"])
                    else:
                        cb = predict.context_bucket(t["transcript_bytes"])
                    out.append({"t": t["t"], "dur": t["dur"], "pb": predict.prompt_bucket(t["prompt_chars"]),
                                "cb": cb, "words": t["words"], "ok": True})
    out.sort(key=lambda r: r["t"])
    return out


def _quantiles(values) -> dict:
    s = sorted(values)
    return {q: round(predict.quantile(s, float(q) / 100), 1) for q in ("10", "25", "75", "90")}


def build(records, chat=False) -> dict:
    groups = {"all": records}
    for r in records:
        groups.setdefault(r["pb"] + "/" + r["cb"], []).append(r)
        groups.setdefault(r["pb"], []).append(r)
    table = {}
    for k, rows in sorted(groups.items()):
        if len(rows) < predict.PRIOR_MIN:
            continue
        table[k] = {"n": len(rows), **_quantiles([r["dur"] for r in rows])}
        if chat:
            table[k]["words"] = _quantiles([r["words"] for r in rows])
    source = ("Claude Code text-only replies (no tools), turn_duration records" if chat
              else "Claude Code turn_duration records")
    return {"source": source, "turns": len(records), "groups": table}


def as_js(prior: dict) -> str:
    return ("/* Built-in typical ranges for the extension's first replies.\n"
            " * Generated by tools/build_prior.py --chat; do not edit by hand. */\n"
            "(function (root) {\n"
            "  const PRIOR = " + json.dumps(prior, sort_keys=True) + ";\n"
            "  if (typeof module !== \"undefined\" && module.exports) module.exports = PRIOR;\n"
            "  else root.RainDragonEtaPrior = PRIOR;\n"
            "})(typeof self !== \"undefined\" ? self : this);\n")


def check(records) -> dict:
    """Build from the older 70%, score the newer 30% against the prior band."""
    cut = int(len(records) * 0.7)
    prior = build(records[:cut])
    hits = {"50": 0, "80": 0}
    test = records[cut:]
    for r in test:
        for cov in hits:
            b = predict.prior_band(prior, r["pb"], r["cb"], cov)
            hits[cov] += b.low <= r["dur"] <= b.high
    return {"train": cut, "test": len(test),
            "coverage_50": hits["50"] / len(test), "coverage_80": hits["80"] / len(test)}


if __name__ == "__main__":
    args = sys.argv[1:]
    chat = "--chat" in args
    do_check = "--check" in args
    dirs = [a for a in args if not a.startswith("--")] or ["~/.claude/projects"]
    records = collect(dirs, chat)
    if do_check:
        print(json.dumps(check(records), indent=2))
    elif chat:
        sys.stdout.write(as_js(build(records, chat=True)))
    else:
        print(json.dumps(build(records), indent=1))
