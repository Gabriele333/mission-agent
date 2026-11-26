import { describe, expect, it } from 'vitest';
import { pathsFor } from './paths.js';

describe('pathsFor', () => {
  it('puts every path inside the root folder', () => {
    const p = pathsFor('/tmp/agent');
    expect(p.dbFile).toBe('/tmp/agent/state/agent.db');
    expect(p.manifestFile('m_abc')).toBe('/tmp/agent/missions/m_abc/manifest.yaml');
    expect(p.memoryIndexFile('m_abc')).toBe('/tmp/agent/missions/m_abc/memory/MEMORY.md');
  });
});
