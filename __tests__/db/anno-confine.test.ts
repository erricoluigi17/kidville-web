import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, creaAnniFissi } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.4c · `sposta_confine_anno`: lo spostamento del confine fra due anni di una sede,
 * rifiutato quando nei giorni spostati ci sono già righe (review focus 2). Solo uuid finti.
 *
 * Il calendario di prova è fisso e non dipende da oggi: ogni test riparte da `ripristina()`.
 *   2025/26  2025-09-01 → 2026-08-31  chiuso
 *   2026/27  2026-09-01 → 2027-08-31  corrente        ← l'anno su cui si sposta la fine
 *   2027/28  2027-09-01 → 2028-08-31  in_preparazione ← il successivo
 * Accorciando 2026/27 a 2027-08-15 i giorni 16-31 agosto passano al 2027/28; allungandolo a
 * 2027-09-15 i giorni 1-15 settembre passano al 2026/27.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222223'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const GENITORE = '55555555-5555-4555-8555-555555555551'
const THREAD = '66666666-6666-4666-8666-666666666661'

let db: PGlite
let A2526: string
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
  const r = await db.query<{ inizio: string; fine: string; prepara: string; ultimo: string; stato: string }>(
    `SELECT inizio::text, fine::text, prepara_successivo_dal::text AS prepara, ultimo_giorno_aperto::text AS ultimo, stato
       FROM public.anni_sede WHERE id = $1`, [id])
  return r.rows[0]
}
/** Tutto ciò che il test non deve veder cambiare quando la funzione rifiuta. */
async function fotografia(): Promise<string> {
  const a = await db.query(`SELECT id, scuola_id, anno_id, inizio::text, fine::text, stato, ultimo_giorno_aperto::text, prepara_successivo_dal::text
                              FROM public.anni_sede ORDER BY id`)
  const p = await db.query(`SELECT id, anno_id FROM public.presenze ORDER BY id`)
  const v = await db.query(`SELECT id, anno_id FROM public.avvisi ORDER BY id`)
  const m = await db.query(`SELECT id, anno_id FROM public.chat_messages ORDER BY id`)
  const g = await db.query(`SELECT id, anno_id FROM public.pagamenti ORDER BY id`)
  const f = await db.query(`SELECT id, anno_id FROM public.frequenze ORDER BY id`)
  return JSON.stringify([a.rows, p.rows, v.rows, m.rows, g.rows, f.rows])
}
async function presenza(sede: string, data: string): Promise<string> {
  return una<string>(`INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, $3) RETURNING id`, [sede, ALUNNO, data])
}

