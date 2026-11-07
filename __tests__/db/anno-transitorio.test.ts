import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, creaAnniFissi, applicaPr2, SCHEMA_PR2 } from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.0 · LA REGOLA TRANSITORIA DEI «DICHIARATI» (migrazione M1, `_anno_strumenti.sql`).
 *
 * Oggi l'app non scrive `anno_id`: con i controlli rigidi accesi ogni INSERT su una tabella `dichiarato`
 * (il modulo pubblico delle iscrizioni per primo) fallirebbe. Il database dà l'anno a quelle scritture;
 * la PR 3 spegne la regola con la manopola `anno_regole.dichiarato_transitorio`.
 *
 * Date FISSE (2025/26, 2026/27, 2027/28) con `creaAnniFissi`: nessun test dipende da oggi. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const ALUNNO = '44444444-4444-4444-8444-444444444441'

let db: PGlite
let A2526: string
let A2627: string
let A2728: string

async function una<T>(sql: string, params: unknown[] = [], d: PGlite = db): Promise<T> {
  const r = await d.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il messaggio dell'eccezione: nel database è il codice stesso. */
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function rigidi(acceso: boolean, d: PGlite = db) {
  await d.query('UPDATE public.anno_regole SET controlli_rigidi = $1', [acceso])
}
async function transitorio(acceso: boolean, d: PGlite = db) {
  await d.query('UPDATE public.anno_regole SET dichiarato_transitorio = $1', [acceso])
}

interface PagOpz { sede?: string; competenza?: string | null; scadenza: string; anno?: string | null; creato?: string }
async function pag(o: PagOpz): Promise<{ id: string; anno_id: string | null }> {
  const r = await db.query<{ id: string; anno_id: string | null }>(
    `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza, anno_id, creato_il)
     VALUES ($1, 'voce di prova', 10, $2, $3, $4, coalesce($5::timestamptz, now())) RETURNING id, anno_id`,
    [o.sede ?? S1, o.scadenza, o.competenza ?? null, o.anno ?? null, o.creato ?? null])
  return r.rows[0]
}
async function annoDellaVoce(id: string): Promise<string | null> {
  return una<string | null>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [id])
}
async function crm(o: { etichetta?: string; quota?: number | null; creata?: string; sede?: string; anno?: string | null }) {
  const r = await db.query<{ id: string; anno_id: string | null }>(
    `INSERT INTO public.crm_bambini (scuola_id, anno_ingresso, quota_anno, creata_il, anno_id)
     VALUES ($1, $2, $3, $4::timestamptz, $5) RETURNING id, anno_id`,
    [o.sede ?? S1, o.etichetta ?? 'in_corso', o.quota ?? null, o.creata ?? '2026-11-01T10:00:00Z', o.anno ?? null])
  return r.rows[0]
}
async function domanda(sede: string, anno: string | null = null) {
  const r = await db.query<{ id: string; anno_id: string | null }>(
    `INSERT INTO public.enrollment_submissions (scuola_id, data, status, anno_id)
     VALUES ($1, '{}'::jsonb, 'pending', $2) RETURNING id, anno_id`, [sede, anno])
  return r.rows[0]
}

beforeAll(async () => {
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [S1, S2], codaPrima: SCHEMA_PR2 })
  await creaAnniFissi(db, [S1, S2])
  await applicaPr2(db, 'M1')
  // Il 2027/28 `in_preparazione` per le due sedi, con la stessa funzione che userà il job (PR 4.5).
  for (const s of [S1, S2]) await db.query(`SELECT public.anni_sede_crea_successivo($1, DATE '2026-11-06')`, [s])
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  A2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, S1])
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await rigidi(false)
  await transitorio(true)
})

