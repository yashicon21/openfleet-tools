#!/usr/bin/env bash
# Set up a throwaway OpenFleet demo: two toy repos (api + web) and a workspace
# that uses this checkout's local build. With --greenfield: no repos, just the
# workspace and the invoice tracker prompt (OpenFleet creates the repos itself).
# Usage: examples/demo/setup.sh [--host copilot|claude] [--greenfield] [dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TMP_BASE="${TMPDIR:-/tmp}"
HOST="copilot"
GREENFIELD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs copilot or claude}"; shift 2 ;;
    --greenfield) GREENFIELD=1; shift ;;
    *) break ;;
  esac
done
case "$HOST" in copilot | claude) ;; *) echo "error: --host must be copilot or claude" >&2; exit 1 ;; esac
PROMPT="$(cat "$HERE/greenfield/prompt.txt")"
if [ "${OPENFLEET_DEMO_PRINT_PROMPT:-}" = 1 ]; then
  # Used by the tests: print what the greenfield demo would launch and stop.
  [ "$GREENFIELD" = 1 ] && printf '%s\n' "$PROMPT"
  exit 0
fi
DEFAULT_NAME="openfleet-demo"
[ "$GREENFIELD" = 1 ] && DEFAULT_NAME="openfleet-greenfield-demo"
DEMO_DIR="${1:-${TMP_BASE%/}/$DEFAULT_NAME}"
DEMO_DIR="${DEMO_DIR%/}"
MARKER=".openfleet-demo"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

for cmd in node git pnpm npm; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is required" >&2; exit 1; }
done

step "Building OpenFleet packages"
(cd "$REPO_ROOT" && pnpm install --frozen-lockfile --silent && pnpm -r --silent run build)

step "Preparing $DEMO_DIR"
if [ -e "$DEMO_DIR" ]; then
  if [ -f "$DEMO_DIR/$MARKER" ]; then
    # Worktrees from a previous run point back into the toy repos; just remove everything.
    rm -rf "$DEMO_DIR"
  elif [ -n "$(ls -A "$DEMO_DIR" 2>/dev/null)" ]; then
    echo "error: $DEMO_DIR exists and is not an OpenFleet demo directory; refusing to wipe it." >&2
    exit 1
  fi
fi
mkdir -p "$DEMO_DIR"
DEMO_DIR="$(cd "$DEMO_DIR" && pwd -P)"
touch "$DEMO_DIR/$MARKER"

make_repo() {
  local name="$1" dest="$DEMO_DIR/$1"
  cp -R "$HERE/template/$name" "$dest"
  git -C "$dest" init -q -b main
  git -C "$dest" add -A
  git -C "$dest" -c user.name="OpenFleet Demo" -c user.email="demo@openfleet.invalid" \
    -c commit.gpgsign=false commit -q -m "Initial commit"
  (cd "$dest" && npm test --silent >/dev/null 2>&1) || { echo "error: $name tests failed" >&2; exit 1; }
  echo "  $name: initial commit on main, tests pass"
}

if [ "$GREENFIELD" = 0 ]; then
  step "Creating toy repos"
  make_repo api
  make_repo web
fi

step "Scaffolding OpenFleet workspace (local build)"
WS="$DEMO_DIR/fleet"
# Force npm: under `pnpm demo` the inherited user agent would pick pnpm, which
# would treat the demo dir as part of this pnpm workspace.
npm_config_user_agent="npm/10" node "$REPO_ROOT/packages/create/dist/index.js" "$WS" --cli "file:$REPO_ROOT/packages/cli" --host "$HOST" \
  >"$DEMO_DIR/setup.log" 2>&1 || { cat "$DEMO_DIR/setup.log" >&2; exit 1; }

if [ "$GREENFIELD" = 1 ]; then
  cat <<EOF

$(printf '\033[1m')Greenfield demo ready.$(printf '\033[0m')

  Workspace: $WS   (repos.json is empty: OpenFleet creates the repos in repos/)
  Host: $HOST   Needs node, git and docker; the grill asks which other toolchains the stack uses.

  1. Start the run (answer the grill: layout, stack, MVP slice; then it runs hands-off):
       cd "$WS" && npx openfleet new invoices "$PROMPT"

  2. Watch it from another terminal:
       cd "$WS" && npx openfleet status invoices

  3. Afterwards: the system is on main in $WS/repos/<key> (or in one draft PR), the run report in
     projects/invoices/report.html, and the next slice starts with: npx openfleet continue invoices
EOF
  exit 0
fi

cat >"$WS/repos.json" <<'JSON'
{
  "v": 1,
  "repos": {
    "api": {
      "path": "../api",
      "defaultBranch": "main",
      "description": "Node HTTP service. GET /greeting returns { \"message\": \"Hello\" }.",
      "test": "npm test",
      "confirmed": true
    },
    "web": {
      "path": "../web",
      "defaultBranch": "main",
      "description": "Client that fetches GET /greeting from api and renders the message.",
      "test": "npm test",
      "confirmed": true
    }
  }
}
JSON
echo "  workspace: $WS"
echo "  repos.json pre-seeded with api and web"
echo "  host: $HOST"
HOST_LABEL="Copilot CLI"
[ "$HOST" = "claude" ] && HOST_LABEL="Claude Code"

PROJECT="greeting-lang"
cat <<EOF

$(printf '\033[1m')Demo ready.$(printf '\033[0m')

  Layout:
    $DEMO_DIR/api     toy API repo (git, main)
    $DEMO_DIR/web     toy client repo (git, main)
    $DEMO_DIR/fleet   OpenFleet workspace

  1. Start the run (opens $HOST_LABEL; answer the grill, then it runs hands-off):
       cd "$WS" && npx openfleet new $PROJECT "Add a language field to the greeting API and show it in web"

  2. Watch it from another terminal:
       cd "$WS" && npx openfleet status $PROJECT
       tail -f "$WS/projects/$PROJECT/events.jsonl"

  3. Review the result (default completion mode stages changes, nothing is committed):
       spec, plans, contracts:  $WS/projects/$PROJECT/
       staged diffs:            git -C "$WS/projects/$PROJECT/worktrees/<child>" diff --cached
       full patches:            $WS/projects/$PROJECT/patches/

  Clean up: cd "$WS" && npx openfleet clean $PROJECT --branches --force   (or re-run this script)
EOF
