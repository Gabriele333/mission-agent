import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Paths } from '../paths.js';
import type {
  AgentConfig,
  CodeCatalog,
  Manifest,
  ManifestDraft,
  ManifestError,
  MissionId,
  MissionRegistry,
  MissionStatus,
} from '../types.js';
import { CODE_ONLY_SYSTEM_IDS, generateMissionId, isSystemMissionId, MISSION_ID_RE } from './ids.js';
import { checkManifestData, parseManifestText } from './schema.js';
import { commandProblem } from '../triage/mission-commands.js';
import { validateManifest } from './validate.js';
import { bumpVersionText, manifestToPlain, serializeManifest, updateManifestText } from './yaml-write.js';

export interface MissionRegistryOptions {
  paths: Paths;
  catalog: CodeCatalog;
  config: () => AgentConfig;
  /** Manifests that are part of the code, such as the mission admin's. Never read from or written to a file. */
  codeManifests: Manifest[];
  /** Remembers the content hash of each manifest file between scans. */
  memory: { get(key: string): string | undefined; set(key: string, value: string): void };
  /** Wait after a file change before the registry scans again. Default 200 ms. */
  watchDebounceMs?: number;
}

export interface WatchingMissionRegistry extends MissionRegistry {
  /** Scans again when a file under `missions/` changes. */
  watch(): void;
  stopWatching(): void;
}

/** A manifest given to create or edit is invalid. Nothing was written. */
export class ManifestValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The manifest is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ManifestValidationError';
    this.problems = problems;
  }
}

/** The operation is not allowed on a system mission (§4). */
export class SystemMissionError extends Error {
  constructor(id: MissionId, operation: string) {
    super(`${id} is a system mission and cannot be ${operation}. Only a developer changes it, in the code.`);
    this.name = 'SystemMissionError';
  }
}

export class MissionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionNotFoundError';
  }
}

