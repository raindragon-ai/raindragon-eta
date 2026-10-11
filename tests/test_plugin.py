import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin", "scripts"))

import raindragon_eta_hook as hook  # noqa: E402
from raindragon_eta import api, fmt, predict, status, store  # noqa: E402


PRIOR = {"groups": {
    "all": {"n": 500, "10": 5.0, "25": 9.0, "75": 80.0, "90": 240.0},
    "short": {"n": 400, "10": 4.0, "25": 8.0, "75": 70.0, "90": 200.0},
    "short/small": {"n": 60, "10": 5.0, "25": 10.0, "75": 17.0, "90": 25.0},
}}


@pytest.fixture(autouse=True)
def fixed_prior(monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", PRIOR)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """No test reaches RainDragon's API; the API tests pass their own `post`."""
    def offline(*a, **k):
        raise OSError("offline in tests")
    monkeypatch.setattr(api, "_post", offline)
    monkeypatch.setattr(api, "_spawn_flush", lambda d: None)


def rec(dur, ok=True, incident=False, pb="short", cb="small", effort="high"):
    return {"t": 0, "dur": dur, "pb": pb, "cb": cb, "effort": effort, "ok": ok, "incident": incident}


# ---------- predict ----------

def test_typical_band_before_min_ready():
    hist = [rec(30)] * (predict.MIN_READY - 1)
    b = predict.predict(hist, 10, 0, "high", "50")
    # the built-in wide band for this size, whatever the setting
    assert b.typical and b.learning and b.coverage == "80"
    assert (b.low, b.high, b.group) == (5.0, 25.0, "typical prompt+context")


def test_typical_band_narrows_like_the_users_own():
    b = predict.predict([], 10, 500_000, None)          # short/medium: not shipped
    assert (b.low, b.high, b.group) == (4.0, 200.0, "typical prompt")
    b = predict.predict([], 5000, 0, None)              # long: not shipped
    assert (b.low, b.high, b.group) == (5.0, 240.0, "typical")


def test_no_band_without_a_built_in_table(monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", {})
    assert predict.predict([rec(30)] * 3, 10, 0, "high") is None


def test_shipped_built_in_table_is_sane(monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", None)
    groups = predict.load_prior()["groups"]
    assert "all" in groups
    for g in groups.values():
        assert g["n"] >= predict.PRIOR_MIN
        assert 0 < g["10"] <= g["25"] <= g["75"] <= g["90"]


def test_failed_and_incident_turns_never_count():
    hist = [rec(30)] * (predict.MIN_READY - 1) + [rec(900, ok=False)] * 20 + [rec(900, incident=True)] * 20
    assert predict.predict(hist, 10, 0, "high").typical
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
    s["incidents"].append({"name": "Elevated errors on Claude Opus", "status": "identified", "impact": "major",
                           "components": [{"name": "Claude API (api.anthropic.com)"}]})
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) == "Elevated errors on Claude Opus"


def test_degraded_component_is_not_an_incident():
    # measured: degraded/minor periods did not slow turns (0.91x), so no warning
    s = json.loads(json.dumps(LIVE_SHAPE))
    s["components"][3]["status"] = "degraded_performance"
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) is None
    s["components"][3]["status"] = "partial_outage"
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) is None


def test_major_outage_component_is_reported():
    s = json.loads(json.dumps(LIVE_SHAPE))
    s["components"][3]["status"] = "major_outage"
    assert status.incident_from_summary(s, status.CLAUDE_CODE_COMPONENTS) == "Claude Code: major outage"


@pytest.mark.parametrize("impact,reported", [("none", False), ("minor", False), (None, False),
                                             ("major", True), ("critical", True)])
def test_only_major_incidents_count(impact, reported):
    inc = {"name": "Slow Claude Code", "status": "investigating",
           "components": [{"name": "Claude Code"}]}
    if impact is not None:
        inc["impact"] = impact
    got = status.incident_from_summary({"components": [], "incidents": [inc]},
                                       status.CLAUDE_CODE_COMPONENTS)
    assert (got == "Slow Claude Code") is reported


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
    return {"CLAUDE_PLUGIN_DATA": str(tmp_path), "CLAUDE_PLUGIN_OPTION_CHECK_STATUS": "false",
            "CLAUDE_PLUGIN_OPTION_SHARE_TEXT": "false", "HOME": str(tmp_path / "home")}


