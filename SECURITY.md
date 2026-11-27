# Security

This program runs an agent on your computer. The agent holds your credentials and can act for you. Read this page before you rely on it.

## Report a problem

Report a security problem in private. Do not open a public issue for it.

Use the "Report a vulnerability" button on the Security tab of this repository. It sends the report to the maintainer only.

Say what you did, what happened, and which version you used (`mission-agent --version`). Leave out every secret value. If the report needs one, replace it with a made-up value of the same shape.

This project has one maintainer and no paid support. A report is answered as time allows, and no date is promised for an answer or for a fix.

## Which versions get fixes

Only the newest release. A fix comes as a new release, and you install it with `mission-agent update`.

## What counts as a security problem

Any way around a rule that the design states. For example:

- A run reads or writes a file outside its own mission folder and `core/`.
- An action that changes something outside the agent runs without your approval, when no `gate:allow` covers it.
- A request for approval shows something other than what then runs.
- The value of a credential appears in a prompt, a memory note, the logbook, a log file, a web page or a chat message.
- The local web pages or the local connection answer without the access token, or answer another computer.
- The install script, the maintenance program or the `update` command runs code that is not from the release it names. This covers the Install button of the dashboard, which starts the maintenance program.
- The Install button, or the progress page of an update, can be used without the access token, or from a tool of the agent.
- A mission added from the mission library does more than its manifest shows.
- Text that comes from outside, such as a web page or a message, makes the harness itself skip one of these rules.

## What the harness does not protect against

These are limits of the design, not faults to report:

- **Anyone who can use your macOS account.** They can read the root folder, the Keychain and the access token. The harness adds no protection against your own account.
- **What the model decides.** The harness checks every tool call against its rules. It does not judge whether an action that you approved was a good idea. Text from outside can still mislead the model into asking for a bad action. The approval request is your check.
- **A shell command that you approve.** A mission has no shell tool unless its manifest lists one. A shell command can read or change any file your account can, and the harness cannot check it. Every one waits for your approval.
- **An action that you allowed in advance.** A `gate:allow` in a manifest lets that action run without asking.
- **Your own tools and triggers.** Code in the `tools/` and `triggers/` folders runs inside the harness with the harness's own access. The harness does not isolate it.
- **Automatic login.** With automatic login, the disk is not encrypted and the session is open to anyone at the computer. The `check` command says so, and the choice is yours.
- **The services that the agent uses.** The Claude Agent SDK, the model, Telegram and every outside system have their own security. Report a problem in one of them to its owner.

## No warranty

The software comes as it is, with no warranty of any kind. See [LICENSE](LICENSE). You decide what the agent may do, and you carry the risk and the cost of what it does.
