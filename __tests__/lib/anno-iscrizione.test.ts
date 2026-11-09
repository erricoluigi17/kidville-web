import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { logEvento, logErrore } from '@/lib/logging/logger'
import { annoDellaDomanda, iscrizioniDelBambino, registraFrequenzaPerAnno } from '@/lib/anno/iscrizione-anno'

/**
 * COMPITO 4.5.5 · la porta TypeScript dell'iscrizione all'anno prossimo (`src/lib/anno/iscrizione-anno.ts`).
 *
 * Il client è un finto che registra le chiamate: qui si prova come la porta traduce gli esiti (schema indietro, codice dell'anno,
 * guasto, eccezione) e che non esca niente che non sia un uuid, un codice o un booleano. La funzione SQL vera è provata in PGlite
 * (`__tests__/db/anno-iscrizione.test.ts`). Solo uuid finti.
 */

const ALUNNO = '11111111-1111-4111-8111-111111111111'
const ANNO_SEDE = '22222222-2222-4222-8222-222222222222'
const FREQ = '33333333-3333-4333-8333-333333333333'
const PAG = '44444444-4444-4444-8444-444444444444'
const SEDE = '55555555-5555-4555-8555-555555555555'
const A_ATTIVO = '66666666-6666-4666-8666-666666666661'
const A_APERTO = '66666666-6666-4666-8666-666666666662'
const A_PREP = '66666666-6666-4666-8666-666666666663'
const ANNO_ATTIVO = '77777777-7777-4777-8777-777777777771'
const ANNO_APERTO = '77777777-7777-4777-8777-777777777772'
const ANNO_PREP = '77777777-7777-4777-8777-777777777773'

type Risposta = { data?: unknown; error?: { code?: string; message?: string } | null }

