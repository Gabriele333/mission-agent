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
# The setup page then checks the settings of the computer that the agent depends on,
# such as sleep and automatic login. Over SSH, with --no-open, or when nobody can be
# asked, the script checks them in the terminal instead. Neither changes them: they say
# what to change and where, and check again after you changed it.
#
# Options:
#
#   --root <path>       the agent's root folder, which holds its data. Asked when left out.
#   --version <vX.Y.Z>  the release to install. Default: the newest one.
#   --no-service        do not install the service
#   --no-link           do not link the command into a folder of your PATH
#   --no-open           do not open the setup page
#   --reinstall         remove the installed program and install it again. The root folder is kept.
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
#   MISSION_AGENT_LAUNCH_AGENTS     the folder that replaces ~/Library/LaunchAgents, where
#                                   this script looks for service files and removes them
#   MISSION_AGENT_KEYCHAIN_SERVICE  the Keychain service that replaces mission-agent, for --wipe-data

set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,49p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
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

# Removes one folder of the program: $1/app or $1/app.installing, and only when $1 is an absolute path.
remove_program_folder() {
  local home_dir="$1" folder="$2"
  case "$home_dir" in
    /?*) ;;
    *) fail "The program folder \"$home_dir\" must be an absolute path other than /. Nothing was removed." ;;
  esac
  case "$folder" in
    "$home_dir/app" | "$home_dir/app.installing") rm -rf "$folder" ;;
    *) fail "$folder is not a folder of the program. Nothing was removed." ;;
  esac
}

# Escapes a text for XML, as the program writes the service file.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

xml_unescape() {
  printf '%s' "$1" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g'
}

# Prints the paths of the service files in $LAUNCH_AGENTS that run the program in $1.
# It only reads that folder.
services_of() {
  local plist needle
  needle="$(xml_escape "$1/dist/cli.js")"
  for plist in "$LAUNCH_AGENTS"/local.mission-agent.*.plist; do
    [ -f "$plist" ] || continue
    if grep -qF "$needle" "$plist" 2>/dev/null; then
      printf '%s\n' "$plist"
    fi
  done
}

# Prints the root folder that the service file $1 runs: the value after --root. Nothing when there is none.
root_of_service() {
  local raw
  raw="$(tr '\n' ' ' <"$1" | sed -n 's|.*<string>--root</string>[[:space:]]*<string>\([^<]*\)</string>.*|\1|p')"
  if [ -n "$raw" ]; then
    xml_unescape "$raw"
    printf '\n'
  fi
}