/** Riporta il calendario di tutte le sedi (e le righe) allo stato dichiarato in cima al file. */
async function ripristina() {
  await db.exec(`
    DELETE FROM public.frequenze;
    DELETE FROM public.presenze;
    DELETE FROM public.avvisi;
    DELETE FROM public.chat_messages;
    DELETE FROM public.pagamenti;
    -- due UPDATE: l'indice unico del corrente non è differibile (prima fuori ogni anno che non è il 2026/27)
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
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE, ALTRA_SEDE] })
  await creaAnniFissi(db, [SEDE, ALTRA_SEDE])
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
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
  await db.query(`INSERT INTO public.chat_threads (id, student_id, parent_id) VALUES ($1, $2, $3)`, [THREAD, ALUNNO, GENITORE])
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(ripristina)

describe('il calendario di prova', () => {
  it('parte da tre anni contigui con gli stati dichiarati', async () => {
    const r = await db.query<{ anno_inizio: number; inizio: string; fine: string; stato: string }>(
      `SELECT y.anno_inizio, s.inizio::text, s.fine::text, s.stato FROM public.anni_sede s
         JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio BETWEEN 2025 AND 2027 ORDER BY 1`, [SEDE])
    expect(r.rows).toEqual([
      { anno_inizio: 2025, inizio: '2025-09-01', fine: '2026-08-31', stato: 'chiuso' },
      { anno_inizio: 2026, inizio: '2026-09-01', fine: '2027-08-31', stato: 'corrente' },
      { anno_inizio: 2027, inizio: '2027-09-01', fine: '2028-08-31', stato: 'in_preparazione' },
    ])
  })
})

describe('sposta_confine_anno · righe nei giorni spostati', () => {
  it('anno che si accorcia: presenze assegnate all\'anno nei giorni che passano al successivo → CONFINE_CON_RIGHE, nulla cambia', async () => {
    const as = await annoSede(SEDE, A2627)
    await presenza(SEDE, '2027-08-20')
    await presenza(SEDE, '2027-08-16')
    await presenza(SEDE, '2027-08-15')   // l'ultimo giorno che resta: non conta
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE anno_id = $1`, [A2627])).toBe('3')
    const prima = await fotografia()

    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
    expect(e.codice).toBe('CONFINE_CON_RIGHE')
    expect(e.detail).toMatchObject({ anno_sede_id: as, nuova_fine: '2027-08-15', dal: '2027-08-16', al: '2027-08-31', righe: 2, tabelle: { presenze: 2 } })
    expect(await fotografia()).toBe(prima)
  })

  it('anno che si allunga: righe del successivo nei giorni che passano all\'anno → CONFINE_CON_RIGHE, nulla cambia', async () => {
    const as = await annoSede(SEDE, A2627)
    await presenza(SEDE, '2027-09-10')
    await presenza(SEDE, '2027-09-16')   // oltre il nuovo confine: non conta
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE anno_id = $1`, [A2728])).toBe('2')
    const prima = await fotografia()

    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-09-15')`, [as]))
    expect(e.codice).toBe('CONFINE_CON_RIGHE')
    expect(e.detail).toMatchObject({ dal: '2027-09-01', al: '2027-09-15', righe: 1, tabelle: { presenze: 1 } })
    expect(await fotografia()).toBe(prima)
  })

  it('le righe di un\'altra data NON contano: accorciando, le righe del successivo non bloccano', async () => {
    const as = await annoSede(SEDE, A2627)
    await presenza(SEDE, '2027-09-10')   // già del successivo, fuori dai giorni spostati
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r.cambiato).toBe(true)
  })

  it('conteggi su più tabelle: due di modo data, pagamenti (competenza, scadenza) e frequenze (ingresso e uscita)', async () => {
    const as = await annoSede(SEDE, A2627)
    await presenza(SEDE, '2027-08-20')
    await presenza(SEDE, '2027-08-21')
    await db.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, DATE '2027-08-30')`, [SEDE])
    // chat_messages è un istante: 22:30 UTC del 15/08 è già il 16/08 a Roma (spostato); 21:30 UTC no.
    await db.query(`INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2027-08-15 22:30:00+00')`, [THREAD])
    await db.query(`INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2027-08-15 21:30:00+00')`, [THREAD])
    // all'altro estremo: 21:30 UTC del 31/08 è ancora il 31/08 a Roma (spostato); 22:30 UTC è già il 1/09 (del successivo)
    await db.query(`INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2027-08-31 21:30:00+00')`, [THREAD])
    await db.query(`INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2027-08-31 22:30:00+00')`, [THREAD])
    // pagamenti: la competenza, e solo se manca la scadenza
    await db.query(`INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
                    VALUES ($1, $2, 'a', 1, DATE '2027-08-01', DATE '2027-08-20')`, [SEDE, ALUNNO])
    await db.query(`INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza)
                    VALUES ($1, $2, 'b', 1, DATE '2027-08-25')`, [SEDE, ALUNNO])
    await db.query(`INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
                    VALUES ($1, $2, 'c', 1, DATE '2027-08-25', DATE '2027-08-01')`, [SEDE, ALUNNO])   // competenza prima: non conta
    // frequenze: due alunni diversi (una viva per bambino e anno)
    const a2 = '44444444-4444-4444-8444-444444444442'
    const a3 = '44444444-4444-4444-8444-444444444443'
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $3), ($2, $3)`, [a2, a3, SEDE])
    await db.query(`INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso)
                    VALUES ($1, $2, 'conferma', 'segreteria', DATE '2027-08-18')`, [a2, as])
    await db.query(`INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso, data_uscita)
                    VALUES ($1, $2, 'conferma', 'segreteria', DATE '2026-10-01', DATE '2027-08-28')`, [a3, as])
    await db.query(`INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso, data_uscita)
                    VALUES ($1, $2, 'conferma', 'segreteria', DATE '2026-10-01', DATE '2027-06-30')`, [ALUNNO, as])   // dentro: non conta

    const prima = await fotografia()
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
    expect(e.codice).toBe('CONFINE_CON_RIGHE')
    expect(e.detail).toMatchObject({
      righe: 9,
      tabelle: { avvisi: 1, chat_messages: 2, frequenze: 2, pagamenti: 2, presenze: 2 },
    })
    expect(await fotografia()).toBe(prima)
  })

  it('le righe di un\'altra sede negli stessi giorni non contano', async () => {
    const as = await annoSede(SEDE, A2627)
    const altra = await annoSede(ALTRA_SEDE, A2627)
    await presenza(ALTRA_SEDE, '2027-08-20')
    expect(await una<string>(`SELECT anno_id FROM public.presenze`)).toBe(A2627)   // è davvero assegnata all'anno
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r.cambiato).toBe(true)
    expect((await riga(altra)).fine).toBe('2027-08-31')   // l'altra sede non si è mossa
  })

  it('le righe con anno_id NULL negli stessi giorni non contano', async () => {
    const as = await annoSede(SEDE, A2627)
    // Il trigger assegnerebbe l'anno da solo: per avere un NULL lo si spegne un istante.
    await db.exec('ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica')
    try {
      await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data, anno_id) VALUES ($1, $2, DATE '2027-08-20', NULL)`, [SEDE, ALUNNO])
    } finally {
      await db.exec('ALTER TABLE public.presenze ENABLE TRIGGER trg_zz_anno_assegna_e_verifica')
    }
    expect(await una<string | null>(`SELECT anno_id FROM public.presenze`)).toBeNull()
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r.cambiato).toBe(true)
  })
})

