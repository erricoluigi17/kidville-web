import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.2.1 · il conteggio delle righe nei giorni spostati diventa selettivo per sede (F11) e la scadenza
 * dei pagamenti conta solo dove la competenza manca (Minor 3). Solo uuid finti.
 *
 * Il calendario di prova è quello di `anno-confine.test.ts` (fisso, indipendente da oggi):
 *   2025/26 chiuso · 2026/27 corrente (2026-09-01 → 2027-08-31) · 2027/28 in_preparazione.
 * Accorciando 2026/27 a 2027-08-15 i giorni 16-31 agosto passano al 2027/28: l'anno che li perde è il 2026/27.
 *
 * La catena è quella di produzione fino alla PR 3 (serve `anno_tabelle.segue_data`, che nasce con la M1) e poi
 * la migrazione della PR 4.2 (`M42`), che è quella provata qui.
 *
 * ONESTÀ SUI ROSSI: il filtro per sede c'era già (dopo, per riga); la modifica lo sposta PRIMA, dentro la CTE
 * (il banco `KIDVILLE_BANCO_ANNO=1` misura quel guadagno, fuori dal gate). I test «sede» sono quindi protezioni
 * del risultato: si provano rompendo il codice (togliendo il filtro), non su quello vecchio. Il rosso vero
 * sul vecchio codice sono la riserva senza `segue_data` e la chiave `senza_competenza`.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222223'
const ALUNNO_A = '44444444-4444-4444-8444-444444444441'
const ALUNNO_B = '44444444-4444-4444-8444-444444444442'

let db: PGlite
let A2627: string
let A2728: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** L'eccezione: il messaggio è il codice, il DETAIL un JSON (se c'è). */
async function errore(p: Promise<unknown>): Promise<{ codice: string; detail: Record<string, unknown> | null }> {
  try { await p } catch (e) {
    const x = e as { message: string; detail?: string }
    return { codice: x.message, detail: x.detail ? (JSON.parse(x.detail) as Record<string, unknown>) : null }
  }
  return { codice: 'nessun-errore', detail: null }
}
async function annoSede(sede: string, anno: string): Promise<string> {
  return una<string>(`SELECT public.anno_sede_di($1, $2)`, [sede, anno])
}
async function riga(id: string) {
  const r = await db.query<{ inizio: string; fine: string }>(`SELECT inizio::text, fine::text FROM public.anni_sede WHERE id = $1`, [id])
  return r.rows[0]
}
const conta = (tabella: string, anno: string, sede: string, dal = '2027-08-16', al = '2027-08-31') =>
  una<string>(`SELECT public.anno_conta_righe_assegnate_nei_giorni($1, $2, $3, $4::date, $5::date)::text`, [tabella, anno, sede, dal, al])

