import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { lstatSync, statSync, unlinkSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { z } from 'zod';
import type { Paths } from '../paths.js';
import { checkFilePath, resolveRealPath } from '../safety/index.js';
import type { MissionId, ToolContext, ToolDefinition } from '../types.js';
import {
  DELETE_FILE_TOOL,
  FILE_DELETE_ACTION,
  HARNESS_SERVER,
  MESSAGE_SEND_ACTION,
  mcpToolName,
  SEND_MESSAGE_TOOL,
} from './ids.js';
import { errorResult, errorText, okResult, type ToolResult } from './results.js';

/**
 * The message tool and the delete tool, which every mission has (§A.5, §C.5).
 * Both are on one MCP server, `harness`, so they are one tool definition:
 * two definitions would each return a server under the same key, and one would replace the other.
 */

function isInside(child: string, parent: string): boolean {
  return child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The real `data/` folder of the mission, or undefined when it does not lie inside the mission's folder. */
function realDataDir(paths: Paths, missionId: MissionId): string | undefined {
  const mission = resolveRealPath(paths.missionDir(missionId), sep);
  const data = resolveRealPath(paths.dataDir(missionId), sep);
  return isInside(data, mission) ? data : undefined;
}

export const sendMessageShape = {
  text: z.string().min(1).describe('The message for the user, in plain text.'),
  file: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional. A file to send with the message. It must be a file inside this mission's data/ folder, " +
        'given relative to the mission folder (such as "data/report.pdf") or as an absolute path.',
    ),
};

export const deleteFileShape = {
  path: z
    .string()
    .min(1)
    .describe(
      "The file to delete. It must be inside this mission's memory/ or data/ folder, " +
        'given relative to the mission folder (such as "memory/old-note.md") or as an absolute path. ' +
        'Folders cannot be deleted.',
    ),
};

export async function sendMessage(
  ctx: ToolContext,
  paths: Paths,
  args: { text: string; file?: string | undefined },
): Promise<ToolResult> {
  let filePath: string | undefined;
  if (args.file !== undefined) {
    const check = checkFilePath(paths, ctx.missionId, args.file, 'read');
    if (!check.ok) return errorResult(`The message was not sent. ${check.message}`);
    let data: string | undefined;
    try {
      data = realDataDir(paths, ctx.missionId);
    } catch (err) {
      return errorResult(`The message was not sent: the data folder could not be checked (${errorText(err)}).`);
    }
    if (data === undefined || !isInside(check.realPath, data)) {
      return errorResult(
        `The message was not sent: "${args.file}" is not inside this mission's data/ folder. ` +
          'Only a file from the data/ folder can be sent. Copy it there first.',
      );
    }
    let isFile = false;
    try {
      isFile = statSync(check.realPath).isFile();
    } catch {
      return errorResult(`The message was not sent: the file "${args.file}" does not exist.`);
    }
    if (!isFile) return errorResult(`The message was not sent: "${args.file}" is not a file.`);
    filePath = check.realPath;
  }
  try {
    await ctx.host.sendMessage(ctx.missionId, args.text, filePath);
  } catch (err) {
    return errorResult(`The message was not sent: ${errorText(err)}`);
  }
  return okResult(filePath === undefined ? 'The message was sent to the user.' : 'The message and the file were sent to the user.');
}

export async function deleteFile(ctx: ToolContext, paths: Paths, args: { path: string }): Promise<ToolResult> {
  const check = checkFilePath(paths, ctx.missionId, args.path, 'write');
  if (!check.ok) {
    return errorResult(
      `Deleting "${args.path}" is refused: a mission can delete only files inside its own memory/ and data/ folders. ` +
        `The path check said: ${check.message}`,
    );
  }
  const real = check.realPath;
  let isIndex: boolean;
  try {
    isIndex = real === resolveRealPath(paths.memoryIndexFile(ctx.missionId), sep);
  } catch (err) {
    return errorResult(`The file was not deleted: the path could not be checked (${errorText(err)}).`);
  }
  if (isIndex) {
    return errorResult(
      'The file was not deleted: MEMORY.md is the index of the memory folder. Edit it to remove lines instead.',
    );
  }
  let kind: 'file' | 'folder' | 'other';
  try {
    const st = lstatSync(real);
    kind = st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other';
  } catch {
    return errorResult(`The file was not deleted: "${args.path}" does not exist.`);
  }
  if (kind === 'folder') return errorResult(`"${args.path}" is a folder. The delete tool removes one file at a time.`);
  if (kind === 'other') return errorResult(`"${args.path}" is not a regular file, so it was not deleted.`);
  try {
    unlinkSync(real);
  } catch (err) {
    return errorResult(`The file was not deleted: ${errorText(err)}`);
  }
  if (!check.inMemory) return okResult(`Deleted ${args.path}.`);
  const memoryDir = resolveRealPath(paths.memoryDir(ctx.missionId), sep);
  const note = relative(memoryDir, real);
  return okResult(
    `Deleted ${args.path}. MEMORY.md was not changed: remove the line for ${note} from the index yourself.`,
  );
}

/** The SDK tool definitions of the `harness` server for one run. */
export function harnessSdkTools(ctx: ToolContext, paths: Paths) {
  return {
    sendMessage: tool(
      SEND_MESSAGE_TOOL,
      'Sends a message to the user, optionally with one file from this mission\'s data/ folder. ' +
        'Use it to report to the user during a run that a timer or an event started, where nobody reads the final text.',
      sendMessageShape,
      (args) => sendMessage(ctx, paths, args),
    ),
    deleteFile: tool(
      DELETE_FILE_TOOL,
      "Deletes one file inside this mission's memory/ or data/ folder. It never deletes a folder. " +
        'After deleting a note from memory/, remove its line from MEMORY.md.',
      deleteFileShape,
      (args) => deleteFile(ctx, paths, args),
    ),
  };
}

/** The always-on tool definition: the message tool and the delete tool. */
export function harnessTool(paths: Paths): ToolDefinition {
  return {
    operations: [
      // Sending only writes to the user (§A.5), so it needs no approval.
      { sdkToolName: mcpToolName(HARNESS_SERVER, SEND_MESSAGE_TOOL), action: MESSAGE_SEND_ACTION, effect: 'read' },
      // It changes only the mission's own folders, not something outside the agent. The path rules apply (§E.2.1).
      { sdkToolName: mcpToolName(HARNESS_SERVER, DELETE_FILE_TOOL), action: FILE_DELETE_ACTION, effect: 'read' },
    ],
    credentials: [],
    provide(ctx) {
      const t = harnessSdkTools(ctx, paths);
      const server = createSdkMcpServer({ name: HARNESS_SERVER, version: '1.0.0', tools: [t.sendMessage, t.deleteFile] });
      return { mcpServers: { [HARNESS_SERVER]: server } };
    },
  };
}
