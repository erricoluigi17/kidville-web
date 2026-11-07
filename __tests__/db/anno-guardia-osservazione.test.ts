import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-1 (b) · L'OSSERVAZIONE DELLA GUARDIA (migrazione M3).
 *
 * Con `guardia_attiva = false` e `guardia_osserva = true` la guardia CALCOLA e, dove avrebbe rifiutato,
 * scrive un contatore (una riga per chiave, mai una per scrittura) e lascia passare. Solo uuid finti, date fisse.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const UTENTE = '33333333-3333-4333-8333-333333333331'
const D2526 = '2026-08-31'

let db: PGlite
let A2526: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function manopole(attiva: boolean, osserva: boolean) {
  await db.query('UPDATE public.anno_regole SET guardia_attiva = $1, guardia_osserva = $2', [attiva, osserva])
}
type Riga = { giorno: string; tabella: string; op: string; stato: string; origine: string; n: string }
const osservazioni = async () => (await db.query<Riga>(
  `SELECT giorno::text, tabella, op, stato, origine, n::text FROM public.anno_guardia_osservazioni ORDER BY tabella, op, origine`)).rows
const oggiRoma = () => una<string>(`SELECT public.giorno_roma(now())::text`)
/** Una riga del 31/08/2026 (anno chiuso), seminata a manopole spente e con i contatori azzerati. */
async function presenzaChiusa(): Promise<string> {
  await manopole(false, false)
  const id = await una<string>(
    `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3) RETURNING id`, [ALUNNO, SEDE, D2526])
  await db.exec('DELETE FROM public.anno_guardia_osservazioni')
  return id
}
const tocca = (tx: Pick<PGlite, 'query'>, id: string) =>
  tx.query(`UPDATE public.presenze SET section_id = NULL WHERE id = $1`, [id])
const conRoute = (route: string, id: string) => db.transaction(async (tx) => {
  await tx.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-kidville-route': route })])
  await tocca(tx, id)
})

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3' })
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await manopole(false, false)
  await db.exec(`DELETE FROM public.correzioni_anno_chiuso; DELETE FROM public.presenze; DELETE FROM public.app_log;
                 DELETE FROM public.anno_guardia_osservazioni;
                 UPDATE public.anni_sede SET stato = 'chiuso' WHERE anno_id = '${A2526}'`)
})

describe('3.3-1 (b) · l\'osservazione conta e lascia passare', () => {
  it('la migrazione porta la manopola `guardia_osserva` accesa di default, e `guardia_attiva` resta spenta', async () => {
    expect(await una<boolean>(`SELECT guardia_attiva FROM public.anno_regole`)).toBe(false)
    expect(await una<string>(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'anno_regole' AND column_name = 'guardia_osserva'`))
      .toBe('true')
  })

  it('UPDATE su una riga del 31/08/2026 (chiuso) PASSA e scrive (oggi, presenze, UPDATE, chiuso, sql-senza-richiesta, n=1)', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await tocca(db, id)
    expect(await osservazioni()).toEqual([
      { giorno: await oggiRoma(), tabella: 'presenze', op: 'UPDATE', stato: 'chiuso', origine: 'sql-senza-richiesta', n: '1' }])
  })

  it('due UPDATE → n = 2: UNA riga per chiave, non una per scrittura', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await tocca(db, id)
    await tocca(db, id)
    const r = await osservazioni()
    expect(r).toHaveLength(1)
    expect(r[0].n).toBe('2')
  })

  it('un UPDATE di DUE righe nello stesso statement conta due (una per riga guardata), sempre in una riga sola', async () => {
    const ids = [await presenzaChiusa()]
    ids.push(await una<string>(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3) RETURNING id`, [ALUNNO, SEDE, D2526]))
    await db.exec('DELETE FROM public.anno_guardia_osservazioni')
    await manopole(false, true)
    await db.query(`UPDATE public.presenze SET section_id = NULL WHERE id = ANY($1::uuid[])`, [ids])
    const r = await osservazioni()
    expect(r).toHaveLength(1)
    expect(r[0].n).toBe('2')
  })

  it('INSERT e DELETE su un anno chiuso si contano con la loro `op`', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await db.query(`DELETE FROM public.presenze WHERE id = $1`, [id])
    await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3)`, [ALUNNO, SEDE, D2526])
    expect((await osservazioni()).map((x) => `${x.op}:${x.n}`).sort()).toEqual(['DELETE:1', 'INSERT:1'])
  })

  it('una scrittura su un anno corrente non conta niente', async () => {
    await manopole(false, true)
    await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, '2026-10-15')`, [ALUNNO, SEDE])
    expect(await osservazioni()).toEqual([])
  })
})

