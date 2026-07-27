import { describe, it, expect } from 'vitest'
import {
  consensiMancanti,
  CONSENSI_RICHIESTI,
  assertTerminiAccettatiSeGenitore,
} from '@/lib/onboarding/consensi'

// P4/DL-045 — onboarding genitore: i consensi GDPR obbligatori devono essere accettati.

// Fake supabase: programma { data, error } per la lettura puntuale di parents.
function fakeSupabase(resp: { data?: unknown; error?: unknown }) {
  return {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
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

describe('assertTerminiAccettatiSeGenitore', () => {
  const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001'

  it('trasparente per lo staff: un docente non viene mai bloccato (né interrogato)', async () => {
    expect(await assertTerminiAccettatiSeGenitore(supabaseCheEsplode, PARENT, 'educator')).toBeNull()
    expect(await assertTerminiAccettatiSeGenitore(supabaseCheEsplode, PARENT, 'admin')).toBeNull()
  })

  it('null per un genitore che HA accettato i termini (consensi_gdpr.termini === true)', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: { privacy: true, termini: true } } })
    expect(await assertTerminiAccettatiSeGenitore(sb, PARENT, 'genitore')).toBeNull()
  })

  it('403 motivo termini_non_accettati per un genitore senza termini accettati', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: { privacy: true } } })
    const res = await assertTerminiAccettatiSeGenitore(sb, PARENT, 'genitore')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.motivo).toBe('termini_non_accettati')
  })

  it('403 anche se consensi_gdpr è assente/null per il genitore', async () => {
    const sb = fakeSupabase({ data: { consensi_gdpr: null } })
    const res = await assertTerminiAccettatiSeGenitore(sb, PARENT, 'genitore')
    expect(res!.status).toBe(403)
  })

  it('degrada a null se la colonna/tabella non esiste (DB E2E non migrato, 42703)', async () => {
    const sb = fakeSupabase({ error: { code: '42703' } })
    expect(await assertTerminiAccettatiSeGenitore(sb, PARENT, 'genitore')).toBeNull()
  })
})
