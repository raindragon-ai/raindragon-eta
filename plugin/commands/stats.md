---
description: See how often RainDragon Forecast's range held on your own past turns
allowed-tools: Bash(python3:*)
---
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/raindragon_eta_hook.py" stats --data "${CLAUDE_PLUGIN_DATA}"`

Show the text above to the user exactly as printed, in a code block. Then add one plain sentence: "Inside the range" is how often a turn really finished inside the range Forecast showed for it, next to the share it aims for (half the time for the default range). Add nothing else.
