"""Human text for durations and bands. Rounded on purpose: a band printed
to the second would read as more precise than it is."""

from __future__ import annotations


def duration(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    if s < 60:
        return "%ds" % s
    if s < 3600:
        m, r = divmod(s, 60)
        # under 10 minutes keep half-minute detail, above that whole minutes
        if m < 10 and r >= 30:
            return "%dm30s" % m
        return "%dm" % (m + (1 if r >= 30 and m >= 10 else 0))
    h, r = divmod(s, 3600)
    m = int(round(r / 60.0))
    if m == 60:
        h, m = h + 1, 0
    return "%dh" % h if m == 0 else "%dh%02dm" % (h, m)


def band_line(low: float, high: float, n: int, coverage: str, learning: bool = False,
              typical: bool = False, learned: int = 0, ready_at: int = 10) -> str:
    share = "Half" if coverage == "50" else "8 in 10"
    lo, hi = duration(low), duration(high)
    span = lo if lo == hi else "%s–%s" % (lo, hi)
    if typical:
        return ("%s typical Claude Code turns like this took %s (yours from turn %d, %d so far)"
                % (share, span, ready_at, learned))
    tail = "from %d turns, still learning" % n if learning else "from %d turns" % n
    return "%s of your similar turns took %s (%s)" % (share, span, tail)
