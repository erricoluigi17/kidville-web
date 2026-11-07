import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-1 (a) · I GETTONI DI CORREZIONE DELL'ANNO CHIUSO (migrazione M3).
 *
 * Una lista nell'header, legata all'utente, valida per UNA transazione, con la registrazione di ogni uso.
 * Date fisse (2025/26 chiuso, 2026/27 corrente), mai `now()` per scegliere l'anno. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222223'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const UTENTE = '33333333-3333-4333-8333-333333333331'
const ALTRO_UTENTE = '33333333-3333-4333-8333-333333333332'
const D2526 = '2026-08-31'
const D2627 = '2026-09-01'
const MOTIVO_SEGRETO = 'SEGRETO-DEL-MOTIVO-XYZ'

let db: PGlite
let A2526: string
let A2627: string

type Tx = Pick<PGlite, 'query'>
interface Imp { header?: string; sub?: string; ruolo?: string }

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function dettaglio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as { detail?: string }).detail ?? '' }
  return ''
}
const guardia = (acceso: boolean) => db.query('UPDATE public.anno_regole SET guardia_attiva = $1', [acceso])
const annoSede = (anno: string, sede = SEDE) => una<string>(`SELECT public.anno_sede_di($1, $2)`, [sede, anno])

async function gettone(o: { codice?: string; anno?: string; sede?: string; scaduto?: boolean; utente?: string } = {}): Promise<string> {
  const codice = o.codice ?? 'correzione'
  const scaduto = o.scaduto ?? false
  return una<string>(
    `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo, creata_il, scade_il)
     VALUES ($1, 'segreteria', $2, $3, $4,
             CASE WHEN $5::boolean THEN now() - interval '20 minutes' ELSE now() END,
             CASE WHEN $5::boolean THEN now() - interval '10 minutes' ELSE now() + interval '10 minutes' END)
     RETURNING id`,
    [o.utente ?? UTENTE, await annoSede(o.anno ?? A2526, o.sede), codice,
     codice === 'correzione' ? MOTIVO_SEGRETO : null, scaduto])
}
/** Una transazione con le impostazioni di sessione che scrive PostgREST. */
async function inTx<T>(imp: Imp, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (imp.header !== undefined) await tx.query(`SELECT set_config('request.headers', $1, true)`, [imp.header])
    if (imp.sub !== undefined || imp.ruolo !== undefined) {
      const claims: Record<string, string> = {}
      if (imp.sub !== undefined) claims.sub = imp.sub
      if (imp.ruolo !== undefined) claims.role = imp.ruolo
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    }
    return fn(tx)
  })
}
const header = (...ids: string[]) => JSON.stringify({ 'x-kidville-correzione': ids.join(',') })
async function presenza(giorno: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3) RETURNING id`, [ALUNNO, SEDE, giorno])
}
const tocca = (tx: Tx, ids: string[]) =>
  tx.query(`UPDATE public.presenze SET section_id = NULL WHERE id = ANY($1::uuid[])`, [ids])
async function usi() {
  return (await db.query<{ tabella: string; riga_id: string | null; transazione: string; correzione_id: string }>(
    `SELECT tabella, riga_id, transazione::text, correzione_id FROM public.correzioni_anno_chiuso_usi ORDER BY id`)).rows
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, ALTRA_SEDE], fino: 'M3' })
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await guardia(false)
  await db.exec(`DELETE FROM public.correzioni_anno_chiuso; DELETE FROM public.presenze; DELETE FROM public.app_log;
                 DELETE FROM public.anno_guardia_osservazioni;
                 UPDATE public.anni_sede SET stato = 'chiuso' WHERE anno_id = '${A2526}';
                 UPDATE public.anni_sede SET stato = 'corrente' WHERE anno_id = '${A2627}'`)
})

describe('3.3-1 (a) · un gettone vale una transazione', () => {
  it('un gettone `correzione` per l\'anno chiuso permette l\'UPDATE di TRE righe nello stesso statement: tre usi, una transazione', async () => {
    const ids = [await presenza(D2526), await presenza(D2526), await presenza(D2526)]
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g) }, (tx) => tocca(tx, ids))
    const u = await usi()
    expect(u).toHaveLength(3)
    expect(new Set(u.map((x) => x.transazione)).size).toBe(1)
    expect(new Set(u.map((x) => x.riga_id))).toEqual(new Set(ids))
    expect(u.every((x) => x.correzione_id === g)).toBe(true)
  })

  it('lo stesso gettone in una SECONDA transazione → ANNO_CHIUSO', async () => {
    const [a, b] = [await presenza(D2526), await presenza(D2526)]
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g) }, (tx) => tocca(tx, [a]))
    expect(await messaggio(inTx({ header: header(g) }, (tx) => tocca(tx, [b])))).toBe('ANNO_CHIUSO')
    expect(await usi()).toHaveLength(1)
  })

  it('due scritture della STESSA transazione con lo stesso gettone passano (non si consuma dentro la transazione)', async () => {
    const [a, b] = [await presenza(D2526), await presenza(D2526)]
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g) }, async (tx) => { await tocca(tx, [a]); await tocca(tx, [b]) })
    expect(await usi()).toHaveLength(2)
  })
})

describe('3.3-1 (a) · una lista di gettoni (chiude la consegna F10b)', () => {
  async function dueAnniProtetti() {
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE anno_id = $1`, [A2627])
    const id = await presenza(D2526)
    const sposta = (tx: Tx) => tx.query(`UPDATE public.presenze SET data = $2 WHERE id = $1`, [id, D2627])
    return { id, sposta }
  }

  it('un UPDATE che sposta presenze.data dal 31/08 al 01/09 (due anni protetti) con DUE gettoni passa, con due usi, uno per gettone', async () => {
    const { sposta } = await dueAnniProtetti()
    const g1 = await gettone({ anno: A2526 })
    const g2 = await gettone({ anno: A2627 })
    await guardia(true)
    await inTx({ header: header(g1, g2) }, sposta)
    const u = await usi()
    expect(u).toHaveLength(2)
    expect(new Set(u.map((x) => x.correzione_id))).toEqual(new Set([g1, g2]))
  })

  it('con UN gettone solo → ANNO_CHIUSO, e la riga resta dov\'era', async () => {
    const { id, sposta } = await dueAnniProtetti()
    const g1 = await gettone({ anno: A2526 })
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g1) }, sposta))).toBe('ANNO_CHIUSO')
    expect(await una<string>(`SELECT data::text FROM public.presenze WHERE id = $1`, [id])).toBe(D2526)
    expect(await usi()).toHaveLength(0)
  })

  it('gli spazi attorno agli elementi sono tollerati e gli elementi che non sono uuid si scartano', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    await inTx({ header: JSON.stringify({ 'x-kidville-correzione': `non-un-uuid ,  ${g}  , 123` }) }, (tx) => tocca(tx, [id]))
    expect(await usi()).toHaveLength(1)
  })
})

