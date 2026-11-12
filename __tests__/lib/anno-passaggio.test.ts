import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { logEvento, logErrore } from '@/lib/logging/logger'
import { redact } from '@/lib/logging/redact'
import {
  anteprimaPassaggio,
  annullaPassaggio,
  confermaPassaggio,
  confermaTardiva,
  correggiRigaPassaggio,
  impostaDocentePassaggio,
  leggiPassaggio,
} from '@/lib/anno/passaggio'

/**
 * COMPITO 4.8.5 · la porta TypeScript del passaggio d'anno (`src/lib/anno/passaggio.ts`).
 *
 * Le funzioni SQL `passaggio_*` si provano in PGlite (compiti 4.8.1, 4.8.2, 4.8.7). Qui il client è un finto che registra le
 * chiamate `.rpc(nome, args)` e le letture `.from(...)`: si prova come la porta traduce gli esiti (schema indietro, codice
 * dell'anno, guasto, eccezione) e che nei log non esca niente che non sia un uuid, un numero o un codice. Solo uuid finti.
 */

const PASSAGGIO = '11111111-1111-4111-8111-111111111111'
const DA_ANNO = '22222222-2222-4222-8222-222222222221'
const A_ANNO = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '33333333-3333-4333-8333-333333333333'
const SEZIONE = '44444444-4444-4444-8444-444444444444'
const UTENTE = '55555555-5555-4555-8555-555555555555'
const STAFF = '66666666-6666-4666-8666-666666666666'

type ErroreFinto = { code?: string; message?: string; details?: string | null }
type Risposta = { data?: unknown; error?: ErroreFinto | null }

