/** Minimal className joiner: filtra i valori falsy e unisce con spazio. Nessuna dipendenza. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
