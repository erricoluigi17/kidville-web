import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.2.2 · le funzioni con cui la segreteria cambia le date di un anno, apre le iscrizioni e apre/sospende
 * le domande dal sito. Solo uuid finti.
 *
 * Calendario di prova (fisso): 2025/26 chiuso · 2026/27 corrente (2026-09-01 → 2027-08-31, ultimo giorno aperto
 * 2027-07-31) · 2027/28 in_preparazione. Gli stati «in_chiusura» si mettono a mano nel seme: la funzione legge
 * `anni_sede.stato`, non l'orologio.
 *
 * SCADENZA: i casi del 2026/27 usano date letterali nel 2027 (`2027-07-15` accettata). Dopo il 2027-07-15 «oggi» le
 * supera e il test va riscritto con il calendario dell'anno dopo: è l'anno di prova che finisce, non un bug.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const UTENTE = '55555555-5555-4555-8555-555555555551'
const INESISTENTE = '99999999-9999-4999-8999-999999999999'

let db: PGlite
let A2526: string
let A2627: string
let A2728: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function errore(p: Promise<unknown>): Promise<{ codice: string; detail: Record<string, unknown> | null }> {
  try { await p } catch (e) {
    const x = e as { message: string; detail?: string }
    return { codice: x.message, detail: x.detail ? (JSON.parse(x.detail) as Record<string, unknown>) : null }
  }
  return { codice: 'nessun-errore', detail: null }
}
const annoSede = (anno: string) => una<string>(`SELECT public.anno_sede_di($1, $2)`, [SEDE, anno])
const chiama = async (sql: string, params: unknown[]) =>
  (await db.query<{ r: Record<string, unknown> }>(`SELECT ${sql} AS r`, params)).rows[0].r
const date = (id: string) => db.query<{ u: string; p: string }>(
  `SELECT ultimo_giorno_aperto::text u, prepara_successivo_dal::text p FROM public.anni_sede WHERE id = $1`, [id]).then((r) => r.rows[0])
const riga = (id: string) => db.query<{ stato: string; domande_aperte: boolean }>(
  `SELECT stato, domande_aperte FROM public.anni_sede WHERE id = $1`, [id]).then((r) => r.rows[0])

async function listino(id: string, voce: string, importo: number | null) {
  await db.query(`INSERT INTO public.listino_voci (anno_sede_id, voce, importo) VALUES ($1, $2, $3)`, [id, voce, importo])
}
async function modulo(id: string, lista: string) {
  await db.query(`INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, $2, 'm1', 'Modulo')`, [id, lista])
}
async function tuttoPronto(id: string) {
  await listino(id, 'quota_conferma', 100); await listino(id, 'quota_nuova', 150)
  await modulo(id, 'conferma'); await modulo(id, 'nuova')
}