def prompt(i, sid="s1"):
    return {"session_id": sid, "prompt_id": "p%d" % i, "prompt": "fix the test", "effort": {"level": "high"},
            "transcript_path": "/nonexistent"}


def test_first_run_shows_the_typical_band(env):
    out = run("prompt", prompt(1), env, 1000)
    assert out["systemMessage"] == ("RainDragon ETA: 8 in 10 typical Claude Code turns like this "
                                    "took 5s–25s (yours from turn 10, 0 so far)")
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 1030)
    out = run("prompt", prompt(2), env, 2000)  # every turn, unlike the learning note
    assert "(yours from turn 10, 1 so far)" in out["systemMessage"]


def test_without_a_table_first_run_says_learning_once(env, monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", {})
    out = run("prompt", prompt(1), env, 1000)
    assert out["systemMessage"].startswith("RainDragon ETA: learning your pace")
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
    # under CONFIDENT turns: the wide band, labelled, whatever the setting
    assert out["systemMessage"].startswith("RainDragon ETA: 8 in 10 of your similar turns took")
    assert "from 10 turns, still learning" in out["systemMessage"]


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
    assert out == {"systemMessage": "RainDragon ETA: took 1m (8 in 10 of typical turns took 5s–25s)"}


def test_show_result_without_any_band(env, monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", {})
    env = dict(env, CLAUDE_PLUGIN_OPTION_SHOW_RESULT="true")
    run("prompt", prompt(1), env, 0)
    out = run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 75)
    assert out == {"systemMessage": "RainDragon ETA: took 1m"}


@pytest.mark.parametrize("cov,share", [("50", "half"), ("80", "8 in 10")])
def test_show_result_names_the_chosen_band(env, cov, share):
    env = dict(env, CLAUDE_PLUGIN_OPTION_SHOW_RESULT="true", CLAUDE_PLUGIN_OPTION_BAND=cov)
    t = 0
    for i in range(predict.CONFIDENT):
        run("prompt", prompt(i), env, t)
        run("stop", {"session_id": "s1", "prompt_id": "p%d" % i}, env, t + 40 + i)
        t += 1000
    run("prompt", prompt(99), env, t)
    out = run("stop", {"session_id": "s1", "prompt_id": "p99"}, env, t + 45)
    assert out["systemMessage"].startswith("RainDragon ETA: took 45s (%s of similar turns took " % share)


def test_incident_turn_flagged_and_excluded(env, monkeypatch):
    env = dict(env, CLAUDE_PLUGIN_OPTION_CHECK_STATUS="true")
    monkeypatch.setattr(status, "_fetch", lambda url: {
        "components": [{"name": "Claude Code", "status": "major_outage"}], "incidents": []})
    # the background refresh, run inline here: the FIRST prompt only starts it
    monkeypatch.setattr(status, "_spawn_refresh", lambda d: status.refresh(d, now=0))
    out = run("prompt", prompt(1), env, 0)
    assert "Claude status" not in out["systemMessage"]
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 30)
    out = run("prompt", prompt(2), env, 40)
    assert "Claude status reports \"Claude Code: major outage\"" in out["systemMessage"]
    run("stop", {"session_id": "s1", "prompt_id": "p2"}, env, 900)
    h = store.read_history(env["CLAUDE_PLUGIN_DATA"])
    assert [r["incident"] for r in h] == [False, True]
    assert predict.learned_count(h) == 1


def test_garbage_input_never_fails(env):
    out = io.StringIO()
    assert hook.main(["hook", "prompt"], io.StringIO("not json"), out, env) == 0
    assert out.getvalue() == ""


