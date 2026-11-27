#!/bin/bash
#
# Installs mission-agent on macOS.
#
# Run it from a copy of the repository:
#
#   ./install.sh
#
# Or run it without a copy:
#
#   curl -fsSL https://raw.githubusercontent.com/Gabriele333/mission-agent/main/install.sh | bash
#
# This script checks what the program needs: macOS, git, Node.js 24 or later, and npm.
# The rest is done by the maintenance program, which is part of each release:
#
#   ~/.mission-agent/app                 the program: one release, built
#   ~/.mission-agent/maintenance         the maintenance program: install, uninstall, update, repair
#   ~/.mission-agent/bin/mission-agent   the command
#   a link to the command in a folder of your PATH, when one can be written
#   ~/.mission-agent/maintenance.log     what git and npm printed
#
# When the maintenance program is installed and works, this script runs it. Otherwise, and with
# --reinstall, it gets the newest release, builds it, and runs the maintenance program of that
# release. So this script also repairs an install whose maintenance program is broken.
#
# When you agree, it also installs the agent as a service of your account
# (one file in ~/Library/LaunchAgents) and opens the setup page.
#
# The setup page then checks the settings of the computer that the agent depends on,
# such as sleep and automatic login. Over SSH, with --no-open, or when nobody can be
# asked, the install checks them in the terminal instead. Neither changes them: they say
# what to change and where, and check again after you changed it.
#
# Options:
#
#   --root <path>       the agent's root folder, which holds its data. Asked when left out.
#   --version <vX.Y.Z>  the release to install. Default: the newest one.
#   --no-service        do not install the service
#   --no-link           do not link the command into a folder of your PATH
#   --no-open           do not open the setup page
#   --reinstall         get the release again and install it from scratch. The root folder is kept.
#   --uninstall         remove the program and its services. The agent's data is kept.
#   --wipe-data         with --uninstall: also delete the agent's root folders and its secrets
#                       in the Keychain. It asks twice, and needs a person to answer.
#   --yes               do not ask: use ~/mission-agent as the root folder, and install the service.
#                       With --uninstall, uninstall without a question.
#   -h, --help          show this text
#
# Four variables change where it reads and writes:
#
#   MISSION_AGENT_REPO              the repository to install from
#   MISSION_AGENT_HOME              the folder that replaces ~/.mission-agent
#   MISSION_AGENT_LAUNCH_AGENTS     the folder that replaces ~/Library/LaunchAgents, for the
#                                   service files
#   MISSION_AGENT_KEYCHAIN_SERVICE  the Keychain service that replaces mission-agent

set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,55p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
}

# True when a person can answer a question: a terminal on standard input, or a terminal to open.
# With "curl ... | bash", standard input is the script, so the answers come from /dev/tty.
can_ask() {
  [ "$ASSUME_YES" = 0 ] || return 1
  [ -t 0 ] && return 0
  (: </dev/tty) 2>/dev/null
}

# Prints the question and reads one line. The answer is in $ANSWER.
ask() {
  ANSWER=""
  if [ -t 0 ]; then
    printf '%s' "$1"
    read -r ANSWER || true
  else
    printf '%s' "$1" >/dev/tty
    read -r ANSWER </dev/tty || true
  fi
}

# Prints the major version of Node.js, or nothing when there is no Node.js.
node_major() {
  command -v node >/dev/null 2>&1 || return 0
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# Stops unless Node.js 24 or later is present. With Homebrew and a person to ask, it offers to install it.
need_node() {
  local major
  major="$(node_major)"
  if [ -n "$major" ] && [ "$major" -ge 24 ]; then
    return 0
  fi
  if [ -z "$major" ]; then
    say "Node.js is missing. The agent needs Node.js 24 or later."
  else
    say "This computer has Node.js $(node --version). The agent needs Node.js 24 or later."
  fi

  if command -v brew >/dev/null 2>&1; then
    local brew_command="brew install node"
    [ -n "$major" ] && brew_command="brew upgrade node"
    if can_ask; then
      ask "Install it now with Homebrew ($brew_command)? [Y/n] "
      case "$ANSWER" in
        n | N | no | No | NO) fail "Install it with \"$brew_command\", then run this again." ;;
      esac
      # The command is one of the two fixed texts above, so it is safe to split into words.
      # shellcheck disable=SC2086
      $brew_command || fail "Homebrew could not install Node.js. Install it with \"$brew_command\", then run this again."
      hash -r
      major="$(node_major)"
      if [ -n "$major" ] && [ "$major" -ge 24 ]; then
        say "Node.js $(node --version) is installed."
        return 0
      fi
      fail "Node.js 24 or later is still not found. Open a new terminal, then run this again."
    fi
    fail "Install it with \"$brew_command\", then run this again."
  fi

  say "Install it in one of these two ways:" >&2
  say "  1. Download the macOS installer from https://nodejs.org and open it. It asks for your password." >&2
  say "  2. Install Homebrew from https://brew.sh, then run: brew install node" >&2
  fail "Then open a new terminal and run this again."
}

