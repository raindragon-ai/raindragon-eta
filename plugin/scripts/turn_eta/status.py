"""Is the provider having an incident right now?

Reads the public Statuspage summary for Claude (status.claude.com) and reports
only incidents and degraded components that touch the surface we time. An
incident on the Console says nothing about Claude Code speed, so it is
ignored.

The result is cached on disk for CACHE_SECONDS so a burst of prompts makes
one request, and every failure (offline, timeout, bad JSON) returns "no
known incident": a status check must never slow down or break a turn.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Optional, Sequence

SUMMARY_URL = "https://status.claude.com/api/v2/summary.json"
CACHE_SECONDS = 120
TIMEOUT_SECONDS = 1.5

# Component names on status.claude.com, matched case-insensitively by prefix.
CLAUDE_CODE_COMPONENTS = ("claude code", "claude api")
CLAUDE_WEB_COMPONENTS = ("claude.ai", "claude api")

# Only MAJOR problems count. Measured on the reference corpus: turns during
# major incidents ran 1.81x longer (z=+4.5); during minor incidents and
# "degraded performance" 0.91x, i.e. no slowdown. Warning on those would cry
# wolf, and excluding their turns from the band would throw away normal data.
MAJOR_IMPACTS = ("major", "critical")
MAJOR_COMPONENT_STATUS = ("major_outage",)


def _relevant(name: str, components: Sequence[str]) -> bool:
    n = (name or "").lower()
    return any(n.startswith(c) for c in components)


def incident_from_summary(summary: dict, components: Sequence[str]) -> Optional[str]:
    """Short text naming an active MAJOR problem on our components, or None."""
    for inc in summary.get("incidents") or []:
        if inc.get("status") in ("resolved", "postmortem"):
            continue
        if str(inc.get("impact") or "").lower() not in MAJOR_IMPACTS:
            continue
        if any(_relevant(c.get("name"), components) for c in inc.get("components") or []):
            return inc.get("name") or "an active incident"
    for comp in summary.get("components") or []:
        if _relevant(comp.get("name"), components) and comp.get("status") in MAJOR_COMPONENT_STATUS:
            return "%s: %s" % (comp.get("name"), str(comp.get("status")).replace("_", " "))
    return None


def _fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "turn-eta"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read().decode("utf-8"))


def current_incident(cache_dir: str, components: Sequence[str] = CLAUDE_CODE_COMPONENTS,
                     now: Optional[float] = None, fetch=None) -> Optional[str]:
    now = time.time() if now is None else now
    fetch = fetch or _fetch
    path = os.path.join(cache_dir, "status_cache.json")
    summary = None
    try:
        with open(path) as f:
            cached = json.load(f)
        if now - cached.get("fetched_at", 0) < CACHE_SECONDS:
            summary = cached.get("summary")
    except (OSError, ValueError):
        pass
    if summary is None:
        try:
            summary = fetch(SUMMARY_URL)
        except Exception:
            return None
        try:
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"fetched_at": now, "summary": summary}, f)
            os.replace(tmp, path)
        except OSError:
            pass
    try:
        return incident_from_summary(summary, components)
    except Exception:
        return None
