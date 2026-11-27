# Mission library

Missions that people publish for others to use. Each folder here is one mission.

This folder is not part of the program, and it is not your agent's folder. The harness never reads it. You copy a mission from here into your own agent.

A mission holds text and settings, never code. It can only use the tools and triggers that your harness has.

## Use a mission

No command does this yet. You copy the folder by hand.

1. Read the mission's `manifest.yaml`. Its `instructions` are what the model is told, and its `triggers` say when it runs.
2. Copy the folder into your agent, under the `id` written in the manifest. That mission's `README.md` gives the exact command. For example:

   ```
   cp -R mission-library/morning-news ~/agents/ada/missions/m_4t8kx2n7w9qd
   mkdir -p ~/agents/ada/missions/m_4t8kx2n7w9qd/memory ~/agents/ada/missions/m_4t8kx2n7w9qd/data
   ```

3. Run `mission-agent status --root ~/agents/ada`. The mission is in the list, or the command says what is wrong with the file.

A running harness finds the new folder without a restart. After the copy the mission is yours: change it by hand, or through the mission admin in the chat.

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
- The `README.md` says what the mission does, when it runs, what it needs, and the copy command.

`npm test` checks these rules for every folder here.