# True when the maintenance program in $1 runs: its self-test prints the fixed line.
maintenance_works() {
  [ -f "$1" ] || return 1
  local first
  first="$(node "$1" self-test 2>/dev/null | head -n 1)" || return 1
  [ "$first" = "The mission-agent maintenance program runs." ]
}

# Runs the maintenance program $1 with the other arguments. When standard input is not a terminal
# and a terminal can be opened, as with "curl ... | bash", the terminal is its standard input, so
# that its questions can be answered. The tests answer through standard input instead.
run_maintenance() {
  local main="$1"
  shift
  if [ ! -t 0 ] && [ "${MISSION_AGENT_STDIN_ANSWERS:-}" != 1 ] && (: </dev/tty) 2>/dev/null; then
    exec node "$main" --home "$HOME_DIR" "$@" </dev/tty
  fi
  exec node "$main" --home "$HOME_DIR" "$@"
}

# Prints how to remove the program by hand, for when no maintenance program can run.
by_hand() {
  local plist label uid
  uid="$(id -u)"
  say "Remove it by hand:" >&2
  for plist in "$LAUNCH_AGENTS"/local.mission-agent.*.plist; do
    [ -f "$plist" ] || continue
    grep -qF "$HOME_DIR/app/dist/cli.js" "$plist" 2>/dev/null || continue
    label="$(basename "$plist" .plist)"
    say "  launchctl bootout gui/$uid/$label" >&2
    say "  rm \"$plist\"" >&2
  done
  say "  rm -rf \"$HOME_DIR\"" >&2
  local dir
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [ -L "$dir/mission-agent" ] && [ "$(readlink "$dir/mission-agent" 2>/dev/null || true)" = "$HOME_DIR/bin/mission-agent" ]; then
      say "  rm \"$dir/mission-agent\"" >&2
    fi
  done
  say "The agent's root folder and its secrets in the Keychain are kept. See docs/install.md, \"Remove it\"." >&2
}

# Gets release $2 of the repository $1 into $HOME_DIR/app.installing and builds it there.
# It returns 1 when a step fails, and says which one.
build_release() {
  local repo="$1" version="$2" building="$HOME_DIR/app.installing" log="$HOME_DIR/maintenance.log"
  mkdir -p "$HOME_DIR"
  if [ -e "$building" ] || [ -L "$building" ]; then
    case "$HOME_DIR" in
      /?*) rm -rf "$building" ;;
      *) fail "The program folder \"$HOME_DIR\" must be an absolute path other than /. Nothing was removed." ;;
    esac
  fi
  say "Getting release $version."
  printf '$ git clone --branch %s %s %s\n' "$version" "$repo" "$building" >>"$log"
  if ! git -c advice.detachedHead=false clone --quiet --branch "$version" "$repo" "$building" >>"$log" 2>&1; then
    tail -n 20 "$log" >&2
    say "git could not get release $version of $repo." >&2
    return 1
  fi
  say "Getting the packages it depends on. This takes a minute."
  if ! (cd "$building" && npm ci --no-audit --no-fund) >>"$log" 2>&1; then
    tail -n 20 "$log" >&2
    say "npm could not install the packages. The whole output is in $log." >&2
    return 1
  fi
  say "Building it."
  if ! (cd "$building" && npm run build) >>"$log" 2>&1; then
    tail -n 20 "$log" >&2
    say "The program could not be built. The whole output is in $log." >&2
    return 1
  fi
  if [ ! -f "$building/dist/maintenance/main.js" ]; then
    say "Release $version has no maintenance program. Install release v0.2.0 or later." >&2
    return 1
  fi
  return 0
}