describe('le manopole e il registro', () => {
  it('anno_regole: dichiarato_transitorio e specchio_alunni_attivo nascono accese', async () => {
    const r = (await db.query<{ t: boolean; s: boolean }>(
      `SELECT dichiarato_transitorio AS t, specchio_alunni_attivo AS s FROM public.anno_regole`)).rows
    expect(r).toEqual([{ t: true, s: true }])
  })

  it('segue_data è vero solo per pagamenti; sede_facoltativa viene dal catalogo (colonna nullable)', async () => {
    const seg = (await db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_tabelle WHERE segue_data ORDER BY 1`)).rows
    expect(seg.map((x) => x.tabella)).toEqual(['pagamenti'])
    const fac = Object.fromEntries((await db.query<{ tabella: string; f: boolean }>(
      `SELECT tabella, sede_facoltativa AS f FROM public.anno_tabelle WHERE tabella IN ('pagamenti', 'presenze', 'enrollment_submissions', 'utenti_sezioni')`)).rows
      .map((x) => [x.tabella, x.f]))
    // pagamenti.scuola_id e enrollment_submissions.scuola_id sono nullable nello schema di prova, presenze.scuola_id no;
    // le tabelle `madre` non hanno una colonna-sede propria
    expect(fac).toEqual({ pagamenti: true, enrollment_submissions: true, presenze: false, utenti_sezioni: false })
  })
})

describe('domanda di iscrizione: l\'anno attivo della sede', () => {
  it('senza anno_id riceve l\'anno attivo, anche a controlli rigidi', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      expect((await domanda(S1)).anno_id).toBe(A2627)
    }
  })

  it('ogni sede ha il SUO anno attivo', async () => {
    // la sede S2 non ha ancora cominciato il 2026/27: il suo anno attivo è il 2025/26
    await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE scuola_id = $1 AND anno_id = $2`, [S2, A2627])
    try {
      await rigidi(true)
      expect((await domanda(S2)).anno_id).toBe(A2526)
      expect((await domanda(S1)).anno_id).toBe(A2627)
    } finally {
      await db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE scuola_id = $1 AND anno_id = $2`, [S2, A2627])
    }
    expect((await domanda(S2)).anno_id).toBe(A2627)
  })

  it('manopola spenta: rigido → ANNO_DA_SPECIFICARE; morbido → NULL; con anno_id scritto passa sempre', async () => {
    await transitorio(false)
    await rigidi(true)
    expect(await messaggio(domanda(S1))).toBe('ANNO_DA_SPECIFICARE')
    expect((await domanda(S1, A2627)).anno_id).toBe(A2627)
    await rigidi(false)
    expect((await domanda(S1)).anno_id).toBeNull()
    expect((await domanda(S1, A2627)).anno_id).toBe(A2627)
  })

  it('una sede non ricavabile (chiave nulla) resta senza anno e senza errore, anche a controlli rigidi', async () => {
    await rigidi(true)
    const r = await db.query<{ anno_id: string | null }>(
      `INSERT INTO public.enrollment_submissions (scuola_id, status) VALUES (NULL, 'pending') RETURNING anno_id`)
    expect(r.rows[0].anno_id).toBeNull()
  })

  it('come authenticated (RLS): la funzione è SECURITY DEFINER e la domanda riceve l\'anno lo stesso', async () => {
    await rigidi(true)
    await db.exec('SET ROLE authenticated')
    try {
      const r = await db.query<{ anno_id: string }>(
        `INSERT INTO public.enrollment_submissions (scuola_id, status) VALUES ($1, 'pending') RETURNING anno_id`, [S1])
      expect(r.rows[0].anno_id).toBe(A2627)
    } finally {
      await db.exec('RESET ROLE')
    }
  })
})

describe('pagamenti: competenza → scadenza → giorno di Roma di creato_il', () => {
  it('competenza 2026-10-05 → 2026/27', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      expect((await pag({ competenza: '2026-10-05', scadenza: '2026-10-05' })).anno_id).toBe(A2627)
    }
  })

  it('competenza NULL e scadenza 2026-06-10 → 2025/26', async () => {
    await rigidi(true)
    expect((await pag({ scadenza: '2026-06-10' })).anno_id).toBe(A2526)
  })

  it('competenza 2027-09-01 → 2027/28 (l\'anno successivo esiste: lo ha creato anni_sede_crea_successivo)', async () => {
    await rigidi(true)
    expect((await pag({ competenza: '2027-09-01', scadenza: '2026-11-30' })).anno_id).toBe(A2728)
  })

  it('competenza fuori da ogni anno della sede (2031) → GIORNO_SENZA_ANNO se rigido, NULL se morbido', async () => {
    await rigidi(true)
    expect(await messaggio(pag({ competenza: '2031-01-01', scadenza: '2026-10-01' }))).toBe('GIORNO_SENZA_ANNO')
    await rigidi(false)
    expect((await pag({ competenza: '2031-01-01', scadenza: '2026-10-01' })).anno_id).toBeNull()
  })

  it('anno_dichiarato_transitorio: senza competenza né scadenza conta il giorno di ROMA di creato_il, non quello UTC', async () => {
    const f = (creato: string) => una<string | null>(
      `SELECT public.anno_dichiarato_transitorio('pagamenti', jsonb_build_object('scuola_id', $1::text, 'creato_il', $2::text))`, [S1, creato])
    // 12/10 22:30 UTC = 13/10 00:30 a Roma: tutti e due i giorni stanno nel 2026/27
    expect(await f('2026-10-12T22:30:00Z')).toBe(A2627)
    // 31/08 22:30 UTC = 01/09 00:30 a Roma: il giorno UTC sarebbe nel 2025/26, quello di Roma nel 2026/27
    expect(await f('2026-08-31T22:30:00Z')).toBe(A2627)
    expect(await f('2026-08-31T21:30:00Z')).toBe(A2526)
  })
})

describe('pagamenti: l\'anno segue la scadenza (segue_data), solo se prima la seguiva', () => {
  it('voce senza competenza: scadenza 31/08 → 01/09, l\'anno passa da 2025/26 a 2026/27, anche rigido', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      const v = await pag({ scadenza: '2026-08-31' })
      expect(v.anno_id).toBe(A2526)
      await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-09-01' WHERE id = $1`, [v.id])
      expect(await annoDellaVoce(v.id)).toBe(A2627)
    }
  })

  it('con la manopola spenta l\'anno segue ancora la scadenza (la manopola spegne solo «anno mancante»)', async () => {
    await transitorio(false)
    await rigidi(true)
    const v = await pag({ scadenza: '2026-08-31', anno: A2526 })
    await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-09-01' WHERE id = $1`, [v.id])
    expect(await annoDellaVoce(v.id)).toBe(A2627)
  })

  it('un anno dichiarato diverso dalla scadenza (quota 2027/28 con scadenza 15/02/2027) resta dov\'è e non dà errore', async () => {
    await rigidi(true)
    const v = await pag({ scadenza: '2027-02-15', anno: A2728 })
    expect(v.anno_id).toBe(A2728)
    await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2027-02-20' WHERE id = $1`, [v.id])
    expect(await annoDellaVoce(v.id)).toBe(A2728)
    // nemmeno portando la scadenza in un altro anno
    await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-12-20' WHERE id = $1`, [v.id])
    expect(await annoDellaVoce(v.id)).toBe(A2728)
  })

  it('un UPDATE di stato non ricalcola niente (nemmeno l\'anno dichiarato diverso dalla scadenza)', async () => {
    await rigidi(true)
    const v = await pag({ scadenza: '2026-10-01', anno: A2526 })
    await db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v.id])
    expect(await annoDellaVoce(v.id)).toBe(A2526)
  })

  it('ANNO_NON_COERENTE resta solo per un anno scritto diverso da quello della competenza (rigido)', async () => {
    await rigidi(true)
    const v = await pag({ competenza: '2026-10-05', scadenza: '2026-10-05' })
    expect(await messaggio(db.query(`UPDATE public.pagamenti SET anno_id = $2 WHERE id = $1`, [v.id, A2526]))).toBe('ANNO_NON_COERENTE')
    // la stessa scrittura a controlli morbidi non solleva e lascia l'anno com'è (come in PR 1)
    await rigidi(false)
    await db.query(`UPDATE public.pagamenti SET anno_id = $2 WHERE id = $1`, [v.id, A2526])
    expect(await annoDellaVoce(v.id)).toBe(A2526)
  })

  it('una voce con competenza che cambia scadenza non segue la scadenza (vale la competenza)', async () => {
    await rigidi(true)
    const v = await pag({ competenza: '2026-10-05', scadenza: '2026-10-05' })
    await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-12-05' WHERE id = $1`, [v.id])
    expect(await annoDellaVoce(v.id)).toBe(A2627)
  })
})