function clienteRpc(risposta: Risposta | (() => never)) {
  const rpc = vi.fn<(...args: unknown[]) => Promise<Risposta>>(async () => {
    if (typeof risposta === 'function') return risposta()
    return { data: risposta.data ?? null, error: risposta.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const logWarn = () => vi.mocked(logEvento).mock.calls.filter((c) => c[1] === 'warn')
const logInfo = () => vi.mocked(logEvento).mock.calls.filter((c) => c[1] === 'info')

beforeEach(() => {
  vi.mocked(logEvento).mockClear()
  vi.mocked(logErrore).mockClear()
})

describe('le sei scritture: nome della RPC e parametri', () => {
  it('anteprima: p_oggi non si manda se non è dato', async () => {
    const { client, rpc } = clienteRpc({ data: { passaggio_id: PASSAGGIO, creato: true, righe: { continua: 2 } } })
    const r = await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF })
    expect(r).toMatchObject({ ok: true, passaggio_id: PASSAGGIO, creato: true })
    expect(rpc).toHaveBeenCalledWith('passaggio_anteprima', { p_da_anno_sede: DA_ANNO, p_a_anno_sede: A_ANNO, p_da: STAFF })
    expect(Object.keys(rpc.mock.calls[0][1] as object)).not.toContain('p_oggi')
  })

  it('anteprima: p_oggi si manda se è dato', async () => {
    const { client, rpc } = clienteRpc({ data: { passaggio_id: PASSAGGIO, creato: false, righe: {} } })
    await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF, oggi: '2027-08-31' })
    expect(rpc).toHaveBeenCalledWith('passaggio_anteprima', {
      p_da_anno_sede: DA_ANNO, p_a_anno_sede: A_ANNO, p_da: STAFF, p_oggi: '2027-08-31',
    })
  })

  it('correzione di una riga: la sezione assente va come null', async () => {
    const { client, rpc } = clienteRpc({ data: { alunno_id: ALUNNO, esito: 'esce', eccezione: true } })
    const r = await correggiRigaPassaggio(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, esito: 'esce', da: STAFF })
    expect(r).toMatchObject({ ok: true, alunno_id: ALUNNO, esito: 'esce', eccezione: true })
    expect(rpc).toHaveBeenCalledWith('passaggio_riga_correggi', {
      p_passaggio: PASSAGGIO, p_alunno: ALUNNO, p_esito: 'esce', p_sezione: null, p_da: STAFF,
    })
  })

  it('correzione di una riga: con la sezione', async () => {
    const { client, rpc } = clienteRpc({ data: { alunno_id: ALUNNO, esito: 'continua', eccezione: true } })
    await correggiRigaPassaggio(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, esito: 'continua', sezioneId: SEZIONE, da: STAFF })
    expect(rpc).toHaveBeenCalledWith('passaggio_riga_correggi', {
      p_passaggio: PASSAGGIO, p_alunno: ALUNNO, p_esito: 'continua', p_sezione: SEZIONE, p_da: STAFF,
    })
  })

  it('docente: aggiunto o tolto', async () => {
    const { client, rpc } = clienteRpc({ data: { utente_id: UTENTE, sezione_a_id: SEZIONE, origine: 'tolta' } })
    const r = await impostaDocentePassaggio(client, { passaggioId: PASSAGGIO, utenteId: UTENTE, sezioneId: SEZIONE, origine: 'tolta', da: STAFF })
    expect(r.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('passaggio_docente_imposta', {
      p_passaggio: PASSAGGIO, p_utente: UTENTE, p_sezione: SEZIONE, p_origine: 'tolta', p_da: STAFF,
    })
  })

  it('conferma: p_oggi solo se dato', async () => {
    const { client, rpc } = clienteRpc({ data: { passaggio_id: PASSAGGIO, gia_confermato: false, conteggi: { continuano: 4, nuovi: 1 } } })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toMatchObject({ ok: true, gia_confermato: false })
    expect(rpc).toHaveBeenCalledWith('passaggio_conferma', { p_passaggio: PASSAGGIO, p_da: STAFF })
    await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF, oggi: '2027-09-01' })
    expect(rpc).toHaveBeenLastCalledWith('passaggio_conferma', { p_passaggio: PASSAGGIO, p_da: STAFF, p_oggi: '2027-09-01' })
  })

  it('annullamento: p_oggi solo se dato', async () => {
    const { client, rpc } = clienteRpc({ data: { passaggio_id: PASSAGGIO, gia_annullato: false } })
    const r = await annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toMatchObject({ ok: true, passaggio_id: PASSAGGIO })
    expect(rpc).toHaveBeenCalledWith('passaggio_annulla', { p_passaggio: PASSAGGIO, p_da: STAFF })
    await annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF, oggi: '2027-09-02' })
    expect(rpc).toHaveBeenLastCalledWith('passaggio_annulla', { p_passaggio: PASSAGGIO, p_da: STAFF, p_oggi: '2027-09-02' })
  })

  it('conferma tardiva: il parametro della sezione si chiama p_section', async () => {
    const { client, rpc } = clienteRpc({ data: { frequenza_id: PASSAGGIO, creata: true, quota: 'creata', pagamento_id: null } })
    const r = await confermaTardiva(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, da: STAFF })
    expect(r).toMatchObject({ ok: true, creata: true })
    expect(rpc).toHaveBeenCalledWith('passaggio_conferma_tardiva', {
      p_passaggio: PASSAGGIO, p_alunno: ALUNNO, p_section: null, p_da: STAFF,
    })
    await confermaTardiva(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, sectionId: SEZIONE, da: STAFF, oggi: '2027-10-04' })
    expect(rpc).toHaveBeenLastCalledWith('passaggio_conferma_tardiva', {
      p_passaggio: PASSAGGIO, p_alunno: ALUNNO, p_section: SEZIONE, p_da: STAFF, p_oggi: '2027-10-04',
    })
  })
})

describe('schema indietro', () => {
  it.each(['PGRST202', '42883', '42P01'])('%s: saltata, con un info e senza errore', async (code) => {
    const { client } = clienteRpc({ error: { code, message: 'qualcosa di Postgres' } })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: true, saltata: 'schema-indietro' })
    expect(logInfo().length).toBe(1)
    expect(logInfo()[0][2]).toMatchObject({ error_code: code })
    expect(logWarn().length).toBe(0)
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('vale per tutte e sei le scritture', async () => {
    const { client } = clienteRpc({ error: { code: 'PGRST202', message: 'x' } })
    const esiti = await Promise.all([
      anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF }),
      correggiRigaPassaggio(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, esito: 'esce', da: STAFF }),
      impostaDocentePassaggio(client, { passaggioId: PASSAGGIO, utenteId: UTENTE, sezioneId: SEZIONE, origine: 'aggiunta', da: STAFF }),
      confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF }),
      annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF }),
      confermaTardiva(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, da: STAFF }),
    ])
    for (const e of esiti) expect(e).toEqual({ ok: true, saltata: 'schema-indietro' })
  })
})

