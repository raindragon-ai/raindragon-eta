#!/usr/bin/env python3
"""Hook entry point: raindragon-eta <event> [--host claude|codex|gemini].

Claude Code (default host; plugin hooks/hooks.json):

UserPromptSubmit  start the clock, show the band for this turn
Stop              stop the clock, save the turn to local history
StopFailure       the turn failed: save it as failed so it never enters a band

Codex CLI (--host codex; ~/.codex/hooks.json, docs/INSTALL_CLI.md):
  prompt     UserPromptSubmit. Before starting the clock, a previous turn of
             the session whose Stop never came is looked up in Codex's
             rollout log: a task_complete with an error is saved as failed.
  stop       Stop
  interrupt  Interrupt: the user stopped the turn; dropped, never recorded

Gemini CLI (--host gemini; ~/.gemini/settings.json):
  prompt     BeforeAgent
  stop       AfterAgent; an empty reply is saved as failed

Each host keeps its own history in its own folder (hosts.py).

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

from raindragon_eta import __version__, fmt, hosts, predict, status, store  # noqa: E402

PREFIX = "RainDragon ETA: "
#: Who makes it. Named, with a link, in doctor output, the extension options page
#: and the README only -- never inside an estimate (CLAIMS.md, "Made by").
MADE_BY = "RainDragon AI"
HOMEPAGE = "https://inference.raindragon.ai/?utm_source=raindragon-eta&utm_medium=doctor"
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


OWN_COMMANDS = "/raindragon-eta:"   # our own slash commands are not turns worth timing


#: What a status warning names, per host.
INCIDENT_TEXT = {"claude": "Claude status reports \"%s\". This turn may run slower than usual.",
                 "gemini": "Google's status dashboard reports a Gemini outage. This turn may run slower than usual."}


def _settle_unfinished(d: str, sid: str, p: dict, host: str) -> None:
    """A turn whose end hook never came. Codex skips Stop when a turn ends in
    an error, and writes the outcome to its rollout log: record that as
    failed so doctor counts it. Anything else (aborted, unknown) is dropped,
    as before."""
    if host != "codex":
        return
    o = hosts.codex_turn_outcome(p.get("transcript_path"), p.get("prompt_id"))
    if not o or o["kind"] != "complete" or not o["error"]:
        return
    dur = (o["duration_ms"] or 0) / 1000.0
    rec = {"t": int(float(p.get("start", 0)) + dur), "dur": round(dur, 2), "pb": p.get("pb"),
           "cb": p.get("cb"), "effort": p.get("effort"), "ok": False,
           "incident": bool(p.get("incident")), "error": o["error"]}
    store.append_history(d, rec)


def on_prompt(inp: dict, env: dict, now: float, fetch=None, host: str = "claude") -> str:
    d = store.data_dir(env)
    store.cleanup(d, now)
    if host != "claude":
        old = store.pop_pending(d, inp.get("session_id") or "")
        if old:
            _settle_unfinished(d, inp.get("session_id") or "", old, host)
    if (inp.get("prompt") or "").lstrip().startswith(OWN_COMMANDS):
        # /raindragon-eta:doctor and :eval take a second and say nothing about
        # the user's pace: no estimate, and no pending turn, so Stop records
        # nothing and the status-line clock does not start.
        store.pop_pending(d, inp.get("session_id") or "")
        return ""
    store.write_json(d, "settings_seen.json", dict(_settings(env), at=int(now)))
    if host == "claude":
        store.write_pointer(env, d)   # for the Claude Code live status line only
    sid = inp.get("session_id") or ""
    effort = hosts.similar_label(inp, host)
    pc = len(inp.get("prompt") or "")
    tb = _transcript_bytes(inp.get("transcript_path"))
    coverage = env.get("CLAUDE_PLUGIN_OPTION_BAND") or "50"
    if coverage not in predict.BANDS:
        coverage = "50"

    incident = None
    if _flag(env, "CHECK_STATUS", True):
        kw = {"fetch": fetch} if fetch else {}
        if host in status.SOURCES:
            incident = status.current_incident(d, status.CLAUDE_CODE_COMPONENTS, now=now,
                                               host=host, **kw)

    history = store.read_history(d)
    band = predict.predict(history, pc, tb, effort, coverage)

    pending = {
        "prompt_id": hosts.turn_key(inp, host), "start": now,
        "pb": predict.prompt_bucket(pc), "cb": predict.context_bucket(tb),
        "effort": effort, "incident": bool(incident), "cov": band.coverage if band else coverage,
        "low": band.low if band else None, "high": band.high if band else None,
        "n": band.n if band else None, "learning": bool(band.learning) if band else None,
        "learned": predict.learned_count(history),
    }
    if host == "codex" and inp.get("transcript_path"):
        # kept only to look up this turn's outcome if its Stop never comes
        pending["transcript_path"] = str(inp["transcript_path"])
    store.write_pending(d, sid, pending)

    lines = []
    if band:
        lines.append(fmt.band_line(band.low, band.high, band.n, band.coverage, band.learning))
    elif store.mark_noted(d, sid):
        lines.append("learning your pace. Estimates start after %d turns (%d so far)."
                     % (predict.MIN_READY, predict.learned_count(history)))
    if incident:
        text = INCIDENT_TEXT.get(host, INCIDENT_TEXT["claude"])
        lines.append(text % incident if "%s" in text else text)
    return PREFIX + " ".join(lines) if lines else ""


def on_stop(inp: dict, env: dict, now: float, ok: bool, host: str = "claude",
            error: str = None) -> str:
    d = store.data_dir(env)
    p = store.pop_pending(d, inp.get("session_id") or "")
    if not p:
        return ""
    key = hosts.turn_key(inp, host)
    if p.get("prompt_id") and key and p["prompt_id"] != key:
        return ""
    dur = now - float(p.get("start", now))
    if dur <= 0 or dur > MAX_TURN_SECONDS:
        return ""
    rec = {"t": int(now), "dur": round(dur, 2), "pb": p.get("pb"), "cb": p.get("cb"),
           "effort": p.get("effort"), "ok": ok, "incident": bool(p.get("incident"))}
    if not ok:
        rec["error"] = error or inp.get("error_type") or "unknown"
    store.append_history(d, rec)
    if ok and _flag(env, "SHOW_RESULT", False):
        took = "took " + fmt.duration(dur)
        if p.get("low") is not None:
            share = "half" if p.get("cov", "50") == "50" else "8 in 10"
            took += " (%s of similar turns took %s–%s)" % (share, fmt.duration(p["low"]), fmt.duration(p["high"]))
        return PREFIX + took
    return ""


def doctor(env: dict, now: float, host: str = "claude") -> dict:
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
        "name": "raindragon-eta", "version": __version__, "host": host,
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
        "made_by": MADE_BY,
        "homepage": HOMEPAGE,
    }


def main(argv, stdin, stdout, env, now=None) -> int:
    try:
        argv = list(argv)
        host = "claude"
        if "--host" in argv:
            i = argv.index("--host")
            host = argv[i + 1] if i + 1 < len(argv) else ""
            del argv[i:i + 2]
            if host not in hosts.HOSTS:
                return 0
        event = argv[1] if len(argv) > 1 else ""
        now = time.time() if now is None else now
        # Slash commands pass the data dir as an argument: they do not get
        # CLAUDE_PLUGIN_DATA in their environment, only as text substitution.
        if len(argv) > 3 and argv[2] == "--data" and argv[3]:
            env = dict(env, CLAUDE_PLUGIN_DATA=argv[3])
            if host != "claude":
                env["RAINDRAGON_ETA_DATA"] = argv[3]
        env = hosts.data_dir_env(env, host)
        if event == "doctor":
            stdout.write(json.dumps(doctor(env, now, host), indent=2) + "\n")
            return 0
        if event == "refresh-status":
            src = status.SOURCES.get(host)
            if src:
                status.refresh(store.data_dir(env), now, url=src[0])
            return 0
        if event == "eval":
            d = store.data_dir(env)
            cov = env.get("CLAUDE_PLUGIN_OPTION_BAND") or "50"
            stdout.write(json.dumps(predict.evaluate(store.read_history(d), cov), indent=2) + "\n")
            return 0
        if not enabled(env):
            return 0
        inp = json.loads(stdin.read() or "{}")
        if not isinstance(inp, dict):
            return 0
        if event == "prompt":
            msg = on_prompt(inp, env, now, host=host)
        elif event == "stop" and host == "gemini":
            err = hosts.gemini_failed(inp)
            msg = on_stop(inp, env, now, ok=err is None, host=host, error=err)
        elif event == "stop":
            msg = on_stop(inp, env, now, ok=True, host=host)
        elif event == "interrupt" and host == "codex":
            # stopped by the user: never recorded (same rule as everywhere)
            store.pop_pending(store.data_dir(env), inp.get("session_id") or "")
            msg = ""
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
