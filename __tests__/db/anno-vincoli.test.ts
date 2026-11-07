import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.3 · I VINCOLI (V1, V2): `NOT NULL`, controlli rigidi, atomicità.
 *
 * Si applica M1 → F1 → V1 → V2 su un seme che nasce COME OGGI (righe senza `anno_id`, scritte a trigger spento).
 * Date FISSE (2025/26-2027/28) con `creaAnniFissi`: nessun test dipende da oggi. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const TRIGGER = 'trg_zz_anno_assegna_e_verifica'

/** `form_submissions` nasce senza `scuola_id` da `send-otp` (src/app/api/forms/send-otp/route.ts:509-517). */
const FORM_SUBMISSIONS = `
  CREATE TABLE public.form_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    signed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`

let db: PGlite
let A2526: string
let A2627: string
let SEZ27: string
let SEZ26: string
let P_VECCHIA: string
const dbDaChiudere: PGlite[] = []

async function una<T>(sql: string, params: unknown[] = [], d: PGlite = db): Promise<T> {
  const r = await d.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il codice dell'errore: quello nostro (il messaggio è il codice) o lo SQLSTATE di Postgres. */
async function codice(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    const x = e as { code?: string; message?: string }
    return /^[A-Z_]+$/.test(x.message ?? '') ? x.message! : (x.code ?? x.message ?? 'senza-codice')
  }
  return 'nessun-errore'
}
async function senzaTrigger<T>(tabella: string, f: () => Promise<T>, d: PGlite = db): Promise<T> {
  await d.exec(`ALTER TABLE public.${tabella} DISABLE TRIGGER ${TRIGGER}`)
  try { return await f() } finally { await d.exec(`ALTER TABLE public.${tabella} ENABLE TRIGGER ${TRIGGER}`) }
}
async function nuovoDb(o: Parameters<typeof creaDbAnnoPr2>[0]): Promise<PGlite> {
  const d = await creaDbAnnoPr2(o)
  dbDaChiudere.push(d)
  return d
}
async function presenza(d: PGlite, data: string, o: { sezione?: string | null; anno?: string | null; sede?: string } = {}) {
  return una<string>(
    `INSERT INTO public.presenze (scuola_id, section_id, data, anno_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [o.sede ?? S1, o.sezione ?? null, data, o.anno ?? null], d)
}

beforeAll(async () => {
  db = await nuovoDb({
    sedi: [S1, S2], fino: 'V2', completo: true, codaPrima: FORM_SUBMISSIONS,
    // il seme di OGGI: righe SENZA anno (scritte a trigger spento) e una riga vecchia in contrasto
    dopoM1: async (d) => {
      A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`, [], d)
      A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`, [], d)
      SEZ27 = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1], d)
      SEZ26 = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Vecchia', $2) RETURNING id`, [S1, A2526], d)
      // la presenza di luglio 2026 (anno 2025/26) con una sezione del 2026/27: come le 194 righe vecchie di produzione
      P_VECCHIA = await presenza(d, '2026-07-10', { sezione: SEZ27 })
      await senzaTrigger('presenze', async () => {
        await presenza(d, '2026-10-05', { sezione: SEZ27 })
      }, d)
      await senzaTrigger('avvisi', async () => {
        await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, DATE '2026-10-05')`, [S1])
        await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES (NULL, DATE '2026-10-05')`)
      }, d)
      // il rapporto distingue le righe «nuove» dall'istante della fotografia `prima` (F1): fra il seme e F1 passa del tempo
      await new Promise((r) => setTimeout(r, 30))
    },
  })
}, 120_000)
afterAll(async () => { for (const d of dbDaChiudere) await d.close() })