describe('un codice dell’anno', () => {
  it.each([
    'PASSAGGIO_NON_PRONTO', 'PASSAGGIO_TROPPO_PRESTO', 'PASSAGGIO_GIA_CONFERMATO', 'PASSAGGIO_NON_ANNULLABILE',
    'PASSAGGIO_NON_MODIFICABILE', 'PASSAGGIO_NON_TROVATO', 'ANTEPRIMA_VECCHIA', 'RIGHE_DA_DECIDERE', 'RIGA_NON_VALIDA',
  ])('%s → ok:false col codice, warn con il solo codice e l’uuid', async (codice) => {
    const { client } = clienteRpc({ error: { code: 'P0001', message: codice } })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: false, codice })
    expect(logWarn().length).toBe(1)
    expect(logWarn()[0][0]).toBe('anno-scolastico')
    expect(logWarn()[0][2]).toEqual({ tipo: 'passaggio-rifiutato', error_code: codice, entita_id: PASSAGGIO })
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('un codice dell’anno già esistente passa dallo stesso ramo (SEDE_DIVERSA)', async () => {
    const { client } = clienteRpc({ error: { code: 'P0001', message: 'SEDE_DIVERSA' } })
    const r = await correggiRigaPassaggio(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, esito: 'continua', sezioneId: SEZIONE, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'SEDE_DIVERSA' })
  })

  it('anteprima: l’entità del log è l’anno nuovo (il passaggio può non esistere ancora)', async () => {
    const { client } = clienteRpc({ error: { code: 'P0001', message: 'PASSAGGIO_NON_PRONTO' } })
    await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF })
    expect(logWarn()[0][2]).toMatchObject({ entita_id: A_ANNO })
  })

  it('il DETAIL con i conteggi arriva alla route come `dettagli`, solo numeri, e NON finisce nei log', async () => {
    const { client } = clienteRpc({
      error: { code: 'P0001', message: 'RIGHE_DA_DECIDERE', details: JSON.stringify({ senza_sezione: 3, avvisi: 2, nome: 'Mario', annidato: { a: 1 }, vuoto: null }) },
    })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'RIGHE_DA_DECIDERE', dettagli: { senza_sezione: 3, avvisi: 2 } })
    expect(JSON.stringify(vi.mocked(logEvento).mock.calls)).not.toContain('senza_sezione')
    expect(JSON.stringify(vi.mocked(logEvento).mock.calls)).not.toContain('Mario')
  })

  it('un DETAIL che non è JSON, o è un testo, non lancia e non produce `dettagli`', async () => {
    for (const details of ['non json {', 'prima_riga=3', '', null, '[1,2]', '"testo"']) {
      const { client } = clienteRpc({ error: { code: 'P0001', message: 'PASSAGGIO_NON_ANNULLABILE', details } })
      const r = await annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
      expect(r).toEqual({ ok: false, codice: 'PASSAGGIO_NON_ANNULLABILE' })
    }
  })
})

describe('un guasto', () => {
  it('SCRITTURA_FALLITA, con il solo SQLSTATE nel log: mai il testo di Postgres', async () => {
    const { client } = clienteRpc({
      error: { code: '23514', message: 'new row violates check constraint, Failing row contains (RSSMRA80A01H501U, allergia grave)', details: 'Key (alunno_id)=(x)' },
    })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledTimes(1)
    const [ctx, err] = vi.mocked(logErrore).mock.calls[0] as [{ operazione: string }, Error]
    expect(ctx.operazione).toContain('passaggio')
    expect(err.message).toBe('passaggio:23514')
    expect(JSON.stringify(vi.mocked(logErrore).mock.calls)).not.toContain('RSSMRA')
    expect(JSON.stringify(vi.mocked(logEvento).mock.calls)).not.toContain('RSSMRA')
    expect(logWarn().length).toBe(0)
  })

  it('senza codice SQLSTATE: lo dice', async () => {
    const { client } = clienteRpc({ error: { message: 'boh' } })
    const r = await annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((vi.mocked(logErrore).mock.calls[0][1] as Error).message).toBe('passaggio:senza-codice')
  })

  it('il client che LANCIA (rete) non fa cadere il chiamante', async () => {
    const { client } = clienteRpc(() => { throw new Error('rete caduta') })
    const r = await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledTimes(1)
  })

  it('una risposta che non ha la forma attesa è un guasto, non un successo', async () => {
    const { client } = clienteRpc({ data: { altro: 1 } })
    const r = await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(logInfo().length).toBe(0)
  })

  it('il `{ error }` di PostgREST è controllato, non lanciato: nessuna eccezione esce', async () => {
    const { client } = clienteRpc({ error: { code: 'XX000', message: 'interno' } })
    await expect(confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })).resolves.toMatchObject({ ok: false })
  })
})