describe('3.3-1 (a) · gettoni che non valgono', () => {
  it('un gettone `agosto` su un anno `chiuso` → ANNO_CHIUSO', async () => {
    const id = await presenza(D2526)
    const g = await gettone({ codice: 'agosto' })
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g) }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
  })

  it('un gettone `agosto` su un anno `in_chiusura` passa', async () => {
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE anno_id = $1`, [A2526])
    const id = await presenza(D2526)
    const g = await gettone({ codice: 'agosto' })
    await guardia(true)
    await inTx({ header: header(g) }, (tx) => tocca(tx, [id]))
    expect(await usi()).toHaveLength(1)
  })

  it('il gettone di un\'altra sede → ANNO_CHIUSO', async () => {
    const id = await presenza(D2526)
    const g = await gettone({ sede: ALTRA_SEDE })
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g) }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
  })

  it('un gettone scaduto (scade_il forzata nel passato dal seme) → ANNO_CHIUSO', async () => {
    const id = await presenza(D2526)
    const g = await gettone({ scaduto: true })
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g) }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
  })

  it.each([
    ['header non-JSON', 'questo non è json'],
    ['header vuoto', ''],
    ['solo elementi scartati', JSON.stringify({ 'x-kidville-correzione': 'non-un-uuid,' })],
    ['valore numerico', JSON.stringify({ 'x-kidville-correzione': 12345 })],
    ['valore nullo', JSON.stringify({ 'x-kidville-correzione': null })],
  ])('%s → come «nessun gettone»: ANNO_CHIUSO, mai un errore diverso', async (_nome, h) => {
    const id = await presenza(D2526)
    await gettone()
    await guardia(true)
    expect(await messaggio(inTx({ header: h }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
  })

  it('il DETAIL porta solo tabella, anno_sede_id e stato (mai il motivo)', async () => {
    const id = await presenza(D2526)
    await gettone()
    await guardia(true)
    const d = JSON.parse(await dettaglio(tocca(db, [id])))
    expect(Object.keys(d).sort()).toEqual(['anno_sede_id', 'stato', 'tabella'])
    expect(d).toMatchObject({ tabella: 'presenze', stato: 'chiuso', anno_sede_id: await annoSede(A2526) })
    expect(JSON.stringify(d)).not.toContain('SEGRETO')
  })
})

describe('3.3-1 (a) · il gettone è legato all\'utente', () => {
  it('`sub` diverso da `utente_id` con ruolo authenticated → ANNO_CHIUSO', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g), sub: ALTRO_UTENTE, ruolo: 'authenticated' }, (tx) => tocca(tx, [id]))))
      .toBe('ANNO_CHIUSO')
  })

  it('`sub` uguale a `utente_id` con ruolo authenticated → passa', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g), sub: UTENTE, ruolo: 'authenticated' }, (tx) => tocca(tx, [id]))
    expect(await usi()).toHaveLength(1)
  })

  it('senza `sub` (service_role) → passa: il controllo è dell\'app', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g), ruolo: 'service_role' }, (tx) => tocca(tx, [id]))
    expect(await usi()).toHaveLength(1)
  })

  it('un `sub` che non è un uuid non rompe niente: non coincide, ANNO_CHIUSO', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    expect(await messaggio(inTx({ header: header(g), sub: 'non-un-uuid', ruolo: 'authenticated' }, (tx) => tocca(tx, [id]))))
      .toBe('ANNO_CHIUSO')
  })
})

describe('3.3-1 (a) · ogni uso lascia la sua riga in app_log, e il motivo non entra mai', () => {
  it('una riga info per uso: evento anno-scolastico, esito correzione-registrata, contesto { tabella, riga_id, codice_gettone }', async () => {
    const ids = [await presenza(D2526), await presenza(D2526)]
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g) }, (tx) => tocca(tx, ids))
    const r = (await db.query<{ livello: string; evento: string; contesto: Record<string, unknown> }>(
      `SELECT livello, evento, contesto FROM public.app_log WHERE evento = 'anno-scolastico'`)).rows
    expect(r).toHaveLength(2)
    for (const x of r) {
      expect(x.livello).toBe('info')
      expect(x.contesto.esito).toBe('correzione-registrata')
      expect(Object.keys(x.contesto).sort()).toEqual(['codice_gettone', 'esito', 'riga_id', 'tabella'])
      expect(x.contesto).toMatchObject({ tabella: 'presenze', codice_gettone: 'correzione' })
      expect(ids).toContain(x.contesto.riga_id)
      expect(x.contesto.codice).toBeUndefined()
    }
  })

  it('il testo del motivo non compare in NESSUNA riga di app_log (né nel messaggio né nel contesto)', async () => {
    const id = await presenza(D2526)
    const g = await gettone()
    await guardia(true)
    await inTx({ header: header(g) }, (tx) => tocca(tx, [id]))
    expect(await una<number>(`SELECT count(*)::int FROM public.app_log`)).toBeGreaterThan(0)
    expect(await una<number>(
      `SELECT count(*)::int FROM public.app_log WHERE to_jsonb(app_log)::text LIKE '%' || $1 || '%'`, [MOTIVO_SEGRETO])).toBe(0)
  })

  it('un rifiuto (ANNO_CHIUSO) non scrive nessuna riga info', async () => {
    const id = await presenza(D2526)
    await guardia(true)
    await messaggio(tocca(db, [id]))
    expect(await una<number>(`SELECT count(*)::int FROM public.app_log WHERE evento = 'anno-scolastico'`)).toBe(0)
  })
})