async function ripristina() {
  await db.exec(`
    DELETE FROM public.listino_voci; DELETE FROM public.moduli_richiesti;
    DELETE FROM public.anni_sede_stati WHERE da IS NOT NULL;
    UPDATE public.anni_sede s
       SET stato = CASE WHEN y.anno_inizio < 2026 THEN 'chiuso' WHEN y.anno_inizio = 2026 THEN 'corrente' ELSE 'in_preparazione' END,
           ultimo_giorno_aperto = make_date(y.anno_inizio + 1, 7, 31),
           prepara_successivo_dal = y.inizio_predefinito, domande_aperte = false
      FROM public.anni_scolastici y WHERE y.id = s.anno_id;
  `)
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3' })
  await db.exec(`
    INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2027) ON CONFLICT (anno_inizio) DO NOTHING;
    INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
    SELECT s.id, y.id, y.inizio_predefinito, y.fine_predefinita, 'in_preparazione', DATE '2028-07-31', y.inizio_predefinito
      FROM public.schools s JOIN public.anni_scolastici y ON y.anno_inizio = 2027
     WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.scuola_id = s.id AND x.anno_id = y.id);
  `)
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  A2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  await applicaPr2(db, 'M42')
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(ripristina)

describe('anno_imposta_date', () => {
  it('sposta l\'ultimo giorno aperto del 2026/27 al 15/07/2027: cambiato true, e lo scrive', async () => {
    const id = await annoSede(A2627)
    const r = await chiama(`public.anno_imposta_date($1, DATE '2027-07-15', NULL)`, [id])
    expect(r).toMatchObject({ cambiato: true, anno_sede_id: id, ultimo_giorno_aperto: '2027-07-15', ultimo_giorno_aperto_precedente: '2027-07-31' })
    expect((await date(id)).u).toBe('2027-07-15')
  })

  it('lo stesso valore di nuovo: cambiato false e nessun errore', async () => {
    const id = await annoSede(A2627)
    await chiama(`public.anno_imposta_date($1, DATE '2027-07-15', NULL)`, [id])
    const r = await chiama(`public.anno_imposta_date($1, DATE '2027-07-15', NULL)`, [id])
    expect(r).toMatchObject({ cambiato: false, ultimo_giorno_aperto: '2027-07-15' })
  })

  it('senza argomenti non tocca niente', async () => {
    const id = await annoSede(A2627)
    expect(await chiama(`public.anno_imposta_date($1)`, [id])).toMatchObject({ cambiato: false })
  })

  it('al 01/09/2027 (fuori dal periodo): DATE_NON_VALIDE / fuori_periodo', async () => {
    const id = await annoSede(A2627)
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, DATE '2027-09-01', NULL)`, [id]))
    expect(e.codice).toBe('DATE_NON_VALIDE')
    expect(e.detail).toMatchObject({ motivo: 'fuori_periodo', campo: 'ultimo_giorno_aperto' })
  })

  it('un ultimo giorno nel passato su un anno corrente: DATE_NON_VALIDE / ultimo_giorno_nel_passato', async () => {
    const id = await annoSede(A2627)
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, DATE '2026-10-01', NULL)`, [id]))
    expect(e.codice).toBe('DATE_NON_VALIDE')
    expect(e.detail).toMatchObject({ motivo: 'ultimo_giorno_nel_passato' })
    expect((await date(id)).u).toBe('2027-07-31')
  })

  it('prepara_successivo_dal fuori dal periodo: DATE_NON_VALIDE / fuori_periodo', async () => {
    const id = await annoSede(A2627)
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, NULL, DATE '2025-01-01')`, [id]))
    expect(e.codice).toBe('DATE_NON_VALIDE')
    expect(e.detail).toMatchObject({ motivo: 'fuori_periodo', campo: 'prepara_successivo_dal' })
  })

  it('tutto o niente: un valore giusto e uno sbagliato non cambiano nessuna delle due date', async () => {
    const id = await annoSede(A2627)
    const prima = await date(id)
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, DATE '2027-07-15', DATE '2028-01-01')`, [id]))
    expect(e.codice).toBe('DATE_NON_VALIDE')
    expect(await date(id)).toEqual(prima)
  })

  it('cambia le due date insieme', async () => {
    const id = await annoSede(A2627)
    const r = await chiama(`public.anno_imposta_date($1, DATE '2027-07-15', DATE '2027-05-01')`, [id])
    expect(r).toMatchObject({ cambiato: true, prepara_successivo_dal: '2027-05-01', prepara_successivo_dal_precedente: '2026-09-01' })
    expect(await date(id)).toEqual({ u: '2027-07-15', p: '2027-05-01' })
  })

  it('su un anno chiuso: ANNO_CHIUSO', async () => {
    const id = await annoSede(A2526)
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, DATE '2026-07-15', NULL)`, [id]))
    expect(e.codice).toBe('ANNO_CHIUSO')
  })

  it('su un anno in_chiusura (stato letto dalla riga): l\'ultimo giorno non si cambia, il resto sì', async () => {
    const id = await annoSede(A2627)
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [id])
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, DATE '2027-07-15', NULL)`, [id]))
    expect(e.codice).toBe('ANNO_IN_CHIUSURA')
    expect((await date(id)).u).toBe('2027-07-31')
    expect(await chiama(`public.anno_imposta_date($1, DATE '2027-07-31', DATE '2027-05-01')`, [id])).toMatchObject({ cambiato: true })
  })

  it('un anno inesistente: ANNO_NON_TROVATO', async () => {
    const e = await errore(db.query(`SELECT public.anno_imposta_date($1, NULL, NULL)`, [INESISTENTE]))
    expect(e.codice).toBe('ANNO_NON_TROVATO')
  })
})

