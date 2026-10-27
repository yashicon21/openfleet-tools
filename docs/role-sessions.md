# Role sessions — design (draft, 2026-10-27)

Status: agreed with the user on 2026-10-27 (per-role host, repo coordinators stay subagents, `agentMode` setting, all four safeguards).

## Why

Today the coordinator spawns planners, baselines, implementers, testers and extension agents as subagents inside its own host session. Every role shares one model server, one context budget and one process. Runs with local models showed that bounded roles (implementer, maybe tester) can run on a local model, but judgment roles (coordinator, planner) cannot: a local coordinator skipped the protocol (children without `kind`/`dependsOn`, spawns without claims, no plans, files written straight into `repos/<key>` on `main`, `summary.md` written early).

Goal: every child role runs as **its own headless session started by the OpenFleet CLI**, so roles are separated and each role can use its own model **and its own endpoint** (for example a Claude coordinator and planner, a local Ollama model for the implementer). No proxy, no MCP. An MCP layer may later wrap the same core.

## Shape

```
coordinator session (interactive, Claude or Copilot)
  └─ npx openfleet agent start <project> <child> --role implementer   → job id at once
        └─ job runner (detached node process, survives the coordinator)
              └─ claude -p --agent openfleet:openfleet-implementer …   (child's own env: endpoint, model)
  └─ npx openfleet agent wait <project>                              → first finished job + its report
  └─ npx openfleet agent reply <job> --message '…'                    → resumes the same child session
```

The coordinator keeps the judgment work (grill, plan validation, consistency check, questions, retries, guided attempt, finalize). The CLI owns process control, attribution, limits and safeguards.

## CLI

All under `npx openfleet agent`, run from the workspace root. Every command prints one JSON object.

| Command                                                                          | What it does                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent start <project> <child> --role <role> [--prompt-file f \| --message '…']` | Runs `claim` for the role (same `maxParallel`, halt and preflight rules). On `claimed`: writes a job record, logs `agent.spawned` (actor `<child>/<role>`, `jobId`, `sessionId`, `model`, `endpoint`), starts the runner and returns `{"result":"started","job":…}`. On `wait`/`stop` it returns the claim result unchanged and starts nothing. |
| `agent start <project> --ext <ext> --slot <slot> [--child <id>]`                 | Same for an extension slot entry (no claim; extensions do not count toward `maxParallel` today and keep not counting).                                                                                                                                                                                                                          |
| `agent status <project> [job]`                                                   | Jobs with `state` (`running`, `finished`, `failed`, `lost`, `stopped`), child, role, model, endpoint, pid, started/ended, turns.                                                                                                                                                                                                                |
| `agent wait <project> [--job <id>] [--timeout <s>]`                              | Blocks until a job of the project finishes a turn that the coordinator has not read yet, then prints it with its parsed `openfleet-report`. `{"result":"timeout"}` after `--timeout` (default 540 s, under every host's shell limit). `{"result":"idle"}` when nothing runs and nothing is unread.                                              |
| `agent result <job>`                                                             | The last turn's report and final text again (marks it read).                                                                                                                                                                                                                                                                                    |
| `agent reply <project> <job> --message '…' \| --message-file f`                  | Next turn in the **same** session (`--resume <sessionId>`): answers to questions, plan revisions, contract-change broadcasts, "give me the report block". On a running job the message is queued and sent right after the current turn ends, before the turn is reported. Logs `message.sent`.                                                  |
| `agent stop <job> [--reason …]`                                                  | SIGTERM, then SIGKILL after 10 s; logs `agent.stopped` with `stopped: true`.                                                                                                                                                                                                                                                                    |

Jobs live in `projects/<project>/jobs/<job>/` (git-ignored like `worktrees/`): `job.json` (record), `prompt.md`, `turns/<n>.json` (host output per turn), `stderr.log`. Job ids are short and sortable (`j-0007-impl-web`).

### Runner

`agent start` forks `node <cli> agent run <job>` detached (internal command). The runner:

1. Builds the prompt: the role line ("Implement the approved plan for child …"), the same `# OpenFleet assignment` block the `subagentStart` hook injects today (`childContext` / extension context, reused as is), then the coordinator's message (findings, guidance).
2. Spawns the host headless in the **workspace root** (agents already `cd <worktree> &&`), with `--add-dir` for the child's worktree, `contracts/`, `spec.md` and plans only, not every repo:
   - Claude Code: `claude -p <prompt> --plugin-dir core/claude --agent openfleet:openfleet-<role> --session-id <uuid> --output-format json --permission-mode acceptEdits --allowedTools Bash --model <model>`; next turns `--resume <uuid>`.
   - Copilot CLI: `copilot -p <prompt> --plugin-dir core --agent openfleet:openfleet-<role> --session-id <uuid> --allow-all-tools --model <model>`; next turns `--resume <uuid>`. The final text is read from the session's `events.jsonl`.
   - Env: `OPENFLEET_WORKSPACE`, `OPENFLEET_PROJECT`, plus `OPENFLEET_JOB`, `OPENFLEET_CHILD`, `OPENFLEET_ROLE` so hooks attribute every tool call without guessing; plus the endpoint env (below).
