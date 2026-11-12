import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2,
  fissaCalendarioAnni,
  SCHEMA_AVVISI_CHAT_VOCI_GENITORE,
  SCHEMA_GALLERIA_GENITORE,
  SCHEMA_ISCRIZIONE_ANNO,
  SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.9.1 · IL PASSO 2 DI `anni_tick` (M49a): `corrente → in_chiusura → chiuso`, mai `→ corrente`.
 *
 * È la prima volta che il programma cambia DA SOLO lo stato di un anno per migliaia di righe di minori, e il rischio peggiore è una
 * sede che si chiude il giorno sbagliato. Per questo le prove vanno dal giorno di Roma (mezzanotte, i due cambi d'ora) alla guardia
 * spenta (che è lo stato di PRODUZIONE oggi) a quella accesa.
 *
 * ── Il calendario del banco ── 2025/26 `chiuso`; 2026/27 `corrente` dal 01/09/2026 al 31/08/2027 con ultimo giorno aperto il
 * 31/07/2027 (le date sono QUELLE della fixture, fissate da `fissaCalendarioAnni`: non dipendono da oggi); 2027/28 `in_preparazione`.
 * Quindi: il 31/07/2027 l'anno è ancora `corrente`, il 01/08 `in_chiusura`, il 31/08 `in_chiusura`, il 01/09 `chiuso`.
 *
 * ── L'orologio ── Il giorno si passa con `p_oggi` (ammesso solo per una sede di prova `e2e0…` o di simulazione). Le prove che
 * chiamano il tick SENZA `p_oggi` (il suo modo di girare in produzione) spostano l'orologio con `vi.setSystemTime`, che PGlite
 * segue (provato da `anno-banco-orologio`): servono a dire che il giorno è quello di ROMA, non quello UTC.
 *
 * Solo uuid finti: `e2e0…` sedi di prova ammesse, `2222…` una sede «vera» (guardia spenta, niente simulazione).
 */

const E = (n: number) => `e2e00000-0000-4000-8000-${String(n).padStart(12, '0')}`
const REALE = '22222222-2222-4222-8222-222222222222'
const SIMULATA = '33333333-3333-4333-8333-333333333333'

type Stati = Record<string, string>

async function creaBanco(sedi: string[]): Promise<PGlite> {
  const db = await creaDbAnnoPr2({
    sedi, fino: 'M49a', completo: true,
    // (rebase sulla 4.8 giro 2) l'invariante 15 dello storico legge `alunni.anonimizzato_il`, che il banco non ha di serie.
    codaPrima: `${SCHEMA_ISCRIZIONE_ANNO}\nALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS anonimizzato_il timestamptz;
      -- (rebase sul merge della 4.8) la conferma del passaggio ricorda le tracce dell'archiviazione: il banco deve avere le colonne.
      ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS archiviato_da uuid, ADD COLUMN IF NOT EXISTS archiviato_motivo text,
        ADD COLUMN IF NOT EXISTS archiviato_section_id uuid, ADD COLUMN IF NOT EXISTS archiviato_classe_sezione text;`,
  })
  void SCHEMA_AVVISI_CHAT_VOCI_GENITORE; void SCHEMA_GALLERIA_GENITORE; void SCHEMA_LEGAMI_GENITORE
  return db
}

async function una<T>(d: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const r = await d.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function guardia(d: PGlite, accesa: boolean): Promise<void> {
  await d.query(`UPDATE public.anno_regole SET guardia_attiva = $1`, [accesa])
}
/** `{ '2025': 'chiuso', '2026': 'corrente', '2027': 'in_preparazione' }` della sede. */
async function stati(d: PGlite, sede: string): Promise<Stati> {
  const r = await d.query<{ anno: number; stato: string }>(
    `SELECT y.anno_inizio AS anno, s.stato FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1 ORDER BY y.anno_inizio`, [sede])
  return Object.fromEntries(r.rows.map((x) => [String(x.anno), x.stato]))
}
async function domande(d: PGlite, sede: string, anno: number): Promise<boolean> {
  return una<boolean>(d, `SELECT s.domande_aperte FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
                           WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [sede, anno])
}
async function idAnno(d: PGlite, sede: string, anno: number): Promise<string> {
  return una<string>(d, `SELECT s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
                          WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [sede, anno])
}
async function storia(d: PGlite, sede: string, anno: number) {
  const r = await d.query<{ stato: string; da: string | null }>(
    `SELECT st.stato, st.da FROM public.anni_sede_stati st
      WHERE st.anno_sede_id = $1 ORDER BY st.dal, st.stato`, [await idAnno(d, sede, anno)])
  return r.rows
}
interface Esito { in_chiusura: number; chiusi: number; saltati_guardia_spenta: number }
async function passo2(d: PGlite, sede: string, oggi: string): Promise<Esito> {
  return una<Esito>(d, `SELECT public.anno_stati_aggiorna($1::uuid, $2::date)`, [sede, oggi])
}
interface EsitoTick { oggi: string; sedi: number; creati: number; copie: number; errori: number; stati: number }
async function tick(d: PGlite, oggi: string | null, sede: string | null): Promise<EsitoTick> {
  return una<EsitoTick>(d, `SELECT public.anni_tick($1::date, $2::uuid)`, [oggi, sede])
}
async function righeLog(d: PGlite, prefisso: string) {
  const r = await d.query<{ livello: string; fingerprint: string; occorrenze: number; campi: Record<string, unknown> }>(
    `SELECT livello, fingerprint, occorrenze, contesto -> 'campi' AS campi FROM public.app_log
      WHERE fingerprint LIKE $1 ORDER BY fingerprint`, [prefisso + '%'])
  return r.rows
}
async function battito(d: PGlite) {
  const r = await d.query<{ campi: Record<string, unknown> }>(
    `SELECT contesto -> 'campi' AS campi FROM public.app_log WHERE fingerprint = 'cron:anni-tick' ORDER BY visto_l_ultima DESC LIMIT 1`)
  return r.rows[0]?.campi
}
/** Riporta il banco al calendario di partenza: il 2026/27 `corrente` con le domande aperte, niente storia, niente log. */
async function riporta(d: PGlite): Promise<void> {
  await d.exec(`DELETE FROM public.anni_sede_stati; DELETE FROM public.app_log;`)
  // il tick crea l'anno successivo dal 01/09/2027: il banco torna ai tre anni di partenza
  await d.exec(`DELETE FROM public.anni_sede WHERE anno_id IN (SELECT id FROM public.anni_scolastici WHERE anno_inizio > 2027);
                DELETE FROM public.anni_scolastici WHERE anno_inizio > 2027;`)
  await fissaCalendarioAnni(d)
  await d.exec(`UPDATE public.anni_sede SET domande_aperte = false; UPDATE public.anni_sede SET domande_aperte = true WHERE stato = 'corrente';`)
  await d.exec(`UPDATE public.anno_regole SET guardia_attiva = false, sedi_simulazione = '{}'`)
}

afterEach(() => {
  vi.useRealTimers()
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('il passo 2 con un giorno passato (sedi di prova)', () => {
  let db: PGlite
  const sedi = Array.from({ length: 12 }, (_, i) => E(i + 1))
  beforeAll(async () => { db = await creaBanco([...sedi, SIMULATA, REALE]) }, 180_000)
  afterAll(async () => { await db?.close() })

  it('il 31/07 l’anno resta `corrente`, il 01/08 passa a `in_chiusura` e lascia UNA riga di storia senza autore', async () => {
    const s = E(1)
    expect(await passo2(db, s, '2027-07-31')).toEqual({ in_chiusura: 0, chiusi: 0, saltati_guardia_spenta: 0 })
    expect(await stati(db, s)).toEqual({ 2025: 'chiuso', 2026: 'corrente', 2027: 'in_preparazione' })
    const prima = (await storia(db, s, 2026)).length

    expect(await passo2(db, s, '2027-08-01')).toEqual({ in_chiusura: 1, chiusi: 0, saltati_guardia_spenta: 0 })
    expect(await stati(db, s)).toEqual({ 2025: 'chiuso', 2026: 'in_chiusura', 2027: 'in_preparazione' })
    const dopo = await storia(db, s, 2026)
    expect(dopo).toHaveLength(prima + 1)
    expect(dopo.at(-1)).toEqual({ stato: 'in_chiusura', da: null })
  })

  it('il 31/08 resta `in_chiusura`, il 01/09 passa a `chiuso`', async () => {
    const s = E(2)
    await passo2(db, s, '2027-08-01')
    expect(await passo2(db, s, '2027-08-31')).toEqual({ in_chiusura: 0, chiusi: 0, saltati_guardia_spenta: 0 })
    expect((await stati(db, s))['2026']).toBe('in_chiusura')
    expect(await passo2(db, s, '2027-09-01')).toEqual({ in_chiusura: 0, chiusi: 1, saltati_guardia_spenta: 0 })
    expect(await stati(db, s)).toEqual({ 2025: 'chiuso', 2026: 'chiuso', 2027: 'in_preparazione' })
    expect((await storia(db, s, 2026)).at(-1)).toEqual({ stato: 'chiuso', da: null })
  })

  it('un anno in ritardo fa i due salti in un giro e lascia DUE righe in `anni_sede_stati`', async () => {
    const s = E(3)
    const prima = (await storia(db, s, 2026)).length
    expect(await passo2(db, s, '2027-12-01')).toEqual({ in_chiusura: 1, chiusi: 1, saltati_guardia_spenta: 0 })
    expect(await stati(db, s)).toEqual({ 2025: 'chiuso', 2026: 'chiuso', 2027: 'in_preparazione' })
    const nuove = (await storia(db, s, 2026)).slice(prima).map((x) => x.stato).sort()
    expect(nuove).toEqual(['chiuso', 'in_chiusura'])
  })

  it('rifatto due volte non cambia niente la seconda (stati, storia e log)', async () => {
    const s = E(4)
    await passo2(db, s, '2027-12-01')
    const storiaPrima = JSON.stringify(await storia(db, s, 2026))
    const logPrima = JSON.stringify(await righeLog(db, 'anno-stato:'))
    expect(await passo2(db, s, '2027-12-01')).toEqual({ in_chiusura: 0, chiusi: 0, saltati_guardia_spenta: 0 })
    expect(JSON.stringify(await storia(db, s, 2026))).toBe(storiaPrima)
    expect(JSON.stringify(await righeLog(db, 'anno-stato:'))).toBe(logPrima)
  })

  it('sedi con calendari diversi cambiano in momenti diversi', async () => {
    const [x, y] = [E(5), E(6)]
    // la sede X ha l'ultimo giorno aperto un mese prima: lo decide la sede, non il job
    await db.query(`UPDATE public.anni_sede SET ultimo_giorno_aperto = DATE '2027-06-30' WHERE id = $1`, [await idAnno(db, x, 2026)])
    await passo2(db, x, '2027-07-15'); await passo2(db, y, '2027-07-15')
    expect((await stati(db, x))['2026']).toBe('in_chiusura')
    expect((await stati(db, y))['2026']).toBe('corrente')
    await passo2(db, y, '2027-08-01')
    expect((await stati(db, y))['2026']).toBe('in_chiusura')
  })

  it('`domande_aperte` torna `false` nello stesso giro, e rimetterla a `true` è rifiutato alla COMMIT', async () => {
    const s = E(7)
    expect(await domande(db, s, 2026)).toBe(true)
    await passo2(db, s, '2027-08-01')
    expect(await domande(db, s, 2026)).toBe(false)
    expect(await messaggio(db.query(`UPDATE public.anni_sede SET domande_aperte = true WHERE id = $1`, [await idAnno(db, s, 2026)])))
      .toBe('ANNO_CHIUSO_CON_DOMANDE')
    expect(await domande(db, s, 2026)).toBe(false)
  })

  it('il vincolo guarda lo stato FINALE: stato e domande scritti in due istruzioni, in qualunque ordine, passano (così la conferma del passaggio della 4.8 non si rompe)', async () => {
    for (const [i, ordine] of [['stato', 'domande'], ['domande', 'stato']].entries()) {
      const s = E(8 + i)
      const id = await idAnno(db, s, 2026)
      await db.exec('BEGIN')
      try {
        for (const cosa of ordine) {
          if (cosa === 'stato') await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [id])
          else await db.query(`UPDATE public.anni_sede SET domande_aperte = false WHERE id = $1`, [id])
        }
        await db.exec('COMMIT')
      } catch (e) {
        await db.exec('ROLLBACK')
        throw e
      }
      expect((await stati(db, s))['2026']).toBe('in_chiusura')
      expect(await domande(db, s, 2026)).toBe(false)
    }
    // …e se alla COMMIT lo stato finale è proibito, la transazione cade e lo stato resta com'era
    const s = E(10)
    const id = await idAnno(db, s, 2026)
    await db.exec('BEGIN')
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [id])
    expect(await messaggio(db.exec('COMMIT'))).toBe('ANNO_CHIUSO_CON_DOMANDE')
    await db.exec('ROLLBACK').catch(() => undefined)
    expect((await stati(db, s))['2026']).toBe('corrente')
  })

  it('mai `corrente`: dopo un giro nessun anno lo è diventato, e un anno `iscrizioni_aperte` non si tocca', async () => {
    const s = E(11)
    await db.query(`UPDATE public.anni_sede SET stato = 'iscrizioni_aperte', domande_aperte = true WHERE id = $1`, [await idAnno(db, s, 2027)])
    const r = await passo2(db, s, '2027-12-01')
    expect(r).toEqual({ in_chiusura: 1, chiusi: 1, saltati_guardia_spenta: 0 })
    expect(await stati(db, s)).toEqual({ 2025: 'chiuso', 2026: 'chiuso', 2027: 'iscrizioni_aperte' })
    expect(await domande(db, s, 2027)).toBe(true)
    expect(await una<number>(db, `SELECT count(*)::int FROM public.anni_sede WHERE scuola_id = $1 AND stato = 'corrente'`, [s])).toBe(0)
  })

  it('un anno già `in_chiusura` per la conferma del passaggio (4.8) non è toccato di nuovo al primo salto', async () => {
    const s = E(12)
    const id = await idAnno(db, s, 2026)
    await db.exec(`BEGIN; UPDATE public.anni_sede SET stato = 'in_chiusura', domande_aperte = false WHERE id = '${id}'; COMMIT;`)
    const prima = (await storia(db, s, 2026)).length
    expect(await passo2(db, s, '2027-08-15')).toEqual({ in_chiusura: 0, chiusi: 0, saltati_guardia_spenta: 0 })
    expect((await storia(db, s, 2026)).length).toBe(prima)
    expect(await passo2(db, s, '2027-09-01')).toEqual({ in_chiusura: 0, chiusi: 1, saltati_guardia_spenta: 0 })
  })

  it('il log di un cambio: livello `info`, soli uuid e codici di stato, fingerprint con anno e stato', async () => {
    await riporta(db)
    const s = E(1)
    await passo2(db, s, '2027-08-01')
    const righe = await righeLog(db, 'anno-stato:')
    expect(righe).toHaveLength(1)
    const id = await idAnno(db, s, 2026)
    expect(righe[0].fingerprint).toBe(`anno-stato:${id}:in_chiusura`)
    expect(righe[0].livello).toBe('info')
    expect(righe[0].campi).toEqual({
      operazione: 'anni-tick', esito: 'stato', anno_sede_id: id, stato_da: 'corrente', stato_a: 'in_chiusura',
    })
  })

  it('la porta del giorno: per una sede che non è di prova né di simulazione un giorno scelto da chi chiama non è ammesso', async () => {
    await riporta(db)
    expect(await messaggio(passo2(db, REALE, '2027-08-01'))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
    expect(await messaggio(tick(db, '2027-08-01', REALE))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
    expect(await stati(db, REALE)).toEqual({ 2025: 'chiuso', 2026: 'corrente', 2027: 'in_preparazione' })
    // una sede in simulazione sì
    await db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [SIMULATA])
    expect(await passo2(db, SIMULATA, '2027-08-01')).toEqual({ in_chiusura: 1, chiusi: 0, saltati_guardia_spenta: 0 })
  })

  it('un parametro mancante è un errore, non un giro a vuoto', async () => {
    expect(await messaggio(db.query(`SELECT public.anno_stati_aggiorna($1::uuid, NULL)`, [E(1)]))).toBe('PARAMETRO_MANCANTE')
    expect(await messaggio(db.query(`SELECT public.anno_stati_aggiorna(NULL, DATE '2027-08-01')`))).toBe('PARAMETRO_MANCANTE')
  })

  it('l’invariante 16 vede un anno chiuso con le domande aperte, anche quando il vincolo non c’era', async () => {
    await riporta(db)
    expect(await una<number>(db, `SELECT coalesce(sum(righe), 0)::int FROM public.anno_invarianti() WHERE invariante = '16'`)).toBe(0)
    await db.exec(`ALTER TABLE public.anni_sede DISABLE TRIGGER anni_sede_domande_solo_aperto`)
    try {
      await db.query(`UPDATE public.anni_sede SET domande_aperte = true WHERE id = $1`, [await idAnno(db, E(2), 2025)])
      expect(await una<number>(db, `SELECT coalesce(sum(righe), 0)::int FROM public.anno_invarianti() WHERE invariante = '16'`)).toBe(1)
    } finally {
      await db.query(`UPDATE public.anni_sede SET domande_aperte = false WHERE id = $1`, [await idAnno(db, E(2), 2025)])
      await db.exec(`ALTER TABLE public.anni_sede ENABLE TRIGGER anni_sede_domande_solo_aperto`)
    }
    expect(await una<number>(db, `SELECT coalesce(sum(righe), 0)::int FROM public.anno_invarianti() WHERE invariante = '16'`)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('il tick senza `p_oggi`: il giorno è quello di ROMA, alla mezzanotte e ai cambi d’ora', () => {
  let db: PGlite
  beforeAll(async () => { db = await creaBanco([E(21), E(22)]) }, 180_000)
  afterAll(async () => { await db?.close() })

  /** Sposta l'orologio a un istante UTC e lancia il tick come lo lancia `pg_cron`: nessun argomento. */
  async function giraAlle(istanteUtc: string): Promise<EsitoTick> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(istanteUtc))
    return tick(db, null, null)
  }
  const sul2026 = async () => (await stati(db, E(21)))['2026']

  it('31/07 alle 23:59:59 di Roma (21:59:59 UTC) l’anno è ancora `corrente`; allo scoccare della mezzanotte di Roma (22:00:00 UTC) passa', async () => {
    await riporta(db)
    expect((await giraAlle('2027-07-31T21:59:59Z')).oggi).toBe('2027-07-31')
    expect(await sul2026()).toBe('corrente')
    expect(await giraAlle('2027-07-31T22:00:00Z')).toMatchObject({ oggi: '2027-08-01', stati: 2 })
    expect(await sul2026()).toBe('in_chiusura')
  })

  it('il cron gira al minuto 10: alle 00:10 di Roma del 01/08 (22:10 UTC del 31/07) l’anno passa; alle 23:10 del 31/07 (21:10 UTC) no', async () => {
    await riporta(db)
    await guardia(db, true)
    await giraAlle('2027-07-31T21:10:00Z')
    expect(await sul2026()).toBe('corrente')
    await giraAlle('2027-07-31T22:10:00Z')
    expect(await sul2026()).toBe('in_chiusura')
  })

  it('stessa cosa il 31/08 → 01/09: alle 23:59:59 di Roma resta `in_chiusura`, a mezzanotte passa a `chiuso`', async () => {
    await riporta(db)
    await guardia(db, true)
    await giraAlle('2027-08-01T10:00:00Z')
    expect(await sul2026()).toBe('in_chiusura')
    await giraAlle('2027-08-31T21:59:59Z')
    expect(await sul2026()).toBe('in_chiusura')
    await giraAlle('2027-08-31T22:00:00Z')
    expect(await sul2026()).toBe('chiuso')
  })

  it('i due cambi d’ora non spostano niente: il giorno di Roma resta quello, e nessun anno cambia', async () => {
    await riporta(db)
    await guardia(db, true)
    // 25/10/2026: alle 03:00 CEST le lancette tornano alle 02:00 CET (01:00 UTC). 28/03/2027: alle 02:00 CET passano alle 03:00 CEST.
    for (const [istante, giorno] of [
      ['2026-10-24T22:00:00Z', '2026-10-25'], ['2026-10-25T00:59:59Z', '2026-10-25'],
      ['2026-10-25T01:00:00Z', '2026-10-25'], ['2026-10-25T22:59:59Z', '2026-10-25'],
      ['2027-03-27T23:00:00Z', '2027-03-28'], ['2027-03-28T00:59:59Z', '2027-03-28'],
      ['2027-03-28T01:00:00Z', '2027-03-28'], ['2027-03-28T21:59:59Z', '2027-03-28'],
    ] as const) {
      const r = await giraAlle(istante)
      expect(r.oggi, istante).toBe(giorno)
      expect(r.stati, istante).toBe(0)
      expect(await stati(db, E(21)), istante).toEqual({ 2025: 'chiuso', 2026: 'corrente', 2027: 'in_preparazione' })
    }
  })

  it('i giorni di Roma ai confini, dall’orologio: l’ora legale (UTC+2) e quella solare (UTC+1) spostano la mezzanotte di un’ora', async () => {
    const giorno = async (istante: string) => una<string>(db, `SELECT public.giorno_roma($1::timestamptz)::text`, [istante])
    expect(await giorno('2027-07-31T22:00:00Z')).toBe('2027-08-01') // estate: mezzanotte = 22:00 UTC
    expect(await giorno('2027-07-31T21:59:59Z')).toBe('2027-07-31')
    expect(await giorno('2027-12-31T23:00:00Z')).toBe('2028-01-01') // inverno: mezzanotte = 23:00 UTC
    expect(await giorno('2027-12-31T22:59:59Z')).toBe('2027-12-31')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('la guardia spenta (lo stato di PRODUZIONE oggi) e quella accesa, con l’orologio vero', () => {
  let db: PGlite
  beforeAll(async () => { db = await creaBanco([REALE, E(31)]) }, 180_000)
  afterAll(async () => { await db?.close() })

  async function giraAlle(istanteUtc: string): Promise<EsitoTick> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(istanteUtc))
    return tick(db, null, null)
  }

  it('guardia spenta e sede vera: il 01/08 NON cambia lo stato, scrive un `error` con i soli conteggi e il battito è `ok-parziale`', async () => {
    await riporta(db)
    const r = await giraAlle('2027-08-01T10:00:00Z')
    expect(await stati(db, REALE)).toEqual({ 2025: 'chiuso', 2026: 'corrente', 2027: 'in_preparazione' })
    expect(await domande(db, REALE, 2026)).toBe(true)
    expect(await storia(db, REALE, 2026)).toEqual([]) // nessuna riga di storia scritta
    const errori = await righeLog(db, 'anni-tick-guardia-spenta:')
    expect(errori.map((x) => x.fingerprint)).toEqual([`anni-tick-guardia-spenta:${REALE}`])
    expect(errori[0].livello).toBe('error')
    expect(errori[0].campi).toEqual({ operazione: 'anni-tick', esito: 'guardia-spenta', n_saltati: 1 })
    expect(r.errori).toBe(1)
    expect(r.stati).toBe(1) // la sede di prova E(31) si è mossa lo stesso, la vera no
    expect((await battito(db))?.esito).toBe('ok-parziale')
  })

  it('la stessa sede vera, guardia spenta, un anno in ritardo di DUE salti: due salti saltati, nessun cambio', async () => {
    await riporta(db)
    await giraAlle('2027-12-01T10:00:00Z')
    // il passo 1 ha creato il 2028/29 (è il suo giorno, dal 01/09/2027): il passo 2 non ha toccato i tre di partenza
    expect(await stati(db, REALE)).toMatchObject({ 2025: 'chiuso', 2026: 'corrente', 2027: 'in_preparazione' })
    expect((await righeLog(db, 'anni-tick-guardia-spenta:'))[0].campi).toMatchObject({ n_saltati: 2 })
  })

  it('guardia spenta ma NESSUN cambio dovuto: nessun errore, battito `ok` (l’allarme non suona per niente)', async () => {
    await riporta(db)
    for (const istante of ['2027-03-01T10:00:00Z', '2027-07-31T21:59:59Z']) {
      const r = await giraAlle(istante)
      expect(r.errori, istante).toBe(0)
      expect((await battito(db))?.esito, istante).toBe('ok')
    }
    expect(await righeLog(db, 'anni-tick-guardia-spenta:')).toEqual([])
  })

  it('guardia accesa: la stessa sede vera, lo stesso giorno, passa a `in_chiusura` e a `chiuso` al suo momento, e il battito è `ok`', async () => {
    await riporta(db)
    await guardia(db, true)
    const r = await giraAlle('2027-08-01T10:00:00Z')
    expect(await stati(db, REALE)).toEqual({ 2025: 'chiuso', 2026: 'in_chiusura', 2027: 'in_preparazione' })
    expect(await domande(db, REALE, 2026)).toBe(false)
    expect(r.errori).toBe(0)
    expect((await battito(db))?.esito).toBe('ok')
    expect(await righeLog(db, 'anni-tick-guardia-spenta:')).toEqual([])
    await giraAlle('2027-09-01T10:00:00Z')
    expect((await stati(db, REALE))['2026']).toBe('chiuso')
  })

  it('la sede di prova (`e2e0…`) si muove anche a guardia spenta: non c’è niente da proteggere, e la CI la usa', async () => {
    await riporta(db)
    await giraAlle('2027-08-01T10:00:00Z')
    expect((await stati(db, E(31)))['2026']).toBe('in_chiusura')
  })

  it('una sede in simulazione si muove a guardia spenta: è il modo di provare l’anno intero in Demo senza accendere la guardia di tutti', async () => {
    await riporta(db)
    await db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [REALE])
    await giraAlle('2027-08-01T10:00:00Z')
    expect((await stati(db, REALE))['2026']).toBe('in_chiusura')
    expect(await righeLog(db, 'anni-tick-guardia-spenta:')).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('una sede che esplode non ferma le altre', () => {
  let db: PGlite
  beforeAll(async () => { db = await creaBanco([E(41), E(42)]) }, 180_000)
  afterAll(async () => { await db?.close() })

  it('l’errore di una sede toglie solo il lavoro di quella sede, scrive un `error` con il solo SQLSTATE, e il battito è `ok-parziale`', async () => {
    await riporta(db)
    // un trigger che fa fallire la scrittura della storia del SOLO anno 2026/27 della sede 41
    const guasto = await idAnno(db, E(41), 2026)
    await db.exec(`
      CREATE FUNCTION public.guasto_di_prova() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.anno_sede_id = '${guasto}'::uuid THEN RAISE EXCEPTION 'GUASTO_DI_PROVA' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER guasto_di_prova BEFORE INSERT ON public.anni_sede_stati FOR EACH ROW EXECUTE FUNCTION public.guasto_di_prova();
    `)
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2027-08-01T10:00:00Z'))
      const r = await tick(db, null, null)
      expect(r).toMatchObject({ sedi: 2, errori: 1, stati: 1 })
      expect((await stati(db, E(41)))['2026']).toBe('corrente') // il lavoro della sede guasta è annullato per intero
      expect(await domande(db, E(41), 2026)).toBe(true)
      expect((await stati(db, E(42)))['2026']).toBe('in_chiusura') // l'altra sede è andata avanti
      const errori = await righeLog(db, 'anni-tick-stati-errore:')
      expect(errori.map((x) => x.fingerprint)).toEqual([`anni-tick-stati-errore:${E(41)}`])
      expect(errori[0].campi).toEqual({ operazione: 'anni-tick', esito: 'errore-stati', sqlstate: 'P0001' })
      expect((await battito(db))?.esito).toBe('ok-parziale')
    } finally {
      await db.exec(`DROP TRIGGER guasto_di_prova ON public.anni_sede_stati; DROP FUNCTION public.guasto_di_prova()`)
    }
  })
  it('(giro 1, S1) un BUCO che il vincolo differito scoprirebbe alla COMMIT resta della sua sede: le altre proseguono e la chiamata non cade', async () => {
    await riporta(db)
    // Un trigger che, appena la sede 41 passa a `in_chiusura`, le rimette `domande_aperte = true`: è lo stato che il vincolo
    // `anni_sede_domande_solo_aperto` rifiuta, ma DIFFERITO lo rifiuterebbe solo alla COMMIT, fuori dal blocco della sede.
    const buco = await idAnno(db, E(41), 2026)
    await db.exec(`
      CREATE FUNCTION public.buco_di_prova() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.id = '${buco}'::uuid AND NEW.stato IN ('in_chiusura', 'chiuso') THEN NEW.domande_aperte := true; END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER buco_di_prova BEFORE UPDATE ON public.anni_sede FOR EACH ROW EXECUTE FUNCTION public.buco_di_prova();
    `)
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2027-08-01T10:00:00Z'))
      const r = await tick(db, null, null)
      expect(r).toMatchObject({ sedi: 2, errori: 1, stati: 1 })
      expect((await stati(db, E(41)))['2026'], 'la sede col buco non cambia stato').toBe('corrente')
      expect((await stati(db, E(42)))['2026'], 'l’altra sede è andata avanti').toBe('in_chiusura')
      // Fine della transazione: se il buco fosse passato, il vincolo cadrebbe QUI (e in produzione alla COMMIT del cron).
      await db.exec('SET CONSTRAINTS ALL IMMEDIATE')
      expect((await righeLog(db, 'anni-tick-stati-errore:')).map((x) => x.fingerprint)).toEqual([`anni-tick-stati-errore:${E(41)}`])
    } finally {
      await db.exec(`DROP TRIGGER buco_di_prova ON public.anni_sede; DROP FUNCTION public.buco_di_prova()`)
    }
  })
  it('(giro 2, S1) un calendario NON CONTINUO (`anni_sede_continuita`) resta della sua sede: le altre cambiano stato, `error` col solo SQLSTATE, battito ok-parziale', async () => {
    await riporta(db)
    // Appena la sede 41 passa a `in_chiusura`, un trigger accorcia la fine del suo anno: il giorno dopo non coincide più con
    // l'inizio del successivo. Il vincolo differito lo scoprirebbe solo alla COMMIT, a giro finito (prova H3 della revisione).
    const rotto = await idAnno(db, E(41), 2026)
    await db.exec(`
      CREATE FUNCTION public.calendario_rotto_di_prova() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.id = '${rotto}'::uuid AND NEW.stato IN ('in_chiusura', 'chiuso') THEN NEW.fine := NEW.fine - 3; END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER calendario_rotto_di_prova BEFORE UPDATE ON public.anni_sede FOR EACH ROW EXECUTE FUNCTION public.calendario_rotto_di_prova();
    `)
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2027-08-01T10:00:00Z'))
      const r = await tick(db, null, null)
      expect(r).toMatchObject({ sedi: 2, errori: 1, stati: 1 })
      expect((await stati(db, E(41)))['2026'], 'la sede col calendario rotto non cambia stato').toBe('corrente')
      expect((await stati(db, E(42)))['2026'], 'l’altra sede è andata avanti').toBe('in_chiusura')
      await db.exec('SET CONSTRAINTS ALL IMMEDIATE') // alla COMMIT non deve cadere più niente
      const errori = await righeLog(db, 'anni-tick-stati-errore:')
      expect(errori.map((x) => x.fingerprint)).toEqual([`anni-tick-stati-errore:${E(41)}`])
      expect(errori[0].campi).toMatchObject({ esito: 'errore-stati', sqlstate: '23514' })
      expect((await battito(db))?.esito).toBe('ok-parziale')
    } finally {
      await db.exec(`DROP TRIGGER calendario_rotto_di_prova ON public.anni_sede; DROP FUNCTION public.calendario_rotto_di_prova()`)
    }
  })
})
