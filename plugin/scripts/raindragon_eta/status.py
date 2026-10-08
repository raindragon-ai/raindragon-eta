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
    req = urllib.request.Request(url, headers={"User-Agent": "raindragon-eta"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read().decode("utf-8"))


STALE_OK_SECONDS = 600     # an older cached status is better than none, up to this
REFRESH_EVERY_SECONDS = 30  # at most one background refresh started per this


def _read_cache(path: str):
    try:
        with open(path) as f:
            cached = json.load(f)
        return float(cached.get("fetched_at", 0)), cached.get("summary")
    except (OSError, ValueError, TypeError, AttributeError):
        return None, None


def refresh(cache_dir: str, now: Optional[float] = None, fetch=None) -> bool:
    """Fetch the status page and cache it. Blocking: run it from the
    background process (hook "refresh-status"), never from a prompt hook."""
    now = time.time() if now is None else now
    try:
        summary = (fetch or _fetch)(SUMMARY_URL)
    except Exception:
        return False
    path = os.path.join(cache_dir, "status_cache.json")
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"fetched_at": now, "summary": summary}, f)
        os.replace(tmp, path)
    except OSError:
        return False
    return True


def _spawn_refresh(cache_dir: str) -> None:
    """Start "refresh-status" detached, and do not wait for it."""
    import subprocess
    import sys
    hook = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "raindragon_eta_hook.py")
    subprocess.Popen([sys.executable, hook, "refresh-status", "--data", cache_dir],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


def current_incident(cache_dir: str, components: Sequence[str] = CLAUDE_CODE_COMPONENTS,
                     now: Optional[float] = None, fetch=None, spawn=None) -> Optional[str]:
    """The active major incident on our components, or None. NEVER waits on
    the network: a prompt hook calls this, and a slow DNS lookup once took it
    past Claude Code's 5 s hook timeout, which discarded the whole message.

    Reads the cached status page. When the cache is older than CACHE_SECONDS
    it starts a background refresh (at most one per REFRESH_EVERY_SECONDS) and
    answers from the old copy if that is under STALE_OK_SECONDS, else None.
    Passing `fetch` refreshes inline instead (tests only)."""
    now = time.time() if now is None else now
    path = os.path.join(cache_dir, "status_cache.json")
    fetched_at, summary = _read_cache(path)
    age = None if fetched_at is None else now - fetched_at
    if age is None or age >= CACHE_SECONDS:
        if fetch is not None:
            if refresh(cache_dir, now, fetch):
                fetched_at, summary = _read_cache(path)
                age = 0.0
        else:
            stamp = os.path.join(cache_dir, "status_refresh_started")
            try:
                started = os.path.getmtime(stamp)
            except OSError:
                started = None              # never refreshed: always start one
            if started is None or now - started >= REFRESH_EVERY_SECONDS:
                try:
                    open(stamp, "w").close()
                    os.utime(stamp, (now, now))
                    (spawn or _spawn_refresh)(cache_dir)
                except Exception:
                    pass
    if summary is None or age is None or age >= STALE_OK_SECONDS:
        return None
    try:
        return incident_from_summary(summary, components)
    except Exception:
        return None