describe('CRM: l\'anno dall\'etichetta di ingresso', () => {
  it('in_corso con creata_il 2026-11-01 → 2026/27', async () => {
    await rigidi(true)
    expect((await crm({ etichetta: 'in_corso' })).anno_id).toBe(A2627)
  })

  it('prossimo senza quota_anno → 2027/28; prossimo con quota_anno 2027 → 2027/28', async () => {
    await rigidi(true)
    expect((await crm({ etichetta: 'prossimo' })).anno_id).toBe(A2728)
    expect((await crm({ etichetta: 'prossimo', quota: 2027 })).anno_id).toBe(A2728)
  })

  it('non_indicato → 2026/27 (si comporta come in_corso: lo conterà il rapporto)', async () => {
    await rigidi(true)
    expect((await crm({ etichetta: 'non_indicato' })).anno_id).toBe(A2627)
  })

  it('UPDATE anno_ingresso = in_corso su una riga 2027/28 → l\'anno torna 2026/27', async () => {
    await rigidi(true)
    const r = await crm({ etichetta: 'prossimo' })
    expect(r.anno_id).toBe(A2728)
    await db.query(`UPDATE public.crm_bambini SET anno_ingresso = 'in_corso' WHERE id = $1`, [r.id])
    expect(await una<string>(`SELECT anno_id FROM public.crm_bambini WHERE id = $1`, [r.id])).toBe(A2627)
  })

  it('se lo stesso comando scrive anche anno_id, vince quello scritto', async () => {
    const r = await crm({ etichetta: 'in_corso' })
    expect(r.anno_id).toBe(A2627)
    await db.query(`UPDATE public.crm_bambini SET anno_ingresso = 'prossimo', anno_id = $2 WHERE id = $1`, [r.id, A2526])
    expect(await una<string>(`SELECT anno_id FROM public.crm_bambini WHERE id = $1`, [r.id])).toBe(A2526)
  })

  it('quota_anno che punta a un anno che la sede non ha (2035) → ANNO_NON_COERENTE (rigido), NULL (morbido)', async () => {
    await rigidi(true)
    expect(await messaggio(crm({ etichetta: 'prossimo', quota: 2035 }))).toBe('ANNO_NON_COERENTE')
    const r = await crm({ etichetta: 'prossimo' })
    expect(await messaggio(db.query(`UPDATE public.crm_bambini SET quota_anno = 2035 WHERE id = $1`, [r.id]))).toBe('ANNO_NON_COERENTE')
    await rigidi(false)
    expect((await crm({ etichetta: 'prossimo', quota: 2035 })).anno_id).toBeNull()
    // in morbido l'UPDATE non toglie l'anno che la riga aveva
    await db.query(`UPDATE public.crm_bambini SET quota_anno = 2035 WHERE id = $1`, [r.id])
    expect(await una<string>(`SELECT anno_id FROM public.crm_bambini WHERE id = $1`, [r.id])).toBe(A2728)
  })

  it('il cambio di etichetta segue anche con la manopola spenta (non è il ramo «anno mancante»)', async () => {
    await transitorio(false)
    const r = await crm({ etichetta: 'prossimo', anno: A2728 })
    await db.query(`UPDATE public.crm_bambini SET anno_ingresso = 'in_corso' WHERE id = $1`, [r.id])
    expect(await una<string>(`SELECT anno_id FROM public.crm_bambini WHERE id = $1`, [r.id])).toBe(A2627)
  })
})

