import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-2 (e) · LA RISERVA PERMANENTE (migrazione M3).
 *
 * `pagamenti` ed `enrollment_submissions` tengono la regola transitoria («l'app non scrive anno_id») ANCHE con
 * `dichiarato_transitorio = false`: una voce di cassa o una domanda di una famiglia non devono mai fallire per
 * l'anno. Le altre cinque tabelle dichiarate la perdono. Ogni uso della regola scrive `anno_transitorio_usi`: è la
 * misura che dice quando il 3-B è sicuro. Date fisse (2025/26-2027/28), mai `now()` per scegliere l'anno; solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'

let db: PGlite
let A2526: string
let A2627: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
/** Controlli rigidi accesi (il 3-B), guardia ed osservazione spente: qui conta solo la regola dell'anno. */
async function regole(transitorio: boolean) {
  await db.query(
    `UPDATE public.anno_regole SET controlli_rigidi = true, guardia_attiva = false, guardia_osserva = false,
            dichiarato_transitorio = $1`, [transitorio])
}
type Uso = { tabella: string; regola: string; origine: string; n: string }
const usi = async () => (await db.query<Uso>(
  `SELECT tabella, regola, origine, n::text FROM public.anno_transitorio_usi ORDER BY tabella, regola`)).rows

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [SEDE], fino: 'M3', completo: true,
    // In produzione `scadenza` è NOT NULL: il ramo «né competenza né scadenza» si prova togliendo il vincolo al banco.
    codaPrima: `ALTER TABLE public.pagamenti ALTER COLUMN scadenza DROP NOT NULL;`,
  })
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`DELETE FROM public.anno_transitorio_usi; DELETE FROM public.app_log;
                 DELETE FROM public.pagamenti; DELETE FROM public.enrollment_submissions;
                 DELETE FROM public.crm_bambini; DELETE FROM public.votazioni; DELETE FROM public.scrutinio_periodi;
                 DELETE FROM public.certificati_competenze; DELETE FROM public.iscrizioni_elenco_caricamenti`)
})

describe('3.3-2 (e) · con dichiarato_transitorio = false e controlli rigidi', () => {
  it('INSERT INTO enrollment_submissions senza anno_id → anno attivo della sede, e un uso `enrollment/anno-attivo`', async () => {
    await regole(false)
    const id = await una<string>(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1) RETURNING id`, [SEDE])
    expect(await una<string>(`SELECT anno_id FROM public.enrollment_submissions WHERE id = $1`, [id])).toBe(A2627)
    const u = await usi()
    expect(u).toEqual([{ tabella: 'enrollment_submissions', regola: 'enrollment/anno-attivo', origine: 'sql-senza-richiesta', n: '1' }])
  })

  it('INSERT INTO pagamenti con scadenza → anno della scadenza, senza uso della regola (lo dà il registro)', async () => {
    await regole(false)
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza) VALUES ($1, 'rata', 10, DATE '2026-03-10') RETURNING id`, [SEDE])
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [id])).toBe(A2526)
    expect(await usi()).toEqual([])
  })

  it('pagamenti senza competenza né scadenza → il giorno di ROMA di creato_il (2026-10-12T22:30Z = 13/10 → 2026/27), e un uso `pagamenti/creazione`', async () => {
    await regole(false)
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, creato_il)
       VALUES ($1, 'voce', 10, TIMESTAMPTZ '2026-10-12 22:30:00+00') RETURNING id`, [SEDE])
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [id])).toBe(A2627)
    expect(await usi()).toEqual([{ tabella: 'pagamenti', regola: 'pagamenti/creazione', origine: 'sql-senza-richiesta', n: '1' }])
  })

  it('pagamenti: il giorno è quello di Roma, non quello UTC (2026-08-31T22:30Z = 01/09 → 2026/27, non 2025/26)', async () => {
    await regole(false)
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, creato_il)
       VALUES ($1, 'voce', 10, TIMESTAMPTZ '2026-08-31 22:30:00+00') RETURNING id`, [SEDE])
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [id])).toBe(A2627)
  })

  it('l\'origine dell\'uso è la route dell\'header, validata come per l\'osservazione', async () => {
    await regole(false)
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-kidville-route': 'iscrizione:POST' })])
      await tx.query(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1)`, [SEDE])
    })
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-kidville-route': 'testo libero con spazi' })])
      await tx.query(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1)`, [SEDE])
    })
    expect((await usi()).map((x) => x.origine).sort()).toEqual(['iscrizione:POST', 'origine-non-valida'])
  })

  const ALTRE: Array<[string, string]> = [
    ['crm_bambini', 'creata_il'],
    ['votazioni', 'creata_il'],
    ['scrutinio_periodi', 'creato_il'],
    ['certificati_competenze', 'created_at'],
    ['iscrizioni_elenco_caricamenti', 'caricato_il'],
  ]
  for (const [t] of ALTRE) {
    it(`INSERT INTO ${t} senza anno_id → ANNO_DA_SPECIFICARE e nessun contatore; con anno_id passa`, async () => {
      await regole(false)
      expect(await messaggio(db.query(`INSERT INTO public.${t} (scuola_id) VALUES ($1)`, [SEDE]))).toBe('ANNO_DA_SPECIFICARE')
      expect(await usi()).toEqual([])
      await db.query(`INSERT INTO public.${t} (scuola_id, anno_id) VALUES ($1, $2)`, [SEDE, A2627])
      expect(await una<string>(`SELECT count(*)::text FROM public.${t}`)).toBe('1')
      expect(await usi()).toEqual([])
    })
  }
})