describe('anno_prerequisiti_iscrizioni e anno_apri_iscrizioni', () => {
  const TUTTI = ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova']
  const mancano = async (id: string) => una<string[]>(`SELECT public.anno_prerequisiti_iscrizioni($1)`, [id])

  it('senza listino né moduli mancano tutte e quattro, nell\'ordine fisso', async () => {
    const id = await annoSede(A2728)
    expect(await mancano(id)).toEqual(TUTTI)
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE]))
    expect(e.codice).toBe('PREREQUISITI_MANCANTI')
    expect(e.detail).toEqual({ mancano: TUTTI })
    expect((await riga(id)).stato).toBe('in_preparazione')
  })

  it('una sola voce mancante: solo quella', async () => {
    const id = await annoSede(A2728)
    await listino(id, 'quota_conferma', 100); await listino(id, 'quota_nuova', 150); await modulo(id, 'conferma')
    expect(await mancano(id)).toEqual(['moduli_nuova'])
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE]))
    expect(e.detail).toEqual({ mancano: ['moduli_nuova'] })
  })

  it('con la sola quota_conferma mancano le altre tre', async () => {
    const id = await annoSede(A2728)
    await listino(id, 'quota_conferma', 100)
    expect(await mancano(id)).toEqual(['quota_nuova', 'moduli_conferma', 'moduli_nuova'])
  })

  it('un importo NULL non conta', async () => {
    const id = await annoSede(A2728)
    await listino(id, 'quota_conferma', null); await listino(id, 'quota_nuova', 150)
    await modulo(id, 'conferma'); await modulo(id, 'nuova')
    expect(await mancano(id)).toEqual(['quota_conferma'])
  })

  it('con tutto pronto: iscrizioni_aperte, una riga in anni_sede_stati con da = p_da, cambiato true', async () => {
    const id = await annoSede(A2728)
    await tuttoPronto(id)
    expect(await mancano(id)).toEqual([])
    const r = await chiama(`public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE])
    expect(r).toMatchObject({ cambiato: true, stato: 'iscrizioni_aperte', stato_precedente: 'in_preparazione' })
    expect((await riga(id)).stato).toBe('iscrizioni_aperte')
    const st = await db.query<{ stato: string; da: string }>(
      `SELECT stato, da FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND da IS NOT NULL`, [id])
    expect(st.rows).toEqual([{ stato: 'iscrizioni_aperte', da: UTENTE }])
  })

  it('la seconda volta: cambiato false e nessuna riga nuova', async () => {
    const id = await annoSede(A2728)
    await tuttoPronto(id)
    await chiama(`public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE])
    const r = await chiama(`public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE])
    expect(r).toMatchObject({ cambiato: false, stato: 'iscrizioni_aperte' })
    expect(await una<string>(`SELECT count(*)::text FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND da IS NOT NULL`, [id])).toBe('1')
  })

  it('su un anno corrente: STATO_NON_AMMESSO', async () => {
    const id = await annoSede(A2627)
    await tuttoPronto(id)
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE]))
    expect(e.codice).toBe('STATO_NON_AMMESSO')
    expect(e.detail).toMatchObject({ stato: 'corrente' })
  })

  it('non tocca mai un altro anno', async () => {
    const id = await annoSede(A2728)
    await tuttoPronto(id)
    await chiama(`public.anno_apri_iscrizioni($1, $2)`, [id, UTENTE])
    expect((await riga(await annoSede(A2627))).stato).toBe('corrente')
    expect((await riga(await annoSede(A2526))).stato).toBe('chiuso')
  })

  it('un anno inesistente: ANNO_NON_TROVATO', async () => {
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [INESISTENTE, UTENTE]))
    expect(e.codice).toBe('ANNO_NON_TROVATO')
  })
})

describe('anno_imposta_domande', () => {
  it('true su in_preparazione: STATO_NON_AMMESSO', async () => {
    const id = await annoSede(A2728)
    const e = await errore(db.query(`SELECT public.anno_imposta_domande($1, true)`, [id]))
    expect(e.codice).toBe('STATO_NON_AMMESSO')
    expect((await riga(id)).domande_aperte).toBe(false)
  })

  it('true su iscrizioni_aperte e su corrente: ok, e poi lo stesso valore è cambiato false', async () => {
    const id = await annoSede(A2728)
    await db.query(`UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = $1`, [id])
    expect(await chiama(`public.anno_imposta_domande($1, true)`, [id])).toMatchObject({ cambiato: true, domande_aperte: true })
    expect(await chiama(`public.anno_imposta_domande($1, true)`, [id])).toMatchObject({ cambiato: false, domande_aperte: true })
    const c = await annoSede(A2627)
    expect(await chiama(`public.anno_imposta_domande($1, true)`, [c])).toMatchObject({ cambiato: true })
  })

  it('false ovunque: ok, anche su in_preparazione e su chiuso', async () => {
    for (const a of [A2526, A2627, A2728]) {
      const id = await annoSede(a)
      expect(await chiama(`public.anno_imposta_domande($1, false)`, [id])).toMatchObject({ cambiato: false, domande_aperte: false })
    }
    const id = await annoSede(A2627)
    await db.query(`UPDATE public.anni_sede SET domande_aperte = true WHERE id = $1`, [id])
    expect(await chiama(`public.anno_imposta_domande($1, false)`, [id])).toMatchObject({ cambiato: true, domande_aperte: false })
  })

  it('NULL e anno inesistente sono errori con il loro codice', async () => {
    const id = await annoSede(A2627)
    expect((await errore(db.query(`SELECT public.anno_imposta_domande($1, NULL)`, [id]))).codice).toBe('PARAMETRO_MANCANTE')
    expect((await errore(db.query(`SELECT public.anno_imposta_domande($1, false)`, [INESISTENTE]))).codice).toBe('ANNO_NON_TROVATO')
  })
})

describe('sicurezza', () => {
  const FIRME = [
    'anno_imposta_date(uuid, date, date)',
    'anno_apri_iscrizioni(uuid, uuid)',
    'anno_imposta_domande(uuid, boolean)',
    'anno_prerequisiti_iscrizioni(uuid)',
  ]
  it('anon e authenticated non possono eseguirle, service_role sì; sono SECURITY DEFINER con search_path fissato', async () => {
    for (const f of FIRME) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; def: boolean; cfg: string }>(
        `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') auth,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') svc,
                p.prosecdef def, array_to_string(p.proconfig, ',') cfg
           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`public.${f}`])
      expect(r.rows[0], f).toMatchObject({ anon: false, auth: false, svc: true, def: true })
      expect(r.rows[0].cfg, f).toContain('search_path=public, pg_temp')
    }
  })

  it('un SET ROLE anon / authenticated riceve permission denied', async () => {
    const id = await annoSede(A2627)
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      try {
        const e = await errore(db.query(`SELECT public.anno_imposta_domande($1, false)`, [id]))
        expect(e.codice).toMatch(/permission denied/)
      } finally { await db.exec('RESET ROLE') }
    }
  })
})