describe('3.3-1 (b) · l\'origine viene da x-kidville-route, validata anche nel database', () => {
  it('con `x-kidville-route` nell\'header → `origine` quel valore', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await conRoute('admin/sections:POST', id)
    expect((await osservazioni()).map((x) => x.origine)).toEqual(['admin/sections:POST'])
  })

  it('un valore lungo oltre 120 caratteri (ma ben formato) → troncato a 120', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await conRoute('a'.repeat(300), id)
    expect((await osservazioni()).map((x) => x.origine)).toEqual(['a'.repeat(120)])
  })

  it.each([
    ['con uno spazio e un testo libero', 'Mario Rossi ha cambiato la presenza'],
    ['con un apice', "x'; DROP TABLE presenze; --"],
    ['con un a-capo', 'admin/sections\nPOST'],
  ])('un valore non valido (%s) → `origine-non-valida`, mai un testo libero', async (_n, route) => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await conRoute(route, id)
    expect((await osservazioni()).map((x) => x.origine)).toEqual(['origine-non-valida'])
  })

  it('un header vuoto o senza la chiave → `sql-senza-richiesta`', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.headers', '{"x-altro":"1"}', true)`)
      await tocca(tx, id)
    })
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.headers', '', true)`)
      await tocca(tx, id)
    })
    const r = await osservazioni()
    expect(r.map((x) => x.origine)).toEqual(['sql-senza-richiesta'])
    expect(r[0].n).toBe('2')
  })
})

describe('3.3-1 (b) · ciò che passerebbe anche accesa non si conta', () => {
  it('la scrittura con un gettone valido NON scrive nell\'osservazione (e non scrive usi)', async () => {
    const id = await presenzaChiusa()
    const g = await una<string>(
      `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo)
       VALUES ($1, 'segreteria', public.anno_sede_di($2, $3), 'correzione', 'motivo di prova') RETURNING id`, [UTENTE, SEDE, A2526])
    await manopole(false, true)
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-kidville-correzione': g })])
      await tocca(tx, id)
    })
    expect(await osservazioni()).toEqual([])
    expect(await una<number>(`SELECT count(*)::int FROM public.correzioni_anno_chiuso_usi`)).toBe(0)
  })

  it('la scrittura esente per colonna (incasso di pagamenti) NON scrive nell\'osservazione', async () => {
    await manopole(false, false)
    const p = await una<string>(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, periodo_competenza)
       VALUES ($1, $2, 'retta di prova', 100, '2026-05-10', '2026-05-01') RETURNING id`, [ALUNNO, SEDE])
    await db.exec('DELETE FROM public.anno_guardia_osservazioni')
    await manopole(false, true)
    await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100, data_incasso = '2026-11-01' WHERE id = $1`, [p])
    expect(await osservazioni()).toEqual([])
    // e una colonna NON esente (importo) si conta
    await db.query(`UPDATE public.pagamenti SET importo = 90 WHERE id = $1`, [p])
    expect((await osservazioni()).map((x) => `${x.tabella}:${x.op}:${x.stato}`)).toEqual(['pagamenti:UPDATE:chiuso'])
  })
})

describe('3.3-1 (b) · le manopole', () => {
  it('`guardia_attiva = true` → ANNO_CHIUSO (come nella PR 1) e nessun contatore', async () => {
    const id = await presenzaChiusa()
    await manopole(true, true)
    expect(await messaggio(tocca(db, id))).toBe('ANNO_CHIUSO')
    expect(await osservazioni()).toEqual([])
  })

  it('entrambe `false` → la scrittura passa e non lascia NESSUN effetto (zero righe contatore, zero log)', async () => {
    const id = await presenzaChiusa()
    await manopole(false, false)
    await tocca(db, id)
    await db.query(`DELETE FROM public.presenze WHERE id = $1`, [id])
    expect(await osservazioni()).toEqual([])
    expect(await una<number>(`SELECT count(*)::int FROM public.app_log`)).toBe(0)
  })
})

describe('3.3-1 (b) · un guasto del contatore non blocca la scrittura', () => {
  it('con la tabella resa illeggibile la scrittura passa e resta `anno_log_guasto`', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await db.exec('ALTER TABLE public.anno_guardia_osservazioni RENAME TO anno_guardia_osservazioni_rotta')
    try {
      await tocca(db, id)
    } finally {
      await db.exec('ALTER TABLE public.anno_guardia_osservazioni_rotta RENAME TO anno_guardia_osservazioni')
    }
    const log = (await db.query<{ livello: string; contesto: Record<string, unknown> }>(
      `SELECT livello, contesto FROM public.app_log WHERE evento = 'anno-scolastico'`)).rows
    expect(log).toHaveLength(1)
    expect(log[0].livello).toBe('error')
    expect(log[0].contesto).toMatchObject({ esito: 'osservazione-fallita', tabella: 'presenze' })
    expect(await osservazioni()).toEqual([])
  })
})

