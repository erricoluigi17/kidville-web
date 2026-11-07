import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, creaAnniFissi } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.4a · REGISTRO DELLE TABELLE, ANNO SULLE TABELLE B, TRIGGER GENERICO.
 * La guardia dell'anno chiuso (gettoni, header, oblio) e `sposta_confine_anno` NON sono qui: arrivano
 * nel 1.4b e nel 1.4c. Solo uuid finti.
 *
 * Gli anni sono fissi: creati con `p_oggi` fisso E con gli stati reimpostati da `fissaCalendarioAnni`
 * (la migrazione dà alle sedi già presenti gli stati di OGGI: dal 01/08/2027 il 2026/27 sarebbe
 * `in_chiusura`, dal 01/09/2027 il 2027/28 sarebbe già `corrente`). L'helper riporta tutto al calendario
 * di sempre; il 2027/28 del describe «F2» si toglie solo se l'ha creato il test. Nessun test dipende da
 * oggi, tranne quello che scrive «oggi» di proposito.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const GENITORE = '55555555-5555-4555-8555-555555555551'
const THREAD = '66666666-6666-4666-8666-666666666661'

let db: PGlite
let A2526: string
let A2627: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il messaggio dell'eccezione: nel database è il codice stesso. */
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function rigidi(acceso: boolean) {
  await db.query('UPDATE public.anno_regole SET controlli_rigidi = $1', [acceso])
}
async function sezione(nome: string, anno: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, $2, $3) RETURNING id`,
    [SEDE, nome, anno])
}
async function presenza(data: string, extra: { anno?: string | null; sezione?: string | null } = {}): Promise<{ id: string; anno_id: string | null }> {
  const r = await db.query<{ id: string; anno_id: string | null }>(
    `INSERT INTO public.presenze (scuola_id, alunno_id, data, section_id, anno_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, anno_id`,
    [SEDE, ALUNNO, data, extra.sezione ?? null, extra.anno ?? null])
  return r.rows[0]
}

beforeAll(async () => {
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE] })
  // Anni fissi: 2025/26 e 2026/27 con date e stati di sempre. Gli stati li ha dati la migrazione con il
  // giorno in cui il test gira: si reimpostano, perché il risultato non dipenda da oggi.
  await creaAnniFissi(db, [SEDE])
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
  await db.query(`INSERT INTO public.chat_threads (id, student_id, parent_id) VALUES ($1, $2, $3)`, [THREAD, ALUNNO, GENITORE])
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(async () => { await rigidi(false) })

describe('anno_regole: una riga sola, due manopole spente', () => {
  it('la migrazione inserisce la riga, con tutto spento', async () => {
    const r = await db.query(`SELECT * FROM public.anno_regole`)
    expect(r.rows).toEqual([{ id: true, controlli_rigidi: false, controlli_rigidi_dal: null, guardia_attiva: false, guardia_attiva_dal: null }])
  })

  it('una seconda riga è impossibile, in entrambi i modi', async () => {
    await expect(db.query(`INSERT INTO public.anno_regole (id) VALUES (true)`)).rejects.toMatchObject({ code: '23505' })
    await expect(db.query(`INSERT INTO public.anno_regole (id) VALUES (false)`)).rejects.toMatchObject({ code: '23514' })
  })

  it('accendere una manopola scrive il suo _dal, spegnerla lo azzera', async () => {
    await db.query(`UPDATE public.anno_regole SET controlli_rigidi = true, guardia_attiva = true`)
    const acceso = (await db.query<{ a: boolean; b: boolean }>(
      `SELECT controlli_rigidi_dal IS NOT NULL AS a, guardia_attiva_dal IS NOT NULL AS b FROM public.anno_regole`)).rows[0]
    expect(acceso).toEqual({ a: true, b: true })
    await db.query(`UPDATE public.anno_regole SET controlli_rigidi = false, guardia_attiva = false`)
    const spento = (await db.query<{ a: boolean; b: boolean }>(
      `SELECT controlli_rigidi_dal IS NULL AS a, guardia_attiva_dal IS NULL AS b FROM public.anno_regole`)).rows[0]
    expect(spento).toEqual({ a: true, b: true })
  })
})

describe('il registro', () => {
  it('contiene le tabelle che esistono e salta quelle assenti (to_regclass)', async () => {
    const t = (await db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_tabelle ORDER BY 1`)).rows.map((x) => x.tabella)
    expect(t).toEqual(['avvisi', 'chat_messages', 'enrollment_submissions', 'frequenze', 'frequenze_moduli', 'pagamenti', 'presenze', 'sections', 'utenti_sezioni', 'valutazioni'])
    // eventi_diario, avvisi_risposte… sono nel registro della migrazione ma nell'aiuto non ci sono: saltate, senza errore.
    expect(t).not.toContain('eventi_diario')
  })

  it('un figlio il cui padre non esiste non entra nel registro', async () => {
    // pagamenti_quote ha il padre (pagamenti) ma la tabella non c'è; scrutini non ha né l'una né l'altro.
    const t = (await db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_tabelle WHERE modo = 'madre' ORDER BY 1`)).rows.map((x) => x.tabella)
    expect(t).toEqual(['frequenze_moduli', 'utenti_sezioni'])
  })

  it('i modi: data, dichiarato, madre; rigide solo frequenze e frequenze_moduli', async () => {
    const r = await db.query<{ tabella: string; modo: string; rigida: boolean }>(
      `SELECT tabella, modo, rigida FROM public.anno_tabelle ORDER BY 1`)
    const m = Object.fromEntries(r.rows.map((x) => [x.tabella, [x.modo, x.rigida]]))
    expect(m).toEqual({
      avvisi: ['data', false], chat_messages: ['data', false], enrollment_submissions: ['dichiarato', false], frequenze: ['dichiarato', true], frequenze_moduli: ['madre', true],
      pagamenti: ['dichiarato', false], presenze: ['data', false], sections: ['dichiarato', false],
      utenti_sezioni: ['madre', false], valutazioni: ['data', false],
    })
  })

  it('il registro non accetta una riga incoerente (CHECK)', async () => {
    const ins = (v: string) => db.query(
      `INSERT INTO public.anno_tabelle (tabella, modo, colonna_data, via_sede, madre_tabella, madre_colonna) VALUES ${v}`)
    await expect(ins(`('x1', 'data', NULL, 'scuola_id', NULL, NULL)`)).rejects.toMatchObject({ code: '23514' })
    await expect(ins(`('x2', 'madre', NULL, NULL, NULL, NULL)`)).rejects.toMatchObject({ code: '23514' })
    await expect(ins(`('x3', 'data', 'data', 'scuola_id', 'sections', 'section_id')`)).rejects.toMatchObject({ code: '23514' })
    await expect(ins(`('x4', 'dichiarato', NULL, NULL, NULL, NULL)`)).rejects.toMatchObject({ code: '23514' })
    await expect(ins(`('x5', 'data', 'data', 'scuola', NULL, NULL)`)).rejects.toMatchObject({ code: '23514' })
  })

  it('ogni tabella del registro ha il trigger generico, e scatta per ULTIMO fra i BEFORE', async () => {
    const r = await db.query<{ tabella: string; n: string; ultimo: string }>(
      `SELECT t.tabella,
              (SELECT count(*)::text FROM pg_trigger g
                WHERE g.tgrelid = format('public.%I', t.tabella)::regclass AND NOT g.tgisinternal
                  AND g.tgname = 'trg_zz_anno_assegna_e_verifica') AS n,
              (SELECT max(g.tgname) FROM pg_trigger g
                WHERE g.tgrelid = format('public.%I', t.tabella)::regclass AND NOT g.tgisinternal
                  AND (g.tgtype & 2) = 2) AS ultimo
         FROM public.anno_tabelle t`)
    expect(r.rows.length).toBeGreaterThan(0)
    for (const x of r.rows) expect(x, x.tabella).toMatchObject({ n: '1', ultimo: 'trg_zz_anno_assegna_e_verifica' })
  })

  it('ogni tabella del registro ha anno_id, e ogni chiave esterna sull\'anno ha il suo indice', async () => {
    const senza = await db.query<{ tabella: string }>(
      `SELECT t.tabella FROM public.anno_tabelle t
        WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = format('public.%I', t.tabella)::regclass
                             AND a.attname = 'anno_id' AND NOT a.attisdropped)`)
    expect(senza.rows).toEqual([])

    const fk = await db.query<{ tabella: string; con: string; indice: boolean }>(
      `SELECT t.tabella, c.conname AS con,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]) AS indice
         FROM public.anno_tabelle t
         JOIN pg_constraint c ON c.conrelid = format('public.%I', t.tabella)::regclass AND c.contype = 'f'
        WHERE c.confrelid IN ('public.anni_sede'::regclass, 'public.anni_scolastici'::regclass)`)
    // sections e frequenze hanno le loro (1.2, 1.3); le altre, quella creata qui.
    expect(new Set(fk.rows.map((x) => x.tabella))).toEqual(new Set(
      ['avvisi', 'chat_messages', 'enrollment_submissions', 'frequenze', 'frequenze_moduli', 'pagamenti', 'presenze', 'sections', 'utenti_sezioni', 'valutazioni']))
    for (const x of fk.rows) expect(x.indice, `${x.tabella} ${x.con}`).toBe(true)
  })

  it('FK composta dove la tabella ha scuola_id, semplice altrove', async () => {
    const r = await db.query<{ tabella: string; colonne: string; verso: string }>(
      `SELECT c.conrelid::regclass::text AS tabella,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS colonne,
              c.confrelid::regclass::text AS verso
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conname IN ('presenze_scuola_anno_fkey', 'valutazioni_anno_id_fkey', 'chat_messages_anno_id_fkey',
                                                'pagamenti_scuola_anno_fkey', 'utenti_sezioni_anno_id_fkey')
        ORDER BY 1`)
    expect(r.rows).toEqual([
      { tabella: 'chat_messages', colonne: 'anno_id', verso: 'anni_scolastici' },
      { tabella: 'pagamenti', colonne: 'scuola_id,anno_id', verso: 'anni_sede' },
      { tabella: 'presenze', colonne: 'scuola_id,anno_id', verso: 'anni_sede' },
      { tabella: 'utenti_sezioni', colonne: 'anno_id', verso: 'anni_scolastici' },
      { tabella: 'valutazioni', colonne: 'anno_id', verso: 'anni_scolastici' },
    ])
  })
})

describe('modo data', () => {
  it('un INSERT in presenze senza anno_id lo riceve dalla data', async () => {
    expect((await presenza('2026-10-05')).anno_id).toBe(A2627)
    expect((await presenza('2026-03-10')).anno_id).toBe(A2526)
  })

  it('i confini dell\'anno: 31/08 è del 2025/26, 01/09 del 2026/27', async () => {
    expect((await presenza('2026-08-31')).anno_id).toBe(A2526)
    expect((await presenza('2026-09-01')).anno_id).toBe(A2627)
  })

  it('un chat_messages del 31/08 alle 22:30 UTC è del 2026/27 (a Roma è già il 01/09)', async () => {
    const r = await db.query<{ anno_id: string }>(
      `INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2026-08-31 22:30:00+00') RETURNING anno_id`, [THREAD])
    expect(r.rows[0].anno_id).toBe(A2627)
    // e un minuto prima delle 22:00 UTC è ancora il 31/08, cioè il 2025/26
    const prima = await db.query<{ anno_id: string }>(
      `INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2026-08-31 21:59:00+00') RETURNING anno_id`, [THREAD])
    expect(prima.rows[0].anno_id).toBe(A2526)
  })

  it('valutazioni: la sede arriva dall\'alunno, la data dalla riserva se data_evento manca', async () => {
    const a = await db.query<{ anno_id: string }>(
      `INSERT INTO public.valutazioni (alunno_id, data_evento) VALUES ($1, DATE '2026-03-10') RETURNING anno_id`, [ALUNNO])
    expect(a.rows[0].anno_id).toBe(A2526)
    const b = await db.query<{ anno_id: string }>(
      `INSERT INTO public.valutazioni (alunno_id, data_evento, creato_il) VALUES ($1, NULL, TIMESTAMPTZ '2026-10-05 10:00:00+00') RETURNING anno_id`, [ALUNNO])
    expect(b.rows[0].anno_id).toBe(A2627)
  })

  it('MORBIDO: un anno_id diverso non si corregge e non si rifiuta; un giorno senza anno lascia NULL', async () => {
    expect((await presenza('2026-10-05', { anno: A2526 })).anno_id).toBe(A2526)
    expect((await presenza('2010-01-01')).anno_id).toBeNull()
  })

  it('RIGIDO: un anno_id diverso dà ANNO_NON_COERENTE; un giorno senza anno dà GIORNO_SENZA_ANNO', async () => {
    await rigidi(true)
    expect(await messaggio(presenza('2026-10-05', { anno: A2526 }))).toBe('ANNO_NON_COERENTE')
    expect(await messaggio(presenza('2010-01-01'))).toBe('GIORNO_SENZA_ANNO')
    // e quello giusto passa, con o senza l'anno scritto
    expect((await presenza('2026-10-05', { anno: A2627 })).anno_id).toBe(A2627)
    expect((await presenza('2026-10-05')).anno_id).toBe(A2627)
  })
})