describe('sposta_confine_anno · senza righe', () => {
  it('accorciando sposta insieme la fine dell\'anno e l\'inizio del successivo; il risultato porta solo uuid e date', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    const r = await una<Record<string, unknown>>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r).toEqual({
      cambiato: true,
      anno_sede_id: as,
      successivo_anno_sede_id: sc,
      fine_precedente: '2027-08-31',
      fine_nuova: '2027-08-15',
      inizio_successivo_precedente: '2027-09-01',
      inizio_successivo_nuovo: '2027-08-16',
      prepara_successivo_dal_precedente: '2027-09-01',
      prepara_successivo_dal_nuovo: '2027-08-16',
    })
    // solo uuid, date e un booleano: nessun testo libero
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'boolean') continue
      expect(v, k).toMatch(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2})$/)
    }
    expect(await riga(as)).toMatchObject({ inizio: '2026-09-01', fine: '2027-08-15' })
    expect(await riga(sc)).toMatchObject({ inizio: '2027-08-16', fine: '2028-08-31' })
  })

  it('allungando sposta nello stesso modo, nell\'altro verso', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    const r = await una<Record<string, unknown>>(`SELECT public.sposta_confine_anno($1, DATE '2027-09-15')`, [as])
    expect(r).toMatchObject({ cambiato: true, fine_precedente: '2027-08-31', fine_nuova: '2027-09-15', inizio_successivo_nuovo: '2027-09-16' })
    expect(await riga(as)).toMatchObject({ fine: '2027-09-15' })
    expect(await riga(sc)).toMatchObject({ inizio: '2027-09-16' })
  })

  it('la continuità regge alla COMMIT, anche forzando il controllo prima della fine della transazione', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.transaction(async (tx) => {
      await tx.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
      // controlli differiti (EXCLUDE e continuità) valutati ORA: se la funzione avesse mosso una riga sola, qui salterebbe
      await tx.exec('SET CONSTRAINTS ALL IMMEDIATE')
    })
    const buchi = await db.query(
      `SELECT 1 FROM (SELECT inizio, lag(fine) OVER (ORDER BY inizio) AS fp FROM public.anni_sede WHERE scuola_id = $1) t
        WHERE fp IS NOT NULL AND inizio <> fp + 1`, [SEDE])
    expect(buchi.rows).toHaveLength(0)
  })

  it('anno_di sui giorni spostati restituisce l\'anno nuovo, in entrambi i versi', async () => {
    const as = await annoSede(SEDE, A2627)
    expect(await una<string>(`SELECT public.anno_di($1, DATE '2027-08-20')`, [SEDE])).toBe(A2627)
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(await una<string>(`SELECT public.anno_di($1, DATE '2027-08-20')`, [SEDE])).toBe(A2728)
    expect(await una<string>(`SELECT public.anno_di($1, DATE '2027-08-15')`, [SEDE])).toBe(A2627)
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-09-15')`, [as])
    expect(await una<string>(`SELECT public.anno_di($1, DATE '2027-09-10')`, [SEDE])).toBe(A2627)
    expect(await una<string>(`SELECT public.anno_di($1, DATE '2027-09-16')`, [SEDE])).toBe(A2728)
  })

  it('p_nuova_fine uguale alla fine di oggi: nessun cambio, nessun errore', async () => {
    const as = await annoSede(SEDE, A2627)
    const prima = await fotografia()
    const r = await una<Record<string, unknown>>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-31')`, [as])
    expect(r).toEqual({ cambiato: false, anno_sede_id: as, fine: '2027-08-31' })
    expect(await fotografia()).toBe(prima)
  })

  it('l\'altra sede non si muove', async () => {
    const as = await annoSede(SEDE, A2627)
    const altra = await annoSede(ALTRA_SEDE, A2627)
    const altraSucc = await annoSede(ALTRA_SEDE, A2728)
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(await riga(altra)).toMatchObject({ fine: '2027-08-31' })
    expect(await riga(altraSucc)).toMatchObject({ inizio: '2027-09-01' })
  })
})

