import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { logEvento, logErrore } from '@/lib/logging/logger'
import { confermaIscrizione, registraFrequenzaPerAnno, segnaNonRinnova } from '@/lib/anno/iscrizione-anno'

/**
 * COMPITO 4.5.6 · la porta TypeScript della conferma e del «non rinnova» (`src/lib/anno/iscrizione-anno.ts`).
 *
 * Il client è un finto che registra le chiamate: si prova come la porta traduce gli esiti (schema indietro, codice dell'anno,
 * guasto, eccezione) e che non esca niente che non sia un uuid, un codice o un booleano. Le funzioni SQL vere sono provate in PGlite
 * (`__tests__/db/anno-conferma.test.ts`). Solo uuid finti.
 */

const FREQ = '33333333-3333-4333-8333-333333333333'
const NUOVA = '33333333-3333-4333-8333-333333333334'
const ANNO = '22222222-2222-4222-8222-222222222222'
const SEZ = '55555555-5555-4555-8555-555555555555'
const PAG = '44444444-4444-4444-8444-444444444444'
const UT = '66666666-6666-4666-8666-666666666666'
const ALUNNO = '11111111-1111-4111-8111-111111111111'

type Risposta = { data?: unknown; error?: { code?: string; message?: string } | null }

function clienteRpc(risposta: Risposta | (() => never)) {
  const rpc = vi.fn<(...args: unknown[]) => Promise<Risposta>>(async () => {
    if (typeof risposta === 'function') return risposta()
    return { data: risposta.data ?? null, error: risposta.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const CONFERMA = {
  frequenza_id: NUOVA, creata: true, cambia_grado: false, retta_personalizzata_precedente: true,
  quota: 'creata', pagamento_id: PAG, posti_oltre: false,
}
const NO = { frequenza_id: FREQ, non_rinnova: true, cambiato: true }

function valoriLoggati(): unknown[] {
  return vi.mocked(logEvento).mock.calls.flatMap((c) => Object.values((c[2] ?? {}) as Record<string, unknown>))
}

beforeEach(() => {
  vi.mocked(logEvento).mockClear()
  vi.mocked(logErrore).mockClear()
})

describe('confermaIscrizione', () => {
  it('chiama `anno_conferma` con i nomi dei parametri e restituisce i campi del jsonb', async () => {
    const { client, rpc } = clienteRpc({ data: CONFERMA })
    const r = await confermaIscrizione(client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, sectionId: SEZ, da: UT, cambiaGrado: true })
    expect(rpc).toHaveBeenCalledWith('anno_conferma', {
      p_frequenza: FREQ, p_anno_sede_nuovo: ANNO, p_section: SEZ, p_da: UT, p_cambia_grado: true,
    })
    expect(r).toEqual({ ok: true, ...CONFERMA })
  })

  it('senza sezione e senza spunta manda NULL e falso', async () => {
    const { client, rpc } = clienteRpc({ data: CONFERMA })
    await confermaIscrizione(client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })
    expect(rpc).toHaveBeenCalledWith('anno_conferma', expect.objectContaining({ p_section: null, p_cambia_grado: false }))
  })

  it.each(['SEZIONE_OBBLIGATORIA', 'FREQUENZA_NON_VIVA', 'ANNO_NON_APERTO', 'SEDE_DIVERSA'])('il codice %s del database è un esito, non un’eccezione', async (codice) => {
    const { client } = clienteRpc({ error: { code: 'P0001', message: codice } })
    expect(await confermaIscrizione(client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })).toEqual({ ok: false, codice })
    expect(vi.mocked(logEvento).mock.calls.some((c) => c[1] === 'warn' && (c[2] as Record<string, unknown>).error_code === codice)).toBe(true)
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('la funzione assente (database non migrato) è `saltata: schema-indietro`, a `info`', async () => {
    const { client } = clienteRpc({ error: { code: 'PGRST202', message: 'funzione assente' } })
    expect(await confermaIscrizione(client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })).toEqual({ ok: true, saltata: 'schema-indietro' })
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('un guasto vero logga il solo SQLSTATE; un’eccezione del client non esce; una risposta storta è un guasto', async () => {
    const guasto = clienteRpc({ error: { code: '23514', message: 'new row for relation "frequenze" violates check constraint: (Mario Rossi)' } })
    expect(await confermaIscrizione(guasto.client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(JSON.stringify(vi.mocked(logErrore).mock.calls.map((c) => String((c[1] as Error).message)))).toBe('["iscrizione-anno:23514"]')

    const rete = clienteRpc(() => { throw new Error('rete caduta') })
    expect(await confermaIscrizione(rete.client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })

    const storta = clienteRpc({ data: { altro: 1 } })
    expect(await confermaIscrizione(storta.client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
  })

  it('nei log solo uuid, codici e booleani', async () => {
    const { client } = clienteRpc({ data: CONFERMA })
    await confermaIscrizione(client, { frequenzaId: FREQ, annoSedeNuovoId: ANNO, da: UT })
    const eventi = vi.mocked(logEvento).mock.calls.map((c) => c[2] as Record<string, unknown>)
    expect(eventi.find((e) => e.tipo === 'conferma-anno-registrata')).toMatchObject({
      esito: 'creata', entita_id: NUOVA, utente: UT, cambia_grado: false, posti_oltre: false,
    })
    expect(eventi.find((e) => e.tipo === 'quota-anno-voce')).toMatchObject({ esito: 'creata', entita_id: PAG })
    for (const v of valoriLoggati()) {
      expect(typeof v === 'boolean' || (typeof v === 'string' && /^[0-9a-f-]{36}$|^[a-z_.:/-]+$/i.test(v)), String(v)).toBe(true)
    }
  })
})

describe('segnaNonRinnova', () => {
  it('chiama `anno_non_rinnova` col motivo dell’elenco chiuso', async () => {
    const { client, rpc } = clienteRpc({ data: NO })
    const r = await segnaNonRinnova(client, { frequenzaId: FREQ, attivo: true, motivo: 'trasloco', da: UT })
    expect(rpc).toHaveBeenCalledWith('anno_non_rinnova', { p_frequenza: FREQ, p_attivo: true, p_motivo: 'trasloco', p_da: UT })
    expect(r).toEqual({ ok: true, ...NO })
  })

  it('`attivo:false` non manda mai il motivo', async () => {
    const { client, rpc } = clienteRpc({ data: { ...NO, non_rinnova: false } })
    await segnaNonRinnova(client, { frequenzaId: FREQ, attivo: false, motivo: 'altro', da: UT })
    expect(rpc).toHaveBeenCalledWith('anno_non_rinnova', expect.objectContaining({ p_attivo: false, p_motivo: null }))
  })

  it('i rifiuti del database sono esiti; lo schema indietro è saltato', async () => {
    const non_viva = clienteRpc({ error: { code: 'P0001', message: 'FREQUENZA_NON_VIVA' } })
    expect(await segnaNonRinnova(non_viva.client, { frequenzaId: FREQ, attivo: true, da: UT })).toEqual({ ok: false, codice: 'FREQUENZA_NON_VIVA' })
    const indietro = clienteRpc({ error: { code: '42883', message: 'function does not exist' } })
    expect(await segnaNonRinnova(indietro.client, { frequenzaId: FREQ, attivo: true, da: UT })).toEqual({ ok: true, saltata: 'schema-indietro' })
  })

  it('nel log il codice del motivo sta sotto `entita_tipo`, mai sotto `motivo`', async () => {
    const { client } = clienteRpc({ data: NO })
    await segnaNonRinnova(client, { frequenzaId: FREQ, attivo: true, motivo: 'fine_ciclo', da: UT })
    const e = vi.mocked(logEvento).mock.calls.map((c) => c[2] as Record<string, unknown>).find((x) => x.tipo === 'non-rinnova-registrato')
    expect(e).toMatchObject({ esito: 'segnato', entita_id: FREQ, utente: UT, entita_tipo: 'fine_ciclo' })
    expect(e).not.toHaveProperty('motivo')
  })

  it('un’eccezione del client non esce', async () => {
    const rete = clienteRpc(() => { throw new Error('rete caduta') })
    expect(await segnaNonRinnova(rete.client, { frequenzaId: FREQ, attivo: true, da: UT })).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
  })
})

describe('registraFrequenzaPerAnno e `da`', () => {
  const OK = { frequenza_id: NUOVA, creata: true, quota: 'creata', pagamento_id: PAG, posti_oltre: false }
  const base = { alunnoId: ALUNNO, annoSedeId: ANNO, tipo: 'nuova', origine: 'domanda' } as const

  it('senza `da` manda gli stessi argomenti di prima (nessun `p_da`)', async () => {
    const { client, rpc } = clienteRpc({ data: OK })
    await registraFrequenzaPerAnno(client, base)
    expect(Object.keys(rpc.mock.calls[0][1] as object)).not.toContain('p_da')
  })

  it('con `da` lo manda: la voce nuova porta chi ha fatto il gesto', async () => {
    const { client, rpc } = clienteRpc({ data: OK })
    await registraFrequenzaPerAnno(client, { ...base, da: UT })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_da: UT })
  })
})