describe('modo dichiarato (pagamenti)', () => {
  async function pagamento(extra: { competenza?: string | null; scadenza: string; anno?: string | null }) {
    const r = await db.query<{ anno_id: string | null }>(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, periodo_competenza, anno_id)
       VALUES ($1, $2, 'retta', 100, $3, $4, $5) RETURNING anno_id`,
      [ALUNNO, SEDE, extra.scadenza, extra.competenza ?? null, extra.anno ?? null])
    return r.rows[0].anno_id
  }

  it('prende la competenza; se manca, la scadenza', async () => {
    expect(await pagamento({ competenza: '2026-03-01', scadenza: '2026-10-05' })).toBe(A2526)
    expect(await pagamento({ competenza: null, scadenza: '2026-10-05' })).toBe(A2627)
  })

  it('MORBIDO: l\'anno dichiarato resta com\'è anche se la competenza è di un altro anno', async () => {
    expect(await pagamento({ competenza: '2026-10-05', scadenza: '2026-10-05', anno: A2526 })).toBe(A2526)
  })

  it('RIGIDO: una competenza che cade in un anno diverso da quello dichiarato → ANNO_NON_COERENTE', async () => {
    await rigidi(true)
    expect(await messaggio(pagamento({ competenza: '2026-10-05', scadenza: '2026-10-05', anno: A2526 }))).toBe('ANNO_NON_COERENTE')
    expect(await pagamento({ competenza: '2026-10-05', scadenza: '2026-10-05', anno: A2627 })).toBe(A2627)
  })

  it('RIGIDO: con l\'anno dichiarato la data di riserva senza anno non solleva niente: serve solo ad assegnare (F2)', async () => {
    await rigidi(true)
    expect(await pagamento({ competenza: null, scadenza: '2010-01-01', anno: A2627 })).toBe(A2627)
  })

  it('RIGIDO: senza anno dichiarato e con una scadenza senza anno → GIORNO_SENZA_ANNO', async () => {
    await rigidi(true)
    expect(await messaggio(pagamento({ competenza: null, scadenza: '2010-01-01' }))).toBe('GIORNO_SENZA_ANNO')
  })

  describe('con il 2027/28 creato (F2)', () => {
    let A2728: string
    // Dal 01/09/2027 il 2027/28 lo crea già la migrazione: si toglie solo quello creato qui.
    let creatoQui = false
    beforeAll(async () => {
      creatoQui = (await una<number>(`SELECT count(*)::int FROM public.anni_scolastici WHERE anno_inizio = 2027`)) === 0
      await db.exec(`
        INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2027) ON CONFLICT (anno_inizio) DO NOTHING;
        INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
        SELECT s.id, y.id, y.inizio_predefinito, y.fine_predefinita, 'in_preparazione', DATE '2028-07-31', y.inizio_predefinito
          FROM public.schools s JOIN public.anni_scolastici y ON y.anno_inizio = 2027
         WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.scuola_id = s.id AND x.anno_id = y.id);`)
      A2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
    })
    afterAll(async () => {
      await db.query(`DELETE FROM public.pagamenti WHERE anno_id = $1`, [A2728])
      if (!creatoQui) return
      await db.query(`DELETE FROM public.anni_sede_stati WHERE anno_sede_id IN (SELECT id FROM public.anni_sede WHERE anno_id = $1)`, [A2728])
      await db.query(`DELETE FROM public.anni_sede WHERE anno_id = $1`, [A2728])
      await db.query(`DELETE FROM public.anni_scolastici WHERE id = $1`, [A2728])
    })

    it('RIGIDO: dichiarata 2027/28 con scadenza 15/02/2027 e senza competenza → passa e resta 2027/28', async () => {
      await rigidi(true)
      expect(await pagamento({ competenza: null, scadenza: '2027-02-15', anno: A2728 })).toBe(A2728)
    })

    it('RIGIDO: la stessa con competenza 01/09/2026 (2026/27) → ANNO_NON_COERENTE', async () => {
      await rigidi(true)
      expect(await messaggio(pagamento({ competenza: '2026-09-01', scadenza: '2027-02-15', anno: A2728 }))).toBe('ANNO_NON_COERENTE')
    })

    it('RIGIDO: senza anno dichiarato e senza competenza → l\'anno viene dalla scadenza', async () => {
      await rigidi(true)
      expect(await pagamento({ competenza: null, scadenza: '2027-02-15' })).toBe(A2627)
    })
  })
})

describe('modo madre (utenti_sezioni)', () => {
  const U1 = '77777777-7777-4777-8777-777777777771'
  const U2 = '77777777-7777-4777-8777-777777777772'
  const U3 = '77777777-7777-4777-8777-777777777773'
  const U4 = '77777777-7777-4777-8777-777777777774'

  it('eredita l\'anno dalla sezione', async () => {
    const s = await sezione('Madre A', A2526)
    const r = await db.query<{ anno_id: string }>(
      `INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2) RETURNING anno_id`, [U1, s])
    expect(r.rows[0].anno_id).toBe(A2526)
  })

  it('MORBIDO: un anno scritto e diverso da quello della madre resta com\'è', async () => {
    const s = await sezione('Madre B', A2526)
    const r = await db.query<{ anno_id: string }>(
      `INSERT INTO public.utenti_sezioni (utente_id, section_id, anno_id) VALUES ($1, $2, $3) RETURNING anno_id`, [U2, s, A2627])
    expect(r.rows[0].anno_id).toBe(A2627)
  })

  it('RIGIDO: un anno diverso da quello della madre → ANNO_NON_COERENTE; quello giusto passa', async () => {
    const s = await sezione('Madre C', A2526)
    await rigidi(true)
    expect(await messaggio(db.query(
      `INSERT INTO public.utenti_sezioni (utente_id, section_id, anno_id) VALUES ($1, $2, $3)`, [U3, s, A2627]))).toBe('ANNO_NON_COERENTE')
    const ok = await db.query<{ anno_id: string }>(
      `INSERT INTO public.utenti_sezioni (utente_id, section_id, anno_id) VALUES ($1, $2, $3) RETURNING anno_id`, [U4, s, A2526])
    expect(ok.rows[0].anno_id).toBe(A2526)
  })
})

describe('SEZIONE_DI_ALTRO_ANNO', () => {
  it('con i controlli accesi: una riga del 2026/27 con la sezione del 2025/26 è rifiutata', async () => {
    const vecchia = await sezione('Sezione vecchia', A2526)
    const giusta = await sezione('Sezione giusta', A2627)
    await rigidi(true)
    expect(await messaggio(presenza('2026-10-05', { sezione: vecchia }))).toBe('SEZIONE_DI_ALTRO_ANNO')
    expect((await presenza('2026-10-05', { sezione: giusta })).anno_id).toBe(A2627)
  })

  it('con i controlli spenti passa (R2)', async () => {
    const vecchia = await sezione('Sezione vecchia 2', A2526)
    expect((await presenza('2026-10-05', { sezione: vecchia })).anno_id).toBe(A2627)
  })
})

describe('UPDATE: ricalcola solo se cambia qualcosa che c\'entra', () => {
  it('una riga vecchia incoerente non blocca un UPDATE di una colonna estranea, a controlli rigidi', async () => {
    const p = await presenza('2026-10-05', { anno: A2526 })      // incoerente, scritta a controlli spenti
    await rigidi(true)
    await db.query(`UPDATE public.presenze SET alunno_id = $2 WHERE id = $1`, [p.id, ALUNNO])
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [p.id])).toBe(A2526)
  })

  it('ma se cambia la data, la riga si riverifica: l\'anno incoerente che c\'era si corregge, non si rifiuta (F1)', async () => {
    const p = await presenza('2026-10-05', { anno: A2526 })
    await rigidi(true)
    await db.query(`UPDATE public.presenze SET data = DATE '2026-10-06' WHERE id = $1`, [p.id])
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [p.id])).toBe(A2627)
  })

  describe('una data corretta oltre il confine sposta la riga nell\'anno nuovo (F1)', () => {
    const p3108 = async () => (await presenza('2026-08-31')).id          // ultimo giorno del 2025/26
    const anno = (id: string) => una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id])
    const sposta = (id: string, extra = '') =>
      db.query(`UPDATE public.presenze SET data = DATE '2026-09-01'${extra} WHERE id = $1`, [id])

    it('MORBIDO: 31/08 → 01/09, la riga passa al 2026/27', async () => {
      const id = await p3108()
      expect(await anno(id)).toBe(A2526)
      await sposta(id)
      expect(await anno(id)).toBe(A2627)
    })

    it('RIGIDO: idem, nessun errore', async () => {
      const id = await p3108()
      await rigidi(true)
      await sposta(id)
      expect(await anno(id)).toBe(A2627)
    })

    it('RIGIDO: chi scrive anche un anno_id nuovo e diverso da quello calcolato riceve ANNO_NON_COERENTE', async () => {
      // Nel trigger «scrivere lo stesso valore di OLD» e «non scrivere» sono indistinguibili: il caso è
      // quindi una riga nata nel 2026/27 (a controlli morbidi), la cui data e il cui anno vengono
      // corretti insieme, e l'anno scritto (2025/26) non è né l'attuale né quello della nuova data.
      const id = (await presenza('2026-08-31', { anno: A2627 })).id
      await rigidi(true)
      expect(await messaggio(sposta(id, `, anno_id = '${A2526}'`))).toBe('ANNO_NON_COERENTE')
    })

    it('a guardia accesa, la stessa correzione su una riga del 2025/26 chiuso, senza gettone → ANNO_CHIUSO', async () => {
      const id = await p3108()
      await guardia(true)
      try {
        expect(await messaggio(sposta(id))).toBe('ANNO_CHIUSO')
      } finally { await guardia(false) }
      expect(await anno(id)).toBe(A2526)
    })
  })

  it('una riga con anno_id NULL (giorno senza anno) si ricalcola a ogni UPDATE', async () => {
    const p = await presenza('2010-01-01')
    expect(p.anno_id).toBeNull()
    await db.query(`UPDATE public.presenze SET data = DATE '2026-10-05' WHERE id = $1`, [p.id])
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [p.id])).toBe(A2627)
  })

  it('il DELETE passa, anche a controlli rigidi', async () => {
    const p = await presenza('2026-10-05')
    await rigidi(true)
    await db.query(`DELETE FROM public.presenze WHERE id = $1`, [p.id])
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE id = $1`, [p.id])).toBe('0')
  })
})