describe('sposta_confine_anno · prepara_successivo_dal del successivo', () => {
  it('se era uguale al vecchio inizio, segue il nuovo', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    expect((await riga(sc)).prepara).toBe('2027-09-01')
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect((await riga(sc)).prepara).toBe('2027-08-16')
    await db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-09-15')`, [as])
    expect((await riga(sc)).prepara).toBe('2027-09-16')
  })

  it('se è un\'altra data dentro il nuovo periodo, resta com\'è', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await db.query(`UPDATE public.anni_sede SET prepara_successivo_dal = DATE '2027-12-01' WHERE id = $1`, [sc])
    const r = await una<Record<string, unknown>>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect((await riga(sc)).prepara).toBe('2027-12-01')
    expect(r).toMatchObject({ prepara_successivo_dal_precedente: '2027-12-01', prepara_successivo_dal_nuovo: '2027-12-01' })
  })

  it('se è un\'altra data che cadrebbe fuori dal nuovo periodo → CONFINE_NON_VALIDO', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await db.query(`UPDATE public.anni_sede SET prepara_successivo_dal = DATE '2027-09-10' WHERE id = $1`, [sc])
    const prima = await fotografia()
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-09-15')`, [as]))
    expect(e.codice).toBe('CONFINE_NON_VALIDO')
    expect(e.detail).toMatchObject({ motivo: 'prepara_successivo_dal_successivo_fuori', anno_sede_id: sc })
    expect(await fotografia()).toBe(prima)
  })
})

describe('sposta_confine_anno · CONFINE_NON_VALIDO, un test per motivo', () => {
  async function rifiuta(as: string, fine: string | null, motivo: string, extra: Record<string, unknown> = {}) {
    const prima = await fotografia()
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, $2::date)`, [as, fine]))
    expect(e.codice).toBe('CONFINE_NON_VALIDO')
    expect(e.detail).toMatchObject({ motivo, ...extra })
    expect(await fotografia()).toBe(prima)
  }

  it('nessun anno successivo nella sede', async () => {
    const ultimo = await annoSede(SEDE, A2728)
    await rifiuta(ultimo, '2028-08-15', 'nessun_successivo', { anno_sede_id: ultimo })
  })

  it('nuova fine non successiva all\'inizio dell\'anno', async () => {
    const as = await annoSede(SEDE, A2627)
    await rifiuta(as, '2026-09-01', 'fine_non_dopo_inizio', { anno_sede_id: as })
    await rifiuta(as, '2026-01-01', 'fine_non_dopo_inizio')
  })

  it('nuovo inizio del successivo non precedente alla sua fine', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await rifiuta(as, '2028-08-31', 'inizio_successivo_non_prima_della_fine', { anno_sede_id: sc })
    await rifiuta(as, '2029-01-01', 'inizio_successivo_non_prima_della_fine')
  })

  it('ultimo_giorno_aperto dell\'anno fuori dal nuovo periodo', async () => {
    const as = await annoSede(SEDE, A2627)
    expect((await riga(as)).ultimo).toBe('2027-07-31')
    await rifiuta(as, '2027-07-30', 'ultimo_giorno_aperto_fuori', { anno_sede_id: as })
    // sul bordo (il 31/07 stesso) passa
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-07-31')`, [as])
    expect(r.cambiato).toBe(true)
  })

  it('prepara_successivo_dal dell\'anno fuori dal nuovo periodo (altrimenti il CHECK darebbe un 23514 muto)', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.query(`UPDATE public.anni_sede SET ultimo_giorno_aperto = DATE '2027-06-01', prepara_successivo_dal = DATE '2027-07-15' WHERE id = $1`, [as])
    await rifiuta(as, '2027-07-10', 'prepara_successivo_dal_fuori', { anno_sede_id: as })
  })

  it('ultimo_giorno_aperto del successivo prima del suo nuovo inizio', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await db.query(`UPDATE public.anni_sede SET ultimo_giorno_aperto = DATE '2027-09-05' WHERE id = $1`, [sc])
    await rifiuta(as, '2027-09-15', 'ultimo_giorno_aperto_successivo_fuori', { anno_sede_id: sc })
  })

  it('anno inesistente e parametri mancanti', async () => {
    await rifiuta('99999999-9999-4999-8999-999999999999', '2027-08-15', 'anno_inesistente')
    const as = await annoSede(SEDE, A2627)
    await rifiuta(as, null, 'parametro_mancante')
    const e = await errore(db.query(`SELECT public.sposta_confine_anno(NULL, DATE '2027-08-15')`))
    expect(e.codice).toBe('CONFINE_NON_VALIDO')
  })
})

