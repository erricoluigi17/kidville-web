import { describe, it, expect } from 'vitest'
import {
  consensiMancanti,
  CONSENSI_RICHIESTI,
  assertTerminiAccettatiSeGenitore,
} from '@/lib/onboarding/consensi'

// P4/DL-045 — onboarding genitore: i consensi GDPR obbligatori devono essere accettati.

// Fake supabase: programma { data, error } per la lettura puntuale di parents.
// `eqCalls`, se passato, registra ogni `.eq(col, val)` — usato per provare CHE
// colonna viene interrogata (non solo che la funzione "funziona" a prescindere).
function fakeSupabase(resp: { data?: unknown; error?: unknown }, eqCalls?: [string, unknown][]) {
  return {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { eqCalls?.push([col, val]); return b }
      b.maybeSingle = async () => ({ data: resp.data ?? null, error: resp.error ?? null })
      return b
    },
  } as never
}

// Se questa fosse mai interrogata, il test fallirebbe: prova che lo staff è trasparente.
const supabaseCheEsplode = {
  from() {
    throw new Error('assertTerminiAccettatiSeGenitore non deve leggere il DB per lo staff')
  },
} as never

describe('consensiMancanti', () => {
  it('nessun mancante se tutti i richiesti sono accettati', () => {
    const accepted = Object.fromEntries(CONSENSI_RICHIESTI.map(k => [k, true]))
    expect(consensiMancanti(accepted, CONSENSI_RICHIESTI)).toEqual([])
  })

  it('ritorna i richiesti non accettati', () => {
    expect(consensiMancanti({ privacy: false }, ['privacy'])).toEqual(['privacy'])
    expect(consensiMancanti({ privacy: true, termini: false }, ['privacy', 'termini'])).toEqual(['termini'])
  })

  it('null/undefined → tutti i richiesti mancano', () => {
    expect(consensiMancanti(null, ['privacy', 'termini'])).toEqual(['privacy', 'termini'])
    expect(consensiMancanti(undefined, ['privacy'])).toEqual(['privacy'])
  })

  it('CONSENSI_RICHIESTI include almeno privacy', () => {
    expect(CONSENSI_RICHIESTI).toContain('privacy')
  })

  it('CONSENSI_RICHIESTI ora include anche i termini (C5)', () => {
    expect(CONSENSI_RICHIESTI).toContain('termini')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * IL TERZO PARAMETRO NON È PIÙ UN RUOLO (2026-09-01).
 *
 * Era `role: string`, confrontato con `'genitore'` — cioè il ruolo ATTIVO, quello
 * che il cookie `kv-active-role` commuta. Le quattro insegnanti che sono anche
 * genitori di un bambino della scuola potevano scrivere nella chat della propria
 * famiglia senza commutare la veste, e il gate le trattava da staff: i Termini di
 * servizio (art. 1341 c.c.) si saltavano cambiando schermata.
 *
 * Adesso il parametro è `scriveComeFamiglia: boolean`, e chi chiama lo calcola come
 * `agisceComeGenitore(user) || thread.parent_id === user.id`. La prova che il
 * secondo termine serve davvero non sta qui — una funzione booleana non sa chi
 * gliel'ha passato — ma in `__tests__/api/chat-messages-c5-guardie.test.ts`, che
 * esercita la route vera e ha visto il 201 diventare 403.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('assertTerminiAccettatiSeGenitore', () => {
  const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001'

  it('trasparente per chi NON scrive dal posto della famiglia (né interrogato)', async () => {
    expect(await assertTerminiAccettatiSeGenitore(supabaseCheEsplode, PARENT, false)).toBeNull()
  })

  it('null per chi HA accettato i termini (consensi_gdpr.termini === true)', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: { privacy: true, termini: true } } })
    expect(await assertTerminiAccettatiSeGenitore(sb, PARENT, true)).toBeNull()
  })

  it('403 motivo termini_non_accettati per chi scrive come famiglia senza termini accettati', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: { privacy: true } } })
    const res = await assertTerminiAccettatiSeGenitore(sb, PARENT, true)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.motivo).toBe('termini_non_accettati')
  })

  it('403 anche se consensi_gdpr è assente/null', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: null } })
    const res = await assertTerminiAccettatiSeGenitore(sb, PARENT, true)
    expect(res!.status).toBe(403)
  })

  it('degrada a null se la colonna/tabella non esiste (DB E2E non migrato, 42703)', async () => {
    const sb = fakeSupabase({ error: { code: '42703' } })
    expect(await assertTerminiAccettatiSeGenitore(sb, PARENT, true)).toBeNull()
  })

  it('interroga parents per auth_user_id, MAI per id (senderId è utenti.id, non parents.id — verificato in produzione: 0 righe coincidono)', async () => {
    const eqCalls: [string, unknown][] = []
    const sb = fakeSupabase({ data: { consensi_gdpr: { privacy: true, termini: true } } }, eqCalls)
    await assertTerminiAccettatiSeGenitore(sb, PARENT, true)
    expect(eqCalls).toEqual([['auth_user_id', PARENT]])
  })
})