describe('a controlli spenti le scritture di oggi passano tutte (PR 1: il comportamento non cambia)', () => {
  it('presenze, valutazioni, chat, pagamenti, utenti_sezioni, sezione con anno diverso: nessun errore', async () => {
    const oggi = await una<string>(`SELECT public.giorno_roma(now())::text`)
    const s = await sezione('Sezione di oggi', A2526)
    const annoOggi = await una<string>(`SELECT public.anno_di($1, public.giorno_roma(now()))`, [SEDE])
    expect((await presenza(oggi)).anno_id).toBe(annoOggi)
    await db.query(`INSERT INTO public.valutazioni (alunno_id, data_evento) VALUES ($1, $2)`, [ALUNNO, oggi])
    await db.query(`INSERT INTO public.chat_messages (thread_id) VALUES ($1)`, [THREAD])
    await db.query(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'x', 1, $3)`, [ALUNNO, SEDE, oggi])
    await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ('77777777-7777-4777-8777-777777777779', $1)`, [s])
    // anche le scritture «sbagliate» di oggi: giorno senza anno, anno diverso, sezione di un altro anno
    expect((await presenza('2010-01-01')).anno_id).toBeNull()
    expect((await presenza(oggi, { anno: A2526, sezione: s })).anno_id).toBe(A2526)
  })
})

describe('R13: il trigger funziona anche per chi scrive dal browser come authenticated', () => {
  it('un INSERT in presenze come authenticated riceve comunque l\'anno (le tabelle dell\'anno sono chiuse al browser)', async () => {
    await db.exec('SET ROLE authenticated')
    try {
      // il browser non vede anni_sede: se il trigger non fosse SECURITY DEFINER, qui darebbe 42501
      await expect(db.query('SELECT 1 FROM public.anni_sede')).rejects.toMatchObject({ code: '42501' })
      const r = await db.query<{ anno_id: string }>(
        `INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, DATE '2026-10-05') RETURNING anno_id`, [SEDE, ALUNNO])
      expect(r.rows[0].anno_id).toBe(A2627)
      const m = await db.query<{ anno_id: string }>(
        `INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, TIMESTAMPTZ '2026-08-31 22:30:00+00') RETURNING anno_id`, [THREAD])
      expect(m.rows[0].anno_id).toBe(A2627)
    } finally {
      await db.exec('RESET ROLE')
    }
  })

  it('anno_tabelle e anno_regole sono chiuse al browser', async () => {
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      await expect(db.query('SELECT * FROM public.anno_tabelle')).rejects.toMatchObject({ code: '42501' })
      await expect(db.query('UPDATE public.anno_regole SET controlli_rigidi = true')).rejects.toMatchObject({ code: '42501' })
      await db.exec('RESET ROLE')
    }
  })
})

