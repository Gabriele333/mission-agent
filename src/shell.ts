/** Quotes a value for a POSIX shell, so a path with spaces or quotes still works when pasted. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