describe('votazioni, caricamenti Excel, scrutini e certificati', () => {
  it('votazioni e iscrizioni_elenco_caricamenti: l\'anno attivo', async () => {
    await rigidi(true)
    expect((await db.query<{ anno_id: string }>(`INSERT INTO public.votazioni (scuola_id) VALUES ($1) RETURNING anno_id`, [S1])).rows[0].anno_id).toBe(A2627)
    expect((await db.query<{ anno_id: string }>(
      `INSERT INTO public.iscrizioni_elenco_caricamenti (scuola_id) VALUES ($1) RETURNING anno_id`, [S1])).rows[0].anno_id).toBe(A2627)
  })

  for (const tabella of ['scrutinio_periodi', 'certificati_competenze']) {
    it(`${tabella}: l'etichetta anno_scolastico → il suo anno; un'etichetta che nessun anno ha → ANNO_NON_COERENTE`, async () => {
      await rigidi(true)
      const ins = (etichetta: string) => db.query<{ anno_id: string | null }>(
        `INSERT INTO public.${tabella} (scuola_id, anno_scolastico) VALUES ($1, $2) RETURNING anno_id`, [S1, etichetta])
      expect((await ins('2026/27')).rows[0].anno_id).toBe(A2627)
      expect((await ins('2025/26')).rows[0].anno_id).toBe(A2526)
      expect(await messaggio(ins('2030/31'))).toBe('ANNO_NON_COERENTE')
      await rigidi(false)
      expect((await ins('2030/31')).rows[0].anno_id).toBeNull()
    })
  }
})

