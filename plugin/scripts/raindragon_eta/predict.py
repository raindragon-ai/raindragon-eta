"""Turn duration band from the user's own past turns.

No model, no network: a lookup over the user's local history. We return a
BAND (default the middle 50% of similar past turns), never a single number.
A point estimate of turn duration sits at its information ceiling (68%
within-2x, worse than a naive baseline), so claiming one would be false.
What we can claim is that the band is calibrated: about half of turns land
inside a 50% band.

"Similar" narrows step by step, and we use the narrowest group that still has
enough turns:

    prompt size + context size + effort
    prompt size + effort
    effort
    all turns

First-run rule (RAI-329): say nothing we have not measured.

    fewer than MIN_READY good turns    no band; the hook says it is learning
    MIN_READY .. CONFIDENT-1           the WIDE band (8 in 10) whatever the
                                       setting, labelled "still learning"
    CONFIDENT or more                  the band the user chose

A quantile from 12 turns is noisy, so a narrow band from it would imply
precision we do not have; the wide band misses less while it is noisy.

evaluate() is the measurement behind the claim: it replays a history in
order, predicting each turn only from the turns before it, and reports how
often the truth landed in the band (coverage) and how wide the band was
(sharpness). Both are reported together: coverage alone is gamed by widening.

Excluded from history: turns that failed (API error) and turns that ran
during a provider incident. Both are slow for reasons that say nothing about
the next normal turn, and counting them is what used to inflate the band.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

MIN_READY = 10       # good turns before we show any band
CONFIDENT = 30       # good turns before we show the narrower band the user chose
MIN_GROUP = 8        # turns a narrower group needs before we trust it
RECENT = 300         # only the most recent turns: pace drifts with model and work

BANDS = {"50": (0.25, 0.75), "80": (0.10, 0.90)}


def prompt_bucket(chars: int) -> str:
    if chars < 200:
        return "short"
    if chars < 2000:
        return "medium"
    return "long"


def context_bucket(transcript_bytes: int) -> str:
    if transcript_bytes < 200_000:
        return "small"
    if transcript_bytes < 1_000_000:
        return "medium"
    return "large"


def quantile(sorted_vals: Sequence[float], q: float) -> float:
    """Linear interpolation between closest ranks (same as numpy's default)."""
    n = len(sorted_vals)
    if n == 1:
        return float(sorted_vals[0])
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac)


@dataclass
class Band:
    low: float
    high: float
    n: int          # turns the band was computed from
    group: str      # which group was used, e.g. "prompt+context+effort"
    coverage: str   # "50" or "80"
    learning: bool = False  # fewer than CONFIDENT good turns: forced wide


def usable(records: Iterable[dict]) -> list:
    out = [r for r in records
           if r.get("ok") and not r.get("incident")
           and isinstance(r.get("dur"), (int, float)) and r["dur"] > 0]
    return out[-RECENT:]


def predict(history: Iterable[dict], prompt_chars: int, transcript_bytes: int,
            effort: Optional[str], coverage: str = "50") -> Optional[Band]:
    return _predict_buckets(usable(history), prompt_bucket(prompt_chars),
                            context_bucket(transcript_bytes), effort, coverage)


def _predict_buckets(good: list, pb: str, cb: str, effort: Optional[str],
                     coverage: str) -> Optional[Band]:
    if len(good) < MIN_READY:
        return None
    learning = len(good) < CONFIDENT
    if learning:
        coverage = "80"
    groups = [
        ("prompt+context+effort",
         lambda r: r.get("pb") == pb and r.get("cb") == cb and r.get("effort") == effort),
        ("prompt+effort", lambda r: r.get("pb") == pb and r.get("effort") == effort),
        ("effort", lambda r: r.get("effort") == effort),
        ("all", lambda r: True),
    ]
    lo_q, hi_q = BANDS.get(coverage, BANDS["50"])
    for name, keep in groups:
        durs = sorted(r["dur"] for r in good if keep(r))
        if len(durs) >= MIN_GROUP or name == "all":
            return Band(quantile(durs, lo_q), quantile(durs, hi_q), len(durs), name, coverage,
                        learning)
    return None  # unreachable


def evaluate(history: Iterable[dict], coverage: str = "50") -> dict:
    """Replay `history` in order; score each good turn against the band built
    from the good turns BEFORE it (never itself, never the future).

    Returns scored (turns with a band), hits, coverage (hits/scored), nominal
    (the band's target share), and median_ratio (median high/low: 2.0 means
    the band's top is twice its bottom). Learning-phase turns are scored at
    the wide band they were actually shown with, so the number is what a user
    saw, not what a mature history would show."""
    good = [r for r in history
            if r.get("ok") and not r.get("incident")
            and isinstance(r.get("dur"), (int, float)) and r["dur"] > 0]
    hits = scored = 0
    ratios = []
    by_nominal = {}
    for i, r in enumerate(good):
        band = _predict_buckets(good[max(0, i - RECENT):i], r.get("pb"), r.get("cb"),
                                r.get("effort"), coverage)
        if band is None:
            continue
        scored += 1
        hit = band.low <= r["dur"] <= band.high
        hits += hit
        if band.low > 0:
            ratios.append(band.high / band.low)
        s = by_nominal.setdefault(band.coverage, [0, 0])
        s[0] += 1
        s[1] += hit
    ratios.sort()
    return {
        "scored": scored,
        "hits": hits,
        "coverage": (hits / scored) if scored else None,
        "by_band": {k: {"scored": v[0], "coverage": v[1] / v[0]} for k, v in by_nominal.items()},
        "median_ratio": quantile(ratios, 0.5) if ratios else None,
    }


def learned_count(history: Iterable[dict]) -> int:
    return len(usable(history))
