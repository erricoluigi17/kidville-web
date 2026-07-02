// Multi-Sede (DL-033). Helper puri per validazione/normalizzazione di una scuola.

export interface ScuolaInput {
  nome: string
  citta?: string | null
  indirizzo?: string | null
}

export interface NormalizedScuola {
  nome: string
  citta: string | null
  indirizzo: string | null
}

/** Valida il nome della sede (obbligatorio, ≤120 caratteri). */
export function validaNomeScuola(nome: unknown): { ok: boolean; error?: string } {
  if (typeof nome !== 'string' || nome.trim().length === 0) {
    return { ok: false, error: 'Il nome della sede è obbligatorio' }
  }
  if (nome.trim().length > 120) {
    return { ok: false, error: 'Il nome della sede è troppo lungo (max 120 caratteri)' }
  }
  return { ok: true }
}

/** Sanifica i campi testuali: trim, campi opzionali vuoti → null. */
export function normalizzaScuola(input: ScuolaInput): NormalizedScuola {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim()
    return t.length > 0 ? t : null
  }
  return {
    nome: input.nome.trim(),
    citta: clean(input.citta),
    indirizzo: clean(input.indirizzo),
  }
}