async function presenze(sede: string, alunno: string, quante: number, data = '2027-08-20') {
  for (let i = 0; i < quante; i++) {
    await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, $3)`, [sede, alunno, data])
  }
}
/** Un pagamento: competenza e scadenza come si vuole; `anno` forza l'anno spegnendo un istante il trigger. */
async function pagamento(o: { competenza: string | null; scadenza: string; anno?: string }): Promise<void> {
  const sql = `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza${o.anno ? ', anno_id' : ''})
               VALUES ($1, $2, 'p', 1, $3, $4${o.anno ? ', $5' : ''})`
  const params = o.anno ? [SEDE, ALUNNO_A, o.scadenza, o.competenza, o.anno] : [SEDE, ALUNNO_A, o.scadenza, o.competenza]
  if (!o.anno) { await db.query(sql, params); return }
  await db.exec('ALTER TABLE public.pagamenti DISABLE TRIGGER trg_zz_anno_assegna_e_verifica')
  try { await db.query(sql, params) } finally { await db.exec('ALTER TABLE public.pagamenti ENABLE TRIGGER trg_zz_anno_assegna_e_verifica') }
}

const TABELLA_PROVA = 'prova_riserva_senza_segue_data'
async function togliTabellaProva() {
  await db.exec(`DELETE FROM public.anno_tabelle WHERE tabella = '${TABELLA_PROVA}'; DROP TABLE IF EXISTS public.${TABELLA_PROVA};`)
}

/** Riporta il calendario (e le righe) allo stato dichiarato in cima al file. */
async function ripristina() {
  await togliTabellaProva()
  await db.exec(`
    DELETE FROM public.presenze;
    DELETE FROM public.valutazioni;
    DELETE FROM public.avvisi;
    DELETE FROM public.pagamenti;
    UPDATE public.anni_sede s
       SET inizio = y.inizio_predefinito, fine = y.fine_predefinita,
           stato = CASE WHEN y.anno_inizio < 2026 THEN 'chiuso' ELSE 'in_preparazione' END,
           ultimo_giorno_aperto = make_date(y.anno_inizio + 1, 7, 31),
           prepara_successivo_dal = y.inizio_predefinito
      FROM public.anni_scolastici y
     WHERE y.id = s.anno_id AND y.anno_inizio <> 2026;
    UPDATE public.anni_sede s
       SET inizio = y.inizio_predefinito, fine = y.fine_predefinita, stato = 'corrente',
           ultimo_giorno_aperto = make_date(y.anno_inizio + 1, 7, 31),
           prepara_successivo_dal = y.inizio_predefinito
      FROM public.anni_scolastici y
     WHERE y.id = s.anno_id AND y.anno_inizio = 2026;
  `)
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, ALTRA_SEDE], fino: 'M3' })
  await db.exec(`
    INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2027) ON CONFLICT (anno_inizio) DO NOTHING;
    INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
    SELECT s.id, y.id, y.inizio_predefinito, y.fine_predefinita, 'in_preparazione', DATE '2028-07-31', y.inizio_predefinito
      FROM public.schools s JOIN public.anni_scolastici y ON y.anno_inizio = 2027
     WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.scuola_id = s.id AND x.anno_id = y.id);
  `)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  A2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2), ($3, $4)`, [ALUNNO_A, SEDE, ALUNNO_B, ALTRA_SEDE])
  // `avvisi` in questo banco non ha un alunno: ne aggiungiamo la colonna per provare la sede nulla che si risolve da lì
  // (in produzione la sede di un avviso senza `scuola_id` si ricava dalle altre vie di `anno_sede_della_riga`).
  await db.exec('ALTER TABLE public.avvisi ADD COLUMN alunno_id uuid')
  await applicaPr2(db, 'M42')
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(ripristina)

