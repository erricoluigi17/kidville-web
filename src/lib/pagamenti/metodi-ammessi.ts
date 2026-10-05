// ─────────────────────────────────────────────────────────────────────────────
// I METODI CON CUI UNA VOCE SI PUÒ PAGARE (2026-10-05).
//
// ZERO IMPORT, ed è un vincolo: lo usano anche componenti `'use client'`
// (badge, «Come pagare»), e un import di server finirebbe nel bundle.
//
// `normalizzaMetodiAmmessi` è la porta UNICA da cui passa il valore letto dal
// DB o dal client. Assente, `null`, vuoto o fatto solo di valori ignoti ⇒
// ENTRAMBI: è la degradazione del DB E2E della CI (colonna assente) e il
// comportamento di prima della colonna. Mai «nessun metodo»: una voce che non
// si può pagare in nessun modo non esiste.
// ─────────────────────────────────────────────────────────────────────────────

export const METODI_AMMESSI = ['contanti', 'bonifico'] as const
export type MetodoAmmesso = (typeof METODI_AMMESSI)[number]

function eMetodo(v: unknown): v is MetodoAmmesso {
  return typeof v === 'string' && (METODI_AMMESSI as readonly string[]).includes(v)
}

export function normalizzaMetodiAmmessi(raw: unknown): MetodoAmmesso[] {
  if (!Array.isArray(raw)) return [...METODI_AMMESSI]
  const presenti = new Set(raw.filter(eMetodo))
  if (presenti.size === 0) return [...METODI_AMMESSI]
  return METODI_AMMESSI.filter((m) => presenti.has(m))
}

export function ammetteBonifico(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).includes('bonifico')
}

export function ammetteContanti(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).includes('contanti')
}

/** Il metodo, quando è UNO solo; `null` quando sono ammessi tutti e due. */
export function soloUnMetodo(raw: unknown): MetodoAmmesso | null {
  const m = normalizzaMetodiAmmessi(raw)
  return m.length === 1 ? m[0] : null
}

/** «Tutti e due»: il default della colonna, che non serve scrivere. */
export function sonoTuttiIMetodi(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).length === METODI_AMMESSI.length
}

/** Codici PostgREST/Postgres di «colonna assente» (DB E2E della CI, non migrato). */
export const CODICI_COLONNA_ASSENTE: readonly string[] = ['PGRST204', '42703']
