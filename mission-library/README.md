# Mission library

Missions that people publish for others to use. Each folder here is one mission.

This folder is the public library. It is not your agent's folder. The missions of your agent are in the `missions/` folder of its root, and a mission gets there by a copy from here.

The harness reads the library that came with the program you installed. A mission published after that release reaches you with the next update.

A mission holds text and settings, never code. It can only use the tools and triggers that your harness has.

## Use a mission

There are two ways. Both copy the mission into your agent, under the `id` written in its manifest.

In the chat, ask the mission admin what the library holds, or ask for a mission by name. Before the mission is added, you get an approval request with its whole manifest.

In a terminal:

```
mission-agent library list --root ~/agents/ada
mission-agent library add morning-news --root ~/agents/ada
```

`library add` shows what the mission is told on every run, when it runs and which tools it uses. It asks before it copies.

Read the `instructions` before you agree: they are what the model is told. A running harness finds the new mission without a restart. After the copy the mission is yours: change it by hand, or through the mission admin in the chat. An update of the program does not change it.

## Publish a mission

Open a pull request that adds one folder:

```
mission-library/
  <mission name>/
    manifest.yaml    required
    README.md        required
    skills/          optional
```

The rules:

- The folder name is the `name` in the manifest.
- The manifest is valid for the harness in this repository, with `version: 1` and `status: active`. The format is in the [design](../docs/design.md), §A.4.
- The `id` is new: `m_` plus 12 characters from `0123456789abcdefghjkmnpqrstvwxyz`. No other mission in the library has it.
- The manifest has no `gate:allow`. Whoever uses the mission decides which actions run without approval.
- The folder has no `memory/` and no `data/` folder, and no secret value. Your notes and your files stay with you.
- The `README.md` says what the mission does, when it runs, what it needs, and the command that adds it.
- The folder holds no link to another file or folder. A link is not copied.

`npm test` checks these rules for every folder here.
