"""RainDragon's reply-length model, over the network.

On each prompt the conversation's text goes to RainDragon's ETA API
(POST /v1/eta/predict), which answers how many tokens Claude's next reply will
probably be (TinyLM; the answer names the model version, so a retrained model
needs no plugin update). The text is used for the prediction and not kept;
RainDragon keeps only the numbers.
After the turn, the real length of that reply goes back (POST /v1/eta/outcome)
from a detached process, so a Stop hook never waits on the network.

Off when the "share_text" option is off or the kill switch is on: then nothing
is sent and the estimate is the local band alone. Every failure (offline, slow,
503) means "no prediction" and the local band is shown as before.

Text is built the way the model was trained: each message's text (string
content whole, list content's "text" parts) joined with spaces, oldest first.
Tool calls and tool results carry no "text" part and so add nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from typing import Optional

DEFAULT_URL = "https://inference.raindragon.ai"
TIMEOUT_SECONDS = 2.5          # inside the hook's 5 s budget, with room to spare
HEAD_CHARS, TAIL_CHARS = 48_000, 16_000   # the model reads the head; the tail is the new prompt
MAX_TRANSCRIPT_BYTES = 64_000_000         # bigger than this: skip, rather than slow the prompt


def base_url(env: dict) -> str:
    return (env.get("RAINDRAGON_ETA_API_URL") or DEFAULT_URL).rstrip("/")


def install_id(d: str) -> str:
    """Random id for this install, so an outcome can only update its own
    prediction. Not tied to any account."""
    path = os.path.join(d, "install_id")
    try:
        with open(path) as f:
            v = f.read().strip()
        if 8 <= len(v) <= 64:
            return v
    except OSError:
        pass
    v = str(uuid.uuid4())
    try:
        with open(path, "w") as f:
            f.write(v)
    except OSError:
        pass
    return v


def _text(content) -> str:
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return content if isinstance(content, str) else ""


def _real_prompt(entry: dict) -> bool:
    if entry.get("isMeta"):
        return False
    c = (entry.get("message") or {}).get("content")
    if isinstance(c, str):
        return bool(c.strip()) and not c.lstrip().startswith("<")
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return False
        return any(isinstance(x, dict) and x.get("type") == "text" for x in c)
    return False


def _entries(transcript_path: Optional[str]):
    if not transcript_path:
        return
    try:
        if os.path.getsize(transcript_path) > MAX_TRANSCRIPT_BYTES:
            return
    except OSError:
        return
    try:
        with open(transcript_path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict) and not d.get("isSidechain"):
                    yield d
    except OSError:
        return


def conversation(transcript_path: Optional[str], prompt: str) -> dict:
    """What the model needs about the conversation before this prompt's reply:
    text, size (chars/4 per message, as trained), tokens already seen by the
    previous call, the number of earlier calls, and the Claude model in use."""
    msgs, seen, model = [], {}, None
    for d in _entries(transcript_path):
        t = d.get("type")
        if t == "user":
            msgs.append(_text((d.get("message") or {}).get("content")))
        elif t == "assistant":
            m = d.get("message") or {}
            if m.get("model") in (None, "<synthetic>"):
                continue
            model = m.get("model")
            mid = m.get("id")
            if mid in seen:
                msgs[seen[mid]] += " " + _text(m.get("content"))
            else:
                seen[mid] = len(msgs)
                msgs.append(_text(m.get("content")))
    # Claude Code may or may not have written this prompt to the transcript yet.
    if prompt and msgs and msgs[-1].strip() == prompt.strip():
        msgs.pop()
    cached = sum(max(1, len(x) // 4) for x in msgs)
    if prompt:
        msgs.append(prompt)
    text = " ".join(msgs)
    if len(text) > HEAD_CHARS + TAIL_CHARS:
        text = text[:HEAD_CHARS] + " " + text[-TAIL_CHARS:]
    return {"text": text, "prompt_tokens": sum(max(1, len(x) // 4) for x in msgs),
            "cached_tokens": max(0, cached), "turn_idx": len(seen), "model": model}


def first_reply_tokens(transcript_path: Optional[str]) -> Optional[int]:
    """Output tokens of the first reply after the latest real prompt: the reply
    the prediction was for."""
    return first_reply(transcript_path)[0]


def first_reply(transcript_path: Optional[str]):
    """(output tokens, model) of the first reply after the latest real prompt."""
    out, after, first_id, model = None, False, None, None
    for d in _entries(transcript_path):
        t = d.get("type")
        if t == "user" and _real_prompt(d):
            after, first_id, out = True, None, None
        elif t == "assistant" and after:
            m = d.get("message") or {}
            if m.get("model") in (None, "<synthetic>"):
                continue
            if first_id is None:
                first_id, model = m.get("id"), m.get("model")
            if m.get("id") == first_id:
                n = (m.get("usage") or {}).get("output_tokens")
                if isinstance(n, int):
                    out = max(out or 0, n)
    return out, model


def last_model(d: str) -> Optional[str]:
    """The Claude model of this install's latest reply: the first prompt of a
    conversation has no reply yet to read it from."""
    try:
        with open(os.path.join(d, "last_model")) as f:
            v = f.read().strip()
        return v if 0 < len(v) <= 100 else None
    except OSError:
        return None


def _remember_model(d: str, model: Optional[str]) -> None:
    if not model or model == "<synthetic>":
        return
    try:
        with open(os.path.join(d, "last_model"), "w") as f:
            f.write(model)
    except OSError:
        pass


def _post(url: str, body: dict, timeout: float) -> Optional[dict]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "raindragon-eta"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def predict(env: dict, d: str, conv: dict, version: str, post=None) -> Optional[dict]:
    """{"prediction_id", "output_tokens", "model_version"} or None on any failure."""
    if not conv.get("text", "").strip():
        return None
    if conv.get("model"):
        _remember_model(d, conv["model"])
    body = {"install_id": install_id(d), "client": "plugin", "client_version": version,
            "model": conv.get("model") or last_model(d) or "claude", "text": conv["text"],
            "prompt_tokens": conv["prompt_tokens"], "cached_tokens": conv["cached_tokens"],
            "turn_idx": conv["turn_idx"]}
    try:
        r = (post or _post)(base_url(env) + "/v1/eta/predict", body, TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001  offline, slow, 4xx/5xx: no prediction
        return None
    if not isinstance(r, dict) or not isinstance(r.get("output_tokens"), int):
        return None
    return r


# --- outcomes: queued to a file, sent by a detached process -------------------

def queue_outcome(d: str, outcome: dict, spawn=None) -> None:
    folder = os.path.join(d, "outbox")
    try:
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, outcome["prediction_id"] + ".json")
        with open(path, "w") as f:
            json.dump(outcome, f)
    except (OSError, KeyError):
        return
    (spawn or _spawn_flush)(d)


def _spawn_flush(d: str) -> None:
    hook = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "raindragon_eta_hook.py")
    try:
        subprocess.Popen([sys.executable, hook, "send-outcomes", "--data", d],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    except OSError:
        pass


#: The Stop hook can run before Claude Code has written the reply's usage to the
#: transcript, so the outcome sender reads it, waiting up to this long.
REPLY_WAIT_SECONDS = 10.0


def _fill_reply(d: str, body: dict, wait: float, sleep) -> dict:
    """The outcome to send: output_tokens read from the local transcript (whose
    path is never sent), the model remembered for the next first prompt."""
    path = body.pop("transcript_path", None)
    if path and body.get("output_tokens") is None and not body.get("failed"):
        waited = 0.0
        while True:
            tokens, model = first_reply(path)
            if tokens is not None or waited >= wait:
                break
            sleep(0.5)
            waited += 0.5
        body["output_tokens"] = tokens
        _remember_model(d, model)
    return body


def flush_outcomes(env: dict, d: str, post=None, max_age: float = 86400, now=None,
                   wait: float = REPLY_WAIT_SECONDS, sleep=None) -> int:
    """Send queued outcomes; drop each once sent, rejected, or a day old."""
    import time
    now = time.time() if now is None else now
    sleep = sleep or time.sleep
    folder = os.path.join(d, "outbox")
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".json"))
    except OSError:
        return 0
    sent = 0
    for name in names[:50]:
        path = os.path.join(folder, name)
        try:
            with open(path) as f:
                body = _fill_reply(d, json.load(f), wait, sleep)
            (post or _post)(base_url(env) + "/v1/eta/outcome", body, 10)
            sent += 1
            os.remove(path)
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:      # unknown or bad: retrying will not help
                _remove(path)
        except Exception:  # noqa: BLE001  try again next time, until max_age
            try:
                if now - os.path.getmtime(path) > max_age:
                    _remove(path)
            except OSError:
                pass
    return sent


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
