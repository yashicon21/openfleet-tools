# Limitations and troubleshooting

## Limitations and known issues

- **Hosts and models:** GitHub Copilot CLI and Claude Code. Other model servers (for example a local Ollama) work only for role sessions on Claude Code, through an Anthropic-compatible endpoint; the coordinator and repo coordinators always use the host's own provider. Local models are best kept to bounded roles (implementer, tester): weaker models skip the coordination protocol. Models per role are workspace-wide and apply from the next `new` or `resume`; whether Copilot honours a model for a subagent depends on Copilot.
- **Guards** check file tools and spawns, not shell commands: an agent can still write files with a shell command.
- **Platforms:** macOS and Linux. Windows only through WSL2.
- **Pull requests:** GitHub only (`gh`). Stacked PRs need the `gh stack` extension and stay within one repo. No GitLab or Bitbucket.
- **Spending limits** are checked when an agent is about to start, so agents already running can take a run past a limit. There is no per-child limit, and usage is only known when the host transcripts are on the machine that runs OpenFleet.
- **`pause` and `cancel`** stop new agents at once; agents already running finish their current step first.
- **Hands-off after the grill:** questions that come up during the run are decided by the coordinator and logged as assumptions, not asked. Review them in `summary.md` and the report.
- **Greenfield** runs build an MVP slice under fixed caps, need network access for the generators, and need Docker for the end-to-end flow.
- **Copilot agent prompts** have a size limit; many role-augmenting extensions on one role can be truncated (OpenFleet warns when that happens).

## Troubleshooting

### Sandbox

OpenFleet creates a git worktree per child, so git must be able to write inside each repo's `.git` directory (ref locks, `.git/worktrees/`). A sandbox can block these writes with `EPERM` ("Operation not permitted"), for example `fatal: cannot lock ref … Operation not permitted`. Copilot's `--add-dir` only affects path verification; it does not lift a sandbox.

- **Before launching**, `new`, `resume` and extension commands probe these writes from the OpenFleet process itself. If they are denied there, the sandbox is inherited from the shell that started OpenFleet and nothing inside Copilot can fix it, so OpenFleet stops before starting the session. If Copilot's command sandbox looks enabled (`--sandbox`, or `sandbox.enabled` in `~/.copilot/settings.json` or `.github/copilot/settings*.json`), it prints a warning; managed policies cannot be detected, so the in-session check below covers them.
- **In the session**, `npx openfleet preflight <project>` runs the same checks before the spec is approved, at the start of the run and first after `resume`. While it fails, the spec cannot be approved and nothing is spawned.

Likely causes of `EPERM`, in order:

1. **OpenFleet or Copilot was started from a sandboxed shell**, such as an IDE or app-embedded terminal or an agent's shell. The whole process tree is sandboxed. Start `npx openfleet` from a normal terminal.
2. **The host's own sandbox is on.** Copilot: run `/sandbox disable`, start without `--sandbox` (or pass `-- --no-sandbox`), or add the repo paths to `sandbox.userPolicy.filesystem.readwritePaths` in `~/.copilot/settings.json`. Claude Code: turn off `sandbox.enabled` (`/sandbox`) or allow writes to the repo paths in its sandbox settings. The sandbox may still protect `.git`.
3. **A managed OS policy** on the device. Ask your administrator.

macOS Full Disk Access does not fix this. `EACCES` ("Permission denied") is a plain file-permissions problem: check the owner and mode of the path.

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · **Limitations and troubleshooting** · [Releasing](./releasing.md)
