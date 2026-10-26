---
"@openfleet-tools/cli": minor
---

Draft PRs can open as GitHub stacked pull requests.

- With the `draft-pr` completion mode on GitHub, the grill asks whether a repo with several children (including a greenfield monorepo) should open as a stack of smaller PRs, one per child in merge order, instead of one PR. It checks for the `gh stack` extension and offers to install it. The choice is saved as `prStack`.
- New helper `npx openfleet stack <project> <repo>` creates one branch per merged child from the integration branch's history (the top layer is the integration branch, with any integration fixes), records the layers and logs `stack.created`. Finalize then opens them with `gh stack init` and `gh stack submit --auto`, and falls back to one PR if `gh stack` fails.
