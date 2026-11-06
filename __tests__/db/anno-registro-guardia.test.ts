import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.4a · REGISTRO DELLE TABELLE, ANNO SULLE TABELLE B, TRIGGER GENERICO.
 * La guardia dell'anno chiuso (gettoni, header, oblio) e `sposta_confine_anno` NON sono qui: arrivano
 * nel 1.4b e nel 1.4c. Solo uuid finti.
 *
 * Gli anni sono fissi (2025/26 e 2026/27, creati con `p_oggi` fisso): nessun test dipende da oggi,
 * tranne quello che scrive «oggi» di proposito.
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
  // Anni fissi: 2025/26 e 2026/27 con le date di sempre, qualunque sia il giorno in cui gira il test.
  await db.query(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [SEDE])
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

  it('RIGIDO: una scadenza senza anno dà GIORNO_SENZA_ANNO anche se l\'anno è dichiarato', async () => {
    await rigidi(true)
    expect(await messaggio(pagamento({ competenza: null, scadenza: '2010-01-01', anno: A2627 }))).toBe('GIORNO_SENZA_ANNO')
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

  it('ma se cambia la data, la riga si riverifica', async () => {
    const p = await presenza('2026-10-05', { anno: A2526 })
    await rigidi(true)
    expect(await messaggio(db.query(`UPDATE public.presenze SET data = DATE '2026-10-06' WHERE id = $1`, [p.id]))).toBe('ANNO_NON_COERENTE')
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
  })
})