def test_old_session_markers_are_cleaned(env, monkeypatch):
    monkeypatch.setattr(predict, "_prior_cache", {})  # the "learning" note writes the marker
    d = env["CLAUDE_PLUGIN_DATA"]
    run("prompt", prompt(1, sid="old"), env, 0)
    old = os.path.join(d, "noted", "old")
    os.utime(old, (0, 0))
    run("prompt", prompt(2, sid="new"), env, 10 * 86400)
    assert not os.path.exists(old) and os.path.exists(os.path.join(d, "noted", "new"))


# ---------- first run, evaluation, kill switch, doctor (M1) ----------

def _turns(env, n, t0=0, dur=lambda i: 40 + i):
    t = t0
    for i in range(n):
        run("prompt", prompt(i), env, t)
        run("stop", {"session_id": "s1", "prompt_id": "p%d" % i}, env, t + dur(i))
        t += 1000
    return t


def test_learning_band_is_wide_then_narrows_at_confident(env):
    h = [rec(10 + i) for i in range(predict.CONFIDENT - 1)]
    b = predict.predict(h, 50, 1000, "high", "50")
    assert b.learning and b.coverage == "80"
    b = predict.predict(h + [rec(30)], 50, 1000, "high", "50")
    assert not b.learning and b.coverage == "50"


def test_ready_band_line_has_no_learning_label(env):
    t = _turns(env, predict.CONFIDENT)
    out = run("prompt", prompt(99), env, t)
    assert out["systemMessage"].startswith("RainDragon ETA: Half of your similar turns took")
    assert "still learning" not in out["systemMessage"]


def test_evaluate_scores_only_from_the_past():
    h = [rec(10 + (i % 7)) for i in range(60)]
    e = predict.evaluate(h, "50")
    assert e["scored"] == 60
    assert 0 <= e["coverage"] <= 1 and e["median_ratio"] >= 1
    assert set(e["by_band"]) == {"typical", "80", "50"}
    assert e["by_band"]["typical"]["scored"] == predict.MIN_READY
    assert e["by_band"]["80"]["scored"] == predict.CONFIDENT - predict.MIN_READY


def test_evaluate_ignores_failed_and_incident_turns():
    h = [rec(20) for _ in range(40)] + [rec(999, ok=False), rec(999, incident=True)]
    assert predict.evaluate(h)["scored"] == 40


def test_evaluate_on_empty_history():
    assert predict.evaluate([])["coverage"] is None


@pytest.mark.parametrize("off", [{"CLAUDE_PLUGIN_OPTION_ENABLED": "false"}, {"RAINDRAGON_ETA_OFF": "1"}])
def test_kill_switch_shows_and_records_nothing(env, off):
    env = dict(env, **off)
    assert run("prompt", prompt(1), env, 0) is None
    assert run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 10) is None
    assert store.read_history(env["CLAUDE_PLUGIN_DATA"]) == []


def test_doctor_reports_counts_never_content(env):
    run("prompt", dict(prompt(1), prompt="SECRET customer text"), env, 0)
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 10)
    out = io.StringIO()
    assert hook.main(["hook", "doctor"], io.StringIO(""), out, env, now=20) == 0
    d = json.loads(out.getvalue())
    assert d["version"] == hook.__version__ and d["turns_recorded"] == 1
    assert d["phase"] == "learning (typical band)"
    assert d["settings"]["enabled"] is True and d["settings"]["band"] == "50"
    assert "SECRET" not in out.getvalue() and "s1" not in out.getvalue()
    assert d["made_by"] == "RainDragon AI"
    assert d["homepage"].startswith("https://inference.raindragon.ai/?utm_source=raindragon-eta")


def test_estimate_never_carries_the_maker_link(env):
    _turns(env, 40)
    for i in range(3):
        msg = run("prompt", prompt(100 + i), env, 10**6 + i) or {}
        text = json.dumps(msg)
        assert "raindragon.ai" not in text and "Made by" not in text


def test_eval_command_prints_json(env):
    _turns(env, 15)
    out = io.StringIO()
    assert hook.main(["hook", "eval"], io.StringIO(""), out, env, now=10**6) == 0
    assert json.loads(out.getvalue())["scored"] == 15