describe('il log del successo porta soli numeri, uuid e codici', () => {
  const chiavi = (o: object) => Object.keys(o).sort()

  it('anteprima', async () => {
    const { client } = clienteRpc({
      data: { passaggio_id: PASSAGGIO, creato: true, righe: { continua: 5, cambia_grado: 1, nuova: 2, esce: 1, non_risposto: 3 }, avvisi: { ritirato_tendina: 1 }, docenti: { copiati: 4 }, apribile_dal: '2027-09-01' },
    })
    await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF })
    const info = logInfo()
    expect(info.length).toBe(1)
    const payload = info[0][2] as Record<string, unknown>
    expect(info[0][0]).toBe('anno-scolastico')
    expect(payload).toEqual({ tipo: 'passaggio-anteprima', esito: 'creata', n: 12, entita_id: PASSAGGIO })
    expect(chiavi(payload)).toEqual(['entita_id', 'esito', 'n', 'tipo'])
    // la lista bianca del logger lascia passare tutto in chiaro: niente da redigere
    expect(redact(payload)).toEqual(payload)
  })

  it('anteprima rifatta: esito `esistente`', async () => {
    const { client } = clienteRpc({ data: { passaggio_id: PASSAGGIO, creato: false, righe: { continua: 1 } } })
    await anteprimaPassaggio(client, { daAnnoSedeId: DA_ANNO, aAnnoSedeId: A_ANNO, da: STAFF })
    expect(logInfo()[0][2]).toMatchObject({ esito: 'esistente', n: 1 })
  })

  it('conferma', async () => {
    const { client } = clienteRpc({ data: { passaggio_id: PASSAGGIO, gia_confermato: false, conteggi: { continuano: 4, nuovi: 2, usciti: 1, cambia_grado: 1, docenti_copiati: 3 } } })
    await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    const payload = logInfo()[0][2] as Record<string, unknown>
    expect(payload).toEqual({ tipo: 'passaggio-confermato', esito: 'confermato', n: 8, entita_id: PASSAGGIO })
    expect(redact(payload)).toEqual(payload)
  })

  it('conferma rifatta: esito `gia_confermato`', async () => {
    const { client } = clienteRpc({ data: { passaggio_id: PASSAGGIO, gia_confermato: true, conteggi: {} } })
    await confermaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    expect(logInfo()[0][2]).toMatchObject({ tipo: 'passaggio-confermato', esito: 'gia_confermato' })
  })

  it('annullamento', async () => {
    const { client } = clienteRpc({ data: { passaggio_id: PASSAGGIO, gia_annullato: false } })
    await annullaPassaggio(client, { passaggioId: PASSAGGIO, da: STAFF })
    const payload = logInfo()[0][2] as Record<string, unknown>
    expect(payload).toMatchObject({ tipo: 'passaggio-annullato', esito: 'annullato', entita_id: PASSAGGIO })
    expect(redact(payload)).toEqual(payload)
  })

  it('conferma tardiva', async () => {
    const FREQ = '77777777-7777-4777-8777-777777777777'
    const { client } = clienteRpc({ data: { frequenza_id: FREQ, creata: true, quota: 'creata', pagamento_id: null } })
    await confermaTardiva(client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, da: STAFF })
    const payload = logInfo()[0][2] as Record<string, unknown>
    expect(payload).toEqual({ tipo: 'passaggio-conferma-tardiva', esito: 'creata', n: 1, entita_id: FREQ })
    expect(redact(payload)).toEqual(payload)
  })

  it('correggi riga e docente non loggano un successo per bambino', async () => {
    const a = clienteRpc({ data: { alunno_id: ALUNNO, esito: 'esce', eccezione: true } })
    await correggiRigaPassaggio(a.client, { passaggioId: PASSAGGIO, alunnoId: ALUNNO, esito: 'esce', da: STAFF })
    const b = clienteRpc({ data: { utente_id: UTENTE, sezione_a_id: SEZIONE, origine: 'aggiunta' } })
    await impostaDocentePassaggio(b.client, { passaggioId: PASSAGGIO, utenteId: UTENTE, sezioneId: SEZIONE, origine: 'aggiunta', da: STAFF })
    expect(JSON.stringify(vi.mocked(logEvento).mock.calls)).not.toContain(ALUNNO)
  })
})

