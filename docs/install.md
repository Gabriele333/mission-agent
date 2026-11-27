# Install

No release exists yet, so you install from the source code. The install with one command is designed ([design](design.md), chapter 7) and not built.

## What you need

- macOS. Secrets are stored in the login Keychain.
- Node.js 24 or later, and git.
- A way to reach Claude: an API key from the Claude Console, or your own Claude plan. A plan also needs Claude Code installed, for its `claude` command.

## 1. Get the program

```
git clone https://github.com/Gabriele333/mission-agent.git
cd mission-agent
npm install
npm run build
```

The program is now `node dist/cli.js` in this folder. These pages write `mission-agent` for it. To get that command, add one line to `~/.zshrc`, with the real path of your copy:

```
alias mission-agent="node /path/to/mission-agent/dist/cli.js"
```

Keep the folder where it is. The service (step 4) records its path.

## 2. Choose the agent's folder

The program and your agent's data are in two places. The data is in one folder that you choose, called the root folder. It holds the configuration, the missions, their memory and the database.

Every command takes it as `--root`. Without `--root`, a command uses `~/mission-agent`. The examples use `~/agents/ada`.

## 3. Start it

```
mission-agent start --root ~/agents/ada
```

This creates the folder and runs the harness until Ctrl+C. The first time it starts paused, because nothing is configured. Leave it running, and configure it from a second terminal: see [Configure](configure.md).

## 4. Start it at login

When the agent is configured, install it as a service of your account. The command shows what it writes before it writes it.

```
mission-agent service install --root ~/agents/ada
mission-agent service status --root ~/agents/ada
```

Stop the foreground harness of step 3 first: one root folder runs one harness.

## Remove it

1. Remove the service: `mission-agent service uninstall --root ~/agents/ada`.
2. Delete each secret: `mission-agent secret list --root ~/agents/ada`, then `mission-agent secret delete <id>` for each one.
3. Delete the root folder. This deletes your missions and their memory.
4. Delete the program folder and the alias.
