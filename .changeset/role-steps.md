---
"@openfleet-tools/cli": minor
---

Add step mode for implementers on small-context models: with `config set split.implementer steps`, the planner ends its plan with a `## Steps` list and an implementer job runs each step in a fresh session that sees only its step, the steps done before it and the files on disk. A failed step is retried once and then given to `models.<host>.fallback` (for example a cloud model behind a local implementer); questions wait for `agent reply`; a later job of the same plan skips finished steps. Steps are logged as `agent.step`, every step session counts toward tokens, and the report lists the fallback model.