// ───────────────────────────── la lettura ─────────────────────────────

type Chiamata = { tabella: string; passi: Array<[string, unknown[]]> }

/** Un client che risponde alle `.from(tabella)` con una catena registrata: `risposte[tabella]` è la risposta finale. */
function clienteLettura(risposte: Record<string, { data?: unknown; error?: ErroreFinto | null; count?: number | null } | (() => never)>) {
  const chiamate: Chiamata[] = []
  const from = vi.fn((tabella: string) => {
    const c: Chiamata = { tabella, passi: [] }
    chiamate.push(c)
    const risolvi = async () => {
      const r = risposte[tabella]
      if (typeof r === 'function') return r()
      return { data: r?.data ?? null, error: r?.error ?? null, count: r?.count ?? null }
    }
    const catena: Record<string, unknown> = {}
    for (const metodo of ['select', 'eq', 'neq', 'in', 'order', 'range', 'limit']) {
      catena[metodo] = (...args: unknown[]) => { c.passi.push([metodo, args]); return catena }
    }
    catena.maybeSingle = () => { c.passi.push(['maybeSingle', []]); return risolvi() }
    catena.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => risolvi().then(ok, ko)
    return catena
  })
  return { client: { from } as unknown as SupabaseClient, chiamate }
}

const passi = (c: Chiamata, nome: string) => c.passi.filter(([m]) => m === nome).map(([, a]) => a)