describe('chi non passa dalla regola transitoria', () => {
  it('sections: una sezione senza anno_id riceve ancora l\'anno attivo dal trigger R8 della PR 1', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      const s = await db.query<{ anno_id: string }>(
        `INSERT INTO public.sections (scuola_id, name) VALUES ($1, $2) RETURNING anno_id`, [S1, `Sezione prova ${r}`])
      expect(s.rows[0].anno_id).toBe(A2627)
    }
  })

  it('con la manopola spenta una sezione nasce lo stesso (non è una dichiarata della regola)', async () => {
    await transitorio(false)
    await rigidi(true)
    const s = await db.query<{ anno_id: string }>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Sezione senza manopola') RETURNING anno_id`, [S1])
    expect(s.rows[0].anno_id).toBe(A2627)
  })

  it('presenze: un anno scritto diverso dalla data resta ANNO_NON_COERENTE (rigido)', async () => {
    await rigidi(true)
    expect(await messaggio(db.query(
      `INSERT INTO public.presenze (scuola_id, alunno_id, data, anno_id) VALUES ($1, $2, DATE '2026-10-05', $3)`, [S1, ALUNNO, A2526])))
      .toBe('ANNO_NON_COERENTE')
  })

  it('presenze: la data spostata senza toccare anno_id segue la data (correzione F1 della PR 1), rigido o morbido', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      const p = await una<string>(
        `INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, DATE '2026-10-05') RETURNING id`, [S1, ALUNNO])
      await db.query(`UPDATE public.presenze SET data = DATE '2026-06-05' WHERE id = $1`, [p])
      expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [p])).toBe(A2526)
    }
  })
})

