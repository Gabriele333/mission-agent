import { randomBytes } from 'node:crypto';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type MissionId } from '../types.js';

export const SYS_SELF_IMPROVE = 'sys-self-improve';

/** The ids of the three system missions (§4). */
export const SYSTEM_MISSION_IDS: readonly string[] = [SYS_GENERAL, SYS_MISSION_ADMIN, SYS_SELF_IMPROVE];

/** System missions whose manifest is part of the code. Only the general mission has a manifest file (§4). */
export const CODE_ONLY_SYSTEM_IDS: readonly string[] = [SYS_MISSION_ADMIN, SYS_SELF_IMPROVE];

/** Reserved for the core folder. Never a mission id. */
export const CORE_ID = 'core';

/**
 * Crockford base32 in lowercase: digits and letters without i, l, o, u.
 * The examples of §A.4 (`m_k7q3zp2xw9ha`) use digits 8 and 9, which RFC 4648 base32 does not have.
 */
const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

export const MISSION_ID_RE = /^m_[0-9a-hjkmnp-tv-z]{12}$/;
export const MISSION_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_NAME_CHARS = 40;

export const TOOL_ID_RE = /^tool:[a-z0-9_]+$/;
export const ACTION_ID_RE = /^action:[a-z0-9_]+\.[a-z0-9_]+$/;
/** `trigger:cron` and `trigger:chat` have one word; every other trigger has a thing and an event. */
export const TRIGGER_ID_RE = /^trigger:[a-z0-9_]+(\.[a-z0-9_]+)?$/;
export const SIGNAL_ID_RE = /^signal:[a-z0-9_]+\.[a-z0-9_]+$/;

export function isSystemMissionId(id: string): boolean {
  return SYSTEM_MISSION_IDS.includes(id);
}

export function isValidMissionId(id: string): boolean {
  return MISSION_ID_RE.test(id) || isSystemMissionId(id);
}

export function generateMissionId(): MissionId {
  const bytes = randomBytes(12);
  let out = 'm_';
  // 256 is a multiple of 32, so every character is equally likely.
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}
