import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin", "scripts"))

import turn_eta_hook as hook  # noqa: E402
from turn_eta import fmt, predict, status, store  # noqa: E402


def rec(dur, ok=True, incident=False, pb="short", cb="small", effort="high"):
    return {"t": 0, "dur": dur, "pb": pb, "cb": cb, "effort": effort, "ok": ok, "incident": incident}


# ---------- predict ----------

def test_no_band_before_min_ready():
    hist = [rec(30)] * (predict.MIN_READY - 1)
    assert predict.predict(hist, 10, 0, "high") is None


def test_failed_and_incident_turns_never_count():
    hist = [rec(30)] * (predict.MIN_READY - 1) + [rec(900, ok=False)] * 20 + [rec(900, incident=True)] * 20
    assert predict.predict(hist, 10, 0, "high") is None
    hist.append(rec(30))
    b = predict.predict(hist, 10, 0, "high")
    assert b.low == b.high == 30


def test_band_is_middle_half():
    hist = [rec(d) for d in range(1, 101)]  # 1..100 seconds
    b = predict.predict(hist, 10, 0, "high")
    assert (round(b.low, 2), round(b.high, 2)) == (25.75, 75.25)
    assert b.group == "prompt+context+effort" and b.n == 100


def test_eighty_band_is_wider():
    hist = [rec(d) for d in range(1, 101)]
    b50 = predict.predict(hist, 10, 0, "high", "50")
    b80 = predict.predict(hist, 10, 0, "high", "80")
    assert b80.low < b50.low and b80.high > b50.high


def test_falls_back_to_broader_group():
    # 20 long-prompt turns but only 3 short ones: a short prompt uses effort-level history
    hist = [rec(300, pb="long")] * 20 + [rec(10, pb="short")] * 3
    b = predict.predict(hist, 10, 0, "high")
    assert b.group == "effort" and b.n == 23


def test_uses_recent_turns_only():
    hist = [rec(1000)] * 500 + [rec(20)] * predict.RECENT
    b = predict.predict(hist, 10, 0, "high")
    assert b.high == 20


@pytest.mark.parametrize("vals,q,want", [([5], 0.25, 5), ([1, 3], 0.5, 2), ([1, 2, 3, 4, 5], 0.75, 4)])
def test_quantile(vals, q, want):
    assert predict.quantile(vals, q) == want


# ---------- fmt ----------

@pytest.mark.parametrize("s,want", [(0, "0s"), (44.6, "45s"), (60, "1m"), (95, "1m30s"), (130, "2m"),
                                    (659, "11m"), (3600, "1h"), (3720, "1h02m"), (7190, "2h")])
def test_duration(s, want):
    assert fmt.duration(s) == want


def test_band_line_collapses_equal_ends():
    assert "took 30s (" in fmt.band_line(30, 30, 12, "50")


# ---------- status ----------

LIVE_SHAPE = {  # shape of status.claude.com on 2026-10-07: Console down, Code fine
    "components": [{"name": "claude.ai", "status": "operational"},
                   {"name": "Claude Console (platform.claude.com)", "status": "partial_outage"},
                   {"name": "Claude API (api.anthropic.com)", "status": "operational"},
                   {"name": "Claude Code", "status": "operational"}],
    "incidents": [{"name": "Elevated errors on platform.claude.com", "status": "investigating",
                   "components": [{"name": "Claude Console (platform.claude.com)"}]}],
}


def test_console_incident_is_not_a_claude_code_incident():
    assert status.incident_from_summary(LIVE_SHAPE, status.CLAUDE_CODE_COMPONENTS) is None


def test_api_incident_is_reported():
    s = json.loads(json.dumps(LIVE_SHAPE))
    s["incidents"].append({"name": "Elevated errors on Claude Opus", "status": "identified",
                           "components": [{"name": "Claude API (api.anthropic.com)"}]})
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) == "Elevated errors on Claude Opus"


def test_degraded_component_without_incident():
    s = json.loads(json.dumps(LIVE_SHAPE))
    s["components"][3]["status"] = "degraded_performance"
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) == "Claude Code: degraded performance"


def test_resolved_incident_ignored():
    s = {"components": [], "incidents": [{"name": "x", "status": "resolved",
                                          "components": [{"name": "Claude Code"}]}]}
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) is None


def test_status_failure_is_silent_and_cached(tmp_path):
    calls = []

    def boom(url):
        calls.append(url)
        raise OSError("offline")

    assert status.current_incident(str(tmp_path), now=100, fetch=boom) is None

    def ok(url):
        calls.append(url)
        return LIVE_SHAPE

    status.current_incident(str(tmp_path), now=200, fetch=ok)
    status.current_incident(str(tmp_path), now=250, fetch=ok)  # cached
    assert len(calls) == 2


