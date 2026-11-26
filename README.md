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

## Requirements

- macOS. Secrets are stored in the login Keychain.
- Node.js 24 or later.
- A way to reach Claude: an API key from the Claude Console, or your own Claude plan (see "Model login").

## Build

```
git clone https://github.com/Gabriele333/mission-agent.git
cd mission-agent
npm install
npm run build
```

The program is then `node dist/cli.js`. The examples below write `mission-agent` for it.

## First start

Choose a folder for your agent. It will hold the configuration, the missions, their memory and the database. Every command takes it as `--root`. Without `--root`, the commands use `~/mission-agent`.

```
mission-agent init --name Ada --root ~/agents/ada
mission-agent start --root ~/agents/ada
```

`start` runs the harness in the foreground until Ctrl+C. It starts paused when something is missing, and says what. In a second terminal:

```
mission-agent setup --root ~/agents/ada      # the setup page
mission-agent chat --root ~/agents/ada       # the chat
mission-agent dashboard --root ~/agents/ada  # the dashboard
mission-agent status --root ~/agents/ada
```

To let the harness start at login, install it as a service. The command shows what it will write before it writes it.

```
mission-agent service install --root ~/agents/ada
```

## Model login

The harness supports two logins. You choose one in the setup page or in `agent.yaml`.

- **An API key.** Store it with `mission-agent secret set credential:model.api_key`. The value is asked with hidden input and goes to the Keychain.
- **Your own Claude plan.** You sign in to Claude Code yourself, with Anthropic's own command. `mission-agent login-help` prints that command for your folder. The harness shows no sign-in screen. It never asks for the token of your plan, never reads it and never stores it.

Your use of Claude through this harness is under your own agreement with Anthropic. Read Anthropic's terms for the login you choose. Anthropic has not reviewed this project, and nothing here is a statement by Anthropic.

## Secrets

A secret value is never accepted in the chat, and it is never written to a file. Three commands manage secrets:

```
mission-agent secret set <id>
mission-agent secret delete <id>
mission-agent secret list
```

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

## Licence

MIT. See [LICENSE](LICENSE). The Claude Agent SDK, which this project depends on, has its own terms.
