# Update

An update replaces the program. Your agent's root folder stays, and your secrets stay in the Keychain.

The harness never updates itself. An update is new code with access to your credentials and tools, so you start it.

## How you learn about a release

Once a day the running harness asks the repository for its release tags. When a newer release exists, it tells you in the chat, once. The check sends nothing about you.

The dashboard shows the same in its Version part: the installed version, the newest release, when it was checked, and the notes of a newer release. "Check for updates" checks now.

## Run the update

There are two ways. Both do the same steps.

On the dashboard, press "Install version X". A progress page opens. It shows each step, what the update printed, and the result. When the update is finished, it links to the dashboard of the new version.

In a terminal:

```
mission-agent update --root ~/agents/ada
```

The update does these steps:

1. It looks for a newer release, and shows its version and its notes. With `--version`, it installs that release, which must be newer.
2. It asks you to confirm. With `--yes` it does not ask.
3. It gets the release, builds it in `~/.mission-agent/app.installing`, and tests it. The agent keeps running meanwhile. If a step fails, it removes the build and stops. Nothing was changed.
4. It stops the harness, when it runs as the service.
5. It copies the root folder to `backups/update/<old version>-<date>/` inside it. It keeps the last 2 copies.
6. It renames the old program to `~/.mission-agent/app.previous`, and puts the new one in `~/.mission-agent/app`.
7. It starts the harness, and checks that it answers with the new version.
8. If step 6 or 7 fails, it goes back. It renames the old program back, puts the copy of the root folder back when the new harness had started, starts the harness and checks that the old version answers.

If going back fails too, the update says to run `mission-agent repair`. The dashboard's progress page then shows a Repair button. See [Repair](#repair).

Keep the copies private: they hold the memory and the conversations of your missions.

The update refuses in four cases, and changes nothing. The dashboard's button is refused in the same cases, and says why.

- The program is a development copy, not an installed release. Update it with git.
- A harness for the root folder runs in a terminal. Stop it with Ctrl+C first.
- Another agent on this computer runs the same program as a service. Remove that service first, run the update for each agent, and install the services again.
- The installed program fails its own tests. Run `mission-agent repair` first.

Without the service, the update builds and tests the new program, and swaps it in. You then start the harness yourself.

What git and npm printed is in `~/.mission-agent/maintenance.log`.

## From version 0.1.x

Versions 0.1.x have no maintenance program. Their `update` command installs version 0.2.0 or later in the old way. The new harness then writes the maintenance program and the new command at its first start. From then on, `update` and `repair` go to the maintenance program.

## From version 0.2.0

Version 0.2.1 changes how the agent writes to you on Telegram. It no longer uses one thread for each mission. It writes in one chat, and a message from a mission other than the general mission starts with the mission's name. Each mission has its own command, such as `/inbox_curator`, and the bot's menu lists them. See [Telegram](configure.md#telegram).

Nothing in your root folder changes. The threads that the earlier version created stay in Telegram with their messages, and the harness deletes none of them. After the update, the agent sends you one message that explains this. It writes where you last wrote, so you can go on in an old thread or leave it. You can turn off Threaded Mode for the bot in BotFather, but you do not need to.

## Repair

```
mission-agent repair
```

Repair finds what is wrong with the installed program and fixes it. It asks before each fix. With `--yes`, it fixes without a question. It checks these things in order:

1. Node.js 24 or later, git and npm. It cannot fix these. It says how to get them.
2. An update that stopped half way, for example because the computer lost power. It finishes it or undoes it.
3. Folders that a past run left behind.
4. The program. When it does not work, repair puts back the version in `app.previous` if that one works. Otherwise it gets the installed version again, builds it, tests it, and puts it in place. The broken program is removed only after the new one passes.
5. The `mission-agent` command and its link.
6. The maintenance program, which must have the same version as the program.
7. Each service of the program. It installs it again when it is not loaded or its harness does not answer.
8. The data. When a harness still does not start, repair shows the newest copy of the root folder in `backups/update/` and asks whether to put it back. It asks each time, even with `--yes`. Putting it back replaces what changed since the copy.

It ends with "Everything is in order." or a list of what is still wrong.

When the command itself does not work, run the install script again. It builds a new maintenance program when the installed one does not run. See [Install](install.md).

## Go back to the old version

A new version can change the data when it starts, and no command changes it back. The copy of step 5 is the only way back for the data. The old program is in `~/.mission-agent/app.previous` until the next update.

1. Remove the service: `mission-agent service uninstall --root ~/agents/ada`. Or stop the harness with Ctrl+C.
2. Rename the program folders: `~/.mission-agent/app` to `~/.mission-agent/app.broken`, then `~/.mission-agent/app.previous` to `~/.mission-agent/app`.
3. Replace the content of the root folder with the copy, except its `backups/` folder.
4. Run `mission-agent repair`. It removes `app.broken`, and copies the maintenance program of the old version.
5. Start the harness: `mission-agent service install --root ~/agents/ada`, or `mission-agent start --root ~/agents/ada`.
6. Check it: `mission-agent status --root ~/agents/ada`. It must say that the harness is running, and list your missions with no error.

Without `app.previous`, get the old program with the install script: `./install.sh --version <old version> --reinstall`.