# Prints the real path of $1 when it looks like an agent's root folder, and nothing otherwise.
# It must be an absolute path, not /, not the home folder or a folder above it, and hold both
# a missions folder and a state folder.
agent_root_path() {
  local real home_real
  case "$1" in
    /?*) ;;
    *) return 0 ;;
  esac
  if [ ! -d "$1" ]; then return 0; fi
  real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  home_real="$(cd "$HOME" 2>/dev/null && pwd -P)" || return 0
  if [ -z "$real" ] || [ "$real" = "/" ]; then return 0; fi
  case "$home_real/" in
    "$real"/*) return 0 ;;
  esac
  case "$HOME/" in
    "$real"/*) return 0 ;;
  esac
  if [ -d "$real/missions" ] && [ -d "$real/state" ]; then
    printf '%s\n' "$real"
  fi
}

# True when the list of lines $1, each one ended by a line feed, holds the line $2.
has_line() {
  case $'\n'"$1" in
    *$'\n'"$2"$'\n'*) return 0 ;;
  esac
  return 1
}

# Prints the path $1 as an absolute path: ~ is the home folder, and a relative path starts here.
absolute_path() {
  case "$1" in
    "") ;;
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

# Stops one service, then removes its file. It needs nothing of the program, which may be broken.
remove_service() {
  local plist="$1" label uid waited=0
  label="$(basename "$plist" .plist)"
  case "$label" in
    local.mission-agent.*) ;;
    *) fail "$plist is not a service file of this program. Nothing more was removed." ;;
  esac
  case "$label" in
    *[!A-Za-z0-9._-]*) fail "The service file $plist has an unexpected name. Nothing more was removed." ;;
  esac
  uid="$(id -u)"
  # The service may not be loaded. Then bootout fails, and that is fine.
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  while launchctl print "gui/$uid/$label" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -ge 40 ]; then
      fail "The service $label did not stop within 40 seconds. Nothing more was removed."
    fi
    sleep 1
  done
  rm -f "$plist"
  say "Removed the service $label ($plist)."
}

# Uninstalls the program in $1 and its services. $2 is the root folder given with --root, or empty.
# With $3 = 1, it also deletes the agent's root folders and its secrets in the Keychain.
uninstall() {
  local home_dir="$1" given_root="$2" wipe="$3"
  case "$home_dir" in
    /?*) ;;
    *) fail "The program folder \"$home_dir\" must be an absolute path other than /. Nothing was removed." ;;
  esac
  local app="$home_dir/app" building="$home_dir/app.installing" bin="$home_dir/bin"
  local cmd="$home_dir/bin/mission-agent" log="$home_dir/install.log"
  local services plist r real dir

  # The services of this program, and the root folder that each one runs.
  services="$(services_of "$app")"
  local candidates=""
  while IFS= read -r plist; do
    [ -n "$plist" ] || continue
    r="$(root_of_service "$plist")"
    if [ -n "$r" ] && ! has_line "$candidates" "$r"; then candidates="$candidates$r"$'\n'; fi
  done <<<"$services"
  r="$(absolute_path "$given_root")"
  if [ -n "$r" ] && ! has_line "$candidates" "$r"; then candidates="$candidates$r"$'\n'; fi
  r="$HOME/mission-agent"
  if [ -e "$r" ] && ! has_line "$candidates" "$r"; then candidates="$candidates$r"$'\n'; fi

  # The links to the command that the install made.
  local links=""
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [ -L "$dir/mission-agent" ] && [ "$(readlink "$dir/mission-agent" 2>/dev/null || true)" = "$cmd" ]; then
      links="$links$dir/mission-agent"$'\n'
    fi
  done

  # What is removed of the program.
  local remove=""
  while IFS= read -r plist; do
    [ -n "$plist" ] || continue
    remove="$remove  the service file $plist"$'\n'
  done <<<"$services"
  if [ -e "$app" ] || [ -L "$app" ]; then remove="$remove  the program folder $app"$'\n'; fi
  if [ -e "$building" ]; then remove="$remove  the folder of an install that stopped half way, $building"$'\n'; fi
  if [ -f "$cmd" ] || [ -L "$cmd" ]; then remove="$remove  the command $cmd"$'\n'; fi
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    remove="$remove  the link to the command $r"$'\n'
  done <<<"$links"
  if [ -f "$log" ]; then remove="$remove  the file $log"$'\n'; fi

  # With --wipe-data: the root folders that look like an agent's, and the others, which are left alone.
  local roots="" alone="" secrets=0
  if [ "$wipe" = 1 ]; then
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      real="$(agent_root_path "$r")"
      if [ -n "$real" ]; then
        if ! has_line "$roots" "$real"; then roots="$roots$real"$'\n'; fi
      else
        alone="$alone$r"$'\n'
      fi
    done <<<"$candidates"
    if /usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then secrets=1; fi
  fi

  if [ -z "$remove" ] && [ -z "$roots" ] && [ "$secrets" = 0 ]; then
    say "Nothing of mission-agent was found in $home_dir. Nothing was removed."
    return 0
  fi

  say ""
  if [ "$wipe" = 1 ]; then
    if ! can_ask; then
      if [ "$ASSUME_YES" = 1 ]; then
        fail "--yes does not cover the deletion of the agent's data. Run it without --yes, and answer the two questions. Nothing was removed."
      fi
      fail "Deleting the agent's data needs a person to answer two questions, and nobody can be asked. Nothing was removed."
    fi
    say "This removes the program and its services, and deletes the agent's data:"
    printf '%s' "$remove"
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      say "  the agent's root folder $r, with everything in it"
    done <<<"$roots"
    if [ "$secrets" = 1 ]; then say "  every item of the Keychain service $KEYCHAIN_SERVICE: the agent's secrets"; fi
    if [ -n "$alone" ]; then
      say "Left alone, because they are not agent root folders. An agent's root folder holds a missions folder and a state folder:"
      printf '%s' "$alone" | sed 's/^/  /'
    fi
    say "This cannot be undone. The copies in backups/ inside each root folder are deleted too."
    ask "Delete all of this? [y/N] "
    case "$ANSWER" in
      y | Y | yes | Yes | YES) ;;
      *)
        say "Nothing was removed."
        return 0
        ;;
    esac
    ask "To confirm, type the word delete: "
    if [ "$ANSWER" != "delete" ]; then
      say "Nothing was removed."
      return 0
    fi
  else
    say "This removes the program and its services:"
    printf '%s' "$remove"
    if [ "$ASSUME_YES" != 1 ]; then
      can_ask || fail "Nobody can confirm the uninstall. Run it with --yes to uninstall without a question. Nothing was removed."
      ask "Remove these? [y/N] "
      case "$ANSWER" in
        y | Y | yes | Yes | YES) ;;
        *)
          say "Nothing was removed."
          return 0
          ;;
      esac
    fi
  fi

  # The services first: this stops the agent.
  while IFS= read -r plist; do
    [ -n "$plist" ] || continue
    remove_service "$plist"
  done <<<"$services"

  if [ "$wipe" = 1 ]; then
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      # Checked again just before, so that only the folder that was shown is deleted.
      [ "$(agent_root_path "$r")" = "$r" ] || fail "$r changed since the question. It was not deleted. Nothing more was removed."
      rm -rf "$r"
      say "Deleted the agent's root folder $r."
    done <<<"$roots"
    local deleted=0
    if [ -n "$KEYCHAIN_SERVICE" ]; then
      while [ "$deleted" -lt 200 ] && /usr/bin/security delete-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; do
        deleted=$((deleted + 1))
      done
    fi
    if [ "$deleted" = 1 ]; then
      say "Deleted 1 item of the Keychain service $KEYCHAIN_SERVICE."
    else
      say "Deleted $deleted items of the Keychain service $KEYCHAIN_SERVICE."
    fi
  fi

  while IFS= read -r r; do
    [ -n "$r" ] || continue
    if [ -L "$r" ] && [ "$(readlink "$r" 2>/dev/null || true)" = "$cmd" ]; then rm -f "$r"; fi
  done <<<"$links"
  remove_program_folder "$home_dir" "$app"
  remove_program_folder "$home_dir" "$building"
  if [ -f "$cmd" ] || [ -L "$cmd" ]; then rm -f "$cmd"; fi
  if [ -f "$log" ]; then rm -f "$log"; fi
  # rmdir removes a folder only when it is empty, so a folder that holds anything else stays.
  rmdir "$bin" 2>/dev/null || true
  rmdir "$home_dir" 2>/dev/null || true
  say "Removed the program."

  say ""
  if [ -d "$home_dir" ]; then say "$home_dir holds other files, so it is kept."; fi
  if [ "$wipe" = 1 ]; then
    if [ -n "$alone" ]; then
      say "Kept, because it is not an agent's root folder:"
      printf '%s' "$alone" | sed 's/^/  /'
    fi
    say "Kept: Node.js and git."
    say "A sign-in with a Claude plan belongs to Claude Code. This script does not remove it."
  else
    say "Kept:"
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      if [ -e "$r" ]; then say "  the agent's root folder $r"; fi
    done <<<"$candidates"
    say "  the agent's secrets in the Keychain"
    say "  Node.js and git"
    say "To delete the agent's data later, delete its root folder. Then, in the Keychain Access app,"
    say "delete each item of the service $KEYCHAIN_SERVICE."
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

main() {
  local repo="${MISSION_AGENT_REPO:-https://github.com/Gabriele333/mission-agent.git}"
  local home_dir="${MISSION_AGENT_HOME:-$HOME/.mission-agent}"
  local version="" root="" service="ask" link=1 open_setup=1 reinstall=0 uninstalling=0 wipe=0
  ASSUME_YES=0
  LAUNCH_AGENTS="${MISSION_AGENT_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
  KEYCHAIN_SERVICE="${MISSION_AGENT_KEYCHAIN_SERVICE:-mission-agent}"

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
      --reinstall)
        reinstall=1
        shift
        ;;
      --uninstall)
        uninstalling=1
        shift
        ;;
      --wipe-data)
        wipe=1
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

  if [ "$wipe" = 1 ] && [ "$uninstalling" = 0 ]; then fail "--wipe-data works only with --uninstall."; fi
  if [ "$uninstalling" = 1 ] && [ "$reinstall" = 1 ]; then fail "--uninstall and --reinstall cannot be used together."; fi
  [ -n "$KEYCHAIN_SERVICE" ] || fail "MISSION_AGENT_KEYCHAIN_SERVICE is empty."

  [ "$(uname -s)" = "Darwin" ] || fail "mission-agent works on macOS only."

  # The command file quotes this path, so these characters would break it.
  case "$home_dir" in
    *\"* | *\$* | *\`* | *\\* | *$'\n'*) fail "The folder $home_dir holds a character that the command file cannot quote." ;;
  esac
  case "$home_dir" in
    /*) ;;
    *) home_dir="$PWD/$home_dir" ;;
  esac

  # The uninstall needs neither git nor Node.js, so it comes before the checks for them.
  if [ "$uninstalling" = 1 ]; then
    uninstall "$home_dir" "$root" "$wipe"
    return 0
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

  local app="$home_dir/app" bin="$home_dir/bin" log="$home_dir/install.log"
  local cmd="$bin/mission-agent"

  # ---------------------------------------------------------------- the program

  # A past install is continued, or removed and installed again (from scratch). With nobody to ask,
  # it is continued, unless --reinstall says otherwise.
  local building="$home_dir/app.installing" fresh=0
  if [ -e "$app" ] || [ -L "$app" ]; then
    if [ "$reinstall" = 1 ]; then
      fresh=1
    elif [ -f "$app/dist/cli.js" ]; then
      if can_ask; then
        local found
        found="$(node "$app/dist/cli.js" --version 2>/dev/null | head -n 1 || true)"
        say ""
        if [ -n "$found" ] && [ "$found" != "unknown" ]; then
          say "A past install was found in $app. It is version $found of the program."
        else
          say "A past install was found in $app."
        fi
        say "  1. Continue the setup with this program."
        say "  2. Remove the program and install it again from scratch."
        say "  3. Uninstall the program and its services. The agent's data is kept."
        say "  4. Uninstall, and delete the agent's data too."
        while :; do
          ask "Which one? Press Enter for 1: "
          case "$ANSWER" in
            "" | 1) break ;;
            2)
              fresh=1
              break
              ;;
            3)
              uninstall "$home_dir" "$root" 0
              return 0
              ;;
            4)
              uninstall "$home_dir" "$root" 1
              return 0
              ;;
            *) say "Type 1, 2, 3 or 4." ;;
          esac
        done
      fi
    elif can_ask; then
      say ""
      say "$app exists, but it holds no built program, so the setup cannot continue with it."
      ask "Remove it and install the program again? [Y/n] "
      case "$ANSWER" in
        n | N | no | No | NO) fail "Remove the folder $app, then run this again." ;;
        *) fresh=1 ;;
      esac
    else
      fail "$app exists, but it holds no built program. Remove the folder, then run this again."
    fi
  fi

  if [ "$fresh" = 1 ]; then
    # A service that runs this program would break when the program is removed.
    local services
    services="$(services_of "$app")"
    if [ -n "$services" ]; then
      say "A service runs the program in $app. Removing the program would break the agent." >&2
      say "The service files:" >&2
      printf '%s\n' "$services" | sed 's/^/  /' >&2
      say "Remove each service first with: mission-agent service uninstall --root <its root folder>" >&2
      say "Or get a newer release with: mission-agent update --root <the agent's root folder>" >&2
      fail "Nothing was removed."
    fi
    say "The program in $app is removed and installed again. The agent's root folder is not touched."
  fi

  if [ "$fresh" = 0 ] && [ -e "$app" ]; then
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
    # When it starts from scratch, the old program stays until the new one is built.
    mkdir -p "$home_dir"
    if [ -e "$building" ]; then
      say "An install that stopped half way was found in $building. It starts again."
      remove_program_folder "$home_dir" "$building"
    fi
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
    if [ "$fresh" = 1 ]; then
      remove_program_folder "$home_dir" "$app"
    fi
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
      say "The service makes macOS start the agent at login and after a crash. It needs no password."
      say "It writes one file in ~/Library/LaunchAgents. Switch it off in System Settings, General, Login Items."
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
    say "To check the settings of this computer that the agent depends on:"
    say "  $name check --root $quoted_root"
    return 0
  fi

  say ""
  # The whole output goes to the install log. The terminal shows it only when the install fails.
  local service_out plist_path
  if service_out="$("$cmd" service install --root "$root" 2>&1)"; then
    printf '%s\n' "$service_out" >>"$log"
  else
    printf '%s\n' "$service_out"
    fail "The service could not be installed. The program itself is installed."
  fi
  plist_path="$(printf '%s\n' "$service_out" | sed -n 's/^  File:  *//p' | head -n 1)"
  say "The service is installed. It starts the agent now, at each login and after a crash."
  say "Its file is ${plist_path:-in ~/Library/LaunchAgents}. The details are in $log."
  # A start that launchd held back, or that failed, is still shown in full.
  printf '%s\n' "$service_out" | awk '/^launchctl could not start it now|^Warning:/ { shown = 1 } shown'

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
  "$cmd" service status --root "$root" >>"$log" 2>&1 || true
  say ""
  say "The agent runs as a service."

  # ---------------------------------------------------------------- the settings of the computer

  # The setup continues in the browser when the page may open, a person can be asked, and this is
  # not an SSH session. Over SSH, the browser would open on the screen of this computer, and the
  # page answers only on this computer. The terminal checks the settings in the other cases.
  local in_browser=0
  if [ "$open_setup" = 1 ] && can_ask && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ]; then
    in_browser=1
  fi

  say ""
  if [ "$in_browser" = 1 ]; then
    say "The setup continues in the browser. The setup page also checks the settings of this computer."
    say "To check them again later: $name check --root $quoted_root"
  else
    # The check only reads. With a person to ask, it goes through each setting that is not in order.
    say "Checking the settings of this computer that the agent depends on."
    if can_ask; then
      if [ -t 0 ]; then
        "$cmd" check --guide --root "$root" || true
      else
        "$cmd" check --guide --root "$root" </dev/tty || true
      fi
    else
      "$cmd" check --root "$root" || true
    fi
    say "To check again later: $name check --root $quoted_root"
    say "The setup page shows the same checks, under Computer."
  fi
  say ""

  # ---------------------------------------------------------------- the setup page

  if [ "$in_browser" = 1 ]; then
    say "Opening the setup page, where you enter the model login and the rest of the configuration."
    if "$cmd" setup --root "$root"; then
      say "To open it again: $name setup --root $quoted_root"
    else
      say "Open it with: $name setup --root $quoted_root"
    fi
  else
    say "Configure it on the setup page: $name setup --root $quoted_root"
  fi
  say "Chat with it: $name chat --root $quoted_root"
}

main "$@"