describe('leggiPassaggio', () => {
  // (giro 3, NS8) 22:30 UTC di luglio sono le 00:30 del giorno dopo a Roma: `confermato_il` esce come GIORNO DI ROMA.
  const PASSAGGIO_RIGA = { id: PASSAGGIO, stato: 'anteprima', conteggi: {}, da_anno_sede_id: DA_ANNO, confermato_il: '2027-07-05T22:30:00Z' }
  const RIGA = { alunno_id: ALUNNO, esito: 'continua', avviso: null, eccezione: false, sezione_da_id: SEZIONE, sezione_a_id: SEZIONE, frequenza_a_id: null }

  it('legge il passaggio NON annullato col suo anno nuovo, le righe a pagine con il totale esatto, i docenti', async () => {
    const { client, chiamate } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [RIGA], count: 57 },
      passaggi_anno_docenti: { data: [{ utente_id: UTENTE, sezione_a_id: SEZIONE, origine: 'copiata' }] },
    })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 3, tetto: 20 })
    expect(r).toEqual({
      ok: true,
      passaggio: { id: PASSAGGIO, stato: 'anteprima', conteggi: {}, apribile_dal: '2027-09-01', inizio_anno_nuovo: null, confermato_il: '2027-07-06' },
      classi_da: {},
      righe: [RIGA],
      totale: 57,
      docenti: [{ utente_id: UTENTE, sezione_a_id: SEZIONE, origine: 'copiata' }],
    })

    const p = chiamate.find((c) => c.tabella === 'passaggi_anno')!
    expect(passi(p, 'eq')).toContainEqual(['a_anno_sede_id', A_ANNO])
    expect(passi(p, 'neq')).toContainEqual(['stato', 'annullato'])

    const righe = chiamate.find((c) => c.tabella === 'passaggi_anno_righe')!
    expect(passi(righe, 'select')[0][1]).toEqual({ count: 'exact' })
    expect(passi(righe, 'eq')).toContainEqual(['passaggio_id', PASSAGGIO])
    // pagina 3 da 20 (1-based): righe 40..59
    expect(passi(righe, 'range')).toEqual([[40, 59]])
    // ordine stabile sugli uuid: mai sui nomi
    expect(passi(righe, 'order')[0][0]).toBe('alunno_id')
  })

  it('il colonnato letto è di soli uuid e stati: nessuna colonna di nomi', async () => {
    const { client, chiamate } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [], count: 0 },
      passaggi_anno_docenti: { data: [] },
    })
    await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 50 })
    const colonne = chiamate.flatMap((c) => passi(c, 'select').map((a) => String(a[0])))
    for (const nome of ['nome', 'cognome', 'email', 'codice_fiscale', 'note', 'allergie']) {
      expect(colonne.join(',')).not.toContain(nome)
    }
  })

  it('il filtro per esito e per avviso si applica alla query, quindi il totale è quello del filtro', async () => {
    const { client, chiamate } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [RIGA], count: 4 },
      passaggi_anno_docenti: { data: [] },
    })
    const r = await leggiPassaggio(client, A_ANNO, { esito: 'cambia_grado', avviso: 'senza_sezione', pagina: 1, tetto: 10 })
    expect(r).toMatchObject({ ok: true, totale: 4 })
    const righe = chiamate.find((c) => c.tabella === 'passaggi_anno_righe')!
    expect(passi(righe, 'eq')).toContainEqual(['esito', 'cambia_grado'])
    expect(passi(righe, 'eq')).toContainEqual(['avviso', 'senza_sezione'])
    expect(passi(righe, 'range')).toEqual([[0, 9]])
  })

  it('senza filtri le query non portano né `esito` né `avviso`', async () => {
    const { client, chiamate } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [], count: 0 },
      passaggi_anno_docenti: { data: [] },
    })
    await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 10 })
    const righe = chiamate.find((c) => c.tabella === 'passaggi_anno_righe')!
    const eq = passi(righe, 'eq').map((a) => a[0])
    expect(eq).not.toContain('esito')
    expect(eq).not.toContain('avviso')
  })

  it('nessun passaggio: passaggio null, righe e docenti vuoti, senza altre letture', async () => {
    const { client, chiamate } = clienteLettura({ passaggi_anno: { data: null } })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 20 })
    expect(r).toEqual({ ok: true, passaggio: null, righe: [], totale: 0, docenti: [] })
    expect(chiamate.map((c) => c.tabella)).toEqual(['passaggi_anno'])
  })

  it('pagina e tetto fuori misura si riportano a valori sani (pagina ≥ 1, tetto 1..200)', async () => {
    const { client, chiamate } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [], count: 0 },
      passaggi_anno_docenti: { data: [] },
    })
    await leggiPassaggio(client, A_ANNO, { pagina: 0, tetto: 100000 })
    const righe = chiamate.find((c) => c.tabella === 'passaggi_anno_righe')!
    expect(passi(righe, 'range')).toEqual([[0, 199]])
  })

  it('schema indietro (tabella assente): saltata, con un info', async () => {
    const { client } = clienteLettura({ passaggi_anno: { error: { code: 'PGRST205', message: 'no table' } } })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 20 })
    expect(r).toEqual({ ok: true, saltata: 'schema-indietro' })
    expect(logInfo().length).toBe(1)
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('il `{ error }` di PostgREST su una lettura è controllato: SCRITTURA_FALLITA col solo SQLSTATE', async () => {
    const { client } = clienteLettura({
      passaggi_anno: { data: PASSAGGIO_RIGA },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { error: { code: '57014', message: 'canceling statement, riga RSSMRA80A01H501U' } },
      passaggi_anno_docenti: { data: [] },
    })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 20 })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(logErrore).mock.calls)).not.toContain('RSSMRA')
    expect((vi.mocked(logErrore).mock.calls[0][1] as Error).message).toBe('passaggio:57014')
  })

  it('il client che lancia non fa cadere la lettura', async () => {
    const { client } = clienteLettura({ passaggi_anno: () => { throw new Error('rete') } })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 20 })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
  })

  it('i conteggi del passaggio sono solo numeri', async () => {
    const { client } = clienteLettura({
      passaggi_anno: { data: { ...PASSAGGIO_RIGA, stato: 'confermato', conteggi: { continuano: 4, usciti: 1, testo: 'Mario', annidato: { a: 1 } } } },
      anni_sede: { data: { ultimo_giorno_aperto: '2027-08-31' } },
      passaggi_anno_righe: { data: [], count: 0 },
      passaggi_anno_docenti: { data: [] },
    })
    const r = await leggiPassaggio(client, A_ANNO, { pagina: 1, tetto: 20 })
    expect(r).toMatchObject({ ok: true, passaggio: { stato: 'confermato', conteggi: { continuano: 4, usciti: 1 } } })
    expect(JSON.stringify(r)).not.toContain('Mario')
  })
})