def test_version_matches_plugin_manifest():
    import pathlib
    root = pathlib.Path(hook.__file__).resolve().parent.parent
    manifest = json.loads((root / ".claude-plugin" / "plugin.json").read_text())
    assert manifest["version"] == hook.__version__


def test_commands_pass_the_data_dir(env, tmp_path):
    other = tmp_path / "elsewhere"
    run("prompt", prompt(1), dict(env, CLAUDE_PLUGIN_DATA=str(other)), 0)
    out = io.StringIO()
    hook.main(["hook", "doctor", "--data", str(other)], io.StringIO(""), out, {}, now=5)
    d = json.loads(out.getvalue())
    assert d["data_dir"] == str(other) and d["turns_in_progress"] == 1


def test_prompt_leaves_pointer_and_live_fields_for_the_mod(env):
    run("prompt", prompt(1), env, 0)
    ptr = os.path.join(env["HOME"], ".raindragon-eta", "data_dir")
    assert open(ptr).read() == env["CLAUDE_PLUGIN_DATA"]
    p = json.load(open(os.path.join(env["CLAUDE_PLUGIN_DATA"], "pending", "s1")))
    assert p["start"] == 0 and p["learned"] == 0 and p["typical"] is True
    assert (p["low"], p["high"], p["cov"]) == (5.0, 25.0, "80")


# ---------- the prompt hook never waits on the network ----------

def test_no_cache_starts_one_background_refresh_and_answers_none(tmp_path):
    spawned = []
    d = str(tmp_path)
    assert status.current_incident(d, now=1000, spawn=spawned.append) is None
    assert status.current_incident(d, now=1010, spawn=spawned.append) is None
    assert spawned == [d]                       # throttled: one per 30 s
    status.current_incident(d, now=1040, spawn=spawned.append)
    assert len(spawned) == 2


def test_stale_cache_is_used_while_it_refreshes(tmp_path):
    d = str(tmp_path)
    down = {"components": [{"name": "Claude Code", "status": "major_outage"}], "incidents": []}
    assert status.refresh(d, now=1000, fetch=lambda url: down)
    spawned = []
    assert status.current_incident(d, now=1300, spawn=spawned.append) == "Claude Code: major outage"
    assert spawned == [d]                       # older than 2 min: refresh started
    assert status.current_incident(d, now=1000 + status.STALE_OK_SECONDS, spawn=spawned.append) is None


def test_prompt_hook_is_fast_even_when_the_network_hangs(env, monkeypatch):
    import time as _time
    env = dict(env, CLAUDE_PLUGIN_OPTION_CHECK_STATUS="true")
    monkeypatch.setattr(status, "_fetch", lambda url: _time.sleep(30))
    monkeypatch.setattr(status, "_spawn_refresh", lambda d: None)
    t = _time.time()
    out = hook.main(["hook", "prompt"], io.StringIO(json.dumps(prompt(1))), io.StringIO(), env)
    assert out == 0 and _time.time() - t < 1.0


def test_refresh_status_command_writes_the_cache(env, monkeypatch):
    monkeypatch.setattr(status, "_fetch", lambda url: {"components": [], "incidents": []})
    hook.main(["hook", "refresh-status", "--data", env["CLAUDE_PLUGIN_DATA"]], io.StringIO(""),
              io.StringIO(), {}, now=50)
    assert os.path.exists(os.path.join(env["CLAUDE_PLUGIN_DATA"], "status_cache.json"))


@pytest.mark.parametrize("cmd", ["/raindragon-eta:doctor", "  /raindragon-eta:eval"])
def test_own_commands_are_not_timed(env, cmd):
    _turns(env, predict.MIN_READY)
    before = len(store.read_history(env["CLAUDE_PLUGIN_DATA"]))
    assert run("prompt", dict(prompt(50), prompt=cmd), env, 10**6) is None
    run("stop", {"session_id": "s1", "prompt_id": "p50"}, env, 10**6 + 2)
    assert len(store.read_history(env["CLAUDE_PLUGIN_DATA"])) == before
    assert not os.listdir(os.path.join(env["CLAUDE_PLUGIN_DATA"], "pending"))


