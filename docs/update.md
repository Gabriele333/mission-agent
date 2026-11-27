# Update

An update replaces the program. Your agent's root folder stays, and your secrets stay in the Keychain.

The harness never updates itself. An update is new code with access to your credentials and tools, so you start it.

## How you learn about a release

Once a day the running harness asks the repository for its release tags. When a newer release exists, it tells you in the chat, once, with the command to run. The check sends nothing about you.

## Run the update

```
mission-agent update --root ~/agents/ada
```

The command does these steps:

1. It looks for a newer release, and shows its version and its notes.
2. It asks you to confirm. With `--yes` it does not ask.
3. It stops the harness, when it runs as the service.
4. It copies the root folder to `backups/update/<old version>-<date>/` inside it. It keeps the last 2 copies.
5. It installs the new release in the program folder.
6. It starts the harness.
7. It checks that the harness answers and reports the new version.
8. If a step from 5 to 7 fails, it installs the old release again and starts the harness. It puts the copy back when the new harness had started.

Keep the copies private: they hold the memory and the conversations of your missions.

The command refuses in three cases, and changes nothing:

- The program is a development copy, not an installed release. Update it with git.
- A harness for the root folder runs in a terminal. Stop it with Ctrl+C first.
- Another agent on this computer runs the same program as a service. Remove that service first, run the update for each agent, and install the services again.

Without the service, the command installs the release and checks that the new program starts. You then start the harness yourself.

## Go back to the old version

A new version can change the data when it starts, and no command changes it back. The copy of step 4 is the only way back.

1. Remove the service: `mission-agent service uninstall --root ~/agents/ada`. Or stop the harness with Ctrl+C.
2. In the program folder, `~/.mission-agent/app`, run `git checkout <old version>`, such as `git checkout v0.1.0`. Then run `npm ci` and `npm run build`.
3. Replace the content of the root folder with the copy, except its `backups/` folder.
4. Start the harness: `mission-agent service install --root ~/agents/ada`, or `mission-agent start --root ~/agents/ada`.
5. Check it: `mission-agent status --root ~/agents/ada`. It must say that the harness is running, and list your missions with no error.
