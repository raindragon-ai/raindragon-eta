"""Build the built-in starting ranges (plugin/scripts/raindragon_eta/prior.json)
from Claude Code transcripts.

Claude Code writes a `turn_duration` record after every finished turn. For
each one we take its duration, the size of the prompt that started it and how
big the transcript was at that point, bucketed the same way the plugin buckets
live turns. Only those numbers are used; the output holds quantiles per bucket
and nothing else (no text, paths or ids).

    python3 tools/build_prior.py ~/.claude/projects [more dirs...] > prior.json
    python3 tools/build_prior.py --check ~/.claude/projects   # holdout coverage
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
    """Yield (timestamp, dur_s, prompt_chars, transcript_bytes) per finished turn."""
    offset = 0
    prompt = None   # (chars, bytes before it) of the prompt that started the turn
    failed = False
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
                    prompt, failed = (pc, start), False
            elif r.get("type") == "assistant" and r.get("isApiErrorMessage"):
                failed = True
            elif r.get("type") == "system" and r.get("subtype") == "turn_duration":
                ms = r.get("durationMs")
                if prompt and not failed and isinstance(ms, (int, float)) and ms > 0:
                    yield r.get("timestamp") or "", ms / 1000.0, prompt[0], prompt[1]
                prompt = None


def collect(dirs):
    out = []
    for d in dirs:
        for root, _, files in os.walk(os.path.expanduser(d)):
            for name in files:
                if name.endswith(".jsonl"):
                    for ts, dur, pc, tb in turns(os.path.join(root, name)):
                        out.append({"t": ts, "dur": dur, "pb": predict.prompt_bucket(pc),
                                    "cb": predict.context_bucket(tb), "ok": True})
    out.sort(key=lambda r: r["t"])
    return out


def build(records) -> dict:
    groups = {"all": [r["dur"] for r in records]}
    for r in records:
        groups.setdefault(r["pb"] + "/" + r["cb"], []).append(r["dur"])
        groups.setdefault(r["pb"], []).append(r["dur"])
    table = {}
    for k, durs in sorted(groups.items()):
        if len(durs) < predict.PRIOR_MIN or k == "all" and not durs:
            continue
        s = sorted(durs)
        table[k] = {"n": len(s), **{q: round(predict.quantile(s, float(q) / 100), 1)
                                    for q in ("10", "25", "75", "90")}}
    return {"source": "Claude Code turn_duration records", "turns": len(records), "groups": table}


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
    if args and args[0] == "--check":
        print(json.dumps(check(collect(args[1:])), indent=2))
    else:
        print(json.dumps(build(collect(args or ["~/.claude/projects"])), indent=1))