const HASH_KEY_PREFIX = 'manifest_hash:';
const MANIFEST_FILE = 'manifest.yaml';

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** System missions first, then by name. */
function compareManifests(a: Manifest, b: Manifest): number {
  const sa = isSystemMissionId(a.id) ? 0 : 1;
  const sb = isSystemMissionId(b.id) ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

interface Candidate {
  manifest: Manifest;
  source: string;
  /** Set for a manifest read from a file. */
  file?: { path: string; text: string };
}

export function createMissionRegistry(options: MissionRegistryOptions): WatchingMissionRegistry {
  const { paths, catalog, memory } = options;
  const debounceMs = options.watchDebounceMs ?? 200;
  const codeIds = new Set(options.codeManifests.map((m) => m.id));

  let valid = new Map<MissionId, Manifest>();
  let sorted: Manifest[] = [];
  let errs: ManifestError[] = [];
  let fingerprint = JSON.stringify({ sorted, errs });
  const fileTexts = new Map<MissionId, string>();
  const listeners: (() => void)[] = [];
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  const ctx = () => ({ catalog, config: options.config() });
  const relSource = (dir: string) => `missions/${dir}/${MANIFEST_FILE}`;

  /** Schema and catalog checks for a manifest object. Does not check the name against other missions. */
  function check(data: unknown): { manifest?: Manifest; problems: string[] } {
    const parsed = checkManifestData(data);
    if (!parsed.ok) return { problems: parsed.errors };
    const problems = validateManifest(parsed.manifest, ctx());
    return problems.length > 0 ? { problems } : { manifest: parsed.manifest, problems: [] };
  }

  function nameUser(name: string, exceptId: MissionId | undefined): Manifest | undefined {
    for (const m of valid.values()) if (m.name === name && m.id !== exceptId) return m;
    return undefined;
  }

  function scan(): { candidates: Candidate[]; errors: ManifestError[] } {
    const candidates: Candidate[] = [];
    const errors: ManifestError[] = [];

    for (const cm of options.codeManifests) {
      const { manifest, problems } = check(manifestToPlain(cm));
      if (manifest === undefined) for (const message of problems) errors.push({ source: cm.id, message });
      else candidates.push({ manifest, source: cm.id });
    }

    if (!existsSync(paths.missionsDir)) return { candidates, errors };
    const dirs = readdirSync(paths.missionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const dir of dirs) {
      const source = relSource(dir);
      const file = join(paths.missionsDir, dir, MANIFEST_FILE);
      if (!existsSync(file)) {
        // The folders of the mission admin and of self-improve hold no manifest (§4).
        if (!isSystemMissionId(dir) && !codeIds.has(dir)) {
          errors.push({ source: `missions/${dir}`, message: `The folder has no ${MANIFEST_FILE}.` });
        }
        continue;
      }
      // An error in one file, of any kind, stops only that mission (§A.4, §H).
      try {
        const text = readFileSync(file, 'utf8');
        const parsed = parseManifestText(text);
        if (!parsed.ok) {
          for (const message of parsed.errors) errors.push({ source, message });
          continue;
        }
        const m = parsed.manifest;
        const problems: string[] = [];
        if (m.id !== dir) problems.push(`id "${m.id}" must be the same as the folder name "${dir}".`);
        if (CODE_ONLY_SYSTEM_IDS.includes(m.id) || codeIds.has(m.id)) {
          problems.push(`The manifest of ${m.id} is part of the harness code. This file is not used.`);
        }
        problems.push(...validateManifest(m, ctx()));
        if (problems.length > 0) {
          for (const message of problems) errors.push({ source, message });
          continue;
        }
        candidates.push({ manifest: m, source, file: { path: file, text } });
      } catch (err) {
        errors.push({ source, message: `The file could not be read: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { candidates, errors };
  }

  /** The version rule of §A.4: a file whose content changed since the last scan gets version + 1. */
  function applyVersionRule(c: Candidate & { file: { path: string; text: string } }): void {
    const key = HASH_KEY_PREFIX + c.manifest.id;
    const previous = memory.get(key);
    let text = c.file.text;
    let hash = hashOf(text);
    if (previous !== undefined && previous !== hash) {
      const version = c.manifest.version + 1;
      const bumped = { ...c.manifest, version };
      text = bumpVersionText(text, version) ?? updateManifestText(text, bumped);
      writeAtomic(c.file.path, text);
      c.manifest = bumped;
      hash = hashOf(text);
    }
    if (previous !== hash) memory.set(key, hash);
    c.file.text = text;
  }

  function writeIndex(list: Manifest[]): void {
    if (!existsSync(paths.missionsDir)) return;
    const lines = [
      '# Missions',
      '',
      'Generated by the harness from the manifests. Do not edit.',
      '',
      ...list.map((m) => `${m.id} → ${m.name} (${m.status})`),
      '',
    ];
    const text = lines.join('\n');
    const current = existsSync(paths.missionsIndexFile) ? readFileSync(paths.missionsIndexFile, 'utf8') : undefined;
    if (current !== text) writeAtomic(paths.missionsIndexFile, text);
  }

  function reload(): void {
    const { candidates, errors } = scan();

    // A name already in use rejects the second manifest. The code manifests come first,
    // then a mission that already had this name, so a rename cannot push out the current owner.
    const rank = (c: Candidate) => (c.file === undefined ? 0 : valid.get(c.manifest.id)?.name === c.manifest.name ? 1 : 2);
    const ordered = [...candidates].sort((a, b) => rank(a) - rank(b) || (a.manifest.id < b.manifest.id ? -1 : 1));
    const byName = new Map<string, MissionId>();
    const accepted: Candidate[] = [];
    for (const c of ordered) {
      const owner = byName.get(c.manifest.name);
      if (owner !== undefined) {
        errors.push({ source: c.source, message: `name "${c.manifest.name}" is already used by mission ${owner}.` });
        continue;
      }
      byName.set(c.manifest.name, c.manifest.id);
      accepted.push(c);
    }

    const next = new Map<MissionId, Manifest>();
    fileTexts.clear();
    for (const c of accepted) {
      if (c.file !== undefined) {
        applyVersionRule(c as Candidate & { file: { path: string; text: string } });
        fileTexts.set(c.manifest.id, c.file.text);
      }
      next.set(c.manifest.id, c.manifest);
    }

    valid = next;
    sorted = [...next.values()].sort(compareManifests);
    errs = errors;
    writeIndex(sorted);

    const nextFingerprint = JSON.stringify({ sorted, errs });
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      for (const listener of listeners) listener();
    }
  }

  function guardSystem(id: MissionId, operation: string): void {
    if (isSystemMissionId(id) || id.startsWith('sys-') || codeIds.has(id)) throw new SystemMissionError(id, operation);
  }

  function requireValid(id: MissionId): Manifest {
    const m = valid.get(id);
    if (m !== undefined) return m;
    const problems = errs.filter((e) => e.source === relSource(id));
    if (problems.length > 0) {
      throw new MissionNotFoundError(
        `Mission ${id} is not loaded because its manifest is invalid: ${problems.map((p) => p.message).join(' ')} Fix the file first.`,
      );
    }
    throw new MissionNotFoundError(`There is no mission with id ${id}.`);
  }

  /**
   * Validates a full manifest for a write. Throws a ManifestValidationError and writes nothing.
   * A new name must also give a chat command (§B.1). Loading a manifest from its file does not
   * check that, so an agent whose mission has a longer or clashing name still starts.
   */
  function checkForWrite(data: Record<string, unknown>, selfId: MissionId | undefined, newName: boolean): Manifest {
    const { manifest, problems } = check(data);
    if (manifest === undefined) throw new ManifestValidationError(problems);
    const owner = nameUser(manifest.name, selfId);
    if (owner !== undefined) {
      throw new ManifestValidationError([`name "${manifest.name}" is already used by mission ${owner.id}.`]);
    }
    const commandIssue = newName ? commandProblem(manifest.name) : undefined;
    if (commandIssue !== undefined) throw new ManifestValidationError([commandIssue]);
    return manifest;
  }

  function writeManifest(m: Manifest, text: string): void {
    writeAtomic(paths.manifestFile(m.id), text);
    memory.set(HASH_KEY_PREFIX + m.id, hashOf(text));
  }

  function create(draft: ManifestDraft): Manifest {
    reload();
    let id = generateMissionId();
    while (existsSync(paths.missionDir(id)) || valid.has(id)) id = generateMissionId();
    const manifest = checkForWrite({ ...draft, id, version: 1, status: draft.status ?? 'active' }, undefined, true);
    mkdirSync(paths.memoryDir(id), { recursive: true });
    mkdirSync(paths.dataDir(id), { recursive: true });
    mkdirSync(paths.skillsDir(id), { recursive: true });
    writeFileSync(paths.memoryIndexFile(id), '');
    writeManifest(manifest, serializeManifest(manifest));
    reload();
    return structuredClone(manifest);
  }

  function install(sourceDir: string): Manifest {
    reload();
    let text: string;
    try {
      text = readFileSync(join(sourceDir, MANIFEST_FILE), 'utf8');
    } catch {
      throw new MissionNotFoundError(`${sourceDir} holds no ${MANIFEST_FILE}.`);
    }
    const parsed = parseManifestText(text);
    if (!parsed.ok) throw new ManifestValidationError(parsed.errors);
    const { id } = parsed.manifest;
    guardSystem(id, 'added');
    if (!MISSION_ID_RE.test(id)) throw new ManifestValidationError([`id "${id}" is not the id of a mission.`]);
    const present = valid.get(id);
    if (present !== undefined || existsSync(paths.missionDir(id))) {
      throw new ManifestValidationError([
        `This agent already has a mission with the id ${id}${present === undefined ? '' : `, named ${present.name}`}. Nothing was added.`,
      ]);
    }
    // Whoever uses a published mission decides which actions run without approval.
    if (parsed.manifest.gates.some((g) => g.use === 'gate:allow')) {
      throw new ManifestValidationError(['A mission that is added with its files must have no gate:allow.']);
    }
    const manifest = checkForWrite(manifestToPlain(parsed.manifest), undefined, true);
    mkdirSync(paths.memoryDir(id), { recursive: true });
    mkdirSync(paths.dataDir(id), { recursive: true });
    mkdirSync(paths.skillsDir(id), { recursive: true });
    writeFileSync(paths.memoryIndexFile(id), '');
    // The file keeps its text, with its comments.
    writeManifest(manifest, text);
    // A link could lead outside the mission's folder, so none is copied.
    const noLinks = (src: string) => !lstatSync(src).isSymbolicLink();
    const readme = join(sourceDir, 'README.md');
    if (existsSync(readme) && noLinks(readme)) cpSync(readme, join(paths.missionDir(id), 'README.md'));
    const skills = join(sourceDir, 'skills');
    if (existsSync(skills) && noLinks(skills)) cpSync(skills, paths.skillsDir(id), { recursive: true, filter: noLinks });
    reload();
    return structuredClone(manifest);
  }

  function edit(id: MissionId, patch: Partial<ManifestDraft>, operation = 'edited'): Manifest {
    guardSystem(id, operation);
    reload();
    const current = requireValid(id);
    const data: Record<string, unknown> = manifestToPlain(current);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'version') continue;
      if (value === undefined) delete data[key];
      else data[key] = value;
    }
    const next = checkForWrite(data, id, data.name !== current.name);
    if (isDeepStrictEqual(manifestToPlain(next), manifestToPlain(current))) return structuredClone(current);
    next.version = current.version + 1;
    writeManifest(next, updateManifestText(fileTexts.get(id), next));
    reload();
    return structuredClone(next);
  }

  function remove(id: MissionId): void {
    guardSystem(id, 'removed');
    reload();
    if (!MISSION_ID_RE.test(id) || !existsSync(paths.missionDir(id))) {
      throw new MissionNotFoundError(`There is no mission with id ${id}.`);
    }
    rmSync(paths.missionDir(id), { recursive: true, force: true });
    reload();
  }

  function isRelevant(filename: string | null): boolean {
    if (filename === null) return true;
    const parts = filename.split(/[\\/]/);
    if (parts.length === 1) return parts[0] !== 'INDEX.md' && !filename.endsWith('.tmp');
    return parts.length === 2 && parts[1] === MANIFEST_FILE;
  }

  function scheduleReload(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        reload();
      } catch (e) {
        errs = [...errs, { source: 'missions', message: `The scan failed: ${e instanceof Error ? e.message : String(e)}` }];
      }
    }, debounceMs);
  }

  return {
    list: () => sorted.map((m) => structuredClone(m)),
    get: (id) => {
      const m = valid.get(id);
      return m === undefined ? undefined : structuredClone(m);
    },
    getByName: (name) => {
      const m = nameUser(name, undefined);
      return m === undefined ? undefined : structuredClone(m);
    },
    errors: () => errs.map((e) => ({ ...e })),
    reload,
    onChange: (listener) => {
      listeners.push(listener);
    },
    create,
    install,
    edit: (id, patch) => edit(id, patch),
    setStatus: (id: MissionId, status: MissionStatus) => edit(id, { status }, status === 'frozen' ? 'frozen' : 'changed'),
    remove,
    watch() {
      if (watcher !== undefined) return;
      mkdirSync(paths.missionsDir, { recursive: true });
      watcher = watch(paths.missionsDir, { recursive: true }, (_event, filename) => {
        if (isRelevant(filename)) scheduleReload();
      });
      watcher.on('error', () => {
        // The folder may have been removed. Stop watching; a later watch() starts again.
        watcher?.close();
        watcher = undefined;
      });
      // On macOS the watcher misses changes made in the first moments after it starts. One scan covers them.
      scheduleReload();
    },
    stopWatching() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}