describe('nessun guasto muto', () => {
  let d: PGlite
  beforeAll(async () => {
    // quota_anno di tipo testo: un valore che non si converte fa guastare la funzione, non il dato
    d = await creaDbAnno({ sediPrimaDellaMigrazione: [S1],
      codaPrima: SCHEMA_PR2.replace('quota_anno integer', 'quota_anno text') })
    await creaAnniFissi(d, [S1])
    await applicaPr2(d, 'M1')
  }, 60_000)
  afterAll(async () => { await d.close() })

  const scrivi = () => d.query<{ anno_id: string | null }>(
    `INSERT INTO public.crm_bambini (scuola_id, anno_ingresso, quota_anno) VALUES ($1, 'prossimo', 'non-un-anno') RETURNING anno_id`, [S1])

  it('in morbido la scrittura passa con anno_id NULL e lascia una riga in app_log (senza valori)', async () => {
    await rigidi(false, d)
    expect((await scrivi()).rows[0].anno_id).toBeNull()
    const log = (await d.query<{ livello: string; fingerprint: string; contesto: Record<string, unknown> }>(
      `SELECT livello, fingerprint, contesto FROM public.app_log WHERE fingerprint LIKE 'db:anno-transitorio:%'`)).rows
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ livello: 'error', fingerprint: 'db:anno-transitorio:crm_bambini' })
    expect(log[0].contesto).toMatchObject({ tabella: 'crm_bambini', sqlstate: '22P02' })
    expect(JSON.stringify(log[0])).not.toContain('non-un-anno')
  })

  it('in rigido lo stesso guasto solleva (la rete è solo del ramo morbido)', async () => {
    await rigidi(true, d)
    await expect(scrivi()).rejects.toMatchObject({ code: '22P02' })
  })
})

describe('l\'interruttore anno_scolastico.riempimento', () => {
  async function righeSenzaAnno(): Promise<string> {
    await transitorio(false)
    const r = await domanda(S1)
    await transitorio(true)
    expect(r.anno_id).toBeNull()
    return r.id
  }
  const leggi = (id: string) => db.query<{ v: number; u: string; a: string | null }>(
    `SELECT storico_versione AS v, updated_at::text AS u, anno_id AS a FROM public.enrollment_submissions WHERE id = $1`, [id])

  it('acceso: il riempimento assegna l\'anno e lascia storico_versione e updated_at com\'erano', async () => {
    const id = await righeSenzaAnno()
    const prima = (await leggi(id)).rows[0]
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('anno_scolastico.riempimento', 'on', true)`)
      await tx.query(`UPDATE public.enrollment_submissions SET anno_id = anno_id WHERE id = $1 AND anno_id IS NULL`, [id])
    })
    const dopo = (await leggi(id)).rows[0]
    expect(dopo.a).toBe(A2627)
    expect(dopo.v).toBe(prima.v)
    expect(dopo.u).toBe(prima.u)
  })

  it('spento (controllo): lo stesso UPDATE muove storico_versione e updated_at', async () => {
    const id = await righeSenzaAnno()
    const prima = (await leggi(id)).rows[0]
    await db.query(`UPDATE public.enrollment_submissions SET anno_id = anno_id WHERE id = $1 AND anno_id IS NULL`, [id])
    const dopo = (await leggi(id)).rows[0]
    expect(dopo.a).toBe(A2627)
    expect(dopo.v).toBe(prima.v + 1)
    expect(dopo.u).not.toBe(prima.u)
  })

  it('vale solo per la transazione e solo sul ramo «anno mancante»: un UPDATE normale muove la versione anche con l\'interruttore acceso', async () => {
    const id = (await domanda(S1)).id
    const prima = (await leggi(id)).rows[0]
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('anno_scolastico.riempimento', 'on', true)`)
      await tx.query(`UPDATE public.enrollment_submissions SET status = 'letta' WHERE id = $1`, [id])
    })
    expect((await leggi(id)).rows[0].v).toBe(prima.v + 1)
    expect(await una<string | null>(`SELECT current_setting('anno_scolastico.riempimento', true)`)).not.toBe('on')
  })
})

