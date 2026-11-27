import { SYS_MISSION_ADMIN, type Manifest } from '../types.js';

/**
 * The general mission's manifest file (§4.1), written by `initRootFolder`.
 * It leaves out `tool:promotion_stage` and the sentence about staging facts for core memory,
 * because the self-improvement loop (§I) is not built yet.
 */
export const GENERAL_MANIFEST_YAML = `id: sys-general
name: sys-general
description: Handles any request that no other mission covers
version: 1
status: active

triggers:
  - use: trigger:chat                   # a chat message that fits no other mission (§B.3)

tools:
  - tool:web_search                     # search the web; it only reads (§A.5)
  - tool:web_fetch                      # read a web page; it only reads (§A.5)

context:
  instructions: |
    You are the general mission. You handle every request that no other
    mission covers.
    Done well means: the request is answered in full, and what you
    learn about the user's general preferences is saved as a note.

signals: []                             # no rating buttons under its answers (§A.4.7)

gates: []                               # the default applies: a changing action waits for approval (§D.3)

model: default
`;

/** The mission admin's manifest (§4.2). It is part of the code and has no file. */
export const MISSION_ADMIN_MANIFEST: Manifest = {
  id: SYS_MISSION_ADMIN,
  name: SYS_MISSION_ADMIN,
  description: 'Creates, edits, freezes and deletes missions, and adds missions from the mission library',
  version: 1,
  status: 'active',
  triggers: [{ use: 'trigger:chat' }],
  tools: ['tool:mission_registry'],
  context: {
    instructions: `You are the mission admin. You turn what the user asks for into a
mission manifest: name, description, triggers, tools, context,
signals, gates, model, effort and limits. Triggers, tools,
signals and gates use only ids that exist in the registry. You
write no code. The context holds the instructions. You may
suggest the rating signal to the user.
A mission can also come from the mission library, the published
missions that come with the harness. You add one as it is
published, when the user asks for it.
You cannot change the manifest of a system mission, your own
included. You may suggest a change to the user, and a developer
makes it.
Done well means: the manifest runs as the user intended on the first
try, uses the fewest tools that do the job, and has an allow gate only
where the user asked for one.
`,
  },
  signals: [],
  gates: [
    { use: 'gate:require_approval', for: 'action:registry.create' },
    { use: 'gate:require_approval', for: 'action:registry.edit' },
    { use: 'gate:require_approval', for: 'action:registry.freeze' },
    { use: 'gate:require_approval', for: 'action:registry.delete' },
  ],
  model: 'default',
};