describe('3.3-1 (b) · sicurezza delle cose nuove', () => {
  it('authenticated non legge il contatore e non esegue le funzioni nuove', async () => {
    await expect(db.exec('SET ROLE authenticated; SELECT * FROM public.anno_guardia_osservazioni')).rejects.toThrow()
    await db.exec('RESET ROLE')
    await expect(db.exec('SET ROLE authenticated; SELECT * FROM public.anno_transitorio_usi')).rejects.toThrow()
    await db.exec('RESET ROLE')
    for (const f of [
      'public.anno_guardia_osserva_conta(text,text,text)',
      'public.anno_log_uso_gettone(uuid,text,text,text)',
      'public.anno_origine_richiesta()',
      'public.anno_transitorio_conta(text)',
      'public.anno_guardia_osserva_sicura(public.anno_tabelle,text,jsonb,jsonb,uuid)',
    ]) {
      expect(await una<boolean>(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE')`, [f]), f).toBe(false)
      expect(await una<boolean>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE')`, [f]), f).toBe(true)
    }
    expect(await una<number>(`SELECT count(*)::int FROM pg_proc WHERE proname = 'anno_guardia_verifica'`)).toBe(1)
  })
})

describe('3.3-2 · P25: in osservazione l\'interruttore `oblio` non lascia nessuna traccia', () => {
  it('con `anno_chiuso.oblio = on` e l\'osservazione accesa: la scrittura su un anno chiuso passa, zero contatori, zero gettoni `oblio`, zero usi', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('anno_chiuso.oblio', 'on', true)`)
      await tocca(tx, id)
    })
    expect(await una<string>(`SELECT count(*)::text FROM public.anno_guardia_osservazioni`)).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso WHERE codice = 'oblio'`)).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso_usi`)).toBe('0')
  })
})

describe('3.3-2 · P27: l\'osservazione non rifiuta MAI una scrittura', () => {
  const GUASTO = 'guasto di prova'
  /** Una guardia resa difettosa apposta: `anno_guardia_sede` (la prima cosa che la guardia chiama) solleva sempre. */
  async function guastaLaGuardia() {
    await db.exec(`
      ALTER FUNCTION public.anno_guardia_sede(text, jsonb, integer) RENAME TO anno_guardia_sede_orig;
      CREATE FUNCTION public.anno_guardia_sede(p_tabella text, p_riga jsonb, p_livello integer DEFAULT 0)
      RETURNS uuid LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '${GUASTO}' USING ERRCODE = 'XX001'; END $f$;`)
  }
  async function riparaLaGuardia() {
    await db.exec(`
      DROP FUNCTION public.anno_guardia_sede(text, jsonb, integer);
      ALTER FUNCTION public.anno_guardia_sede_orig(text, jsonb, integer) RENAME TO anno_guardia_sede;`)
  }

  it('una guardia difettosa, con l\'osservazione accesa: la scrittura PASSA e lascia un guasto (solo SQLSTATE e tabella)', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await guastaLaGuardia()
    try {
      await tocca(db, id)
      await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3)`, [ALUNNO, SEDE, D2526])
      await db.query(`DELETE FROM public.presenze WHERE id = $1`, [id])
    } finally {
      await riparaLaGuardia()
    }
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze`)).toBe('1')
    const log = (await db.query<{ livello: string; occorrenze: number; contesto: Record<string, unknown> }>(
      `SELECT livello, occorrenze, contesto FROM public.app_log WHERE evento = 'anno-scolastico'`)).rows
    expect(log).toHaveLength(1)
    expect(log[0].livello).toBe('error')
    expect(log[0].occorrenze).toBe(3)
    expect(log[0].contesto).toEqual({
      esito: 'osservazione-guardia-fallita', operazione: 'anno_guardia_osserva_sicura', tabella: 'presenze', sqlstate: 'XX001' })
    expect(JSON.stringify(log[0].contesto)).not.toContain(GUASTO)
  })

  it('la stessa guardia difettosa con la guardia ACCESA: la scrittura CADE (gli errori restano errori)', async () => {
    const id = await presenzaChiusa()
    await manopole(true, false)
    await guastaLaGuardia()
    try {
      expect(await messaggio(tocca(db, id))).toBe(GUASTO)
    } finally {
      await riparaLaGuardia()
    }
    expect(await una<string>(`SELECT count(*)::text FROM public.app_log WHERE evento = 'anno-scolastico'`)).toBe('0')
  })

  it('senza difetti, l\'osservazione continua a contare come prima (il guasto è un\'eccezione, non la regola)', async () => {
    const id = await presenzaChiusa()
    await manopole(false, true)
    await tocca(db, id)
    expect((await osservazioni()).map((x) => x.n)).toEqual(['1'])
    expect(await una<string>(`SELECT count(*)::text FROM public.app_log WHERE evento = 'anno-scolastico'`)).toBe('0')
  })
})