describe('sposta_confine_anno · anno chiuso', () => {
  it('l\'anno è chiuso → ANNO_CHIUSO, nulla cambia', async () => {
    const chiuso = await annoSede(SEDE, A2526)   // il successivo è il 2026/27
    const prima = await fotografia()
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2026-08-15')`, [chiuso]))
    expect(e.codice).toBe('ANNO_CHIUSO')
    expect(e.detail).toMatchObject({ anno_sede_id: chiuso, stato: 'chiuso' })
    expect(await fotografia()).toBe(prima)
  })

  it('il successivo è chiuso → ANNO_CHIUSO', async () => {
    const as = await annoSede(SEDE, A2627)
    const sc = await annoSede(SEDE, A2728)
    await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [sc])
    const prima = await fotografia()
    const e = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
    expect(e.codice).toBe('ANNO_CHIUSO')
    expect(e.detail).toMatchObject({ anno_sede_id: sc })
    expect(await fotografia()).toBe(prima)
  })

  it('un anno in_chiusura non è chiuso: lo spostamento passa', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [as])
    const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
    expect(r.cambiato).toBe(true)
  })
})

describe('anno_conta_righe_assegnate_nei_giorni', () => {
  it('conta solo l\'anno, l\'intervallo e la sede dati', async () => {
    await presenza(SEDE, '2027-08-20')
    await presenza(ALTRA_SEDE, '2027-08-20')
    await presenza(SEDE, '2027-09-20')
    const conta = (anno: string, sede: string, dal: string, al: string) => una<string>(
      `SELECT public.anno_conta_righe_assegnate_nei_giorni('presenze', $1, $2, $3::date, $4::date)::text`, [anno, sede, dal, al])
    expect(await conta(A2627, SEDE, '2027-08-16', '2027-08-31')).toBe('1')
    expect(await conta(A2627, ALTRA_SEDE, '2027-08-16', '2027-08-31')).toBe('1')
    expect(await conta(A2627, SEDE, '2027-08-21', '2027-08-31')).toBe('0')
    expect(await conta(A2728, SEDE, '2027-08-16', '2027-08-31')).toBe('0')   // altro anno
    expect(await conta(A2728, SEDE, '2027-09-01', '2027-09-30')).toBe('1')
  })

  it('una tabella di modo madre, o fuori dal registro, è un errore: contare zero in silenzio sarebbe un falso verde', async () => {
    const e1 = await errore(db.query(`SELECT public.anno_conta_righe_assegnate_nei_giorni('utenti_sezioni', $1, $2, DATE '2027-08-16', DATE '2027-08-31')`, [A2627, SEDE]))
    expect(e1.codice).toMatch(/non ha una data da guardare/)
    const e2 = await errore(db.query(`SELECT public.anno_conta_righe_assegnate_nei_giorni('pg_class', $1, $2, DATE '2027-08-16', DATE '2027-08-31')`, [A2627, SEDE]))
    expect(e2.codice).toMatch(/non è nel registro/)
  })
})

describe('sposta_confine_anno · sicurezza', () => {
  it('anon e authenticated non possono eseguire né la funzione né il mattone del conteggio', async () => {
    const as = await annoSede(SEDE, A2627)
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      try {
        const a = await errore(db.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as]))
        expect(a.codice, `${ruolo} sposta_confine_anno`).toMatch(/permission denied/)
        const b = await errore(db.query(
          `SELECT public.anno_conta_righe_assegnate_nei_giorni('presenze', $1, $2, DATE '2027-08-16', DATE '2027-08-31')`, [A2627, SEDE]))
        expect(b.codice, `${ruolo} anno_conta_righe_assegnate_nei_giorni`).toMatch(/permission denied/)
      } finally { await db.exec('RESET ROLE') }
    }
    expect((await riga(as)).fine).toBe('2027-08-31')
  })

  it('service_role può eseguirla', async () => {
    const as = await annoSede(SEDE, A2627)
    await db.exec('SET ROLE service_role')
    try {
      const r = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [as])
      expect(r.cambiato).toBe(true)
    } finally { await db.exec('RESET ROLE') }
  })
})