describe('sections e frequenze: il generico non contraddice i loro trigger', () => {
  it('con i controlli rigidi accesi una sezione e una frequenza nascono, e la spunta eredita l\'anno', async () => {
    await rigidi(true)
    const sez = await sezione('Sezione frequenze', A2627)
    const as = await una<string>(`SELECT public.anno_sede_di($1, $2)`, [SEDE, A2627])
    const alunno2 = '44444444-4444-4444-8444-444444444442'
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno2, SEDE])
    const f = await db.query<{ id: string; anno_id: string }>(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, tipo, origine, data_ingresso)
       VALUES ($1, $2, $3, 'conferma', 'segreteria', DATE '2026-09-10') RETURNING id, anno_id`, [alunno2, as, sez])
    expect(f.rows[0].anno_id).toBe(A2627)
    const mod = await una<string>(
      `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, 'conferma', 'm1', 'Modulo') RETURNING id`, [as])
    const sp = await db.query<{ anno_id: string }>(
      `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2) RETURNING anno_id`, [f.rows[0].id, mod])
    expect(sp.rows[0].anno_id).toBe(A2627)
    // il tocco di ricalcolo (UPDATE senza cambiare niente) non è mai bloccato dal generico
    await db.query(`UPDATE public.frequenze SET quota_pagamento_id = quota_pagamento_id WHERE id = $1`, [f.rows[0].id])
  })

  it('frequenze_moduli è rigida da subito: un anno scritto e diverso da quello della frequenza → ANNO_NON_COERENTE', async () => {
    const as = await una<string>(`SELECT public.anno_sede_di($1, $2)`, [SEDE, A2627])
    const alunno3 = '44444444-4444-4444-8444-444444444443'
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno3, SEDE])
    const f = await una<string>(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso)
       VALUES ($1, $2, 'nuova', 'segreteria', DATE '2026-09-10') RETURNING id`, [alunno3, as])
    const mod = await una<string>(
      `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, 'nuova', 'm2', 'Modulo') RETURNING id`, [as])
    // controlli SPENTI: la tabella è rigida lo stesso
    expect(await una<boolean>(`SELECT NOT controlli_rigidi FROM public.anno_regole`)).toBe(true)
    expect(await messaggio(db.query(
      `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id, anno_id) VALUES ($1, $2, $3)`, [f, mod, A2526]))).toBe('ANNO_NON_COERENTE')
  })
})

describe('anno_sede_della_riga', () => {
  const riga = (o: Record<string, unknown>) => JSON.stringify(o)
  it('la sede arriva da scuola_id, section_id, alunno_id, student_id o thread_id', async () => {
    const s = await sezione('Sezione sede', A2627)
    const sede = (tabella: string, o: Record<string, unknown>) =>
      una<string | null>(`SELECT public.anno_sede_della_riga($1, $2::jsonb)`, [tabella, riga(o)])
    expect(await sede('presenze', { scuola_id: SEDE })).toBe(SEDE)
    expect(await sede('valutazioni', { alunno_id: ALUNNO })).toBe(SEDE)
    expect(await sede('chat_messages', { thread_id: THREAD })).toBe(SEDE)
    // la colonna del registro è NULL: si prova la sezione
    expect(await sede('presenze', { scuola_id: null, section_id: s })).toBe(SEDE)
    // tabella fuori dal registro: scuola_id, poi le altre vie
    expect(await sede('non_nel_registro', { student_id: ALUNNO })).toBe(SEDE)
    expect(await sede('presenze', {})).toBeNull()
  })
})

describe('giro 1 · la rete del ramo morbido e la validazione delle madri', () => {
  const dbMadreSenza = (colonne: string) => creaDbAnno({
    codaPrima: `
      CREATE TABLE public.votazioni (${colonne}, scuola_id uuid, creata_il timestamptz DEFAULT now());
      CREATE TABLE public.votazioni_classi (votazione_id uuid NOT NULL, scuola_id uuid);
    `,
  })

  it('la migrazione si ferma se una madre non ha la colonna id', async () => {
    await expect(dbMadreSenza('codice uuid')).rejects.toThrow(/la madre votazioni non ha una colonna id uuid/)
  })

  it('la migrazione si ferma se una madre ha un anno_id che non è uuid', async () => {
    await expect(dbMadreSenza('id uuid PRIMARY KEY DEFAULT gen_random_uuid(), anno_id text'))
      .rejects.toThrow(/la madre votazioni non ha una colonna anno_id uuid/)
  })

  it('con madri a posto la migrazione passa (la stessa tabella, fatta bene)', async () => {
    const d = await dbMadreSenza('id uuid PRIMARY KEY DEFAULT gen_random_uuid()')
    const n = (await d.query<{ n: string }>(`SELECT count(*)::text n FROM public.anno_tabelle WHERE tabella = 'votazioni_classi'`)).rows[0].n
    expect(n).toBe('1')
    await d.close()
  })

  describe('un guasto nel calcolo', () => {
    let d: PGlite
    const S = '22222222-2222-4222-8222-222222222299'
    const scrivi = () => d.query<{ anno_id: string | null }>(
      `INSERT INTO public.prova_guasto (scuola_id, giorno) VALUES ($1, 'non-una-data') RETURNING anno_id`, [S])
    beforeAll(async () => {
      d = await creaDbAnno({ sediPrimaDellaMigrazione: [S] })
      // Una tabella di prova registrata apposta, con una colonna «data» che non si converte.
      await d.exec(`
        CREATE TABLE public.prova_guasto (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, giorno text, anno_id uuid);
        INSERT INTO public.anno_tabelle (tabella, modo, colonna_data, via_sede) VALUES ('prova_guasto', 'data', 'giorno', 'scuola_id');
        CREATE TRIGGER trg_zz_anno_assegna_e_verifica BEFORE INSERT OR UPDATE OR DELETE ON public.prova_guasto
          FOR EACH ROW EXECUTE FUNCTION public.anno_assegna_e_verifica();
      `)
    }, 60_000)
    afterAll(async () => { await d.close() })
    beforeEach(async () => { await d.query('UPDATE public.anno_regole SET controlli_rigidi = false') })

    it('a controlli spenti la scrittura passa con anno_id NULL e lascia una riga in app_log', async () => {
      expect((await scrivi()).rows[0].anno_id).toBeNull()
      const log = (await d.query<{ livello: string; fingerprint: string; contesto: Record<string, unknown> }>(
        `SELECT livello, fingerprint, contesto FROM public.app_log WHERE fingerprint LIKE 'db:anno-calcolo:%'`)).rows
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ livello: 'error', fingerprint: 'db:anno-calcolo:prova_guasto' })
      expect(log[0].contesto).toMatchObject({ tabella: 'prova_guasto', sqlstate: '22007' })
      // nessun valore della riga nel log
      expect(JSON.stringify(log[0].contesto)).not.toContain('non-una-data')
    })

    it('un secondo guasto lo stesso giorno non duplica la riga: conta le occorrenze', async () => {
      await scrivi()
      const r = (await d.query<{ occorrenze: number }>(
        `SELECT occorrenze FROM public.app_log WHERE fingerprint = 'db:anno-calcolo:prova_guasto'`)).rows
      expect(r).toHaveLength(1)
      expect(r[0].occorrenze).toBeGreaterThanOrEqual(2)
    })

    it('a controlli accesi lo stesso guasto solleva ancora (la rete è solo del ramo morbido)', async () => {
      await d.query('UPDATE public.anno_regole SET controlli_rigidi = true')
      await expect(scrivi()).rejects.toMatchObject({ code: '22007' })
    })

    it('1.4b · un guasto nel calcolo DENTRO LA GUARDIA lascia una traccia in app_log (senza valori) e la riga passa', async () => {
      await scrivi()   // anno_id resta NULL: alla guardia tocca ricalcolare l'anno di OLD, e il calcolo si rompe
      await d.query('UPDATE public.anno_regole SET guardia_attiva = true')
      try {
        await d.query(`UPDATE public.prova_guasto SET giorno = 'non-una-data'`)
      } finally { await d.query('UPDATE public.anno_regole SET guardia_attiva = false') }
      const log = (await d.query<{ livello: string; contesto: Record<string, unknown> }>(
        `SELECT livello, contesto FROM public.app_log WHERE fingerprint = 'db:anno-guardia:prova_guasto'`)).rows
      expect(log).toHaveLength(1)
      expect(log[0].livello).toBe('error')
      expect(log[0].contesto).toEqual({ esito: 'guardia-calcolo-fallito', operazione: 'anno_guardia_verifica',
                                         tabella: 'prova_guasto', sqlstate: '22007' })
      expect(JSON.stringify(log[0])).not.toContain('non-una-data')
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPITO 1.4b · LA GUARDIA DELL'ANNO CHIUSO E I GETTONI DI CORREZIONE (spenta di default).
// ════════════════════════════════════════════════════════════════════════════════════════════

const UTENTE = '77777777-7777-4777-8777-777777777771'
const D2526 = '2025-10-15'   // dentro il 2025/26 (chiuso: lo stato lo fissa fissaCalendarioAnni)
const D2627 = '2026-10-15'   // dentro il 2026/27 (corrente: idem)

type Tx = Pick<PGlite, 'query'>

async function guardia(acceso: boolean) {
  await db.query('UPDATE public.anno_regole SET guardia_attiva = $1', [acceso])
}
async function annoSede(anno: string): Promise<string> {
  return una<string>(`SELECT public.anno_sede_di($1, $2)`, [SEDE, anno])
}
async function gettone(o: { codice?: string; anno?: string; motivo?: string | null; scaduto?: boolean; utente?: string | null } = {}): Promise<string> {
  const codice = o.codice ?? 'correzione'
  const motivo = o.motivo === undefined ? (codice === 'correzione' ? 'motivo di prova' : null) : o.motivo
  const utente = o.utente === undefined ? (codice === 'oblio' ? null : UTENTE) : o.utente
  const scaduto = o.scaduto ?? false
  return una<string>(
    `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo, creata_il, scade_il)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::boolean THEN now() - interval '20 minutes' ELSE now() END,
             CASE WHEN $6::boolean THEN now() - interval '10 minutes' ELSE now() + interval '10 minutes' END)
     RETURNING id`,
    [utente, utente ? 'segreteria' : null, await annoSede(o.anno ?? A2526), codice, motivo, scaduto])
}
/** Una transazione con le impostazioni di sessione che PostgREST e le funzioni di oblio scrivono. */
async function inTx<T>(imp: { header?: string; oblio?: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (imp.header !== undefined) await tx.query(`SELECT set_config('request.headers', $1, true)`, [imp.header])
    if (imp.oblio !== undefined) await tx.query(`SELECT set_config('anno_chiuso.oblio', $1, true)`, [imp.oblio])
    return fn(tx)
  })
}
const conGettone = (id: string) => ({ header: JSON.stringify({ 'x-kidville-correzione': id }) })
async function presenzeChiuse(n = 1): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    ids.push((await presenza(D2526)).id)
  }
  return ids
}
const tocca = (tx: Tx, ids: string[]) =>
  tx.query(`UPDATE public.presenze SET section_id = NULL WHERE id = ANY($1::uuid[])`, [ids])
async function usi() {
  return (await db.query<{ tabella: string; riga_id: string | null; transazione: string; usata_il: string | null; correzione_id: string }>(
    `SELECT tabella, riga_id, transazione::text, usata_il::text, correzione_id FROM public.correzioni_anno_chiuso_usi ORDER BY id`)).rows
}
async function dettaglio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as { detail?: string }).detail ?? '' }
  return ''
}