def test_other_slash_commands_are_still_timed(env):
    run("prompt", dict(prompt(1), prompt="/review this file"), env, 0)
    run("stop", {"session_id": "s1", "prompt_id": "p1"}, env, 20)
    assert len(store.read_history(env["CLAUDE_PLUGIN_DATA"])) == 1


# ---------- RainDragon API (api.py) ----------

def _transcript(path, entries):
    with open(path, "w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    return str(path)


def _user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def _asst(mid, text, out=50, model="claude-opus-5-5"):
    return {"type": "assistant", "message": {"id": mid, "model": model, "role": "assistant",
            "content": [{"type": "text", "text": text}], "usage": {"output_tokens": out}}}


def _tool_result():
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}


def test_conversation_text_is_built_like_training(tmp_path):
    t = _transcript(tmp_path / "t.jsonl", [
        _user("first question"), _asst("m1", "an answer"), _asst("m1", "more of it"),
        _tool_result(), _asst("m2", "done", model="claude-sonnet-5"),
        {"type": "assistant", "isSidechain": True, "message": {"id": "x", "model": "m",
         "content": [{"type": "text", "text": "SIDE"}]}},
    ])
    c = api.conversation(t, "second question")
    assert c["text"] == "first question an answer more of it  done second question"
    assert c["model"] == "claude-sonnet-5" and c["turn_idx"] == 2
    assert c["cached_tokens"] == 3 + 5 + 1 + 1          # chars/4 per message before the prompt
    assert c["prompt_tokens"] == c["cached_tokens"] + len("second question") // 4
    # the prompt already in the transcript is not counted twice
    t2 = _transcript(tmp_path / "t2.jsonl", [_user("hi there"), _asst("m1", "yo"), _user("again")])
    assert api.conversation(t2, "again")["text"] == "hi there yo again"


def test_long_text_keeps_head_and_tail(tmp_path):
    t = _transcript(tmp_path / "t.jsonl", [_user("H" * 100_000)])
    c = api.conversation(t, "NEW PROMPT")
    assert len(c["text"]) == api.HEAD_CHARS + 1 + api.TAIL_CHARS
    assert c["text"].startswith("HHH") and c["text"].endswith("NEW PROMPT")


def test_first_reply_tokens_is_the_reply_the_prediction_was_for(tmp_path):
    t = _transcript(tmp_path / "t.jsonl", [
        _user("old"), _asst("m0", "x", out=999),
        _user("now"), _asst("m1", "a", out=40), _asst("m1", "b", out=120), _tool_result(),
        _asst("m2", "c", out=700)])
    assert api.first_reply_tokens(t) == 120
    assert api.first_reply_tokens(str(tmp_path / "missing")) is None


def test_install_id_is_stable(tmp_path):
    a = api.install_id(str(tmp_path))
    assert a == api.install_id(str(tmp_path)) and 8 <= len(a) <= 64


@pytest.fixture
def share_env(env):
    return dict(env, CLAUDE_PLUGIN_OPTION_SHARE_TEXT="true")


def _fake_post(calls, tokens=900):
    def post(url, body, timeout):
        calls.append((url, body, timeout))
        if url.endswith("/v1/eta/predict"):
            return {"prediction_id": "etp_" + "a" * 32, "output_tokens": tokens,
                    "model_version": "tinylm-test"}
        return {}
    return post


def test_prompt_asks_the_api_and_shows_the_reply_length(share_env, tmp_path):
    calls = []
    t = _transcript(tmp_path / "t.jsonl", [_user("hello"), _asst("m1", "hi")])
    inp = dict(prompt(1), transcript_path=t)
    msg = hook.on_prompt(inp, share_env, 1000, post=_fake_post(calls))
    url, body, timeout = calls[0]
    assert url == "https://inference.raindragon.ai/v1/eta/predict" and timeout <= 3
    assert body["text"] == "hello hi fix the test" and body["model"] == "claude-opus-5-5"
    assert body["client"] == "plugin" and body["client_version"] == hook.__version__
    assert hook.SHARING_NOTICE in msg                     # first time only
    assert "Claude's reply: ~900 tokens." in msg
    msg2 = hook.on_prompt(dict(inp, prompt_id="p2"), share_env, 1001, post=_fake_post([]))
    assert hook.SHARING_NOTICE not in msg2


