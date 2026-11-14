# Run report

`npx openfleet report <name>` writes `projects/<name>/report.html`: one self-contained HTML file (no scripts, fonts or network requests) that shows what the run did. The coordinator runs it at the end of every run and links it from `summary.md`; you can also run it at any time, on a finished run or one still in progress.

It is built only from the project's files (`events.jsonl`, `state.json`, `spec.md`, `summary.md`) and git, with no agent involved:

- active time (pauses left out), children, agent spawns, agents at once, test runs, lines changed;
- the ask (the spec's `## Goal`), how the work was split, and a timeline of every child's phases;
- the plan gate (plans submitted, validated and sent back), agents running at once and spawns by role;
- lines changed and test runs per child;
- the **Coverage**, **Assumptions**, **Follow-ups** and **Lessons** sections of `summary.md`, when it has them (assumptions fall back to the `assumption` events);
- tokens by role and model, read from the host's transcripts on this machine (Claude Code: `~/.claude/projects/`; Copilot CLI: `~/.copilot/session-state/`). Each API message is counted once, even when sessions were forked. Without transcripts the section says "not available".
- the spending limits (`budget`) against usage, and every halt, resume and 80% warning; a halted run is marked in the header.
- the model configured for each role at launch next to the models the transcripts show it used, so you can check the `models` settings took effect.

Pauses are left out of every time in the report: stretches of more than 15 minutes (`--gap <min>`) with no events and no agent running, and the time between `npx openfleet pause` and `resume`. The timeline marks each with a dotted line. `--out <file>` writes elsewhere and `--open` opens the report in the browser.

Cost is shown only when `openfleet.json` has a `pricing` table. Prices are USD per million tokens, per model name as the host reports it (`.`/`-` and case differences are ignored). `input`, `output` and `cacheRead` are required; cache writes use `cacheWrite`, or `cacheWrite5m` and `cacheWrite1h` where the host tells them apart. OpenFleet ships no prices: copy them from your provider.

```json
{
  "version": "0.5.0",
  "maxParallel": 6,
  "pricing": {
    "claude-opus-5.5": { "input": 4, "output": 20, "cacheWrite5m": 5, "cacheWrite1h": 8, "cacheRead": 0.2 }
  }
}
```

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · **Run report** · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
