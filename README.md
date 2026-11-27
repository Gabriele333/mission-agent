# mission-agent

A mission-driven open source agent harness, built on the Claude Agent SDK.

One personal agent runs many **missions**. A mission is a module with one ongoing purpose, such as "curate my inbox" or "hire someone this month". Each mission has its own instructions, tools, memory, conversation and safety rules. Missions can be added, frozen and deleted, and they share one core: the harness, the triggers, the approval queue and the chat.

The design is in [docs/design.md](docs/design.md).

## Status

This is a first version. It is not released, and it has not been used as a daily agent yet.

Built and tested:

- The agent configuration and the mission manifests, with validation.
- One run of one mission through the SDK: its own prompt, memory folder, tools and session.
- The safety layer. A run reads only its own folder and `core/`. Every tool call passes one check. An action that changes something outside the agent waits for your approval.
- Triggers (a timer and the chat), triage of chat messages, and the commands `/mission`, `/stop`, `/pause` and `/resume`.
- The mission admin, a system mission that creates, edits, freezes and deletes missions from the chat. Every change waits for your approval.
- Secrets in the macOS Keychain.
- A chat in the terminal, a setup page and a dashboard. All three are local.

Built, but never run against the real service:

- The Telegram surface. Its tests use a fake Bot API. It has never met a real bot.
- The macOS service (a LaunchAgent). Its tests use a fake `launchctl`.
- The two web pages. Their scripts are tested in a fake DOM, and no person has looked at them in a browser.

Not built yet:

- The self-improvement loop of the design (chapter I), signals and the rating buttons.
- Any tool for an outside system, such as mail or a calendar. A developer adds a tool as code (design, §A.5).
- The `update` command, the data format number, and the `tools/` and `triggers/` folders for a user's own code (design, chapter 7).

## Documentation

- [Install](docs/install.md): what you need, and how to get the agent running.
- [Configure](docs/configure.md): the model login, the secrets, Telegram and the missions.
- [Update](docs/update.md): how to move to a newer version, and how to go back.
- [Mission library](mission-library/README.md): missions that people publish, and how to publish yours.
- [Design](docs/design.md): how the harness works, and why.

You can use an API key, or your own Claude plan. Your use of Claude through this harness is under your own agreement with Anthropic. Anthropic has not reviewed this project, and nothing here is a statement by Anthropic.

## Tests

```
npm test             # unit tests, with a fake model
npm run typecheck
npm run test:live    # calls the real model with your own login, and costs a little
```

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
| `src/cli` | The command line program |
| `docs` | The documentation and the design |
| `mission-library` | Missions that people publish. The program does not read it |

## Licence

MIT. See [LICENSE](LICENSE). The Claude Agent SDK, which this project depends on, has its own terms.