def test_api_url_can_point_at_staging(share_env):
    calls = []
    hook.on_prompt(prompt(1), dict(share_env, RAINDRAGON_ETA_API_URL="https://staging.example/"),
                   1000, post=_fake_post(calls))
    assert calls[0][0] == "https://staging.example/v1/eta/predict"


def test_sharing_off_sends_nothing(env):
    calls = []
    msg = hook.on_prompt(prompt(1), env, 1000, post=_fake_post(calls))
    assert calls == [] and hook.SHARING_NOTICE not in msg and "tokens" not in msg


def test_api_failure_falls_back_to_the_local_band(share_env):
    def down(url, body, timeout):
        raise OSError("timeout")
    msg = hook.on_prompt(prompt(1), share_env, 1000, post=down)
    assert "8 in 10 typical Claude Code turns like this took 5s–25s" in msg
    assert "tokens" not in msg.replace(hook.SHARING_NOTICE, "")


def test_stop_records_the_prediction_and_queues_the_outcome(share_env, tmp_path):
    t = _transcript(tmp_path / "t.jsonl", [_user("fix the test"), _asst("m1", "ok", out=321)])
    hook.on_prompt(dict(prompt(1), transcript_path=t), share_env, 1000, post=_fake_post([]))
    spawned = []
    hook.on_stop({"session_id": "s1", "prompt_id": "p1", "transcript_path": t}, share_env, 1042,
                 ok=True, spawn=spawned.append)
    d = share_env["CLAUDE_PLUGIN_DATA"]
    assert store.read_history(d)[-1]["pred"] == 900
    queued = json.load(open(os.path.join(d, "outbox", "etp_" + "a" * 32 + ".json")))
    assert queued == {"prediction_id": "etp_" + "a" * 32, "install_id": api.install_id(d),
                      "output_tokens": 321, "duration_ms": 42000, "failed": False}
    assert spawned == [d]
    calls = []
    assert api.flush_outcomes(share_env, d, post=_fake_post(calls)) == 1
    assert calls[0][0].endswith("/v1/eta/outcome") and calls[0][1] == queued
    assert not os.listdir(os.path.join(d, "outbox"))


def test_outcomes_retry_then_expire(share_env, tmp_path):
    d = share_env["CLAUDE_PLUGIN_DATA"]
    api.queue_outcome(d, {"prediction_id": "etp_" + "b" * 32}, spawn=lambda d: None)

    def down(url, body, timeout):
        raise OSError("offline")
    assert api.flush_outcomes(share_env, d, post=down) == 0
    assert len(os.listdir(os.path.join(d, "outbox"))) == 1      # kept for later
    api.flush_outcomes(share_env, d, post=down, now=10 ** 12)    # a day later: dropped
    assert not os.listdir(os.path.join(d, "outbox"))


def test_predicted_band_scales_the_users_pace():
    hist = [dict(rec(d), pred=100) for d in range(1, 41)]     # 0.01..0.40 s per token
    b = predict.predicted_band(hist, 1000, "50")
    assert b.group == "predicted length" and b.n == 40 and not b.learning
    assert (round(b.low, 1), round(b.high, 1)) == (107.5, 302.5)
    assert predict.predicted_band(hist[:predict.MIN_READY - 1], 1000) is None
    assert predict.predicted_band(hist[:20], 1000, "50").coverage == "80"   # still learning


def test_eval_compares_predicted_and_bucket_bands():
    hist = [dict(rec(10 + (i % 7)), pred=100) for i in range(60)]
    out = predict.evaluate_predicted(hist, "50")
    assert out["predicted"]["scored"] == out["buckets"]["scored"] == 60 - predict.MIN_READY
    assert 0 <= out["predicted"]["coverage"] <= 1