describe('dopo V2: NOT NULL dove la sede è garantita, CHECK dove è facoltativa', () => {
  it('INSERT in presenze senza anno_id funziona (lo mette il trigger)', async () => {
    const id = await presenza(db, '2026-10-06')
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id])).toBe(A2627)
  })

  it('UPDATE presenze SET anno_id = NULL → 23502 (col trigger spento: con il trigger acceso la riga si riallinea da sola)', async () => {
    const id = await presenza(db, '2026-10-07')
    expect(await una<boolean>(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.presenze'::regclass AND attname = 'anno_id'`)).toBe(true)
    // con il trigger acceso, `anno_id = NULL` è un anno MANCANTE: il trigger lo ricalcola dalla data
    await db.query(`UPDATE public.presenze SET anno_id = NULL WHERE id = $1`, [id])
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id])).toBe(A2627)
    // senza il trigger resta solo il vincolo, ed è lui a dire di no
    const e = await senzaTrigger('presenze', () => codice(db.query(`UPDATE public.presenze SET anno_id = NULL WHERE id = $1`, [id])))
    expect(e).toBe('23502')
  })

  it('avvisi (sede facoltativa): senza sede passa senza anno; con la sede lo riceve; col trigger spento il CHECK dà 23514', async () => {
    const senza = await una<string | null>(
      `INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES (NULL, DATE '2026-10-05') RETURNING anno_id`)
    expect(senza).toBeNull()
    const con = await una<string | null>(
      `INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, DATE '2026-10-05') RETURNING anno_id`, [S1])
    expect(con).toBe(A2627)
    const e = await senzaTrigger('avvisi', () => codice(db.query(
      `UPDATE public.avvisi SET anno_id = NULL WHERE scuola_id IS NOT NULL AND giorno_competenza = DATE '2026-10-05'`)))
    expect(e).toBe('23514')
    // senza sede l'anno può mancare anche per il vincolo
    await senzaTrigger('avvisi', async () => {
      await db.query(`UPDATE public.avvisi SET anno_id = NULL WHERE scuola_id IS NULL`)
    })
    // la colonna resta nullable: è il CHECK a fare il lavoro
    expect(await una<boolean>(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.avvisi'::regclass AND attname = 'anno_id'`)).toBe(false)
  })

  it('form_submissions senza scuola_id (send-otp) passa a controlli rigidi con anno_id NULL; con la sede riceve l\'anno', async () => {
    expect(await una<boolean>(`SELECT controlli_rigidi FROM public.anno_regole`)).toBe(true)
    const senza = await una<string | null>(
      `INSERT INTO public.form_submissions (scuola_id, signed_at) VALUES (NULL, TIMESTAMPTZ '2026-10-05 10:00:00+00') RETURNING anno_id`)
    expect(senza).toBeNull()
    const con = await una<string | null>(
      `INSERT INTO public.form_submissions (scuola_id, signed_at) VALUES ($1, TIMESTAMPTZ '2026-10-05 10:00:00+00') RETURNING anno_id`, [S1])
    expect(con).toBe(A2627)
  })

  it('anno_righe_senza_anno_con_sede conta solo le righe con una sede (il predicato del CHECK)', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`ALTER TABLE public.avvisi DROP CONSTRAINT avvisi_anno_id_presente`)
      await senzaTrigger('avvisi', async () => {
        await db.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, DATE '2026-10-05')`, [S2])
      })
      const tutte = await una<number>(`SELECT public.anno_righe_senza_anno('avvisi')::int`)
      const conSede = await una<number>(`SELECT public.anno_righe_senza_anno_con_sede('avvisi')::int`)
      expect(tutte).toBeGreaterThan(conSede)
      expect(conSede).toBe(1)
    } finally { await db.exec('ROLLBACK') }
  })
})

describe('dopo V2: i controlli rigidi sono accesi e reggono', () => {
  it('controlli_rigidi = true e controlli_rigidi_dal valorizzato', async () => {
    const r = await db.query<{ r: boolean; d: string | null }>(`SELECT controlli_rigidi AS r, controlli_rigidi_dal::text AS d FROM public.anno_regole`)
    expect(r.rows[0].r).toBe(true)
    expect(r.rows[0].d).not.toBeNull()
  })

  it('ANNO_NON_COERENTE, GIORNO_SENZA_ANNO (data 2031), SEZIONE_DI_ALTRO_ANNO su una riga NUOVA', async () => {
    expect(await codice(presenza(db, '2026-10-08', { anno: A2526 }))).toBe('ANNO_NON_COERENTE')
    expect(await codice(presenza(db, '2031-01-10'))).toBe('GIORNO_SENZA_ANNO')
    expect(await codice(presenza(db, '2026-10-08', { sezione: SEZ26 }))).toBe('SEZIONE_DI_ALTRO_ANNO')
  })

  it('I-3: in una sede SENZA sezioni 2025/26 la rettifica estiva con la sezione di oggi passa e si conta; con una sezione 2025/26 è rifiutata', async () => {
    const sez = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Soli') RETURNING id`, [S2])
    expect(await una<string>(`SELECT anno_id FROM public.sections WHERE id = $1`, [sez])).toBe(A2627)
    const fp = 'db:anno-sezione-anno-senza-sezioni:presenze'
    const avvisi = () => una<number>(`SELECT coalesce(sum(occorrenze), 0)::int FROM public.app_log WHERE fingerprint = $1`, [fp])
    expect(await avvisi()).toBe(0)

    // (1) una presenza nuova di luglio 2026 (anno 2025/26) con la sezione 2026/27
    const id = await presenza(db, '2026-07-10', { sede: S2, sezione: sez })
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id])).toBe(A2526)
    expect(await avvisi()).toBe(1)
    const log = (await db.query<{ livello: string; contesto: Record<string, unknown> }>(
      `SELECT livello, contesto FROM public.app_log WHERE fingerprint = $1`, [fp])).rows[0]
    expect(log.livello).toBe('warn')
    expect(log.contesto).toMatchObject({ tabella: 'presenze', conteggio: 1 })

    // (3) l'upsert della presenza estiva (ON CONFLICT: il BEFORE INSERT gira sulla riga proposta)
    await db.exec(`CREATE UNIQUE INDEX zz_presenze_prova ON public.presenze (alunno_id, data)`)
    try {
      const al = '55555555-5555-4555-8555-555555555555'
      const up = () => db.query(
        `INSERT INTO public.presenze (scuola_id, section_id, alunno_id, data) VALUES ($1, $2, $3, DATE '2026-07-11')
         ON CONFLICT (alunno_id, data) DO UPDATE SET stato = 'presente'`, [S2, sez, al])
      await up()
      await up()
      expect(await una<number>(`SELECT count(*)::int FROM public.presenze WHERE alunno_id = $1`, [al])).toBe(1)
    } finally { await db.exec(`DROP INDEX public.zz_presenze_prova`) }

    // (4) l'invariante 9 non conta questi casi (né una riga scritta a trigger spento: guarda la funzione, non il trigger)
    await senzaTrigger('presenze', () => presenza(db, '2026-07-13', { sede: S2, sezione: sez, anno: A2526 }))
    expect(await una<number>(
      `SELECT righe::int FROM public.anno_invarianti() WHERE invariante = '9' AND tabella = 'presenze'`)).toBe(0)

    // (2) la stessa riga, ma la sede ha una sezione 2025/26: rifiutata, e ora l'invariante la conterebbe
    const vecchia = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Vecchia S2', $2) RETURNING id`, [S2, A2526])
    try {
      expect(await codice(presenza(db, '2026-07-12', { sede: S2, sezione: sez }))).toBe('SEZIONE_DI_ALTRO_ANNO')
      expect(await una<number>(`SELECT public.anno_righe_sezione_altro_anno('presenze')::int`)).toBeGreaterThan(0)
    } finally {
      // il DB è condiviso con gli altri test: via la sezione 2025/26 di S2 e le presenze estive
      await db.query(`DELETE FROM public.sections WHERE id = $1`, [vecchia])
      await db.query(`DELETE FROM public.presenze WHERE scuola_id = $1`, [S2])
      await db.query(`DELETE FROM public.sections WHERE id = $1`, [sez])
    }
  })

  it('la riga vecchia in contrasto (presenza di luglio con sezione 2026/27) si aggiorna ancora, e l\'invariante 9 non la conta', async () => {
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [P_VECCHIA])).toBe(A2526)
    await db.query(`UPDATE public.presenze SET stato = 'presente' WHERE id = $1`, [P_VECCHIA])
    expect(await una<string>(`SELECT stato FROM public.presenze WHERE id = $1`, [P_VECCHIA])).toBe('presente')
    expect(await una<number>(`SELECT righe::int FROM public.anno_invarianti() WHERE invariante = '9' AND tabella = 'presenze'`)).toBe(0)
  })

  it('le righe senza anno del seme sono state riempite (tranne l\'avviso senza sede)', async () => {
    expect(await una<number>(`SELECT count(*)::int FROM public.presenze WHERE anno_id IS NULL`)).toBe(0)
    expect(await una<number>(`SELECT count(*)::int FROM public.avvisi WHERE anno_id IS NULL AND scuola_id IS NOT NULL`)).toBe(0)
  })
})

