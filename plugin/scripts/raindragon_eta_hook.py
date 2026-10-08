#!/usr/bin/env python3
"""Claude Code hook entry point: raindragon-eta <event>.

UserPromptSubmit  start the clock, show the band for this turn
Stop              stop the clock, save the turn to local history
StopFailure       the turn failed: save it as failed so it never enters a band

Also run by hand (or via the plugin's slash commands):
  doctor            version, settings and counts -- never content -- to paste
                    into a bug report
  refresh-status    fetch status.claude.com into the cache; started detached
                    by the prompt hook, which never waits on the network
  eval              how often your band held on your own history (coverage)
                    and how wide it was, replayed in order

Kill switch: the plugin option "enabled" (in /config) or RAINDRAGON_ETA_OFF=1.
Off means nothing is shown and nothing is recorded.

Contract with Claude Code:
  * stdout is either empty or ONE JSON object with "systemMessage". Plain
    stdout from UserPromptSubmit would be added to the model's context, and
    the estimate is for the user, not the model.
  * always exit 0. A timing aid must never block or break a turn, so every
    error is swallowed.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from raindragon_eta import __version__, fmt, predict, status, store  # noqa: E402

PREFIX = "RainDragon ETA: "
MAX_TURN_SECONDS = 6 * 3600   # longer than this is a turn left open, not a duration


def _flag(env: dict, key: str, default: bool) -> bool:
    v = env.get("CLAUDE_PLUGIN_OPTION_" + key)
    if v is None or v == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def enabled(env: dict) -> bool:
    if str(env.get("RAINDRAGON_ETA_OFF") or "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    return _flag(env, "ENABLED", True)


def _transcript_bytes(path) -> int:
    try:
        return os.path.getsize(path) if path else 0
    except OSError:
        return 0


def _settings(env: dict) -> dict:
    return {"enabled": enabled(env), "band": env.get("CLAUDE_PLUGIN_OPTION_BAND") or "50",
            "show_result": _flag(env, "SHOW_RESULT", False),
            "check_status": _flag(env, "CHECK_STATUS", True)}


def on_prompt(inp: dict, env: dict, now: float, fetch=None) -> str:
    d = store.data_dir(env)
    store.cleanup(d, now)
    store.write_json(d, "settings_seen.json", dict(_settings(env), at=int(now)))
    store.write_pointer(env, d)
    sid = inp.get("session_id") or ""
    effort = (inp.get("effort") or {}).get("level")
    pc = len(inp.get("prompt") or "")
    tb = _transcript_bytes(inp.get("transcript_path"))
    coverage = env.get("CLAUDE_PLUGIN_OPTION_BAND") or "50"
    if coverage not in predict.BANDS:
        coverage = "50"

    incident = None
    if _flag(env, "CHECK_STATUS", True):
        kw = {"fetch": fetch} if fetch else {}
        incident = status.current_incident(d, status.CLAUDE_CODE_COMPONENTS, now=now, **kw)

    history = store.read_history(d)
    band = predict.predict(history, pc, tb, effort, coverage)

    store.write_pending(d, sid, {
        "prompt_id": inp.get("prompt_id"), "start": now,
        "pb": predict.prompt_bucket(pc), "cb": predict.context_bucket(tb),
        "effort": effort, "incident": bool(incident), "cov": band.coverage if band else coverage,
        "low": band.low if band else None, "high": band.high if band else None,
        "n": band.n if band else None, "learning": bool(band.learning) if band else None,
        "learned": predict.learned_count(history),
    })

    lines = []
    if band:
        lines.append(fmt.band_line(band.low, band.high, band.n, band.coverage, band.learning))
    elif store.mark_noted(d, sid):
        lines.append("learning your pace. Estimates start after %d turns (%d so far)."
                     % (predict.MIN_READY, predict.learned_count(history)))
    if incident:
        lines.append("Claude status reports \"%s\". This turn may run slower than usual." % incident)
    return PREFIX + " ".join(lines) if lines else ""


def on_stop(inp: dict, env: dict, now: float, ok: bool) -> str:
    d = store.data_dir(env)
    p = store.pop_pending(d, inp.get("session_id") or "")
    if not p:
        return ""
    if p.get("prompt_id") and inp.get("prompt_id") and p["prompt_id"] != inp["prompt_id"]:
        return ""
    dur = now - float(p.get("start", now))
    if dur <= 0 or dur > MAX_TURN_SECONDS:
        return ""
    rec = {"t": int(now), "dur": round(dur, 2), "pb": p.get("pb"), "cb": p.get("cb"),
           "effort": p.get("effort"), "ok": ok, "incident": bool(p.get("incident"))}
    if not ok:
        rec["error"] = inp.get("error_type") or "unknown"
    store.append_history(d, rec)
    if ok and _flag(env, "SHOW_RESULT", False):
        took = "took " + fmt.duration(dur)
        if p.get("low") is not None:
            share = "half" if p.get("cov", "50") == "50" else "8 in 10"
            took += " (%s of similar turns took %s–%s)" % (share, fmt.duration(p["low"]), fmt.duration(p["high"]))
        return PREFIX + took
    return ""


def doctor(env: dict, now: float) -> dict:
    """State for a bug report. Counts and settings only: no prompt text,
    no file names, no session ids."""
    d = store.data_dir(env)
    h = store.read_history(d)
    try:
        pending = len([n for n in os.listdir(os.path.join(d, "pending")) if not n.endswith(".tmp")])
    except OSError:
        pending = 0
    cache_age = None
    try:
        with open(os.path.join(d, "status_cache.json")) as f:
            cache_age = round(now - float(json.load(f).get("fetched_at", 0)))
    except (OSError, ValueError):
        pass
    good = predict.learned_count(h)
    # Slash commands do not get the plugin options, so report the settings the
    # last prompt hook saw (None before the first prompt).
    seen = store.read_json(d, "settings_seen.json")
    return {
        "name": "raindragon-eta", "version": __version__,
        "settings": seen,
        "data_dir": d,
        "turns_recorded": len(h),
        "turns_used": good,
        "turns_failed": sum(1 for r in h if not r.get("ok")),
        "turns_in_incident": sum(1 for r in h if r.get("ok") and r.get("incident")),
        "phase": ("learning (no band yet)" if good < predict.MIN_READY
                  else "learning (wide band)" if good < predict.CONFIDENT else "ready"),
        "turns_in_progress": pending,
        "status_cache_age_s": cache_age,
        "python": sys.version.split()[0],
    }


def main(argv, stdin, stdout, env, now=None) -> int:
    try:
        event = argv[1] if len(argv) > 1 else ""
        now = time.time() if now is None else now
        # Slash commands pass the data dir as an argument: they do not get
        # CLAUDE_PLUGIN_DATA in their environment, only as text substitution.
        if len(argv) > 3 and argv[2] == "--data" and argv[3]:
            env = dict(env, CLAUDE_PLUGIN_DATA=argv[3])
        if event == "doctor":
            stdout.write(json.dumps(doctor(env, now), indent=2) + "\n")
            return 0
        if event == "refresh-status":
            status.refresh(store.data_dir(env), now)
            return 0
        if event == "eval":
            d = store.data_dir(env)
            cov = env.get("CLAUDE_PLUGIN_OPTION_BAND") or "50"
            stdout.write(json.dumps(predict.evaluate(store.read_history(d), cov), indent=2) + "\n")
            return 0
        if not enabled(env):
            return 0
        inp = json.loads(stdin.read() or "{}")
        if event == "prompt":
            msg = on_prompt(inp, env, now)
        elif event == "stop":
            msg = on_stop(inp, env, now, ok=True)
        elif event == "stop-failure":
            on_stop(inp, env, now, ok=False)
            msg = ""  # StopFailure output is ignored by Claude Code anyway
        else:
            msg = ""
        if msg:
            stdout.write(json.dumps({"systemMessage": msg}))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin, sys.stdout, dict(os.environ)))
