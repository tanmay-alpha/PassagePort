export type ClassValue = string | false | null | undefined

/** Joins class names, skipping falsy entries. */
export function cx(...values: ClassValue[]): string {
  let out = ''
  for (const value of values) {
    if (value) out = out ? `${out} ${value}` : value
  }
  return out
}