describe('anni_sede_crea_successivo', () => {
  let d: PGlite
  const SA = '22222222-2222-4222-8222-2222222222a1'
  const SB = '22222222-2222-4222-8222-2222222222b2'
  beforeAll(async () => {
    d = await creaDbAnno({ sediPrimaDellaMigrazione: [SA, SB] })
    await creaAnniFissi(d, [SA, SB])
    await applicaPr2(d, 'M1')
  }, 60_000)
  afterAll(async () => { await d.close() })

  const crea = (sede: string, oggi: string) =>
    una<number>(`SELECT public.anni_sede_crea_successivo($1, $2::date)`, [sede, oggi], d)
  const anni = async (sede: string) => (await d.query<{ anno: number; inizio: string; fine: string; stato: string; ult: string; prep: string }>(
    `SELECT y.anno_inizio AS anno, s.inizio::text AS inizio, s.fine::text AS fine, s.stato, s.ultimo_giorno_aperto::text AS ult,
            s.prepara_successivo_dal::text AS prep
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1 ORDER BY s.inizio`, [sede])).rows

  it('prima di prepara_successivo_dal non crea niente', async () => {
    expect(await crea(SA, '2026-08-31')).toBe(0)
    expect(await anni(SA)).toHaveLength(2)
  })

  it('crea il 2027/28 con le date dell\'anno prima, in_preparazione, con la riga di stato; due chiamate = un anno solo', async () => {
    const attivoPrima = await una<string>(`SELECT public.anno_attivo($1)`, [SA], d)
    expect(await crea(SA, '2026-11-06')).toBe(1)
    expect(await crea(SA, '2026-11-06')).toBe(0)
    const a = await anni(SA)
    expect(a).toHaveLength(3)
    expect(a[2]).toEqual({ anno: 2027, inizio: '2027-09-01', fine: '2028-08-31', stato: 'in_preparazione',
                           ult: '2028-07-31', prep: '2027-09-01' })
    expect(await una<number>(
      `SELECT count(*)::int FROM public.anni_sede_stati st JOIN public.anni_sede s ON s.id = st.anno_sede_id
        JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2027`, [SA], d)).toBe(1)
    expect(await una<string>(`SELECT public.anno_attivo($1)`, [SA], d)).toBe(attivoPrima)
  })

  it('una sede con il confine spostato al 25/08 → il nuovo anno inizia il 26/08 e finisce il 25/08 dopo', async () => {
    await d.query(`UPDATE public.anni_sede SET fine = DATE '2027-08-25'
                    WHERE scuola_id = $1 AND anno_id = (SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026)`, [SB])
    expect(await crea(SB, '2026-11-06')).toBe(1)
    const a = await anni(SB)
    expect(a[2]).toMatchObject({ anno: 2027, inizio: '2027-08-26', fine: '2028-08-25', stato: 'in_preparazione' })
  })

  it('anno_invarianti() resta a zero: il calendario è continuo', async () => {
    expect(await una<string>(`SELECT coalesce(sum(righe), 0)::text FROM public.anno_invarianti()`, [], d)).toBe('0')
  })
})

