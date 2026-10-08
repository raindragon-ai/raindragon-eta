"""Local state. Nothing here leaves the machine.

history.jsonl  one line per finished turn: duration and coarse size buckets.
               No prompt text, no file names, no session ids.
pending/<sid>  the turn currently running in a session (start time + the
               estimate we showed), removed when the turn ends.
noted/<sid>    marker that we already told this session we are still learning.
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

MAX_HISTORY_BYTES = 512_000
KEEP_LINES = 1000


def data_dir(env: dict) -> str:
    d = env.get("CLAUDE_PLUGIN_DATA") or os.path.join(os.path.expanduser("~"), ".turn-eta")
    os.makedirs(os.path.join(d, "pending"), exist_ok=True)
    os.makedirs(os.path.join(d, "noted"), exist_ok=True)
    return d


def _safe(session_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "nosession")[:128]


def read_history(d: str) -> list:
    out = []
    try:
        with open(os.path.join(d, "history.jsonl")) as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def append_history(d: str, record: dict) -> None:
    path = os.path.join(d, "history.jsonl")
    with open(path, "a") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")
    try:
        if os.path.getsize(path) > MAX_HISTORY_BYTES:
            with open(path) as f:
                lines = f.readlines()[-KEEP_LINES:]
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                f.writelines(lines)
            os.replace(tmp, path)
    except OSError:
        pass


def write_pending(d: str, session_id: str, pending: dict) -> None:
    path = os.path.join(d, "pending", _safe(session_id))
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(pending, f)
    os.replace(tmp, path)


def pop_pending(d: str, session_id: str) -> Optional[dict]:
    path = os.path.join(d, "pending", _safe(session_id))
    try:
        with open(path) as f:
            p = json.load(f)
    except (OSError, ValueError):
        return None
    try:
        os.remove(path)
    except OSError:
        pass
    return p


def cleanup(d: str, now: float, max_age: float = 2 * 86400) -> None:
    """Drop per-session markers older than max_age so they don't pile up."""
    for sub in ("pending", "noted"):
        folder = os.path.join(d, sub)
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            path = os.path.join(folder, name)
            try:
                if now - os.path.getmtime(path) > max_age:
                    os.remove(path)
            except OSError:
                pass


def mark_noted(d: str, session_id: str) -> bool:
    """True the first time for a session, False after."""
    path = os.path.join(d, "noted", _safe(session_id))
    if os.path.exists(path):
        return False
    try:
        open(path, "w").close()
    except OSError:
        pass
    return True


def write_json(d: str, name: str, obj: dict) -> None:
    path = os.path.join(d, name)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except OSError:
        pass


def read_json(d: str, name: str) -> Optional[dict]:
    try:
        with open(os.path.join(d, name)) as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


POINTER = os.path.join(".turn-eta", "data_dir")


def write_pointer(env: dict, d: str) -> None:
    """Leave the data dir's path at ~/.turn-eta/data_dir for the live
    status-line mod (plugin/live/live.ts): a mod is told its plugin's root but
    not its data dir, which Claude Code names after the install id. Written
    only when it changed."""
    home = env.get("HOME") or os.path.expanduser("~")
    path = os.path.join(home, POINTER)
    try:
        with open(path) as f:
            if f.read().strip() == d:
                return
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(d)
        os.replace(tmp, path)
    except OSError:
        pass
