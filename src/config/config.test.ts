import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { pathsFor, type Paths } from '../paths.js';
import { DEFAULT_CORE_TEXT, defaultConfig } from './defaults.js';
import { ConfigError, createConfigHolder, loadConfig, writeConfig } from './load.js';

let root: string;
let paths: Paths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mission-agent-config-'));
  paths = pathsFor(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeYaml(text: string): void {
  writeFileSync(paths.agentYaml, text);
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('reports a file with too many YAML aliases as a ConfigError, and the holder keeps the last valid values', () => {
    writeYaml('agent_name: Ada\n');
    const holder = createConfigHolder(paths);
    expect(holder.current().config.agentName).toBe('Ada');
    writeYaml(`agent_name: &a Bob\nx: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\n`);
    expect(problemsOf(() => loadConfig(paths))[0]).toMatch(/could not be read as YAML: Excessive alias count/);
    expect(holder.reload()).toMatchObject({ ok: false });
    expect(holder.current().config.agentName).toBe('Ada');
  });

  it('applies every default of §A.1 when only agent_name is set', () => {
    writeYaml('agent_name: Ada\n');
    const { config } = loadConfig(paths);
    expect(config).toEqual(defaultConfig('Ada'));
    expect(config).toMatchObject({
      defaultSurface: 'terminal',
      modelLogin: 'subscription',
      defaultModel: 'claude-opus-5-5',
      defaultEffort: 'high',
      triageModel: 'claude-haiku-5-5',
      triageEffort: 'low',
      runLimits: { maxSteps: 50, maxCostUsd: 2, maxMinutes: 30 },
      maxCostPerDayUsd: 20,
      approvalWaitHours: 24,
      triageSwitchConfidence: 0.8,
      retriesAfterFailure: 1,
      maxIndexLineChars: 200,
      maxNoteBytes: 4096,
      coreMemoryMaxLines: 50,
      coreMemoryMaxLineChars: 200,
      maxInstructionsChars: 4000,
      maxDescriptionChars: 200,
    });
    expect(config.telegramUserId).toBeUndefined();
  });

  it('defaults the surface to telegram when telegram_user_id is set', () => {
    writeYaml('agent_name: Ada\ntelegram_user_id: 123456789\n');
    const { config } = loadConfig(paths);
    expect(config.defaultSurface).toBe('telegram');
    expect(config.telegramUserId).toBe(123456789);
  });

  it('keeps an explicit terminal surface when Telegram is set', () => {
    writeYaml('agent_name: Ada\ntelegram_user_id: 5\ndefault_surface: terminal\n');
    expect(loadConfig(paths).config.defaultSurface).toBe('terminal');
  });

  it('reads every key and fills a partial run_limits', () => {
    writeYaml(
      [
        'agent_name: Bob',
        'model_login: subscription',
        'run_limits:',
        '  max_steps: 10',
        'max_cost_per_day_usd: 5',
        'default_effort: max',
        'triage_switch_confidence: 0.5',
        'retries_after_failure: 0',
        '',
      ].join('\n'),
    );
    const { config } = loadConfig(paths);
    expect(config.modelLogin).toBe('subscription');
    expect(config.runLimits).toEqual({ maxSteps: 10, maxCostUsd: 2, maxMinutes: 30 });
    expect(config.maxCostPerDayUsd).toBe(5);
    expect(config.defaultEffort).toBe('max');
    expect(config.triageSwitchConfidence).toBe(0.5);
    expect(config.retriesAfterFailure).toBe(0);
  });

  it('uses the default core text with the agent name, and an empty note paragraph', () => {
    writeYaml('agent_name: Ada\n');
    const loaded = loadConfig(paths);
    expect(loaded.coreText).toBe(DEFAULT_CORE_TEXT.replace('{agent name}', 'Ada'));
    expect(loaded.coreText.startsWith('You are Ada, the personal agent of one user.')).toBe(true);
    expect(loaded.coreText).not.toContain('{agent name}');
    expect(loaded.noteParagraph).toBe('');
  });

  it('reads core-prompt.md and note-paragraph.md when they exist', () => {
    writeYaml('agent_name: Ada\n');
    writeFileSync(paths.corePromptFile, 'I am {agent name}. {agent name} works.\n');
    writeFileSync(paths.noteParagraphFile, 'Save a note when corrected.\n');
    const loaded = loadConfig(paths);
    expect(loaded.coreText).toBe('I am Ada. Ada works.');
    expect(loaded.noteParagraph).toBe('Save a note when corrected.');
  });

  it('requires the file', () => {
    expect(problemsOf(() => loadConfig(paths))[0]).toContain('agent.yaml does not exist');
  });

  it('requires agent_name', () => {
    writeYaml('default_effort: low\n');
    expect(problemsOf(() => loadConfig(paths))).toEqual(['agent_name is required.']);
    writeYaml('agent_name: "  "\n');
    expect(problemsOf(() => loadConfig(paths))).toEqual(['agent_name must not be empty.']);
    writeYaml('');
    expect(problemsOf(() => loadConfig(paths))[0]).toContain('agent_name is required');
  });

  it('rejects unknown keys, naming them', () => {
    writeYaml('agent_name: Ada\nfoo: 1\nrun_limits:\n  max_turns: 3\n');
    const problems = problemsOf(() => loadConfig(paths));
    expect(problems).toContain('Unknown key "foo".');
    expect(problems).toContain('Unknown key "max_turns" in run_limits.');
  });

  it('lists every problem in plain words', () => {
    writeYaml(
      [
        'agent_name: Ada',
        'default_effort: huge',
        'run_limits:',
        '  max_steps: 1.5',
        '  max_cost_usd: -1',
        'triage_switch_confidence: 2',
        'max_note_bytes: lots',
        'model_login: password',
        '',
      ].join('\n'),
    );
    const problems = problemsOf(() => loadConfig(paths));
    expect(problems).toEqual(
      expect.arrayContaining([
        'default_effort must be one of "low", "medium", "high", "xhigh", "max", but it is "huge".',
        'run_limits.max_steps must be a whole number, but it is 1.5.',
        'run_limits.max_cost_usd must be more than 0.',
        'triage_switch_confidence must be at most 1.',
        'max_note_bytes must be a number, but it is "lots".',
        'model_login must be one of "subscription", "api_key", but it is "password".',
      ]),
    );
    expect(problems).toHaveLength(6);
  });

  it('rejects a telegram surface without a Telegram account', () => {
    writeYaml('agent_name: Ada\ndefault_surface: telegram\n');
    expect(problemsOf(() => loadConfig(paths))).toEqual(['default_surface is telegram, but telegram_user_id is not set.']);
  });

  it('reports invalid YAML and a file that is not a mapping', () => {
    writeYaml('agent_name: [Ada\n');
    expect(problemsOf(() => loadConfig(paths))[0]).toContain('not valid YAML');
    writeYaml('- Ada\n');
    expect(problemsOf(() => loadConfig(paths))[0]).toContain('mapping of keys to values');
  });

  it('puts every problem in the error message', () => {
    writeYaml('agent_name: Ada\nfoo: 1\nbar: 2\n');
    expect(() => loadConfig(paths)).toThrow(/Unknown key "foo"\.\n- Unknown key "bar"\./);
  });
});