3. Per turn: stores the output, parses the `openfleet-report` block, logs `agent.turn` (and on the last turn `agent.stopped` with `response`, exactly like `subagentStop`), takes the worktree snapshot (`worktree.snapshot`) as `subagentStop` does today, and clears the child's `role` so `maxParallel` frees the slot.
4. No report block → one automatic `reply` ("End with the openfleet-report block."), then the turn counts as `failed`.
5. Host exits non-zero with no output (endpoint down, crash) → one automatic resume after 15 s; then `failed` with stderr tail in the report.

`maxParallel` counts busy children as today; a job holds its child's phase (`implementing`, …) from claim until its turn ends.

### Halts and crashes

- `pause` and budget halts: `claim` already returns `stop`; running jobs finish their turn. Budget is checked again after each turn from the job transcripts.
- `cancel`: the CLI stops every running job of the project itself (no longer relies on the coordinator).
- Coordinator crash: jobs keep running; their results wait unread. On `resume`, the coordinator runs `agent status` and `agent wait` and picks up where it was.
- Runner crash or machine restart: a `running` job whose runner pid is gone is `lost`. `resume` lists lost jobs; the coordinator restarts them with `agent start … --resume-job <job>`, which resumes the same host session (`--resume <sessionId>`) so implementers continue from the session and the worktree.

## Config

```jsonc
// openfleet.json
{
  "endpoints": {
    "ollama": { "baseUrl": "http://localhost:11434", "token": "ollama", "minContext": 65536 },
    "lab": { "baseUrl": "https://llm.internal.example/v1", "tokenEnv": "LAB_LLM_TOKEN" },
  },
  "models": {
    "claude": { "default": "sonnet", "implementer": "ollama:qwen3-coder:30b", "tester": "ollama:qwen3-coder:30b" },
  },
}
```

- `endpoints.<name>`: `baseUrl` (http/https), `token` (literal; allowed only for `localhost`/`127.0.0.1`/`[::1]` because `openfleet.json` is committed) or `tokenEnv` (name of an env var read at launch), optional `minContext` (default 32768).
- A model value `<endpoint>:<model>` uses that endpoint when `<endpoint>` names a configured endpoint; otherwise the whole value is a model name for the host's own provider (today's behaviour). Validation: unknown endpoint prefix that looks like one (`^[a-z][a-z0-9-]*:`) and is not a known model form → error listing the endpoints.
- `config set endpoints.<name>.<key> <value>`, `config set endpoints.<name> ''` removes it; removing an endpoint a model still uses is refused.
- Claude Code env for an endpoint role: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=` (empty, so a key in the shell does not win), `--model <model>`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` set to the same model, so background calls never leave the endpoint. Ollama speaks the Anthropic Messages API natively, so no proxy.
- No endpoint configured = today's behaviour, byte for byte.
- **Copilot and endpoints.** Copilot CLI has no documented way to point at another server, so endpoints are Claude Code only. Instead, a role may run on a different **host** than the coordinator: `roleHosts.<role> = "claude"` (`config set roleHosts.implementer claude`), so a Copilot coordinator can still run its implementer as a Claude Code session against Ollama. That role's model then comes from `models.<role host>.<role>`. `config` refuses an endpoint model under `models.copilot`, and a role host needs `agentMode: "session"`.

## Coordinator and repo-coordinator skills