describe('sicurezza delle funzioni nuove', () => {
  for (const f of ['anno_dichiarato_transitorio(text, jsonb)', 'anni_sede_crea_successivo(uuid, date)',
                   'crm_bambini_anno_da_etichetta()']) {
    it(`${f}: SECURITY DEFINER, search_path fisso, EXECUTE solo a service_role`, async () => {
      const r = (await db.query<{ definer: boolean; cfg: string[] | null; anon: boolean; auth: boolean; svc: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS cfg,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.${f}')`)).rows[0]
      expect(r.definer).toBe(true)
      expect(r.cfg?.join(',')).toContain('search_path=public, pg_temp')
      expect([r.anon, r.auth, r.svc]).toEqual([false, false, true])
    })
  }

  it('il trigger delle etichette del CRM sta prima di trg_zz_anno_assegna_e_verifica (ordine alfabetico)', async () => {
    const t = (await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.crm_bambini'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map((x) => x.tgname)
    expect(t).toEqual(['trg_crm_bambini_anno_da_etichetta', 'trg_zz_anno_assegna_e_verifica'])
  })
})

describe('2.3 · i casi di segue_data e del riempimento che mancavano, e il CRM rigido', () => {
  it('segue_data con la scadenza prima NULL: non solleva e l\'anno resta valido', async () => {
    for (const r of [false, true]) {
      await rigidi(r)
      await db.query(`ALTER TABLE public.pagamenti ALTER COLUMN scadenza DROP NOT NULL`)
      try {
        const v = await pag({ scadenza: '2026-08-31', anno: A2526 })
        await db.query(`UPDATE public.pagamenti SET scadenza = NULL WHERE id = $1`, [v.id])
        // la scadenza sparisce: si ricade sulla data di creazione (oggi, 2026/27) e l'anno la segue
        expect(await annoDellaVoce(v.id)).toBe(A2627)
        // OLD.scadenza NULL: nessuna eccezione, si parte dalla data di creazione; l'anno resta valido
        await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-09-02' WHERE id = $1`, [v.id])
        expect(await annoDellaVoce(v.id)).toBe(A2627)
      } finally {
        await db.query(`DELETE FROM public.pagamenti WHERE scadenza IS NULL`)
        await db.query(`ALTER TABLE public.pagamenti ALTER COLUMN scadenza SET NOT NULL`)
      }
    }
  })

  it('la rete morbida di segue_data: un guasto lascia passare la scrittura e scrive la riga in app_log', async () => {
    await rigidi(false)
    const v = await pag({ scadenza: '2026-08-31' })
    await db.query(`ALTER FUNCTION public.anno_di(uuid, date) RENAME TO anno_di_guasta`)
    try {
      await db.query(`UPDATE public.pagamenti SET scadenza = DATE '2026-09-01' WHERE id = $1`, [v.id])
    } finally {
      await db.query(`ALTER FUNCTION public.anno_di_guasta(uuid, date) RENAME TO anno_di`)
    }
    expect(await annoDellaVoce(v.id)).toBe(A2526)
    const n = await una<string>(`SELECT count(*)::text FROM public.app_log WHERE fingerprint LIKE 'db:anno-segue-data:pagamenti%'`)
    expect(Number(n)).toBeGreaterThanOrEqual(1)
  })

  it('anno_riempi con guardia_attiva = true: RIEMPIMENTO_A_GUARDIA_ATTIVA e nessuna riga cambia', async () => {
    await rigidi(false)
    const prima = await una<string>(`SELECT count(*)::text FROM public.pagamenti WHERE anno_id IS NULL`)
    await db.query(`UPDATE public.anno_regole SET guardia_attiva = true`)
    try {
      expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('RIEMPIMENTO_A_GUARDIA_ATTIVA')
    } finally {
      await db.query(`UPDATE public.anno_regole SET guardia_attiva = false`)
    }
    expect(await una<string>(`SELECT count(*)::text FROM public.pagamenti WHERE anno_id IS NULL`)).toBe(prima)
  })

  it('CRM: il trigger delle etichette rispetta anno_tabelle.rigida (errore anche a controlli_rigidi spenti)', async () => {
    await rigidi(false)
    await db.query(`UPDATE public.anno_tabelle SET rigida = true WHERE tabella = 'crm_bambini'`)
    try {
      expect(await messaggio(crm({ etichetta: 'prossimo', quota: 2035 }))).toBe('ANNO_NON_COERENTE')
    } finally {
      await db.query(`UPDATE public.anno_tabelle SET rigida = false WHERE tabella = 'crm_bambini'`)
    }
    expect((await crm({ etichetta: 'prossimo', quota: 2035 })).anno_id).toBeNull()
  })
})
