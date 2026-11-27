# Install

One script installs the program, the `mission-agent` command and the service.

## What you need

- macOS. Secrets are stored in the login Keychain.
- Node.js 24 or later, and git. The script checks for both and says how to get the one that is missing. With Homebrew present, it offers to install Node.js for you.
- A way to reach Claude: an API key from the Claude Console, or your own Claude plan. A plan also needs Claude Code installed, for its `claude` command.

## Run the script

There are two ways. Both run the same script.

From a copy of the repository:

```
git clone https://github.com/Gabriele333/mission-agent.git
cd mission-agent
./install.sh
```

Without a copy:

```
curl -fsSL https://raw.githubusercontent.com/Gabriele333/mission-agent/main/install.sh | bash
```

The second way works only while the repository is public. Read a script before you run it this way.

## What the script does

1. It checks for macOS, git, Node.js 24 and npm. Without Node.js, it stops and shows two ways to install it: the installer from nodejs.org, or Homebrew.
2. It gets the newest release with git and builds it in `~/.mission-agent/app`.
3. It writes the command `~/.mission-agent/bin/mission-agent`. It links the command into a folder of your PATH when it can write to one. Otherwise it shows the line to add to `~/.zshrc`.
4. It asks for the agent's root folder. See the next section.
5. It asks whether to install the service. See [Start at login](#start-at-login).
6. It checks the settings of the computer. See [Check the computer](#check-the-computer).
7. It opens the setup page in the browser. Continue with [Configure](configure.md).

Run it with `--help` to see its options. With `--yes` it asks nothing: it uses `~/mission-agent` and installs the service.

## The agent's folder

The program and your agent's data are in two places. The data is in one folder that you choose, called the root folder. It holds the configuration, the missions, their memory and the database.

Every command takes it as `--root`. Without `--root`, a command uses `~/mission-agent`. The `service` and `update` commands always need `--root`. The examples use `~/agents/ada`.

## Start at login

The service makes macOS start the agent when you log in, and start it again after a crash. The script installs it when you agree. You can also do it yourself, at any time:

```
mission-agent service install --root ~/agents/ada
mission-agent service status --root ~/agents/ada
```

The command shows what it writes before it writes it. Four things to know:

- It writes one file in `~/Library/LaunchAgents`. It needs no password. macOS shows a notice that a background item was added.
- You can switch the service off in System Settings, under General, Login Items. The agent then no longer starts by itself.
- It starts at login, not when the computer starts. After a power cut, a computer with no screen stays stopped until someone logs in. Automatic login solves this, and macOS allows it only with FileVault off.
- One root folder runs one harness. Stop a harness that runs in a terminal before you install the service.

If `service install` or `service status` says that launchd holds back the start, your login session is in a state in which launchd starts no service by itself. The command still starts the harness. Until that state ends, the harness is not started again after a crash. Log out of macOS and log in again, then run `service status`.

## Check the computer

The agent depends on a few settings of macOS. The install script checks them, and you can check them at any time:

```
mission-agent check --root ~/agents/ada
```

The check only reads. It changes no setting. For each one that is not in order, it says what to change and where. The setup page shows the same list under "Computer", and reads it again every minute.

What every agent needs:

- The root folder can be read and written, and is not inside Desktop, Documents, Downloads or iCloud Drive. macOS asks for permission before a background program reads those.
- The login Keychain answers.
- git is on the PATH.
- The service is installed, switched on, and runs the agent.
- launchd starts services by itself in your login session. If not, the agent is not started again after a crash.

What a computer needs to run the agent with nobody at it, such as a computer with no screen:

- Automatic login is on for your account. macOS offers it only with FileVault off, and with FileVault off the disk is not encrypted. You decide which matters more.
- With automatic login, the screen asks for the password as soon as it turns off.
- The computer does not go to sleep by itself.
- The computer starts by itself after a power cut. A computer with a battery has no such setting.

On a computer that you sit at, the second list is your choice, and the check shows those settings as "not set". With `--unattended`, they count as problems.

With `--guide`, the check goes through each problem with you. It can open System Settings at the right place, and it checks again after your change. The install script runs it this way.

## Run it without the service

```
mission-agent start --root ~/agents/ada
```

This runs the harness until Ctrl+C. The first time it starts paused, because nothing is configured. Leave it running, and configure it from a second terminal: see [Configure](configure.md).

## Remove it

1. Remove the service: `mission-agent service uninstall --root ~/agents/ada`.
2. Delete each secret: `mission-agent secret list --root ~/agents/ada`, then `mission-agent secret delete <id>` for each one.
3. Delete the root folder. This deletes your missions and their memory.
4. Delete `~/.mission-agent`, and the link to the command if the script made one. The script printed its path.

## A development copy

To work on the harness itself, build it from the source code:

```
git clone https://github.com/Gabriele333/mission-agent.git
cd mission-agent
npm install
npm run build
```

The program is then `node dist/cli.js` in that folder. Use a test root folder with it, never the root folder of a real agent. The `update` command refuses a development copy: update it with git.