- "Claim, then spawn with the Agent tool / background subagent" becomes one step: `npx openfleet agent start …`. `claim` stays as a helper (used inside `agent start`).
- Waiting: Claude Code runs `npx openfleet agent wait <project>` with the Bash tool **in the background**; its exit is a completion notification, so the "end your turn, act on the next notification" loop stays. Copilot runs `agent wait` in the foreground in a loop (`timeout` → just wait again), replacing `read_agent`.
- Questions: a child reports `status: "question"` and its session ends the turn. The coordinator decides as today and answers with `agent reply <job>`; that replaces `write_agent` / `SendMessage`. Plan revisions and contract broadcasts go the same way. Questions cannot interrupt a running child; a broadcast to a running job is queued (see `reply`).
- Results feed the next role exactly as now: plans saved to `plans/<child>.md` and passed by path in the assignment; tester findings passed as the next implementer's `--message-file`; extension outputs injected as "Upstream outputs" by the same code.
- Repo coordinators stay subagents of the top coordinator (a judgment role on the coordinator's model, needs the coordinator's session for escalations), and start their children with `agent start` too. Making them sessions as well is possible later; a `-p` session cannot use background notifications, so it would loop on `agent wait`.
- **Subagent mode as fallback.** Setting `agentMode: "session" | "subagent"`; new workspaces get `session`, existing workspaces keep `subagent` until the user sets it (no behaviour change on `update`), and `subagent` stays for at least 1.x. Skills carry both paths behind a mode marker rendered at `update`, like the host markers. An endpoint model requires `session` mode (validated).

## Preflight for endpoints

`npx openfleet preflight <project>` (and `agent start` before the first job of a role per run) for each endpoint a role uses:

1. Reachable: `GET <baseUrl>/api/version` (Ollama) or `GET <baseUrl>/v1/models`, 5 s timeout. Failure: "Start Ollama (`ollama serve`) or fix `endpoints.ollama.baseUrl`."
2. Model present: Ollama `/api/tags` (or `/v1/models`) lists it. Failure: "`ollama pull qwen3-coder:30b`."
3. Context length: Ollama `/api/show` `model_info.*.context_length` ≥ `minContext`; and, when the model is loaded, `/api/ps` `context_length` (the server's `num_ctx`) ≥ `minContext`. Ollama's default context is far below what an agent's system prompt needs, so a short loaded context fails with "Set `OLLAMA_CONTEXT_LENGTH=65536` for `ollama serve`." When the server does not report it, a warning, not a failure.
4. Tool calling: Ollama `/api/show` `capabilities` includes `tools`.

Results go into `state.preflight` like the git checks; a failed endpoint check blocks `claim` for roles using it only.

## Reporting

- Tokens: `readTokenUsage` also reads each job's session (role from `job.json`, not from `agentType`), for both hosts. Messages are already deduped by id.
- "Models by role" gains an **Endpoint** column (from `agent.spawned`); local endpoints are priced at 0 unless `pricing` has the model.
- Timeline: one lane per job, with turns (`agent.turn`) as segments; `lost`/`stopped` jobs marked.
- New events: `agent.turn`, `agent.lost`, `guard.refused` (below). `agent.spawned`/`agent.stopped` keep their payloads plus `jobId`, `sessionId`, `endpoint`, `model`.

## Safeguards (CLI-enforced, from the failed local runs)

1. **No early summary or finalize.** `state --patch` refuses project `status: finalizing|done` while any child is not final (escalations counted), unless the run is halted. A `PreToolUse` hook (both hosts) denies writing `projects/<p>/summary.md` under the same rule; `openfleet-finalize` writes it only after `finalizing`.
2. **Greenfield children need a kind.** In a greenfield project, adding a child without `kind` (or with an unknown one) is refused, listing the kinds; `dependsOn` edges are added from kinds as today.
3. **No spawn without a claim.** In session mode only `agent start` launches roles, so a spawn always has a claim target. In subagent mode a `PreToolUse` hook on `Agent` (Claude) / the task tool (Copilot) denies spawning an `openfleet-*` role agent without a fresh claim, and `subagentStart` without a claim logs `guard.refused` with actor `unknown/<role>` instead of a silent `agent.spawned`.
4. **No writes outside the worktree.** `PreToolUse` denies `Write`/`Edit` by a role session to paths outside its worktree (and the plan file for planners), and denies the coordinator writing under `repos/` or any worktree. Each denial logs `guard.refused`.

## PR stack

1. `role-endpoints`: `endpoints` config, `<endpoint>:<model>` parsing, `config set`, validation, endpoint preflight. No behaviour change without endpoints.
2. `role-jobs`: `agent start|status|wait|result|reply|stop`, runner, job records, events, hooks attribution via `OPENFLEET_JOB`, cancel stops jobs, lost-job resume. Fake host bins in tests.
3. `role-session-skills`: `agentMode`, coordinator / repo-coordinator / orchestrate / finalize text for session mode (both hosts, parity tests).
4. `role-guards`: the four safeguards (state checks + `PreToolUse` hooks).
5. `role-report`: tokens from job transcripts, endpoint column, job lanes; README (Models, Hosts, Limitations), CLI README, `docs/design.md`.

Each with a changeset, tests (`pnpm lint`, `format:check`, `typecheck`, `build`, `test`), and draft PR.
