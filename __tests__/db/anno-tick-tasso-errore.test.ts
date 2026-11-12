import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  creaDbAnnoPr2,
  fissaCalendarioAnni,
  SCHEMA_ISCRIZIONE_ANNO,
} from '../helpers/schema-anno-pglite'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { controlloTassoErrore } from '@/lib/health/controlli'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * CORREZIONI DOPO LA REVISIONE FINALE · F1. Il giro orario di `anni_tick` scrive una riga `error` per sede quando il passaggio d'anno
 * non è fatto a 7 giorni dall'inizio (e una quando la guardia spenta tiene fermo un cambio di stato dovuto). Con `ON CONFLICT … DO UPDATE
 * SET occorrenze = occorrenze + 1` la riga di ogni sede valeva k al k-esimo tick del giorno, con `visto_l_ultima` sempre fresca: il
 * controllo `tasso-errore` (somma le occorrenze dei 15 minuti, soglia 25) diventava `degradato` da solo dal 9° tick su 3 sedi. Il
 * commento di M49a lo prometteva già: UN `error` al giorno per sede.
 *
 * Il test parte dalle righe VERE che i giri scrivono nel banco e le dà al controllo vero, via un finto client Supabase.
 * Solo uuid inventati (nessuno comincia per `e2e0…`: sono sedi «vere» per il tick).
 */

const SEDI = [
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
]

let db: PGlite

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: SEDI, fino: 'M49b', completo: true,
    codaPrima: `${SCHEMA_ISCRIZIONE_ANNO}
      ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS anonimizzato_il timestamptz;
      ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS archiviato_da uuid, ADD COLUMN IF NOT EXISTS archiviato_motivo text,
        ADD COLUMN IF NOT EXISTS archiviato_section_id uuid, ADD COLUMN IF NOT EXISTS archiviato_classe_sezione text;`,
  })
  await fissaCalendarioAnni(db)
}, 180_000)
afterAll(async () => { await db?.close() })
afterEach(() => { vi.useRealTimers() })

/** Il tick come lo lancia `pg_cron` (nessun argomento) a un istante UTC. */
async function giraAlle(istanteUtc: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(istanteUtc))
  await db.query('SELECT public.anni_tick()')
}

/** Le righe vere di `app_log` date al controllo vero. (In produzione `ambiente` lo riempie la migrazione 20260804103151.) */
async function tassoErrore(adessoUtc: string) {
  const r = await db.query<{ occorrenze: number; visto_l_ultima: string; livello: string; sorgente: string; fingerprint: string }>(
    `SELECT occorrenze, visto_l_ultima::text, livello, sorgente, fingerprint FROM public.app_log`)
  const righe = r.rows.map((x) => ({ ...x, visto_l_ultima: new Date(x.visto_l_ultima).toISOString(), ambiente: 'production' }))
  const client = creaFintoSupabase({ app_log: righe }) as unknown as SupabaseClient
  return { righe: r.rows, esito: await controlloTassoErrore(client, Date.parse(adessoUtc), 'production') }
}

describe('F1 · le righe orarie di anni_tick non accendono `tasso-errore`', () => {
  it('9 giri orari su 3 sedi vere col passaggio da fare (25/08/2027): UN `error` per sede, occorrenze 1, tasso-errore `ok`', async () => {
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true, sedi_simulazione = '{}'`)
    await db.exec(`DELETE FROM public.app_log`)
    for (let ora = 1; ora <= 9; ora++) {
      await giraAlle(`2027-08-25T${String(ora).padStart(2, '0')}:10:00Z`)
    }
    const { righe, esito } = await tassoErrore('2027-08-25T09:20:00Z')
    const passaggio = righe.filter((x) => x.fingerprint.startsWith('anni-tick-passaggio-da-fare:'))
    expect(passaggio, 'una riga per sede vera').toHaveLength(3)
    expect(passaggio.map((x) => x.occorrenze), 'mai sommate nel giorno').toEqual([1, 1, 1])
    expect(esito).toMatchObject({ nome: 'tasso-errore', esito: 'ok' })
  })

  it('la guardia SPENTA con un cambio di stato dovuto: anche `anni-tick-guardia-spenta:<sede>` resta a una occorrenza al giorno', async () => {
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false`)
    await db.exec(`DELETE FROM public.app_log`)
    // il 01/08/2027 l'anno 2026/27 dovrebbe passare a `in_chiusura`: a guardia spenta il tick non lo fa e lo scrive
    await db.exec(`UPDATE public.anni_sede SET stato = 'corrente' WHERE stato = 'in_chiusura'`)
    for (let ora = 1; ora <= 5; ora++) {
      await giraAlle(`2027-08-02T${String(ora).padStart(2, '0')}:10:00Z`)
    }
    const { righe } = await tassoErrore('2027-08-02T05:20:00Z')
    const spente = righe.filter((x) => x.fingerprint.startsWith('anni-tick-guardia-spenta:'))
    expect(spente, 'una riga per sede').toHaveLength(3)
    expect(spente.map((x) => x.occorrenze)).toEqual([1, 1, 1])
  })
})

describe('(correzioni, giro 2, N4) guardia spenta E passaggio da fare, 3 sedi vere, primo giro del giorno', () => {
  it('le sei impronte di anni_tick non accendono `tasso-errore`; un errore vero di un\'altra impronta sì', async () => {
    await fissaCalendarioAnni(db)
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false, sedi_simulazione = '{}'`)
    await db.exec(`DELETE FROM public.app_log`)
    await giraAlle('2027-08-25T00:10:00Z')
    const { righe, esito } = await tassoErrore('2027-08-25T00:20:00Z')
    const impronte = righe.map((x) => x.fingerprint.split(':')[0]).sort()
    expect(impronte.filter((f) => f === 'anni-tick-guardia-spenta'), 'una per sede vera').toHaveLength(3)
    expect(impronte.filter((f) => f === 'anni-tick-passaggio-da-fare'), 'una per sede vera').toHaveLength(3)
    expect(esito, 'sei impronte, ma le copre già il controllo `anno`: tasso-errore resta ok').toMatchObject({ nome: 'tasso-errore', esito: 'ok' })

    // Sei errori veri (soglia 5): tre di un'impronta qualunque e tre di `anni-tick-stati-errore`, un'ALTRA impronta di anni_tick
    // (un errore vero del tick). Il controllo li conta ancora, anche con le due impronte escluse presenti; un filtro `anni-tick-%`
    // troppo largo nasconderebbe i tre del tick e lascerebbe il controllo `ok`.
    await db.exec(`INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint)
                   SELECT 'error', 'api', 'server', 'prova', 'errore-vero-di-prova:' || g FROM generate_series(1, 3) g`)
    await db.exec(`INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint)
                   SELECT 'error', 'api', 'server', 'prova', 'anni-tick-stati-errore:' || g FROM generate_series(1, 3) g`)
    const dopo = await tassoErrore('2027-08-25T00:20:00Z')
    expect(dopo.esito).toMatchObject({ nome: 'tasso-errore', esito: 'degradato' })
  })
})
