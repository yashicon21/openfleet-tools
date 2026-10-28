---
"@openfleet-tools/cli": minor
---

`openfleet report` leaves pauses out of every time it shows. Pauses are stretches over `--gap` minutes with no events and no agent running, plus the time between `pause` and `resume`. They take no space on the timeline (a dotted line marks each), phase and plan durations count active time only, and the wall-clock total is gone. A quiet stretch while an agent works is no longer counted as a pause.
