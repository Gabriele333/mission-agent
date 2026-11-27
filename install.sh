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
# What it writes:
#
#   ~/.mission-agent/app                 the program: one release, built
#   ~/.mission-agent/bin/mission-agent   the command
#   a link to the command in a folder of your PATH, when one can be written
#   ~/.mission-agent/install.log         what git and npm printed
#
# When you agree, it also installs the agent as a service of your account
# (one file in ~/Library/LaunchAgents) and opens the setup page.
#
# Options:
#
#   --root <path>       the agent's root folder, which holds its data. Asked when left out.
#   --version <vX.Y.Z>  the release to install. Default: the newest one.
#   --no-service        do not install the service
#   --no-link           do not link the command into a folder of your PATH
#   --no-open           do not open the setup page
#   --yes               do not ask: use ~/mission-agent as the root folder, and install the service
#   -h, --help          show this text
#
# Two variables change where it reads and writes:
#
#   MISSION_AGENT_REPO  the repository to install from
#   MISSION_AGENT_HOME  the folder that replaces ~/.mission-agent

set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,36p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
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

main() {
  local repo="${MISSION_AGENT_REPO:-https://github.com/Gabriele333/mission-agent.git}"
  local home_dir="${MISSION_AGENT_HOME:-$HOME/.mission-agent}"
  local version="" root="" service="ask" link=1 open_setup=1
  ASSUME_YES=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --root)
        [ $# -ge 2 ] || fail "--root needs a path."
        root="$2"
        shift 2
        ;;
      --version)
        [ $# -ge 2 ] || fail "--version needs a release, such as v0.2.0."
        version="$2"
        shift 2
        ;;
      --no-service)
        service="no"
        shift
        ;;
      --no-link)
        link=0
        shift
        ;;
      --no-open)
        open_setup=0
        shift
        ;;
      --yes)
        ASSUME_YES=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown option \"$1\". Run it with --help to see the options." ;;
    esac
  done

  # ---------------------------------------------------------------- what the program needs

  [ "$(uname -s)" = "Darwin" ] || fail "mission-agent works on macOS only."
  local tool
  for tool in git node npm; do
    command -v "$tool" >/dev/null 2>&1 || fail "\"$tool\" was not found. Install Node.js 24 or later, and git, then run this again."
  done
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 24 ] || fail "Node.js 24 or later is needed. This computer has $(node --version)."

  # The command file quotes this path, so these characters would break it.
  case "$home_dir" in
    *\"* | *\$* | *\`* | *\\* | *$'\n'*) fail "The folder $home_dir holds a character that the command file cannot quote." ;;
  esac
  case "$home_dir" in
    /*) ;;
    *) home_dir="$PWD/$home_dir" ;;
  esac
  local app="$home_dir/app" bin="$home_dir/bin" log="$home_dir/install.log"
  local cmd="$bin/mission-agent"

  # ---------------------------------------------------------------- the program

  if [ -e "$app" ]; then
    [ -f "$app/dist/cli.js" ] || fail "$app exists, but it holds no built program. Remove the folder, then run this again."
    say "The program is already installed in $app. It is left as it is."
    say "To install a newer release, run: mission-agent update --root <the agent's root folder>"
  else
    if [ -z "$version" ]; then
      say "Looking for the newest release of $repo."
      local tags
      tags="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$repo" 'v*')" ||
        fail "git could not read the releases of $repo. If the repository is private, sign in to it with git first."
      version="$(printf '%s\n' "$tags" | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -V | tail -n 1)"
      [ -n "$version" ] || fail "$repo has no release yet. A release is a tag such as v0.2.0."
    fi
    printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "\"$version\" is not a release. A release is a tag such as v0.2.0."

    # The program is built in a second folder and moved at the end, so a failed install leaves nothing at $app.
    local building="$home_dir/app.installing"
    mkdir -p "$home_dir"
    rm -rf "$building"
    say "Getting release $version."
    git -c advice.detachedHead=false clone --quiet --branch "$version" "$repo" "$building" >"$log" 2>&1 || {
      tail -n 20 "$log" >&2
      fail "git could not get release $version of $repo."
    }
    say "Getting the packages it depends on. This takes a minute."
    (cd "$building" && npm ci --no-audit --no-fund) >>"$log" 2>&1 || {
      tail -n 20 "$log" >&2
      fail "npm could not install the packages. The whole output is in $log."
    }
    say "Building it."
    (cd "$building" && npm run build) >>"$log" 2>&1 || {
      tail -n 20 "$log" >&2
      fail "The program could not be built. The whole output is in $log."
    }
    [ -f "$building/dist/cli.js" ] || fail "The build did not write dist/cli.js. The output is in $log."
    mv "$building" "$app"
    say "Installed release $version in $app."
  fi

  # ---------------------------------------------------------------- the command

  mkdir -p "$bin"
  printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$app" >"$cmd"
  chmod 755 "$cmd"

  local name="$cmd" dir linked=""
  if [ "$link" = 1 ]; then
    for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
      case ":$PATH:" in
        *":$dir:"*) ;;
        *) continue ;;
      esac
      [ -d "$dir" ] && [ -w "$dir" ] || continue
      # A command of the same name that this script did not write is left alone.
      if [ -e "$dir/mission-agent" ] || [ -L "$dir/mission-agent" ]; then
        [ "$(readlink "$dir/mission-agent" 2>/dev/null || true)" = "$cmd" ] || continue
      fi
      ln -sf "$cmd" "$dir/mission-agent"
      linked="$dir/mission-agent"
      name="mission-agent"
      break
    done
    if [ -n "$linked" ]; then
      say "The command is mission-agent ($linked)."
    else
      say "The command is $cmd."
      say "To type only \"mission-agent\", add this line to ~/.zshrc and open a new terminal:"
      say "  export PATH=\"$bin:\$PATH\""
    fi
  else
    say "The command is $cmd."
  fi

  # ---------------------------------------------------------------- the agent's root folder

  if [ -z "$root" ]; then
    if can_ask; then
      say ""
      say "The agent keeps its data in one folder: its configuration, its missions, their memory and its database."
      ask "Which folder? Press Enter for ~/mission-agent: "
      root="$ANSWER"
    fi
    if [ -z "$root" ]; then
      if [ "$ASSUME_YES" = 1 ] || can_ask; then
        root="$HOME/mission-agent"
      else
        say ""
        say "No root folder was given, and nobody can be asked, so the agent is not started."
        say "Choose a folder, then run:"
        say "  $name service install --root <folder>"
        say "  $name setup --root <folder>"
        return 0
      fi
    fi
  fi
  case "$root" in
    "~") root="$HOME" ;;
    "~/"*) root="$HOME/${root#"~/"}" ;;
    /*) ;;
    *) root="$PWD/$root" ;;
  esac
  local quoted_root
  quoted_root="$(printf '%q' "$root")"

  # ---------------------------------------------------------------- the service

  if [ "$service" = "ask" ]; then
    if [ "$ASSUME_YES" = 1 ]; then
      service="yes"
    elif can_ask; then
      say ""
      say "The agent can run as a service of your account. macOS then starts it when you log in,"
      say "and starts it again after a crash. This writes one file in ~/Library/LaunchAgents."
      say "It needs no password. macOS shows a notice that a background item was added."
      say "You can switch it off at any time in System Settings, under General, Login Items."
      ask "Install the service? [Y/n] "
      case "$ANSWER" in
        n | N | no | No | NO) service="no" ;;
        *) service="yes" ;;
      esac
    else
      service="no"
    fi
  fi

  if [ "$service" != "yes" ]; then
    say ""
    say "The service is not installed. To run the agent until Ctrl+C:"
    say "  $name start --root $quoted_root"
    say "To install the service later:"
    say "  $name service install --root $quoted_root"
    return 0
  fi

  say ""
  "$cmd" service install --root "$root" || fail "The service could not be installed. The program itself is installed."

  # The service starts the harness. It answers within a few seconds.
  local waited=0
  until "$cmd" setup --no-open --root "$root" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -ge 30 ]; then
      "$cmd" service status --root "$root" || true
      fail "The service is installed, but the agent does not answer. Its log is $root/state/logs/harness.err.log."
    fi
    sleep 1
  done
  say ""
  "$cmd" service status --root "$root"
  say ""
  say "The agent runs as a service."

  # ---------------------------------------------------------------- the setup page

  if [ "$open_setup" = 1 ] && can_ask; then
    say "Opening the setup page, where you enter the model login and the rest of the configuration."
    "$cmd" setup --root "$root" || say "Open it with: $name setup --root $quoted_root"
  else
    say "Configure it on the setup page: $name setup --root $quoted_root"
  fi
  say "Chat with it: $name chat --root $quoted_root"
}

main "$@"