describe('stragglers: le righe nate fra F1 e V2', () => {
  it('una riga senza anno (trigger spento nel seme) viene riempita dall\'anno_riempi() di V2', async () => {
    let id = ''
    const d = await nuovoDb({
      sedi: [S1], fino: 'V2', completo: true,
      dopoF1: async (x) => {
        await senzaTrigger('presenze', async () => { id = await presenza(x, '2026-10-05') }, x)
        expect(await una<string | null>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id], x)).toBeNull()
      },
    })
    const anno = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`, [], d)
    expect(await una<string>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [id], d)).toBe(anno)
    expect(await una<boolean>(`SELECT controlli_rigidi FROM public.anno_regole`, [], d)).toBe(true)
  })

  it('una riga NON riempibile (data 2031) fa fallire V2 con ANNO_RIEMPIMENTO_INCOMPLETO e niente cambia', async () => {
    let riempibile = ''
    const d = await nuovoDb({
      sedi: [S1], fino: 'V1', completo: true,
      dopoF1: async (x) => {
        await senzaTrigger('presenze', async () => {
          riempibile = await presenza(x, '2026-10-05')
          await presenza(x, '2031-01-10')
        }, x)
      },
    })
    expect(await codice(applicaPr2(d, 'V2'))).toBe('ANNO_RIEMPIMENTO_INCOMPLETO')
    // rollback completo
    expect(await una<boolean>(`SELECT controlli_rigidi FROM public.anno_regole`, [], d)).toBe(false)
    expect(await una<boolean>(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.presenze'::regclass AND attname = 'anno_id'`, [], d)).toBe(false)
    expect(await una<boolean>(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.presenze'::regclass AND conname = 'presenze_anno_id_presente'`, [], d)).toBe(false)
    expect(await una<boolean>(`SELECT to_regprocedure('public.anno_riempi(text[],date)') IS NOT NULL`, [], d)).toBe(true)
    // anche la riga riempibile è tornata com'era: l'anno_riempi() di V2 è stato annullato
    expect(await una<string | null>(`SELECT anno_id FROM public.presenze WHERE id = $1`, [riempibile], d)).toBeNull()
  })
})