function clienteRpc(risposta: Risposta | (() => never)) {
  const rpc = vi.fn<(...args: unknown[]) => Promise<Risposta>>(async () => {
    if (typeof risposta === 'function') return risposta()
    return { data: risposta.data ?? null, error: risposta.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const args = { alunnoId: ALUNNO, annoSedeId: ANNO_SEDE, tipo: 'nuova', origine: 'domanda' } as const
const OK = { frequenza_id: FREQ, creata: true, quota: 'creata', pagamento_id: PAG, posti_oltre: false }

/** Ogni valore passato ai log: solo uuid, codici, booleani, numeri. Niente testo libero. */
function valoriLoggati(): unknown[] {
  return [...vi.mocked(logEvento).mock.calls.flatMap((c) => Object.values((c[2] ?? {}) as Record<string, unknown>))]
}

beforeEach(() => {
  vi.mocked(logEvento).mockClear()
  vi.mocked(logErrore).mockClear()
})

describe('registraFrequenzaPerAnno', () => {
  it('chiama la funzione con gli argomenti, nomi compresi, e restituisce i campi del jsonb', async () => {
    const { client, rpc } = clienteRpc({ data: OK })
    const r = await registraFrequenzaPerAnno(client, {
      ...args, domandaId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sectionId: null, dataIngresso: '2027-09-15', campi: { usa_pannolino: true },
    })
    expect(r).toEqual({ ok: true, ...OK })
    expect(rpc).toHaveBeenCalledWith('anno_registra_frequenza', {
      p_alunno: ALUNNO, p_anno_sede: ANNO_SEDE, p_tipo: 'nuova', p_origine: 'domanda',
      p_domanda: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', p_section: null, p_data_ingresso: '2027-09-15', p_campi: { usa_pannolino: true },
    })
  })

  it('gli argomenti facoltativi assenti vanno come NULL', async () => {
    const { client, rpc } = clienteRpc({ data: OK })
    await registraFrequenzaPerAnno(client, args)
    expect(rpc).toHaveBeenCalledWith('anno_registra_frequenza', expect.objectContaining({
      p_domanda: null, p_section: null, p_data_ingresso: null, p_campi: null,
    }))
  })

  it('il successo si logga (frequenza e voce) con soli uuid, codici e booleani', async () => {
    const { client } = clienteRpc({ data: OK })
    await registraFrequenzaPerAnno(client, args)
    const eventi = vi.mocked(logEvento).mock.calls.map((c) => c[2])
    expect(eventi).toContainEqual(expect.objectContaining({ tipo: 'frequenza-anno-registrata', esito: 'creata', entita_id: FREQ, posti_oltre: false }))
    expect(eventi).toContainEqual(expect.objectContaining({ tipo: 'quota-anno-voce', esito: 'creata', entita_id: PAG }))
    for (const v of valoriLoggati()) {
      expect(['string', 'boolean', 'number', 'undefined']).toContain(typeof v)
    }
    expect(vi.mocked(logErrore)).not.toHaveBeenCalled()
  })

  it('una frequenza già esistente si logga `esistente`; senza voce (ritirata) non si logga la voce', async () => {
    const { client } = clienteRpc({ data: { ...OK, creata: false, quota: null, pagamento_id: null } })
    const r = await registraFrequenzaPerAnno(client, args)
    expect(r).toMatchObject({ ok: true, creata: false, quota: null })
    const tipi = vi.mocked(logEvento).mock.calls.map((c) => (c[2] as { tipo: string; esito?: string }))
    expect(tipi).toContainEqual(expect.objectContaining({ tipo: 'frequenza-anno-registrata', esito: 'esistente' }))
    expect(tipi.some((t) => t.tipo === 'quota-anno-voce')).toBe(false)
  })

  it.each([['PGRST202'], ['42883'], ['PGRST205'], ['42P01']])('schema indietro (%s): `saltata`, un info, nessun errore', async (code) => {
    const { client } = clienteRpc({ error: { code, message: 'Could not find the function' } })
    const r = await registraFrequenzaPerAnno(client, args)
    expect(r).toEqual({ ok: true, saltata: 'schema-indietro' })
    expect(vi.mocked(logErrore)).not.toHaveBeenCalled()
    expect(vi.mocked(logEvento).mock.calls.every((c) => c[1] === 'info')).toBe(true)
    expect(vi.mocked(logEvento)).toHaveBeenCalledTimes(1)
  })

  it.each([['ANNO_NON_APERTO'], ['SEDE_DIVERSA'], ['SEZIONE_DI_ALTRO_ANNO']])('il codice dell’anno %s: `ok:false` col codice e un warn', async (codice) => {
    const { client } = clienteRpc({ error: { code: 'P0001', message: codice } })
    const r = await registraFrequenzaPerAnno(client, args)
    expect(r).toEqual({ ok: false, codice })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith('anno-scolastico', 'warn', expect.objectContaining({ error_code: codice }))
    expect(vi.mocked(logErrore)).not.toHaveBeenCalled()
  })

  it('ogni altro errore: `SCRITTURA_FALLITA`, e del guasto si logga il SOLO SQLSTATE (mai il messaggio, che porta la riga)', async () => {
    const riga = 'Failing row contains (cognome-di-prova, nota-sanitaria-di-prova)'
    const { client } = clienteRpc({ error: { code: '23514', message: riga } })
    const r = await registraFrequenzaPerAnno(client, args)
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(vi.mocked(logErrore)).toHaveBeenCalledTimes(1)
    const err = vi.mocked(logErrore).mock.calls[0][1] as Error
    expect(err.message).toBe('iscrizione-anno:23514')
    expect(JSON.stringify(vi.mocked(logErrore).mock.calls)).not.toContain('nota-sanitaria-di-prova')
    expect(JSON.stringify(vi.mocked(logEvento).mock.calls)).not.toContain('nota-sanitaria-di-prova')
  })

  it('un errore senza codice SQLSTATE è comunque `SCRITTURA_FALLITA`', async () => {
    const { client } = clienteRpc({ error: { message: 'boh' } })
    expect(await registraFrequenzaPerAnno(client, args)).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
  })

  it('il client che lancia non fa cadere il chiamante', async () => {
    const { client } = clienteRpc(() => { throw new Error('rete caduta') })
    expect(await registraFrequenzaPerAnno(client, args)).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(vi.mocked(logErrore)).toHaveBeenCalledTimes(1)
  })

  it('una risposta che non è un risultato è un guasto, non un successo', async () => {
    const { client } = clienteRpc({ data: null })
    expect(await registraFrequenzaPerAnno(client, args)).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(vi.mocked(logErrore)).toHaveBeenCalledTimes(1)
  })
})

describe('annoDellaDomanda', () => {
  /** Un client con `anno_attivo` (rpc) e la lista degli `anni_sede` della sede. */
  function clienteAnni(o: { attivo?: Risposta; anni?: Risposta }) {
    const eq = vi.fn<(...a: unknown[]) => Promise<Risposta>>(async () => ({ data: o.anni?.data ?? null, error: o.anni?.error ?? null }))
    const select = vi.fn<(...a: unknown[]) => { eq: typeof eq }>(() => ({ eq }))
    const from = vi.fn<(...a: unknown[]) => { select: typeof select }>(() => ({ select }))
    const rpc = vi.fn<(...a: unknown[]) => Promise<Risposta>>(async () => ({ data: o.attivo?.data ?? null, error: o.attivo?.error ?? null }))
    return { client: { rpc, from } as unknown as SupabaseClient, rpc, from, eq }
  }
  const ANNI = [
    { id: A_ATTIVO, anno_id: ANNO_ATTIVO, stato: 'corrente' },
    { id: A_APERTO, anno_id: ANNO_APERTO, stato: 'iscrizioni_aperte' },
    { id: A_PREP, anno_id: ANNO_PREP, stato: 'in_preparazione' },
  ]

  it('senza anno indicato è l’anno attivo, come oggi', async () => {
    const { client, rpc, eq } = clienteAnni({ attivo: { data: A_ATTIVO }, anni: { data: ANNI } })
    expect(await annoDellaDomanda(client, SEDE, null)).toEqual({ tipo: 'attivo', annoSedeId: A_ATTIVO, annoId: ANNO_ATTIVO })
    expect(rpc).toHaveBeenCalledWith('anno_attivo', { p_scuola: SEDE })
    expect(eq).toHaveBeenCalledWith('scuola_id', SEDE)
  })

  it('l’anno indicato è l’attivo → `attivo`; con le iscrizioni aperte → `aperto`', async () => {
    const { client } = clienteAnni({ attivo: { data: A_ATTIVO }, anni: { data: ANNI } })
    expect(await annoDellaDomanda(client, SEDE, ANNO_ATTIVO)).toEqual({ tipo: 'attivo', annoSedeId: A_ATTIVO, annoId: ANNO_ATTIVO })
    expect(await annoDellaDomanda(client, SEDE, ANNO_APERTO)).toEqual({ tipo: 'aperto', annoSedeId: A_APERTO, annoId: ANNO_APERTO })
  })

  it('un anno in preparazione, chiuso o che la sede non ha è `non-aperto`', async () => {
    const { client } = clienteAnni({ attivo: { data: A_ATTIVO }, anni: { data: ANNI } })
    expect(await annoDellaDomanda(client, SEDE, ANNO_PREP)).toEqual({ tipo: 'non-aperto' })
    expect(await annoDellaDomanda(client, SEDE, '77777777-7777-4777-8777-7777777777ff')).toEqual({ tipo: 'non-aperto' })
  })

  it('una sede senza anno attivo e senza anno indicato è `non-aperto`', async () => {
    const { client } = clienteAnni({ attivo: { data: null }, anni: { data: ANNI } })
    expect(await annoDellaDomanda(client, SEDE, null)).toEqual({ tipo: 'non-aperto' })
  })

  it.each([['PGRST202'], ['42883'], ['PGRST205'], ['42P01']])('schema indietro (%s) sulla funzione: `schema-indietro`, nessun errore', async (code) => {
    vi.mocked(logErrore).mockClear()
    const { client } = clienteAnni({ attivo: { error: { code } } })
    expect(await annoDellaDomanda(client, SEDE, null)).toEqual({ tipo: 'schema-indietro' })
    expect(vi.mocked(logErrore)).not.toHaveBeenCalled()
  })

  it('schema indietro sulla tabella: `schema-indietro`', async () => {
    const { client } = clienteAnni({ attivo: { data: null }, anni: { error: { code: 'PGRST205' } } })
    expect(await annoDellaDomanda(client, SEDE, ANNO_APERTO)).toEqual({ tipo: 'schema-indietro' })
    expect(vi.mocked(logErrore)).not.toHaveBeenCalled()
  })

  it('un guasto: senza anno indicato fa come oggi (`schema-indietro`), con un anno esplicito rifiuta; sempre un logErrore col solo codice', async () => {
    const { client } = clienteAnni({ attivo: { error: { code: '57014', message: 'timeout con dati' } } })
    expect(await annoDellaDomanda(client, SEDE, null)).toEqual({ tipo: 'schema-indietro' })
    expect(await annoDellaDomanda(client, SEDE, ANNO_APERTO)).toEqual({ tipo: 'non-aperto' })
    expect(vi.mocked(logErrore)).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(logErrore).mock.calls)).not.toContain('timeout con dati')
  })

  it('il client che lancia non fa cadere il chiamante', async () => {
    const client = { rpc: vi.fn(async () => { throw new Error('rete') }) } as unknown as SupabaseClient
    expect(await annoDellaDomanda(client, SEDE, null)).toEqual({ tipo: 'schema-indietro' })
    expect(await annoDellaDomanda(client, SEDE, ANNO_APERTO)).toEqual({ tipo: 'non-aperto' })
  })
})

describe('iscrizioniDelBambino · la riga chiusa dell\u2019anno attivo (4.5.16, C)', () => {
  /** Un client finto per tabella: la lettura dell'anno attivo torna `righeAttive`, quella degli anni che vengono nessuna riga. */
  function cliente(righeAttive: Array<{ id: string; stato: string; data_uscita: string | null }>) {
    const catena = (righe: unknown[]) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'limit']) q[m] = () => q
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: righe, error: null }).then(ok)
      return q
    }
    return {
      from: (t: string) => (t === 'frequenze' ? catena(righeAttive) : catena([])),
    } as unknown as SupabaseClient
  }
  const attiva = (client: SupabaseClient, archiviatoIl?: string | null) =>
    iscrizioniDelBambino(client, { alunnoId: ALUNNO, annoAttivoId: A_ATTIVO, archiviatoIl })

  it('uscita PRECEDENTE al giorno di Roma dell\u2019archiviazione: non conta come frequenza attiva', async () => {
    const r = await attiva(cliente([{ id: FREQ, stato: 'ritirato', data_uscita: '2026-11-04' }]), '2026-11-09T10:00:00+01:00')
    expect(r).toMatchObject({ ok: true, haFrequenzaAttiva: false })
  })
  it.each([
    ['uscita NULL', { stato: 'ritirato', data_uscita: null }, '2026-11-09T10:00:00+01:00'],
    ['uscita dello stesso giorno', { stato: 'ritirato', data_uscita: '2026-11-09' }, '2026-11-09T10:00:00+01:00'],
    ['archiviatoIl assente', { stato: 'ritirato', data_uscita: '2026-11-04' }, undefined],
    ['riga viva', { stato: 'iscritto', data_uscita: null }, '2026-11-09T10:00:00+01:00'],
  ])('%s: conta come frequenza attiva, come prima', async (_nome, riga, quando) => {
    const r = await attiva(cliente([{ id: FREQ, ...riga }]), quando)
    expect(r).toMatchObject({ ok: true, haFrequenzaAttiva: true })
  })
  it('il giorno è quello di ROMA: 23:30 UTC del 8 è già il 9 a Roma, e un\u2019uscita dell\u20198 è precedente', async () => {
    const r = await attiva(cliente([{ id: FREQ, stato: 'uscito', data_uscita: '2026-11-08' }]), '2026-11-08T23:30:00Z')
    expect(r).toMatchObject({ ok: true, haFrequenzaAttiva: false })
  })
})