describe('3.3-2 (e) · con dichiarato_transitorio = true (lo stato di oggi, per la finestra fra M3 e M3b)', () => {
  const SETTE: Array<[string, string]> = [
    ['enrollment_submissions', `(scuola_id) VALUES ('${SEDE}')`],
    ['pagamenti', `(scuola_id, descrizione, importo, creato_il) VALUES ('${SEDE}', 'voce', 10, TIMESTAMPTZ '2026-10-12 12:00:00+00')`],
    ['crm_bambini', `(scuola_id, creata_il) VALUES ('${SEDE}', TIMESTAMPTZ '2026-10-12 12:00:00+00')`],
    ['votazioni', `(scuola_id) VALUES ('${SEDE}')`],
    ['scrutinio_periodi', `(scuola_id) VALUES ('${SEDE}')`],
    ['certificati_competenze', `(scuola_id) VALUES ('${SEDE}')`],
    ['iscrizioni_elenco_caricamenti', `(scuola_id) VALUES ('${SEDE}')`],
  ]
  for (const [t, valori] of SETTE) {
    it(`${t}: usa la regola e ogni uso scrive il contatore`, async () => {
      await regole(true)
      await db.query(`INSERT INTO public.${t} ${valori}`)
      await db.query(`INSERT INTO public.${t} ${valori}`)
      expect(await una<string>(`SELECT anno_id FROM public.${t} LIMIT 1`)).toBe(A2627)
      const u = await usi()
      expect(u).toHaveLength(1)
      expect(u[0].tabella).toBe(t)
      expect(u[0].n).toBe('2')
    })
  }

  it('un INSERT di PIÙ righe senza anno_id in una transazione → n = 1 (e le righe ricevono tutte l\'anno)', async () => {
    await regole(true)
    await db.query(`INSERT INTO public.enrollment_submissions (scuola_id) SELECT $1 FROM generate_series(1, 5)`, [SEDE])
    expect(await una<string>(`SELECT count(*)::text FROM public.enrollment_submissions WHERE anno_id = $1`, [A2627])).toBe('5')
    expect((await usi()).map((x) => x.n)).toEqual(['1'])
    await db.query(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1)`, [SEDE])
    expect((await usi()).map((x) => x.n)).toEqual(['2'])
  })

  it('un guasto del contatore non blocca la scrittura e lascia `anno_log_guasto`', async () => {
    await regole(true)
    await db.exec(`ALTER TABLE public.anno_transitorio_usi RENAME TO anno_transitorio_usi_rotta`)
    try {
      await db.query(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1)`, [SEDE])
      expect(await una<string>(`SELECT count(*)::text FROM public.enrollment_submissions`)).toBe('1')
      expect(await una<string>(
        `SELECT count(*)::text FROM public.app_log WHERE evento = 'anno-scolastico' AND contesto ->> 'esito' = 'transitorio-conta-fallito'`)).toBe('1')
    } finally {
      await db.exec(`ALTER TABLE public.anno_transitorio_usi_rotta RENAME TO anno_transitorio_usi`)
    }
  })
})
