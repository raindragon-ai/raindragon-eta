---
description: Show RainDragon ETA's version, settings and turn counts (no content) for a bug report
allowed-tools: Bash(python3:*)
---
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/raindragon_eta_hook.py" doctor --data "${CLAUDE_PLUGIN_DATA}"`

Show the JSON above to the user exactly as printed, in a code block, and add nothing else. It holds no prompt text, file names or session ids, so it is safe to paste into a bug report.