describe('V2 rieseguita, CHECK doppi, funzioni', () => {
  async function istantanea(): Promise<string> {
    const v = await db.query<{ s: string }>(`
      SELECT (SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text, conname, convalidated) ORDER BY conrelid::regclass::text, conname)
                FROM pg_constraint WHERE connamespace = 'public'::regnamespace) ||
             (SELECT jsonb_agg(jsonb_build_array(attrelid::regclass::text, attnotnull) ORDER BY attrelid::regclass::text)
                FROM pg_attribute WHERE attname = 'anno_id' AND attnum > 0 AND NOT attisdropped
                  AND attrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r')) ||
             (SELECT jsonb_build_array(to_jsonb(r)) FROM public.anno_regole r) ||
             (SELECT jsonb_build_array(count(*)) FROM public.riconciliazione_anno) AS s`)
    return v.rows[0].s
  }

  it('V2 rieseguita: nessun errore, nessuna modifica', async () => {
    const prima = await istantanea()
    await applicaPr2(db, 'V2')
    await applicaPr2(db, 'V1')
    expect(await istantanea()).toEqual(prima)
  })

  it('nessun CHECK doppio: ne restano solo sulle tabelle con la sede facoltativa, e tutti convalidati', async () => {
    const r = await db.query<{ t: string; fac: boolean; nn: boolean; ok: boolean }>(`
      SELECT c.conrelid::regclass::text AS t, t.sede_facoltativa AS fac, a.attnotnull AS nn, c.convalidated AS ok
        FROM pg_constraint c
        JOIN public.anno_tabelle t ON t.tabella = c.conrelid::regclass::text
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'anno_id'
       WHERE c.conname = c.conrelid::regclass::text || '_anno_id_presente'`)
    expect(r.rows.length).toBeGreaterThan(0)
    for (const x of r.rows) expect({ t: x.t, fac: x.fac, nn: x.nn, ok: x.ok }).toEqual({ t: x.t, fac: true, nn: false, ok: true })
    // e ogni tabella del registro con `anno_id` ha o il NOT NULL o il CHECK
    const nude = await db.query<{ t: string }>(`
      SELECT t.tabella AS t FROM public.anno_tabelle t
        JOIN pg_attribute a ON a.attrelid = to_regclass(format('public.%I', t.tabella)) AND a.attname = 'anno_id' AND NOT a.attisdropped
       WHERE NOT a.attnotnull
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = a.attrelid AND c.conname = t.tabella || '_anno_id_presente')`)
    expect(nude.rows).toEqual([])
  })

  it('anno_riempi non esiste più; nessuna delle funzioni della PR 2 è chiamabile da anon o authenticated', async () => {
    expect(await una<boolean>(`SELECT to_regprocedure('public.anno_riempi(text[],date)') IS NULL`)).toBe(true)
    expect(await una<number>(`SELECT count(*)::int FROM pg_proc WHERE proname = 'anno_riempi'`)).toBe(0)
    const nomi = [
      'anni_sede_crea_successivo', 'anno_dichiarato_transitorio', 'crm_bambini_anno_da_etichetta', 'anno_assegna_e_verifica',
      'anno_sede_sql', 'anno_fotografa_scrivi', 'anno_fotografa', 'anno_riconciliazione_differenze', 'anno_invarianti',
      'anno_traduci_classi', 'anno_traduci_classi_trg', 'anno_copia_configurazione', 'alunni_specchio_frequenza',
      'anno_log_avviso', 'anno_target_divergenti', 'anno_righe_senza_anno_con_sede',
    ]
    const r = await db.query<{ proname: string; a: boolean; u: boolean; s: boolean }>(
      `SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS a,
              has_function_privilege('authenticated', oid, 'EXECUTE') AS u,
              has_function_privilege('service_role', oid, 'EXECUTE') AS s
         FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY ($1::text[])`, [nomi])
    expect(r.rows.map((x) => x.proname).sort()).toEqual([...nomi].sort())
    for (const x of r.rows) expect({ f: x.proname, anon: x.a, auth: x.u, svc: x.s }).toEqual({ f: x.proname, anon: false, auth: false, svc: true })
  })

  it('la fotografia finale c\'è nel rapporto, e le differenze prima → finale sono vuote', async () => {
    expect(await una<number>(`SELECT count(*)::int FROM public.riconciliazione_anno WHERE fase = 'finale'`)).toBeGreaterThan(0)
    const diff = await db.query(`SELECT * FROM public.anno_riconciliazione_differenze()`)
    expect(diff.rows).toEqual([])
  })
})
