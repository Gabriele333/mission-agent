# mission-agent

A mission-driven open source agent harness, built on the Claude Agent SDK.

One personal agent runs many **missions**. A mission is a module with one ongoing purpose, such as "curate my inbox" or "hire someone this month". Each mission has its own instructions, tools, memory, conversation and safety rules. Missions can be added, frozen and deleted, and they share one core: the harness, the triggers, the approval queue and the chat.

The design is in [docs/design.md](docs/design.md).

## Status

This is an early version. It has not been used as a daily agent yet.

Built and tested:

- The agent configuration and the mission manifests, with validation.
- One run of one mission through the SDK: its own prompt, memory folder, tools and session.
- The safety layer. A run reads only its own folder and `core/`. Every tool call passes one check. An action that changes something outside the agent waits for your approval.
- Triggers (a timer and the chat), triage of chat messages, and the commands `/mission`, `/stop`, `/pause` and `/resume`.
- The mission admin, a system mission that creates, edits, freezes and deletes missions from the chat. Every change waits for your approval.
- Secrets in the macOS Keychain.
- A chat in the terminal, a setup page and a dashboard. All three are local.
- The mission library: the `library` commands, and the mission admin's tools that list, read and add a published mission.
- The `check` command and the "Computer" part of the setup page. They read the settings of macOS that the agent depends on, and say what to change.
- The maintenance program, which installs, uninstalls, updates and repairs the program. It is copied outside the program folder, so it runs when the program is broken. A real install test runs the install script, git and npm against a test repository in every `npm test`. The update, a failed update, a killed update, a repair and the move from version 0.1.3 were also run on one Mac with a real service and the real `launchctl`.
- The daily check for a newer release, and the Version part of the dashboard, with its buttons "Check for updates" and "Install".

Built, but never run against the real service:

- The Telegram surface. Its tests use a fake Bot API. It has never met a real bot.
- The start of the macOS service at login, and its restart after a crash. Installing, starting, stopping and removing the service were run with the real `launchctl`. The restart after a crash could not be checked: on the test Mac, launchd started no service by itself ([Install](docs/install.md), "Start at login").
- The two web pages. Their scripts are tested in a fake DOM, and no person has looked at them in a browser.

Not built yet:

- The self-improvement loop of the design (chapter I), signals and the rating buttons.
- Any tool for an outside system, such as mail or a calendar. A developer adds a tool as code (design, §A.5).
- The data format number, and the `tools/` and `triggers/` folders for a user's own code (design, chapter 7).

## Documentation

- [Install](docs/install.md): what you need, the install script, and the service that starts the agent at login.
- [Configure](docs/configure.md): the model login, the secrets, Telegram and the missions.
- [Update](docs/update.md): how to move to a newer version, how to repair the program, and how to go back.
- [Mission library](mission-library/README.md): missions that people publish, how to add one to your agent, and how to publish yours.
- [Design](docs/design.md): how the harness works, and why.
- [Security](SECURITY.md): how to report a problem, and what the harness does not protect against.

You can use your own Claude plan, which is the default, or an API key from the Claude Console.

With a plan, you sign in on Anthropic's own page. The setup page starts Anthropic's own sign-in program, and that program opens the page in your browser. You can also run Anthropic's `claude auth login` command in a terminal instead. The harness shows no sign-in screen of its own. It reads nothing that the sign-in program prints and passes nothing to it. It never asks for the login of your plan, never reads it and never stores it. It sends no request through another server or another account. Claude Code, which comes with the Claude Agent SDK, runs on your computer and talks to Anthropic under your own plan and its limits. You need no other install of Claude Code.

Your use of Claude through this harness is under your own agreement with Anthropic. Anthropic decides what a plan may be used for, and it has changed those rules before: read its terms for the login you choose. Anthropic has not reviewed this project, and nothing here is a statement by Anthropic.

## No warranty

This is experimental software, and you use it at your own risk. It comes as it is, with no warranty of any kind, and its author is not liable for anything that comes from its use. The full terms are in [LICENSE](LICENSE).

An agent acts for you. It can spend money on model calls, send messages, change files and act in the outside systems that you connect. It can do the wrong thing. You decide what it may do, you approve its actions, and you carry the cost and the result of what it does. The tests check only the format of a mission in the mission library. Nobody promises that a mission is safe: read it before you add it.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Tests

```
npm test               # unit tests with a fake model, and the real install test (about a minute)
npm run typecheck
npm run test:install   # the real install test alone
npm run test:service   # the service with the real launchctl
npm run test:live      # calls the real model with your own login, and costs a little
```

The real install test runs `install.sh`, git and npm against a repository that it makes in a temporary folder. It installs no service. It needs the packages in the npm cache, or the network.

The service test installs and removes a service for a temporary folder. Set `MISSION_AGENT_LAUNCH_AGENTS` to a temporary folder to keep its file out of `~/Library/LaunchAgents`.

## Layout of the code

| Folder | What it holds |
| --- | --- |
| `src/config` | The agent configuration and the creation of the root folder |
| `src/manifest` | The manifest schema, its validation and the mission registry |
| `src/db` | The SQLite database: the logbook and the harness state |
| `src/safety` | The path rules, the gate and the approval queue |
| `src/secrets` | The Keychain, the redaction of secrets and the `secret` commands |
| `src/run` | One run of one mission through the SDK |
| `src/triggers`, `src/triage` | The timer, the scheduler, the classifier and the chat commands |
| `src/tools` | The tool catalog and the tools that come with the harness |
| `src/server`, `src/surfaces` | The local connection, the terminal chat and the Telegram surface |
| `src/harness` | Start-up, and the dispatcher that decides which run starts when |
| `src/pages`, `src/service` | The setup page, the dashboard and the macOS service |
| `src/maintenance` | The maintenance program: install, uninstall, update, repair, and the progress page of an update |
| `src/update`, `src/library` | The release check, the copies of the root folder made by an update, and the reader of the mission library |
| `src/system` | The checks of the computer's settings |
| `src/cli` | The command line program |
| `docs` | The documentation and the design |
| `mission-library` | Missions that people publish. The harness reads it, and copies a mission into an agent when asked |
| `install.sh` | The install script. It checks what the program needs, then runs the maintenance program |

## Licence

MIT. See [LICENSE](LICENSE). The Claude Agent SDK, which this project depends on, has its own terms.