main() {
  local repo="${MISSION_AGENT_REPO:-https://github.com/Gabriele333/mission-agent.git}"
  HOME_DIR="${MISSION_AGENT_HOME:-$HOME/.mission-agent}"
  local version="" reinstall=0 uninstalling=0 wipe=0
  local args=() uninstall_args=()
  ASSUME_YES=0
  LAUNCH_AGENTS="${MISSION_AGENT_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --root)
        [ $# -ge 2 ] || fail "--root needs a path."
        args+=(--root "$2")
        uninstall_args+=(--root "$2")
        shift 2
        ;;
      --version)
        [ $# -ge 2 ] || fail "--version needs a release, such as v0.2.0."
        version="$2"
        args+=(--version "$2")
        shift 2
        ;;
      --no-service | --no-link | --no-open)
        args+=("$1")
        shift
        ;;
      --reinstall)
        reinstall=1
        args+=(--reinstall)
        shift
        ;;
      --uninstall)
        uninstalling=1
        shift
        ;;
      --wipe-data)
        wipe=1
        uninstall_args+=(--wipe-data)
        shift
        ;;
      --yes)
        ASSUME_YES=1
        args+=(--yes)
        uninstall_args+=(--yes)
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown option \"$1\". Run it with --help to see the options." ;;
    esac
  done

  if [ "$wipe" = 1 ] && [ "$uninstalling" = 0 ]; then fail "--wipe-data works only with --uninstall."; fi
  if [ "$uninstalling" = 1 ] && [ "$reinstall" = 1 ]; then fail "--uninstall and --reinstall cannot be used together."; fi
  if [ -n "$version" ]; then
    printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "\"$version\" is not a release. A release is a tag such as v0.2.0."
  fi

  [ "$(uname -s)" = "Darwin" ] || fail "mission-agent works on macOS only."

  # The command file quotes this path, so these characters would break it.
  case "$HOME_DIR" in
    *\"* | *\$* | *\`* | *\\* | *$'\n'*) fail "The folder $HOME_DIR holds a character that the command file cannot quote." ;;
  esac
  case "$HOME_DIR" in
    /*) ;;
    *) HOME_DIR="$PWD/$HOME_DIR" ;;
  esac
  case "$HOME_DIR" in
    / | //) fail "The program folder \"$HOME_DIR\" must be an absolute path other than /." ;;
  esac

  local installed="$HOME_DIR/maintenance/dist/maintenance/main.js"

  # ---------------------------------------------------------------- uninstall

  if [ "$uninstalling" = 1 ]; then
    if ! command -v node >/dev/null 2>&1; then
      say "Node.js is missing, so the maintenance program cannot run." >&2
      by_hand
      exit 1
    fi
    if maintenance_works "$installed"; then run_maintenance "$installed" uninstall "${uninstall_args[@]+"${uninstall_args[@]}"}"; fi
    if maintenance_works "$HOME_DIR/app/dist/maintenance/main.js"; then
      run_maintenance "$HOME_DIR/app/dist/maintenance/main.js" uninstall "${uninstall_args[@]+"${uninstall_args[@]}"}"
    fi
    # No maintenance program runs here. A release is built to get one.
    say "No maintenance program runs in $HOME_DIR. A release is built to get one."
    if git --version >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ "$(node_major)" -ge 24 ] 2>/dev/null; then
      if [ -z "$version" ]; then
        version="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$repo" 'v*' 2>/dev/null | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -V | tail -n 1)" || true
      fi
      if [ -n "$version" ] && build_release "$repo" "$version" && maintenance_works "$HOME_DIR/app.installing/dist/maintenance/main.js"; then
        run_maintenance "$HOME_DIR/app.installing/dist/maintenance/main.js" uninstall "${uninstall_args[@]+"${uninstall_args[@]}"}"
      fi
    fi
    say "No maintenance program could be built." >&2
    by_hand
    exit 1
  fi

  # ---------------------------------------------------------------- what the program needs

  # git comes with Apple's command line tools. Without them, /usr/bin/git exists but does not run,
  # and running it makes macOS offer to install them.
  if ! git --version >/dev/null 2>&1; then
    say "git is missing. It comes with Apple's command line tools." >&2
    say "Run this, and finish the window that opens:" >&2
    say "  xcode-select --install" >&2
    fail "Then run this again."
  fi

  need_node
  command -v npm >/dev/null 2>&1 || fail "\"npm\" was not found. It comes with Node.js: install Node.js again, then run this again."

  # ---------------------------------------------------------------- the maintenance program

  # The installed maintenance program continues, unless it does not run or --reinstall was given.
  # Then a release is built, and its own maintenance program installs it. Old installed code never runs.
  if [ "$reinstall" = 0 ] && maintenance_works "$installed"; then
    run_maintenance "$installed" install "${args[@]+"${args[@]}"}"
  fi
  if [ -f "$installed" ] && [ "$reinstall" = 0 ]; then
    say "The maintenance program in $HOME_DIR/maintenance does not run. A new release is built to replace it."
  fi

  if [ -z "$version" ]; then
    say "Looking for the newest release of $repo."
    local tags
    tags="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$repo" 'v*')" ||
      fail "git could not read the releases of $repo. If the repository is private, sign in to it with git first."
    version="$(printf '%s\n' "$tags" | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -V | tail -n 1)"
    [ -n "$version" ] || fail "$repo has no release yet. A release is a tag such as v0.2.0."
  fi
  build_release "$repo" "$version" || fail "Nothing was installed."
  maintenance_works "$HOME_DIR/app.installing/dist/maintenance/main.js" ||
    fail "The maintenance program of release $version does not run. Nothing was installed. The output is in $HOME_DIR/maintenance.log."
  run_maintenance "$HOME_DIR/app.installing/dist/maintenance/main.js" install --staged "$HOME_DIR/app.installing" "${args[@]+"${args[@]}"}"
}

main "$@"