describe('writeConfig', () => {
  it('writes snake_case YAML that loads back to the same values', () => {
    const config = { ...defaultConfig('Ada'), telegramUserId: 42, defaultSurface: 'telegram' as const };
    writeConfig(paths, config);
    const text = readFileSync(paths.agentYaml, 'utf8');
    expect(text).toContain('agent_name: Ada');
    expect(text).toContain('telegram_user_id: 42');
    expect(text).toContain('run_limits:\n  max_steps: 50');
    expect(text).toContain('# Model of the triage classifier.');
    expect(text).not.toMatch(/agentName|runLimits/);
    expect(loadConfig(paths).config).toEqual(config);
  });

  it('writes only the known keys, so no other value reaches the file', () => {
    const config = { ...defaultConfig('Ada'), apiKey: 'sk-secret-value' } as ReturnType<typeof defaultConfig>;
    writeConfig(paths, config);
    const text = readFileSync(paths.agentYaml, 'utf8');
    expect(text).not.toContain('sk-secret-value');
    expect(text).not.toContain(root);
    const data = YAML.parse(text) as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain('api_key');
  });

  it('omits telegram_user_id when it is not set', () => {
    writeConfig(paths, defaultConfig('Ada'));
    expect(readFileSync(paths.agentYaml, 'utf8')).not.toContain('telegram_user_id');
  });

  it('refuses an invalid configuration and writes nothing', () => {
    expect(() => writeConfig(paths, { ...defaultConfig('Ada'), triageSwitchConfidence: 3 })).toThrow(ConfigError);
    expect(() => readFileSync(paths.agentYaml)).toThrow();
  });
});

describe('createConfigHolder', () => {
  it('reports whether the file exists', () => {
    const holder = createConfigHolder(paths);
    expect(holder.exists()).toBe(false);
    writeYaml('agent_name: Ada\n');
    expect(holder.exists()).toBe(true);
  });

  it('throws on current() when the file was never valid', () => {
    const holder = createConfigHolder(paths);
    expect(() => holder.current()).toThrow(ConfigError);
    expect(holder.lastError()).toContain('agent.yaml does not exist');
  });

  it('keeps the last valid values when the file becomes invalid', () => {
    writeYaml('agent_name: Ada\nmax_cost_per_day_usd: 7\n');
    const holder = createConfigHolder(paths);
    expect(holder.current().config.maxCostPerDayUsd).toBe(7);

    writeYaml('agent_name: Ada\nmax_cost_per_day_usd: nothing\n');
    const result = holder.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('max_cost_per_day_usd must be a number');
    expect(holder.current().config.maxCostPerDayUsd).toBe(7);
    expect(holder.lastError()).toContain('max_cost_per_day_usd');

    writeYaml('agent_name: Ada\nmax_cost_per_day_usd: 9\n');
    expect(holder.reload()).toEqual({ ok: true });
    expect(holder.current().config.maxCostPerDayUsd).toBe(9);
    expect(holder.lastError()).toBeUndefined();
  });

  it('picks up a changed core text on reload', () => {
    writeYaml('agent_name: Ada\n');
    const holder = createConfigHolder(paths);
    expect(holder.current().coreText).toBe(DEFAULT_CORE_TEXT.replace('{agent name}', 'Ada'));
    writeFileSync(paths.corePromptFile, 'Hello {agent name}');
    holder.reload();
    expect(holder.current().coreText).toBe('Hello Ada');
  });
});
