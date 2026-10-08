---
description: Check how often Turn ETA's band held on your own past turns
allowed-tools: Bash(python3:*)
---
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/turn_eta_hook.py" eval --data "${CLAUDE_PLUGIN_DATA}"`

Report the result above to the user in two plain sentences: the share of scored turns that landed inside the band (`coverage`, as a percentage, out of `scored`) next to the target share (50% for the default band, 80% while learning or with the 80 setting; `by_band` splits them), and how wide the band typically was (`median_ratio`: the top of the band divided by the bottom). If `scored` is 0, say there are not enough turns yet.