describe('1.4b · la guardia dell\'anno chiuso', () => {
  beforeEach(async () => {
    await guardia(false)
    await db.exec(`DELETE FROM public.correzioni_anno_chiuso; DELETE FROM public.presenze;
                   DELETE FROM public.frequenze; DELETE FROM public.moduli_richiesti;
                   UPDATE public.anni_sede SET stato = 'chiuso' WHERE anno_id = '${A2526}'`)
  })
  afterAll(async () => { await guardia(false) })

  it('il 2025/26 è chiuso, il 2026/27 corrente: il banco di prova parte da qui', async () => {
    expect(await una<string>(`SELECT stato FROM public.anni_sede WHERE anno_id = $1`, [A2526])).toBe('chiuso')
    expect(await una<string>(`SELECT stato FROM public.anni_sede WHERE anno_id = $1`, [A2627])).toBe('corrente')
  })

  describe('senza gettone', () => {
    it('con la guardia accesa, un UPDATE su una riga del 2025/26 senza header → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      expect(await messaggio(tocca(db, [id]))).toBe('ANNO_CHIUSO')
    })

    it('il DETAIL porta solo tabella, anno_sede e stato (uuid, nome e stato: mai il motivo)', async () => {
      const [id] = await presenzeChiuse()
      await gettone({ motivo: 'SEGRETO-DEL-MOTIVO' })
      await guardia(true)
      const d = JSON.parse(await dettaglio(tocca(db, [id])))
      expect(Object.keys(d).sort()).toEqual(['anno_sede_id', 'stato', 'tabella'])
      expect(d).toMatchObject({ tabella: 'presenze', stato: 'chiuso', anno_sede_id: await annoSede(A2526) })
      expect(JSON.stringify(d)).not.toContain('SEGRETO')
    })

    it('un UPDATE su una riga del 2026/27 (corrente) passa', async () => {
      const r = await presenza(D2627)
      await guardia(true)
      await tocca(db, [r.id])
    })

    it('un DELETE di una riga del 2025/26 senza gettone → ANNO_CHIUSO, e la riga resta', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      expect(await messaggio(db.query(`DELETE FROM public.presenze WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
      expect(await una<number>(`SELECT count(*)::int FROM public.presenze WHERE id = $1`, [id])).toBe(1)
    })

    it('un INSERT dentro il 2025/26 senza gettone → ANNO_CHIUSO', async () => {
      await guardia(true)
      expect(await messaggio(presenza(D2526))).toBe('ANNO_CHIUSO')
    })

    it('un UPDATE che PORTA la data di una riga dentro il 2025/26 → ANNO_CHIUSO', async () => {
      const r = await presenza(D2627)
      await guardia(true)
      expect(await messaggio(db.query(`UPDATE public.presenze SET data = $2 WHERE id = $1`, [r.id, D2526]))).toBe('ANNO_CHIUSO')
    })

    it('e uno che la porta FUORI dal 2025/26 (la riga esce da un anno chiuso) → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      expect(await messaggio(db.query(`UPDATE public.presenze SET data = $2 WHERE id = $1`, [id, D2627]))).toBe('ANNO_CHIUSO')
    })

    it('anche a controlli rigidi accesi e con l\'uscita anticipata dell\'UPDATE: la guardia gira comunque', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      await rigidi(true)
      expect(await messaggio(tocca(db, [id]))).toBe('ANNO_CHIUSO')
    })

    it('R13: anche per chi scrive dal browser come authenticated (la guardia sta nel database)', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      await db.exec('SET ROLE authenticated')
      try {
        expect(await messaggio(tocca(db, [id]))).toBe('ANNO_CHIUSO')
      } finally { await db.exec('RESET ROLE') }
    })

    it('una riga di cui non si conosce la sede (nessuna via) NON si ferma', async () => {
      const v = await una<string>(
        `INSERT INTO public.valutazioni (alunno_id, section_id, data_evento) VALUES (NULL, NULL, $1) RETURNING id`, [D2526])
      await guardia(true)
      await db.query(`UPDATE public.valutazioni SET data_evento = data_evento WHERE id = $1`, [v])
    })
  })

  describe('con il gettone', () => {
    it('un gettone valido in request.headers → passa, e l\'uso registra usata_il, transazione, tabella e riga_id', async () => {
      const [id] = await presenzeChiuse()
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), (tx) => tocca(tx, [id]))
      const u = await usi()
      expect(u).toHaveLength(1)
      expect(u[0]).toMatchObject({ tabella: 'presenze', riga_id: id, correzione_id: g })
      expect(u[0].usata_il).not.toBeNull()
      expect(Number(u[0].transazione)).toBeGreaterThan(0)
    })

    it('il gettone non si consuma: vale per più scritture fino alla scadenza', async () => {
      const [a, b] = await presenzeChiuse(2)
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), (tx) => tocca(tx, [a]))
      await inTx(conGettone(g), (tx) => tocca(tx, [b]))
      expect((await usi()).map((x) => x.riga_id).sort()).toEqual([a, b].sort())
    })

    it('un UPDATE su tre righe → tre usi', async () => {
      const ids = await presenzeChiuse(3)
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), (tx) => tocca(tx, ids))
      expect((await usi()).map((x) => x.riga_id).sort()).toEqual([...ids].sort())
    })

    it('DELETE e INSERT con il gettone passano e lasciano il loro uso', async () => {
      const [id] = await presenzeChiuse()
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), async (tx) => {
        await tx.query(`DELETE FROM public.presenze WHERE id = $1`, [id])
        await tx.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, $3)`, [SEDE, ALUNNO, D2526])
      })
      expect(await usi()).toHaveLength(2)
    })

    it('la transazione dell\'uso è la stessa che la scatola nera scrive nella stessa transazione', async () => {
      const [id] = await presenzeChiuse()
      const g = await gettone()
      await guardia(true)
      const uguale = await inTx(conGettone(g), async (tx) => {
        await tocca(tx, [id])
        await tx.query(
          `INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
           VALUES ('presenze', $1, '{}'::jsonb, '{}', 'service_role')`, [id])
        const r = await tx.query<{ uguale: boolean }>(
          `SELECT u.transazione = m.transazione AS uguale
             FROM public.correzioni_anno_chiuso_usi u, scatola_nera.modifiche m WHERE u.riga_id = m.riga_id`)
        return r.rows[0].uguale
      })
      expect(uguale).toBe(true)
    })

    it('un gettone scaduto → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      const g = await gettone({ scaduto: true })
      await guardia(true)
      expect(await messaggio(inTx(conGettone(g), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
      expect(await usi()).toHaveLength(0)
    })

    it('un gettone di un altro anno → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      const g = await gettone({ anno: A2627 })
      await guardia(true)
      expect(await messaggio(inTx(conGettone(g), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
    })

    it('un id di gettone che non esiste → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      expect(await messaggio(inTx(conGettone('99999999-9999-4999-8999-999999999999'), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
    })

    it('anno in_chiusura: il gettone agosto passa; anno chiuso: il gettone agosto → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      const ago = await gettone({ codice: 'agosto' })
      await guardia(true)
      expect(await messaggio(inTx(conGettone(ago), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
      await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE anno_id = $1`, [A2526])
      await inTx(conGettone(ago), (tx) => tocca(tx, [id]))
      // e in_chiusura accetta anche la correzione
      const cor = await gettone({ codice: 'correzione' })
      await inTx(conGettone(cor), (tx) => tocca(tx, [id]))
    })

    it('un gettone oblio nell\'header NON apre niente: oblio nasce solo dall\'interruttore', async () => {
      const [id] = await presenzeChiuse()
      const o = await gettone({ codice: 'oblio' })
      await guardia(true)
      expect(await messaggio(inTx(conGettone(o), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
      await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE anno_id = $1`, [A2526])
      expect(await messaggio(inTx(conGettone(o), (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
    })

    it.each([
      ['assente', undefined],
      ['vuoto', ''],
      ['non JSON', 'questo non è json {'],
      ['JSON ma non un oggetto', '[1, 2, 3]'],
      ['JSON scalare', '42'],
      ['senza la nostra chiave', '{"altro":"x"}'],
      ['id che non è un uuid', '{"x-kidville-correzione":"non-un-uuid"}'],
      ['id con un tentativo di iniezione', '{"x-kidville-correzione":"1; DROP TABLE presenze"}'],
      ['id numerico', '{"x-kidville-correzione":12345}'],
      ['id nullo', '{"x-kidville-correzione":null}'],
    ])('header %s → ANNO_CHIUSO, mai un errore di cast', async (_n, header) => {
      const [id] = await presenzeChiuse()
      await gettone()
      await guardia(true)
      expect(await messaggio(inTx({ header }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
    })
  })

  describe('l\'interruttore anno_chiuso.oblio', () => {
    it('passa, e registra UN gettone oblio per transazione con un uso per riga', async () => {
      const ids = await presenzeChiuse(2)
      await guardia(true)
      await inTx({ oblio: 'on' }, async (tx) => {
        await tocca(tx, [ids[0]])
        await tx.query(`DELETE FROM public.presenze WHERE id = $1`, [ids[1]])
      })
      const g = await db.query<{ codice: string; utente_id: string | null; motivo: string | null }>(
        `SELECT codice, utente_id, motivo FROM public.correzioni_anno_chiuso`)
      expect(g.rows).toEqual([{ codice: 'oblio', utente_id: null, motivo: null }])
      expect((await usi()).map((x) => x.riga_id).sort()).toEqual([...ids].sort())
    })

    it('senza l\'interruttore, o con un valore diverso da on → ANNO_CHIUSO', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      expect(await messaggio(tocca(db, [id]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(inTx({ oblio: 'off' }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
      expect(await messaggio(inTx({ oblio: 'true' }, (tx) => tocca(tx, [id])))).toBe('ANNO_CHIUSO')
    })

    it('è locale alla transazione: la successiva senza interruttore torna a fermarsi', async () => {
      const [id] = await presenzeChiuse()
      await guardia(true)
      await inTx({ oblio: 'on' }, (tx) => tocca(tx, [id]))
      expect(await messaggio(tocca(db, [id]))).toBe('ANNO_CHIUSO')
    })
  })

  describe('colonne d\'incasso di pagamenti', () => {
    async function voceChiusa(): Promise<string> {
      return una<string>(
        `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
         VALUES ($1, $2, 'Retta di prova', 100, DATE '2025-10-31', DATE '2025-10-01') RETURNING id`, [SEDE, ALUNNO])
    }
    it('un UPDATE di sole colonne d\'incasso su un pagamento del 2025/26 passa senza gettone, e non lascia usi', async () => {
      const v = await voceChiusa()
      expect(await una<string>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [v])).toBe(A2526)
      await guardia(true)
      await db.query(
        `UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100, data_incasso = DATE '2026-11-01',
                fattura_id = gen_random_uuid(), fattura_stato = 'inviata', ultimo_sollecito_il = now(), aggiornato_il = now()
          WHERE id = $1`, [v])
      expect(await una<string>(`SELECT stato FROM public.pagamenti WHERE id = $1`, [v])).toBe('pagato')
      expect(await usi()).toHaveLength(0)
    })

    it('se l\'UPDATE tocca anche UNA colonna che non è d\'incasso → ANNO_CHIUSO', async () => {
      const v = await voceChiusa()
      await guardia(true)
      expect(await messaggio(db.query(
        `UPDATE public.pagamenti SET stato = 'pagato', importo = 90 WHERE id = $1`, [v]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(db.query(
        `UPDATE public.pagamenti SET descrizione = 'altro' WHERE id = $1`, [v]))).toBe('ANNO_CHIUSO')
    })

    it('l\'esenzione è solo per l\'UPDATE: DELETE e INSERT in un anno chiuso vogliono il gettone', async () => {
      const v = await voceChiusa()
      await guardia(true)
      expect(await messaggio(db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [v]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(voceChiusa())).toBe('ANNO_CHIUSO')
    })

    it('un pagamento del 2026/27 non è toccato dalla guardia', async () => {
      const v = await una<string>(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza)
         VALUES ($1, 'Retta', 100, DATE '2026-10-31', DATE '2026-10-01') RETURNING id`, [SEDE])
      await guardia(true)
      await db.query(`UPDATE public.pagamenti SET descrizione = 'altro' WHERE id = $1`, [v])
    })
  })

  describe('frequenze: i ricalcoli derivati passano, la scrittura di una persona no', () => {
    async function frequenzaChiusa() {
      const as = await annoSede(A2526)
      const inizio = await una<string>(`SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [as])
      const alunno = await una<string>(`INSERT INTO public.alunni (scuola_id) VALUES ($1) RETURNING id`, [SEDE])
      const voce = await una<string>(
        `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
         VALUES ($1, $2, 'Quota', 100, DATE '2025-10-31', DATE '2025-10-01') RETURNING id`, [SEDE, alunno])
      const f = await una<string>(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso, quota_pagamento_id)
         VALUES ($1, $2, 'nuova', 'segreteria', $3, $4) RETURNING id`, [alunno, as, inizio, voce])
      const modulo = await una<string>(
        `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo)
         VALUES ($1, 'nuova', 'm-guardia', 'Modulo') RETURNING id`, [as])
      return { f, voce, modulo }
    }
    const leggiF = async (f: string) => (await db.query<{ stato: string; moduli_completi: boolean; quota_saldata: boolean; quota_pagamento_id: string | null }>(
      `SELECT stato, moduli_completi, quota_saldata, quota_pagamento_id FROM public.frequenze WHERE id = $1`, [f])).rows[0]

    it('il tocco di ricalcolo (nessuna colonna cambia) passa senza gettone', async () => {
      const { f } = await frequenzaChiusa()
      await guardia(true)
      await db.query(`UPDATE public.frequenze SET quota_pagamento_id = quota_pagamento_id WHERE id = $1`, [f])
    })

    it('la voce della quota incassata ricalcola quota_saldata e lo stato senza gettone; l\'incasso stesso è cassa', async () => {
      const { f, voce, modulo } = await frequenzaChiusa()
      // la spunta del modulo (guardia spenta): la frequenza resta in attesa finché non si paga
      await db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [f, modulo])
      expect(await leggiF(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: true, quota_saldata: false })
      await guardia(true)
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100 WHERE id = $1`, [voce])
      expect(await leggiF(f)).toMatchObject({ stato: 'iscritto', moduli_completi: true, quota_saldata: true })
      expect(await usi()).toHaveLength(0)
    })

    it('la voce eliminata (FK → NULL, stato che torna in_attesa): serve il gettone per la voce, NON per la frequenza', async () => {
      const { f, voce, modulo } = await frequenzaChiusa()
      await db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [f, modulo])
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100 WHERE id = $1`, [voce])
      expect((await leggiF(f)).stato).toBe('iscritto')
      const g = await gettone()
      await guardia(true)
      expect(await messaggio(db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [voce]))).toBe('ANNO_CHIUSO')
      await inTx(conGettone(g), (tx) => tx.query(`DELETE FROM public.pagamenti WHERE id = $1`, [voce]))
      expect(await leggiF(f)).toMatchObject({ stato: 'in_attesa', quota_saldata: false, quota_pagamento_id: null })
      expect((await usi()).map((x) => x.tabella)).toEqual(['pagamenti'])   // la frequenza non ha consumato un uso
    })

    it('l\'INSERT in frequenze_moduli della stessa frequenza → ANNO_CHIUSO (la spunta è una scrittura di una persona)', async () => {
      const { f, modulo } = await frequenzaChiusa()
      await guardia(true)
      expect(await messaggio(db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [f, modulo]))).toBe('ANNO_CHIUSO')
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze_moduli WHERE frequenza_id = $1`, [f])).toBe(0)
    })

    it('con il gettone la spunta passa, e il ricalcolo che ne segue non consuma altri usi', async () => {
      const { f, modulo } = await frequenzaChiusa()
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), (tx) => tx.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [f, modulo]))
      expect((await leggiF(f)).moduli_completi).toBe(true)
      expect((await usi()).map((x) => x.tabella)).toEqual(['frequenze_moduli'])
    })

    it.each([
      ['data_uscita', `data_uscita = data_ingresso + 30`],
      ['retta_mensile', `retta_mensile = 123`],
      ['sospeso', `sospeso = true`],
      ['non_rinnova_il', `non_rinnova_il = now()`],
    ])('una scrittura di una persona su %s → ANNO_CHIUSO', async (_n, set) => {
      const { f } = await frequenzaChiusa()
      await guardia(true)
      expect(await messaggio(db.query(`UPDATE public.frequenze SET ${set} WHERE id = $1`, [f]))).toBe('ANNO_CHIUSO')
    })

    it('scollegare a mano la voce della quota: indistinguibile dalla FK, passa (limite noto)', async () => {
      const { f } = await frequenzaChiusa()
      await guardia(true)
      await db.query(`UPDATE public.frequenze SET quota_pagamento_id = NULL WHERE id = $1`, [f])
    })

    it('ma COLLEGARE un\'altra voce, o cambiare lo stato a mano → ANNO_CHIUSO', async () => {
      const { f } = await frequenzaChiusa()
      const altra = await una<string>(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza)
         VALUES ($1, 'Altra', 50, DATE '2025-10-31', DATE '2025-10-01') RETURNING id`, [SEDE])
      await guardia(true)
      expect(await messaggio(db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [f, altra]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(db.query(`UPDATE public.frequenze SET stato = 'ritirato' WHERE id = $1`, [f]))).toBe('ANNO_CHIUSO')
    })
  })

  describe('la cascata del padre: ogni figlia cancellata ha il suo uso', () => {
    async function frequenzaConSpunte() {
      const as = await annoSede(A2526)
      const inizio = await una<string>(`SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [as])
      const alunno = await una<string>(`INSERT INTO public.alunni (scuola_id) VALUES ($1) RETURNING id`, [SEDE])
      const f = await una<string>(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso)
         VALUES ($1, $2, 'nuova', 'segreteria', $3) RETURNING id`, [alunno, as, inizio])
      const spunte: string[] = []
      for (const codice of ['c1', 'c2']) {
        const m = await una<string>(
          `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, 'nuova', $2, 'Modulo') RETURNING id`, [as, codice])
        spunte.push(await una<string>(
          `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2) RETURNING id`, [f, m]))
      }
      return { f, spunte }
    }

    it('con il gettone: il DELETE del padre lascia un uso per il padre e uno per ogni figlia', async () => {
      const { f, spunte } = await frequenzaConSpunte()
      const g = await gettone()
      await guardia(true)
      expect(await messaggio(db.query(`DELETE FROM public.frequenze WHERE id = $1`, [f]))).toBe('ANNO_CHIUSO')
      await inTx(conGettone(g), (tx) => tx.query(`DELETE FROM public.frequenze WHERE id = $1`, [f]))
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze_moduli WHERE frequenza_id = $1`, [f])).toBe(0)
      const u = await usi()
      expect(u.filter((x) => x.tabella === 'frequenze').map((x) => x.riga_id)).toEqual([f])
      expect(u.filter((x) => x.tabella === 'frequenze_moduli').map((x) => x.riga_id).sort()).toEqual([...spunte].sort())
      expect(new Set(u.map((x) => x.correzione_id))).toEqual(new Set([g]))
    })

    it('con l\'oblio: lo stesso, sotto UN gettone oblio solo', async () => {
      const { f, spunte } = await frequenzaConSpunte()
      await guardia(true)
      await inTx({ oblio: 'on' }, (tx) => tx.query(`DELETE FROM public.frequenze WHERE id = $1`, [f]))
      const u = await usi()
      expect(u.filter((x) => x.tabella === 'frequenze_moduli').map((x) => x.riga_id).sort()).toEqual([...spunte].sort())
      expect(u).toHaveLength(3)
      expect(await una<number>(`SELECT count(*)::int FROM public.correzioni_anno_chiuso WHERE codice = 'oblio'`)).toBe(1)
    })

    it('un gettone di un altro anno non registra niente per le figlie (e il padre è fermato)', async () => {
      const { f } = await frequenzaConSpunte()
      const g = await gettone({ anno: A2627 })
      await guardia(true)
      expect(await messaggio(inTx(conGettone(g), (tx) => tx.query(`DELETE FROM public.frequenze WHERE id = $1`, [f])))).toBe('ANNO_CHIUSO')
      expect(await usi()).toHaveLength(0)
    })

    it('sezione → utenti_sezioni (tabella senza id): un uso per ogni figlia, con riga_id NULL', async () => {
      const sez = await sezione('Sezione cascata', A2526)
      for (const u of ['88888888-8888-4888-8888-888888888881', '88888888-8888-4888-8888-888888888882']) {
        await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [u, sez])
      }
      const g = await gettone()
      await guardia(true)
      await inTx(conGettone(g), (tx) => tx.query(`DELETE FROM public.sections WHERE id = $1`, [sez]))
      const u = await usi()
      expect(u.filter((x) => x.tabella === 'sections').map((x) => x.riga_id)).toEqual([sez])
      expect(u.filter((x) => x.tabella === 'utenti_sezioni')).toHaveLength(2)
    })
  })

  describe('a guardia spenta le scritture di oggi passano tutte (la PR 1 non cambia il comportamento)', () => {
    it('UPDATE, DELETE e INSERT su un anno chiuso, senza gettone: nessun errore, nessun uso', async () => {
      const [a, b] = await presenzeChiuse(2)
      await tocca(db, [a])
      await db.query(`DELETE FROM public.presenze WHERE id = $1`, [b])
      await presenza(D2526)
      await db.query(`UPDATE public.presenze SET data = $1`, [D2627])
      expect(await usi()).toHaveLength(0)
      expect(await una<number>(`SELECT count(*)::int FROM public.correzioni_anno_chiuso`)).toBe(0)
    })

    it('anche con un header manomesso e con l\'interruttore dell\'oblio acceso: nessun gettone nasce', async () => {
      const [id] = await presenzeChiuse()
      await inTx({ header: 'non json', oblio: 'on' }, (tx) => tocca(tx, [id]))
      expect(await una<number>(`SELECT count(*)::int FROM public.correzioni_anno_chiuso`)).toBe(0)
    })
  })

  describe('i gettoni: forma e sicurezza', () => {
    it('un gettone correzione senza motivo (NULL, vuoto, spazi) è rifiutato dal CHECK', async () => {
      for (const motivo of [null, '', '   ']) {
        await expect(gettone({ codice: 'correzione', motivo })).rejects.toMatchObject({ code: '23514' })
      }
    })

    it('agosto e oblio non vogliono il motivo; agosto e correzione vogliono l\'utente, oblio no', async () => {
      await gettone({ codice: 'agosto' })
      await gettone({ codice: 'oblio' })
      await expect(gettone({ codice: 'agosto', utente: null })).rejects.toMatchObject({ code: '23514' })
      await expect(gettone({ codice: 'correzione', utente: null })).rejects.toMatchObject({ code: '23514' })
    })

    it('il codice è un elenco chiuso', async () => {
      await expect(gettone({ codice: 'magia', motivo: 'x' })).rejects.toMatchObject({ code: '23514' })
    })

    it('la scadenza di default è a 10 minuti', async () => {
      const g = await gettone()
      expect(await una<number>(
        `SELECT round(extract(epoch FROM scade_il - creata_il) / 60)::int FROM public.correzioni_anno_chiuso WHERE id = $1`, [g])).toBe(10)
    })

    it('utente_id è un uuid senza chiave esterna (R15): nessuna FK oltre a quella verso anni_sede', async () => {
      const fk = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correzioni_anno_chiuso'::regclass AND contype = 'f'
            AND confrelid <> 'public.anni_sede'::regclass`)
      expect(fk.rows).toHaveLength(0)
    })

    it('authenticated e anon non leggono né scrivono le tabelle dei gettoni', async () => {
      const as = await annoSede(A2526)
      for (const ruolo of ['authenticated', 'anon']) {
        await db.exec(`SET ROLE ${ruolo}`)
        try {
          for (const t of ['correzioni_anno_chiuso', 'correzioni_anno_chiuso_usi']) {
            expect(await messaggio(db.query(`SELECT * FROM public.${t}`)), `${ruolo} SELECT ${t}`).toMatch(/permission denied/)
            expect(await messaggio(db.query(`DELETE FROM public.${t}`)), `${ruolo} DELETE ${t}`).toMatch(/permission denied/)
          }
          expect(await messaggio(db.query(
            `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo)
             VALUES ($1, 'segreteria', $2, 'correzione', 'x')`, [UTENTE, as]))).toMatch(/permission denied/)
          expect(await messaggio(db.query(`SELECT public.anno_guardia_sede('presenze', '{}'::jsonb)`))).toMatch(/permission denied/)
        } finally { await db.exec('RESET ROLE') }
      }
    })

    it('le due tabelle hanno la RLS accesa e nessuna policy', async () => {
      const r = await db.query<{ relname: string; rls: boolean; policy: number }>(
        `SELECT c.relname, c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy
           FROM pg_class c WHERE c.relname IN ('correzioni_anno_chiuso', 'correzioni_anno_chiuso_usi') ORDER BY 1`)
      expect(r.rows).toEqual([
        { relname: 'correzioni_anno_chiuso', rls: true, policy: 0 },
        { relname: 'correzioni_anno_chiuso_usi', rls: true, policy: 0 },
      ])
    })

    it('le FK nuove hanno il loro indice', async () => {
      const r = await db.query<{ idx: string }>(
        `SELECT indexname AS idx FROM pg_indexes WHERE tablename IN ('correzioni_anno_chiuso', 'correzioni_anno_chiuso_usi')`)
      const nomi = r.rows.map((x) => x.idx)
      expect(nomi).toContain('correzioni_anno_chiuso_anno_sede_idx')
      expect(nomi).toContain('correzioni_anno_chiuso_usi_correzione_idx')
    })
  })
})

describe('la sede della riga è la sua scuola_id (revisione finale, I1)', () => {
  const SEDE_B = '22222222-2222-4222-8222-222222222223'
  let dbB: PGlite

  beforeAll(async () => {
    // `giustifiche_didattiche` (nel DB vero: scuola_id E alunno_id, via_sede = alunno_id) non è nello schema base.
    dbB = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE, SEDE_B],
      codaPrima: `CREATE TABLE public.giustifiche_didattiche (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, scuola_id uuid NOT NULL,
        data date NOT NULL, creato_il timestamptz DEFAULT now());`,
    })
    await creaAnniFissi(dbB, [SEDE, SEDE_B])
    await dbB.exec(`
      INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2027) ON CONFLICT (anno_inizio) DO NOTHING;
      INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
      SELECT s.id, y.id, y.inizio_predefinito, y.fine_predefinita, 'in_preparazione', DATE '2028-07-31', y.inizio_predefinito
        FROM public.schools s JOIN public.anni_scolastici y ON y.anno_inizio = 2027
       WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.scuola_id = s.id AND x.anno_id = y.id);
    `)
    await dbB.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
  }, 60_000)
  afterAll(async () => { await dbB.close() })

  it('riga con scuola_id della sede B e alunno della sede A, confini diversi, controlli spenti: anno del calendario di B', async () => {
    // La sede B chiude l'anno 2026/27 il 15/08/2027 (la A il 31/08): il 20/08/2027 è 2027/28 per B, 2026/27 per A.
    const asB = await dbB.query<{ id: string }>(
      `SELECT s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
        WHERE s.scuola_id = $1 AND y.anno_inizio = 2026`, [SEDE_B])
    await dbB.query(`SELECT public.sposta_confine_anno($1, DATE '2027-08-15')`, [asB.rows[0].id])
    const attesoB = await dbB.query<{ anno: string }>(`SELECT public.anno_di($1, DATE '2027-08-20') AS anno`, [SEDE_B])
    const attesoA = await dbB.query<{ anno: string }>(`SELECT public.anno_di($1, DATE '2027-08-20') AS anno`, [SEDE])
    expect(attesoB.rows[0].anno).not.toBe(attesoA.rows[0].anno)

    await dbB.query('UPDATE public.anno_regole SET controlli_rigidi = false')
    const r = await dbB.query<{ anno_id: string }>(
      `INSERT INTO public.giustifiche_didattiche (scuola_id, alunno_id, data) VALUES ($1, $2, DATE '2027-08-20') RETURNING anno_id`,
      [SEDE_B, ALUNNO])
    expect(r.rows[0].anno_id).toBe(attesoB.rows[0].anno)
  })
})

describe('solo tabelle vere nel registro (revisione finale, I2)', () => {
  it('una vista con il nome di una tabella del registro non entra, e la migrazione passa', async () => {
    const dbV = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE],
      // Come se `eventi_agenda` fosse una vista, e `avvisi_risposte` (figlia di `avvisi`) pure.
      codaPrima: `CREATE VIEW public.eventi_agenda AS SELECT 1 AS x;
                  CREATE VIEW public.avvisi_risposte AS SELECT 1 AS avviso_id;
                  CREATE VIEW public.madre_finta AS SELECT 1 AS id;`,
    })
    try {
      const r = await dbV.query<{ tabella: string }>(
        `SELECT tabella FROM public.anno_tabelle WHERE tabella IN ('eventi_agenda', 'avvisi_risposte', 'avvisi', 'presenze') ORDER BY 1`)
      expect(r.rows.map((x) => x.tabella)).toEqual(['avvisi', 'presenze'])
    } finally { await dbV.close() }
  }, 60_000)
})

describe('eventi_diario: la data è orario_inizio, non la colonna generata (revisione Opus, F5)', () => {
  it('un UPDATE che non tocca orario_inizio non ricalcola; uno che lo sposta oltre il confine sì', async () => {
    // In un trigger BEFORE `giorno_competenza` (generata, STORED) vale NULL in NEW: confrontata con OLD
    // sembrava sempre cambiata e l'uscita anticipata non scattava mai. La data registrata è l'istante.
    const dbE = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE],
      codaPrima: `CREATE TABLE public.eventi_diario (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, tipo_evento text,
        orario_inizio timestamptz NOT NULL,
        giorno_competenza date GENERATED ALWAYS AS ((orario_inizio AT TIME ZONE 'Europe/Rome')::date) STORED,
        creato_il timestamptz DEFAULT now());`,
    })
    try {
      await creaAnniFissi(dbE, [SEDE])
      await dbE.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
      const anni = await dbE.query<{ anno_inizio: number; id: string }>(`SELECT anno_inizio, id FROM public.anni_scolastici`)
      const a2526 = anni.rows.find((x) => x.anno_inizio === 2025)!.id
      const a2627 = anni.rows.find((x) => x.anno_inizio === 2026)!.id
      // scritta a controlli morbidi con un anno incoerente (2025/26 per un giorno del 2026/27)
      const id = (await dbE.query<{ id: string }>(
        `INSERT INTO public.eventi_diario (alunno_id, tipo_evento, orario_inizio, anno_id)
         VALUES ($1, 'pasto', TIMESTAMPTZ '2026-10-05 10:00:00+02', $2) RETURNING id`, [ALUNNO, a2526])).rows[0].id
      await dbE.query(`UPDATE public.anno_regole SET controlli_rigidi = true`)
      // un'altra colonna: non blocca (era ANNO_NON_COERENTE)
      await dbE.query(`UPDATE public.eventi_diario SET tipo_evento = 'sonno' WHERE id = $1`, [id])
      const anno = async () => (await dbE.query<{ anno_id: string }>(`SELECT anno_id FROM public.eventi_diario WHERE id = $1`, [id])).rows[0].anno_id
      expect(await anno()).toBe(a2526)
      // l'istante cambia: la riga si riverifica e segue la data (le 00:30 romane del 01/09 sono del 2026/27)
      await dbE.query(`UPDATE public.eventi_diario SET orario_inizio = TIMESTAMPTZ '2026-09-01 00:30:00+02' WHERE id = $1`, [id])
      expect(await anno()).toBe(a2627)
    } finally { await dbE.close() }
  }, 60_000)
})