# ---------- hook end to end ----------

def run(event, payload, env, now):
    out = io.StringIO()
    assert hook.main(["hook", event], io.StringIO(json.dumps(payload)), out, env, now=now) == 0
    return json.loads(out.getvalue()) if out.getvalue() else None


@pytest.fixture
def env(tmp_path):
    return {"CLAUDE_PLUGIN_DATA": str(tmp_path), "CLAUDE_PLUGIN_OPTION_CHECK_STATUS": "false"}


def prompt(i, sid="s1"):
    return {"session_id": sid, "prompt_id": "p%d" % i, "prompt": "fix the test", "effort": {"level": "high"},
            "transcript_path": "/nonexistent"}


def test_first_run_says_learning_once_then_nothing(env):
    out = run("prompt", prompt(1), env, 1000)
    assert out["systemMessage"].startswith("Turn ETA: learning your pace")
    assert "(0 so far)" in out["systemMessage"]
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 1030)
    assert run("prompt", prompt(2), env, 2000) is None  # no repeat in the same session


def test_band_appears_after_enough_turns_and_only_systemmessage(env):
    t = 0
    for i in range(predict.MIN_READY):
        run("prompt", prompt(i), env, t)
        run("stop", {"session_id": "s1", "prompt_id": "p%d" % i}, env, t + 40 + i)
        t += 1000
    out = run("prompt", prompt(99), env, t)
    assert set(out) == {"systemMessage"}
    assert out["systemMessage"].startswith("Turn ETA: Half of your similar turns took")
    assert "from 10 turns" in out["systemMessage"]


def test_failure_is_recorded_but_excluded(env):
    run("prompt", prompt(1), env, 0)
    assert run("stop-failure", {"session_id": "s1", "error_type": "overloaded"}, env, 500) is None
    h = store.read_history(env["CLAUDE_PLUGIN_DATA"])
    assert h == [{"t": 500, "dur": 500.0, "pb": "short", "cb": "small", "effort": "high",
                  "ok": False, "incident": False, "error": "overloaded"}]
    assert predict.learned_count(h) == 0


def test_interrupted_turn_is_not_recorded(env):
    run("prompt", prompt(1), env, 0)          # user hits Esc: no Stop
    run("prompt", prompt(2), env, 100)        # next prompt replaces the pending turn
    run("stop", {"session_id": "s1", "prompt_id": "p2"}, env, 130)
    assert [r["dur"] for r in store.read_history(env["CLAUDE_PLUGIN_DATA"])] == [30.0]


def test_stop_for_other_prompt_is_ignored(env):
    run("prompt", prompt(1), env, 0)
    run("stop", {"session_id": "s1", "prompt_id": "other"}, env, 10)
    assert store.read_history(env["CLAUDE_PLUGIN_DATA"]) == []


def test_history_holds_no_prompt_text(env):
    run("prompt", dict(prompt(1), prompt="SECRET customer text"), env, 0)
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 10)
    for root, _, files in os.walk(env["CLAUDE_PLUGIN_DATA"]):
        for f in files:
            assert "SECRET" not in open(os.path.join(root, f)).read()


def test_show_result(env):
    env = dict(env, CLAUDE_PLUGIN_OPTION_SHOW_RESULT="true")
    run("prompt", prompt(1), env, 0)
    out = run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 75)
    assert out == {"systemMessage": "Turn ETA: took 1m"}


def test_incident_turn_flagged_and_excluded(env, monkeypatch):
    env = dict(env, CLAUDE_PLUGIN_OPTION_CHECK_STATUS="true")
    monkeypatch.setattr(status, "_fetch", lambda url: {
        "components": [{"name": "Claude Code", "status": "major_outage"}], "incidents": []})
    out = run("prompt", prompt(1), env, 0)
    assert "Claude status reports \"Claude Code: major outage\"" in out["systemMessage"]
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 900)
    h = store.read_history(env["CLAUDE_PLUGIN_DATA"])
    assert h[0]["incident"] is True and predict.learned_count(h) == 0


def test_garbage_input_never_fails(env):
    out = io.StringIO()
    assert hook.main(["hook", "prompt"], io.StringIO("not json"), out, env) == 0
    assert out.getvalue() == ""


def test_old_session_markers_are_cleaned(env):
    d = env["CLAUDE_PLUGIN_DATA"]
    run("prompt", prompt(1, sid="old"), env, 0)
    old = os.path.join(d, "noted", "old")
    os.utime(old, (0, 0))
    run("prompt", prompt(2, sid="new"), env, 10 * 86400)
    assert not os.path.exists(old) and os.path.exists(os.path.join(d, "noted", "new"))
