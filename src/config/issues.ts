import type { z } from 'zod';

/** Writes a path such as `run_limits.max_steps` or `tools[2]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const part of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[part];
  }
  return cur;
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const TYPE_WORDS: Record<string, string> = {
  string: 'a text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  object: 'a mapping of keys to values',
};

/** Turns zod issues into one plain sentence each, naming the key. */
export function formatIssues(issues: readonly z.core.$ZodIssue[], input: unknown): string[] {
  return issues.flatMap((issue) => {
    const key = formatPath(issue.path);
    const subject = key === '' ? 'The file' : key;
    switch (issue.code) {
      case 'unrecognized_keys': {
        const where = key === '' ? '' : ` in ${key}`;
        return issue.keys.map((k) => `Unknown key "${k}"${where}.`);
      }
      case 'invalid_type': {
        const found = valueAt(input, issue.path);
        if (found === undefined) return `${subject} is required.`;
        const want = TYPE_WORDS[issue.expected] ?? issue.expected;
        return `${subject} must be ${want}, but it is ${show(found)}.`;
      }
      case 'too_small': {
        const min = Number(issue.minimum);
        if (issue.origin === 'string') {
          return min <= 1 ? `${subject} must not be empty.` : `${subject} must have at least ${min} characters.`;
        }
        if (issue.origin === 'array') return `${subject} must have at least ${min} items.`;
        return issue.inclusive ? `${subject} must be at least ${min}.` : `${subject} must be more than ${min}.`;
      }
      case 'too_big': {
        const max = Number(issue.maximum);
        if (issue.origin === 'string') {
          const found = valueAt(input, issue.path);
          const len = typeof found === 'string' ? ` It has ${found.length}.` : '';
          return `${subject} must have at most ${max} characters.${len}`;
        }
        if (issue.origin === 'array') return `${subject} must have at most ${max} items.`;
        return issue.inclusive ? `${subject} must be at most ${max}.` : `${subject} must be less than ${max}.`;
      }
      case 'invalid_value': {
        const found = valueAt(input, issue.path);
        if (found === undefined) return `${subject} is required.`;
        const values = issue.values.map((v) => show(v)).join(', ');
        return `${subject} must be one of ${values}, but it is ${show(found)}.`;
      }
      // Our own checks write their message as the end of a sentence, such as "must be ...".
      case 'invalid_format':
      case 'custom':
        return `${subject} ${issue.message}`;
      default:
        return `${subject}: ${issue.message}`;
    }
  });
}