describe('anno_conta_righe_assegnate_nei_giorni · la sede', () => {
  it('conta solo le righe della sede: 5 presenze della A e 5 della B nello stesso anno e negli stessi giorni', async () => {
    await presenze(SEDE, ALUNNO_A, 5)
    await presenze(ALTRA_SEDE, ALUNNO_B, 5)
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE anno_id = $1`, [A2627])).toBe('10')
    expect(await conta('presenze', A2627, SEDE)).toBe('5')
    expect(await conta('presenze', A2627, ALTRA_SEDE)).toBe('5')
  })

  it('una riga con la sede nulla si risolve dall\'alunno: contata per la sua sede e non per l\'altra (tabella a sede facoltativa)', async () => {
    await db.query(`INSERT INTO public.avvisi (scuola_id, alunno_id, giorno_competenza) VALUES (NULL, $1, DATE '2027-08-20')`, [ALUNNO_A])
    const r = await db.query<{ scuola_id: string | null; anno_id: string | null }>(`SELECT scuola_id, anno_id FROM public.avvisi`)
    expect(r.rows).toEqual([{ scuola_id: null, anno_id: A2627 }])   // è davvero senza sede e assegnata all'anno
    expect(await conta('avvisi', A2627, SEDE)).toBe('1')
    expect(await conta('avvisi', A2627, ALTRA_SEDE)).toBe('0')
  })

  it('una tabella senza `scuola_id` (modo data via alunno) risale ancora alla sede riga per riga', async () => {
    await db.exec(`INSERT INTO public.valutazioni (alunno_id, data_evento) VALUES ('${ALUNNO_A}', DATE '2027-08-20'), ('${ALUNNO_B}', DATE '2027-08-20')`)
    expect(await conta('valutazioni', A2627, SEDE)).toBe('1')
    expect(await conta('valutazioni', A2627, ALTRA_SEDE)).toBe('1')
  })
})

describe('anno_conta_righe_assegnate_nei_giorni · la regola della scadenza sui pagamenti (Minor 3)', () => {
  it('(1) competenza nei giorni spostati e anno = perdente → contata', async () => {
    await pagamento({ competenza: '2027-08-20', scadenza: '2027-08-01' })
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti`)).toBe(A2627)
    expect(await conta('pagamenti', A2627, SEDE)).toBe('1')
  })

  it('(2) competenza NULL, scadenza nei giorni, anno = perdente → contata; sposta_confine_anno rifiuta e dice quante dalla sola scadenza', async () => {
    await pagamento({ competenza: null, scadenza: '2027-08-25' })
    await pagamento({ competenza: '2027-08-20', scadenza: '2027-08-01' })   // una con la competenza: conta ma non è «senza competenza»
    expect(await conta('pagamenti', A2627, SEDE)).toBe('2')
    const as = await annoSede(SEDE, A2627)
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
    expect(e.codice).toBe('CONFINE_CON_RIGHE')
    expect(e.detail).toMatchObject({ righe: 2, tabelle: { pagamenti: 2 }, senza_competenza: 1 })
    expect((await riga(as)).fine).toBe('2027-08-31')   // nulla è cambiato
  })

  it('(2b) senza_competenza c\'è sempre nel dettaglio, anche a zero', async () => {
    await presenze(SEDE, ALUNNO_A, 1)
    const as = await annoSede(SEDE, A2627)
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
    expect(e.detail).toMatchObject({ tabelle: { presenze: 1 }, senza_competenza: 0 })
  })

  it('(3) competenza NULL, scadenza nei giorni, ma anno_id di un altro anno → non contata', async () => {
    await pagamento({ competenza: null, scadenza: '2027-08-25', anno: A2728 })
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti`)).toBe(A2728)
    expect(await conta('pagamenti', A2627, SEDE)).toBe('0')
    const as = await annoSede(SEDE, A2627)
    expect((await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])).cambiato).toBe(true)
  })

  it('(4) competenza presente FUORI dai giorni e scadenza dentro → non contata (la scadenza non smentisce la competenza)', async () => {
    await pagamento({ competenza: '2027-08-01', scadenza: '2027-08-25' })
    expect(await una<string>(`SELECT anno_id FROM public.pagamenti`)).toBe(A2627)
    expect(await conta('pagamenti', A2627, SEDE)).toBe('0')
  })

  it('(5) una tabella con la colonna di riserva ma SENZA segue_data: la riserva non conta, la colonna principale sì', async () => {
    await db.exec(`
      CREATE TABLE public.${TABELLA_PROVA} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id uuid NOT NULL,
        giorno date,
        riserva date,
        anno_id uuid
      );
      INSERT INTO public.anno_tabelle (tabella, modo, colonna_data, colonna_data_riserva, via_sede, segue_data)
      VALUES ('${TABELLA_PROVA}', 'data', 'giorno', 'riserva', 'scuola_id', false);
    `)
    await db.query(`INSERT INTO public.${TABELLA_PROVA} (scuola_id, giorno, riserva, anno_id) VALUES ($1, NULL, DATE '2027-08-20', $2)`, [SEDE, A2627])
    expect(await conta(TABELLA_PROVA, A2627, SEDE)).toBe('0')   // solo la riserva nei giorni: non conta
    await db.query(`INSERT INTO public.${TABELLA_PROVA} (scuola_id, giorno, riserva, anno_id) VALUES ($1, DATE '2027-08-20', NULL, $2)`, [SEDE, A2627])
    expect(await conta(TABELLA_PROVA, A2627, SEDE)).toBe('1')   // la colonna principale sì
    // e il registro con segue_data acceso fa contare la riserva: la regola dipende dal registro, non dal nome della tabella
    await db.exec(`UPDATE public.anno_tabelle SET segue_data = true WHERE tabella = '${TABELLA_PROVA}'`)
    expect(await conta(TABELLA_PROVA, A2627, SEDE)).toBe('2')
  })
})

describe('sposta_confine_anno · senza righe e tabelle fuori registro', () => {
  it('lo spostamento legittimo passa: con zero righe la fine e l\'inizio si spostano insieme', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await presenze(ALTRA_SEDE, ALUNNO_B, 3)   // le righe dell'altra sede negli stessi giorni non fermano questa
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r.cambiato).toBe(true)
    expect(await riga(as)).toMatchObject({ inizio: '2026-09-01', fine: '2027-08-15' })
    expect(await riga(sc)).toMatchObject({ inizio: '2027-08-16', fine: '2028-08-31' })
  })

  it('una tabella non nel registro resta un errore, non uno zero in silenzio', async () => {
    const e = await errore(db.query(`SELECT public.anno_conta_righe_assegnate_nei_giorni('pg_class', $1, $2, DATE '2027-08-16', DATE '2027-08-31')`, [A2627, SEDE]))
    expect(e.codice).toMatch(/non è nel registro/)
  })
})

describe('la continuità del calendario regge su UPDATE e DELETE (protezione: già verde prima della modifica)', () => {
  it('UPDATE della fine senza spostare il successivo → CALENDARIO_NON_CONTINUO alla COMMIT', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.exec('BEGIN')
    await db.query(`UPDATE public.anni_sede SET fine = fine - 1 WHERE id = $1`, [as])
    await expect(db.exec('COMMIT')).rejects.toMatchObject({ message: expect.stringContaining('CALENDARIO_NON_CONTINUO') })
    await db.exec('ROLLBACK').catch(() => undefined)
    expect((await riga(as)).fine).toBe('2027-08-31')
  })

  it('DELETE dell\'anno in mezzo → CALENDARIO_NON_CONTINUO alla COMMIT', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.exec('BEGIN')
    await db.query(`DELETE FROM public.frequenze WHERE anno_sede_id = $1`, [as])   // le frequenze dell'alunno (specchio) tengono l'anno
    await db.query(`DELETE FROM public.anni_sede WHERE id = $1`, [as])
    await expect(db.exec('COMMIT')).rejects.toMatchObject({ message: expect.stringContaining('CALENDARIO_NON_CONTINUO') })
    await db.exec('ROLLBACK').catch(() => undefined)
    expect((await riga(as)).fine).toBe('2027-08-31')
  })

  it('la stessa riduzione passata da sposta_confine_anno riesce', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.exec('BEGIN')
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-30')`, [as])
    await db.exec('COMMIT')
    expect((await riga(as)).fine).toBe('2027-08-30')
  })
})

describe('sicurezza', () => {
  it('anon e authenticated non eseguono le due funzioni ridefinite; service_role sì', async () => {
    const as = await annoSede(SEDE, A2627)
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      try {
        const a = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
        expect(a.codice, `${ruolo} sposta_confine_anno`).toMatch(/permission denied/)
        const b = await errore(db.query(`SELECT public.anno_conta_righe_assegnate_nei_giorni('presenze', $1, $2, DATE '2027-08-16', DATE '2027-08-31')`, [A2627, SEDE]))
        expect(b.codice, `${ruolo} anno_conta_righe_assegnate_nei_giorni`).toMatch(/permission denied/)
      } finally { await db.exec('RESET ROLE') }
    }
    await db.exec('SET ROLE service_role')
    try {
      expect(await conta('presenze', A2627, SEDE)).toBe('0')
    } finally { await db.exec('RESET ROLE') }
  })
})
