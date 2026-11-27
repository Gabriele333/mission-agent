# Configure

The configuration is in the agent's root folder ([Install](install.md), "The agent's folder"). Secrets are in the macOS Keychain, never in a file. The harness reads a change without a restart.

You configure the agent in the setup page, or by hand.

## The setup page

The harness must be running. Then:

```
mission-agent setup --root ~/agents/ada
```

The page opens in the browser. It asks for the agent name, the model login, Telegram (you can skip it), the limits and the service. Its last step shows the settings of the computer. It saves each answer when you give it. The harness ends its pause when the name and the model login are present.

The last step shows whether the settings of macOS that the agent depends on are in order, such as the service, the Keychain, sleep and automatic login. Check the box "This computer runs the agent with nobody at it" if nobody sits at the computer. The settings that such a computer needs then count as problems. You can finish the first setup with a problem still open, because some changes need you to log out first. The page says which problems are still open.

After the first setup, the page shows the same list in its part named "Computer". The page reads the settings again every minute, and it changes none of them. See [Install](install.md), "Check the computer".

## By hand

```
mission-agent init --name Ada --root ~/agents/ada
```

This writes `agent.yaml` in the root folder. Add `--login subscription` to use your Claude plan. Then edit the file. Each key has a comment above it.

The keys you are most likely to change:

| Key | Meaning | Default |
| --- | --- | --- |
| `agent_name` | The name of the agent. Required. | none |
| `model_login` | `api_key` or `subscription`. | `api_key` |
| `default_surface` | Where the agent writes to you: `terminal` or `telegram`. | `terminal`, or `telegram` when Telegram is set |
| `default_model` | The model of a mission that sets none. | `claude-opus-5-5` |
| `max_cost_per_day_usd` | The cost limit per day, for the whole agent. | 20 |
| `run_limits` | The limits of one run: `max_steps`, `max_cost_usd`, `max_minutes`. | 50, 2, 30 |
| `approval_wait_hours` | How long an action waits for your approval before it is cancelled. | 24 |

The other keys are in the [design](design.md), §A.1. If the file becomes invalid, the harness keeps the last valid values and tells you the error.

Every mission also reads one core text. You change it in the setup page, or in the file `core-prompt.md` in the root folder. Without that file, the harness uses its default text.

## Model login

Choose one.

With an API key, store the key. The value is asked with hidden input.

```
mission-agent secret set credential:model.api_key --root ~/agents/ada
```

With your own Claude plan, set `model_login: subscription`. Then run the command that this prints:

```
mission-agent login-help --root ~/agents/ada
```

It is Anthropic's own sign-in command of Claude Code, for this agent's folder. The harness shows no sign-in screen. It never asks for the token of your plan, never reads it and never stores it.

Nothing is sent through anyone else. Claude Code runs on your computer and talks to Anthropic with your own sign-in. The runs draw from the limits of your own plan. The author of this program has no part in that connection, and receives nothing from it.

Your use of Claude through this harness is under your own agreement with Anthropic. Read Anthropic's terms for the login you choose. Anthropic has not reviewed this project.

## Secrets

```
mission-agent secret set <id> --root ~/agents/ada
mission-agent secret delete <id> --root ~/agents/ada
mission-agent secret list --root ~/agents/ada
```

`secret list` shows each secret that your agent needs and whether it has a value. Never type a secret value in the chat.

## Telegram

Telegram is optional. Without it you chat in the terminal: `mission-agent chat --root ~/agents/ada`.

1. Create a bot with BotFather in Telegram.
2. Store its token: `mission-agent secret set credential:telegram.bot_token --root ~/agents/ada`.
3. Open the Telegram part of the setup page. It shows a code. Send the code to your bot.

The Telegram part has only been tested with a fake Telegram service so far.

## Missions

A new agent has two missions: the general mission, and the mission admin. You get more in three ways:

- Ask in the chat, for example "create a mission that sends me the news each morning". The mission admin writes it, and every change waits for your approval.
- Add one that someone published. Ask the mission admin for it in the chat, or run `mission-agent library add <name> --root ~/agents/ada`. See the [mission library](../mission-library/README.md).
- Edit a `missions/<id>/manifest.yaml` file by hand. The harness reads the change and reports an error in the file.

## Check it

```
mission-agent status --root ~/agents/ada
mission-agent dashboard --root ~/agents/ada
```

`status` says whether the harness runs and why it is paused. The dashboard shows the missions, the runs, the cost and the waiting approvals.
