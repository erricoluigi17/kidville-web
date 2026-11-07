import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-3 (d) · LE RPC DELL'OBLIO (migrazione M3), con la guardia ACCESA.
 *
 * `anno_oblio_scrivi` / `anno_oblio_svuota` accendono l'interruttore `anno_chiuso.oblio`, scrivono, lo spengono, e la
 * guardia lascia un gettone `oblio` per anno-sede con un uso per riga. L'allowlist è un `CASE` DENTRO la funzione.
 * Date fisse (2025/26 chiuso, 2026/27 corrente); solo uuid finti e testi inventati.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const ALTRO = '44444444-4444-4444-8444-444444444442'
const SEGNALE = 'TESTO-INVENTATO-DA-NON-LOGGARE'

/** Le colonne e le tabelle di oblio che lo schema di prova non ha: nascono PRIMA della migrazione. */
const CODA_PRIMA = `
  ALTER TABLE public.presenze ADD COLUMN giustificazione_testo text, ADD COLUMN note_appello text;
  ALTER TABLE public.presenze ADD CONSTRAINT presenze_alunno_fk FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) ON DELETE CASCADE;
  ALTER TABLE public.eventi_diario ADD COLUMN nota_bambino text, ADD COLUMN nota_libera text, ADD COLUMN dettagli jsonb;
  ALTER TABLE public.chat_messages ADD COLUMN attachment_url text, ADD COLUMN attachment_type text;
  ALTER TABLE public.galleria_media_v2 ADD COLUMN tag_students uuid[], ADD COLUMN file_rimosso_il timestamptz;
  ALTER TABLE public.enrollment_submissions ADD COLUMN consents_log jsonb;
  CREATE TABLE public.student_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, created_at timestamptz DEFAULT now());
  CREATE TABLE public.forms_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, created_at timestamptz DEFAULT now());
`

let db: PGlite
let A2526: string
let AS2526: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function dettaglio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return String((e as { detail?: string }).detail ?? '') }
  return ''
}
/** Il seme nasce a guardia spenta (si scrive in un anno chiuso, come i dati di prima); poi si accende. */
async function seme<T>(fn: () => Promise<T>): Promise<T> {
  await db.query(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = false`)
  try { return await fn() } finally {
    await db.query(`UPDATE public.anno_regole SET guardia_attiva = true, guardia_osserva = false`)
  }
}
const scrivi = (azione: string, tabella: string, colonna: string, valori: string[], set: unknown = null, op: string | null = 'test/oblio:POST') =>
  db.query<{ n: unknown }>(`SELECT public.anno_oblio_scrivi($1, $2, $3, $4::text[], $5::jsonb, $6) AS n`,
    [azione, tabella, colonna, valori, set === null ? null : JSON.stringify(set), op])

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3', completo: true, codaPrima: CODA_PRIMA })
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  AS2526 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [SEDE, A2526])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = false;
                 DELETE FROM public.frequenze; DELETE FROM public.presenze; DELETE FROM public.alunni;
                 DELETE FROM public.eventi_diario; DELETE FROM public.chat_messages; DELETE FROM public.chat_threads;
                 DELETE FROM public.galleria_media_v2; DELETE FROM public.enrollment_submissions;
                 DELETE FROM public.student_documents; DELETE FROM public.forms_submissions;
                 DELETE FROM public.correzioni_anno_chiuso_usi; DELETE FROM public.correzioni_anno_chiuso;
                 DELETE FROM public.app_log; DELETE FROM public.anno_guardia_osservazioni;
                 UPDATE public.anni_sede SET stato = 'chiuso' WHERE anno_id = '${A2526}';
                 UPDATE public.anno_regole SET guardia_attiva = true, guardia_osserva = false`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $3), ($2, $3)`, [ALUNNO, ALTRO, SEDE])
})

async function tre_presenze(): Promise<string[]> {
  return seme(async () => {
    const ids: string[] = []
    for (const g of ['2026-03-10', '2026-03-11', '2026-08-31']) {
      ids.push(await una<string>(
        `INSERT INTO public.presenze (alunno_id, scuola_id, data, giustificazione_testo, note_appello)
         VALUES ($1, $2, $3, $4, 'nota') RETURNING id`, [ALUNNO, SEDE, g, SEGNALE]))
    }
    return ids
  })
}

describe('3.3-3 (d) · anno_oblio_scrivi con la guardia accesa', () => {
  it('scrive N righe di un anno chiuso, lascia UN gettone `oblio` con N usi, e a fine chiamata l\'interruttore è `off`', async () => {
    await tre_presenze()
    await db.exec('BEGIN')
    let dopo: string
    let n: string
    try {
      n = (await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { giustificazione_testo: null, note_appello: null })).rows[0]
        ? String((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.presenze WHERE giustificazione_testo IS NULL`)).rows[0].n)
        : '?'
      dopo = await una<string>(`SELECT current_setting('anno_chiuso.oblio', true)`)
      await db.exec('COMMIT')
    } catch (e) { await db.exec('ROLLBACK'); throw e }
    expect(n).toBe('3')
    expect(dopo).toBe('off')
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE giustificazione_testo IS NOT NULL OR note_appello IS NOT NULL`)).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso WHERE codice = 'oblio' AND anno_sede_id = $1`, [AS2526])).toBe('1')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso_usi u JOIN public.correzioni_anno_chiuso c ON c.id = u.correzione_id
                               WHERE c.codice = 'oblio' AND u.tabella = 'presenze'`)).toBe('3')
  })

  it('restituisce il numero di righe cambiate, e solo di quelle che avevano il dato', async () => {
    await tre_presenze()
    const set = { giustificazione_testo: null, note_appello: null }
    expect(String((await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], set)).rows[0].n)).toBe('3')
    expect(String((await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], set)).rows[0].n)).toBe('0')
  })

  it('la stessa UPDATE scritta a mano, senza RPC → ANNO_CHIUSO (non è cieco); l\'interruttore dopo la chiamata è spento', async () => {
    await tre_presenze()
    expect(await messaggio(db.query(`UPDATE public.presenze SET giustificazione_testo = NULL, note_appello = NULL WHERE alunno_id = $1`, [ALUNNO])))
      .toBe('ANNO_CHIUSO')
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE giustificazione_testo IS NOT NULL`)).toBe('3')
  })

  it('nel riepilogo di `app_log` ci sono solo { tabella, azione, righe, op }: mai i valori del filtro né il `set`', async () => {
    await tre_presenze()
    await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { giustificazione_testo: null, note_appello: null })
    const righe = (await db.query<{ contesto: Record<string, unknown> }>(
      `SELECT contesto FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)).rows
    expect(righe).toHaveLength(1)
    expect(righe[0].contesto).toEqual({ esito: 'oblio-eseguito', tabella: 'presenze', azione: 'update', righe: 3, op: 'test/oblio:POST' })
    const tutto = JSON.stringify((await db.query(`SELECT livello, evento, messaggio, contesto FROM public.app_log`)).rows)
    expect(tutto).not.toContain(ALUNNO)
    expect(tutto).not.toContain(SEGNALE)
    expect(tutto).not.toContain('giustificazione_testo')
    expect(await una<string>(`SELECT livello FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)).toBe('info')
    expect(await una<string>(`SELECT evento FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)).toBe('anno-scolastico')
  })

  it('`op` non valida o mancante non finisce in chiaro nel riepilogo', async () => {
    await tre_presenze()
    await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { note_appello: null }, 'testo libero con spazi')
    await seme(async () => db.query(`UPDATE public.presenze SET note_appello = 'x'`))
    await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { note_appello: null }, null)
    const ops = (await db.query<{ op: string }>(`SELECT contesto ->> 'op' AS op FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)).rows.map((r) => r.op)
    expect(ops.sort()).toEqual(['op-assente', 'op-non-valida'])
  })

  it('P25 · in osservazione (`guardia_attiva = false`) l\'interruttore non scrive gettoni né usi né contatori', async () => {
    await tre_presenze()
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = true`)
    expect(String((await scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { giustificazione_testo: null, note_appello: null })).rows[0].n)).toBe('3')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso`)).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso_usi`)).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.anno_guardia_osservazioni`)).toBe('0')
    // ... ma il riepilogo c'è (Ruling P24)
    expect(await una<string>(`SELECT count(*)::text FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)).toBe('1')
  })
})

describe('3.3-3 (d) · l\'allowlist dentro la funzione', () => {
  const SET_AMMESSI: Array<[string, string, string, Record<string, unknown> | null]> = [
    ['update', 'chat_messages', 'id', { attachment_url: null, attachment_type: null }],
    ['update', 'enrollment_submissions', 'id', { data: {}, updated_at: '2026-11-07T10:00:00Z', consents_log: [] }],
    ['delete', 'enrollment_submissions', 'id', null],
    ['update', 'galleria_media_v2', 'id', { tag_students: [] }],
    ['update', 'galleria_media_v2', 'id', { file_rimosso_il: '2026-11-07T10:00:00Z' }],
    ['delete', 'galleria_media_v2', 'id', null],
    ['update', 'eventi_diario', 'alunno_id', { nota_bambino: null, nota_libera: null }],
    ['update', 'eventi_diario', 'alunno_id', { nota_libera: null }],
    ['update', 'eventi_diario', 'id', { dettagli: { risposta: 'testo', valore: null } }],
    ['update', 'presenze', 'alunno_id', { giustificazione_testo: null, note_appello: null }],
    ['delete', 'student_documents', 'id', null],
    ['delete', 'forms_submissions', 'id', null],
  ]
  for (const [azione, tabella, colonna, set] of SET_AMMESSI) {
    it(`ammessa: ${azione} ${tabella} per ${colonna}${set ? ` {${Object.keys(set).join(', ')}}` : ''}`, async () => {
      // elenco vuoto: la funzione valida la coppia (e il `set`) e non scrive niente → 0, mai OBLIO_NON_AMMESSO
      const r = await scrivi(azione, tabella, colonna, [], set)
      expect(String(r.rows[0].n)).toBe('0')
    })
  }

  const NON_AMMESSI: Array<[string, string, string, string, unknown]> = [
    ['presenze con la colonna `note`', 'update', 'presenze', 'alunno_id', { note: null }],
    ['`utenti`', 'update', 'utenti', 'id', { nome: null }],
    ['update su `pagamenti`', 'update', 'pagamenti', 'id', { stato: 'x' }],
    ['delete su `pagamenti`', 'delete', 'pagamenti', 'id', null],
    ['delete su `presenze`', 'delete', 'presenze', 'alunno_id', null],
    ['una colonna di filtro non ammessa (presenze per `id`)', 'update', 'presenze', 'id', { note_appello: null }],
    ['una colonna di filtro non ammessa (eventi_diario per `scuola_id`)', 'update', 'eventi_diario', 'scuola_id', { nota_libera: null }],
    ['un set con una chiave non ammessa insieme a una ammessa', 'update', 'presenze', 'alunno_id', { note_appello: null, data: '2026-01-01' }],
    ['`dettagli` filtrato per alunno', 'update', 'eventi_diario', 'alunno_id', { dettagli: {} }],
    ['un update senza `set`', 'update', 'presenze', 'alunno_id', null],
    ['un update con un `set` vuoto', 'update', 'presenze', 'alunno_id', {}],
    ['una delete con un `set`', 'delete', 'forms_submissions', 'id', { x: 1 }],
    ['pagelle (nessun sito di oblio le cancella)', 'delete', 'pagelle', 'id', null],
    ['un\'azione inventata', 'truncate', 'presenze', 'alunno_id', null],
  ]
  for (const [nome, azione, tabella, colonna, set] of NON_AMMESSI) {
    it(`non ammessa → OBLIO_NON_AMMESSO: ${nome}`, async () => {
      expect(await messaggio(scrivi(azione, tabella, colonna, [ALUNNO], set))).toBe('OBLIO_NON_AMMESSO')
    })
  }

  it('l\'errore dice solo azione e tabella: mai i valori del filtro', async () => {
    const d = await dettaglio(scrivi('update', 'utenti', 'id', [ALUNNO], { nome: SEGNALE }))
    expect(JSON.parse(d)).toEqual({ azione: 'update', tabella: 'utenti' })
    expect(d).not.toContain(ALUNNO)
    expect(d).not.toContain(SEGNALE)
  })

  it('un valore del filtro che non è un uuid fa fallire la chiamata e non lascia l\'interruttore acceso', async () => {
    await db.exec('BEGIN')
    let dopo = ''
    try {
      await db.exec('SAVEPOINT s')
      expect(await messaggio(scrivi('update', 'presenze', 'alunno_id', ['non-un-uuid'], { note_appello: null }))).toMatch(/uuid/)
      await db.exec('ROLLBACK TO s')
      dopo = await una<string>(`SELECT coalesce(current_setting('anno_chiuso.oblio', true), '')`)
      await db.exec('COMMIT')
    } catch (e) { await db.exec('ROLLBACK'); throw e }
    expect(dopo).not.toBe('on')
  })

  it('scrive davvero sulle altre coppie, anche su righe di un anno chiuso (diario, chat, galleria, domanda, fascicolo, moduli)', async () => {
    const t = await seme(async () => {
      await db.query(`INSERT INTO public.eventi_diario (alunno_id, orario_inizio, nota_bambino, nota_libera)
                      VALUES ($1, TIMESTAMPTZ '2026-03-10 10:00:00+01', $2, $2)`, [ALUNNO, SEGNALE])
      const th = await una<string>(`INSERT INTO public.chat_threads (student_id) VALUES ($1) RETURNING id`, [ALUNNO])
      const m = await una<string>(`INSERT INTO public.chat_messages (thread_id, created_at, attachment_url, attachment_type)
                                   VALUES ($1, TIMESTAMPTZ '2026-03-10 10:00:00+01', 'u', 'image') RETURNING id`, [th])
      const g = await una<string>(`INSERT INTO public.galleria_media_v2 (scuola_id, giorno_competenza, tag_students)
                                   VALUES ($1, DATE '2026-03-10', ARRAY[$2::uuid]) RETURNING id`, [SEDE, ALUNNO])
      const e = await una<string>(`INSERT INTO public.enrollment_submissions (scuola_id, data, created_at)
                                   VALUES ($1, '{"x":1}', TIMESTAMPTZ '2026-03-10 10:00:00+01') RETURNING id`, [SEDE])
      const d = await una<string>(`INSERT INTO public.student_documents (student_id) VALUES ($1) RETURNING id`, [ALUNNO])
      const f = await una<string>(`INSERT INTO public.forms_submissions (student_id) VALUES ($1) RETURNING id`, [ALUNNO])
      return { m, g, e, d, f }
    })
    const n = async (r: Promise<{ rows: Array<{ n: unknown }> }>) => String((await r).rows[0].n)
    expect(await n(scrivi('update', 'eventi_diario', 'alunno_id', [ALUNNO], { nota_bambino: null, nota_libera: null }))).toBe('1')
    expect(await una<string>(`SELECT coalesce(nota_bambino, 'NULL') FROM public.eventi_diario`)).toBe('NULL')
    expect(await n(scrivi('update', 'chat_messages', 'id', [t.m], { attachment_url: null, attachment_type: null }))).toBe('1')
    expect(await una<string>(`SELECT coalesce(attachment_url, 'NULL') FROM public.chat_messages`)).toBe('NULL')
    expect(await n(scrivi('update', 'galleria_media_v2', 'id', [t.g], { tag_students: [] }))).toBe('1')
    expect(await una<string>(`SELECT cardinality(tag_students)::text FROM public.galleria_media_v2`)).toBe('0')
    expect(await n(scrivi('update', 'enrollment_submissions', 'id', [t.e], { data: { x: 2 }, updated_at: '2026-11-07T10:00:00Z' }))).toBe('1')
    expect(await una<string>(`SELECT data ->> 'x' FROM public.enrollment_submissions`)).toBe('2')
    expect(await n(scrivi('delete', 'enrollment_submissions', 'id', [t.e]))).toBe('1')
    expect(await n(scrivi('delete', 'galleria_media_v2', 'id', [t.g]))).toBe('1')
    expect(await n(scrivi('delete', 'student_documents', 'id', [t.d]))).toBe('1')
    expect(await n(scrivi('delete', 'forms_submissions', 'id', [t.f]))).toBe('1')
    expect(await una<string>(`SELECT count(*)::text FROM public.enrollment_submissions`)).toBe('0')
  })
})

describe('3.3-3 (d) · anno_oblio_svuota', () => {
  const ELENCO = [
    'student_parents', 'legame_genitori_alunni', 'student_adults', 'delegates', 'delegati', 'student_documents',
    'educator_sections', 'eventi_diario', 'valutazioni', 'galleria_media', 'armadietto', 'locker_inventory',
    'locker_requests', 'locker_loads', 'ticket_mensa', 'pagamenti', 'registro_modifiche', 'firme_documenti',
    'daily_routines', 'presenze', 'firme_docenti', 'registro_orario', 'note_disciplinari', 'alunni', 'parents', 'adults',
  ]
  it('l\'elenco del wipe è 23 tabelle più `alunni`, `parents` e `adults`', () => {
    expect(ELENCO).toHaveLength(26)
  })
  it('ammette ognuno dei 26 nomi (una tabella che non c\'è vale 0 righe)', async () => {
    // le tabelle con righe del seme sono svuotate da altri test: qui basta che la funzione NON rifiuti il nome
    await db.exec('DELETE FROM public.frequenze; DELETE FROM public.presenze; DELETE FROM public.alunni')
    for (const t of ELENCO.filter((x) => !['alunni', 'presenze'].includes(x))) {
      expect(await messaggio(db.query(`SELECT public.anno_oblio_svuota($1, 'admin/wipe:POST')`, [t]))).not.toBe('OBLIO_NON_AMMESSO')
    }
  })
  it('una tabella fuori elenco → OBLIO_NON_AMMESSO, e nessuna riga sparisce', async () => {
    for (const t of ['utenti', 'schools', 'app_log', 'anni_sede', 'enrollment_submissions', 'chat_messages', '']) {
      expect(await messaggio(db.query(`SELECT public.anno_oblio_svuota($1)`, [t]))).toBe('OBLIO_NON_AMMESSO')
    }
    expect(await messaggio(db.query(`SELECT public.anno_oblio_svuota(NULL)`))).toBe('OBLIO_NON_AMMESSO')
  })
  it('svuota davvero una tabella con righe di un anno chiuso e scrive il riepilogo', async () => {
    await tre_presenze()
    expect(String((await db.query<{ n: string }>(`SELECT public.anno_oblio_svuota('presenze', 'admin/wipe:POST') AS n`)).rows[0].n)).toBe('3')
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze`)).toBe('0')
    const c = await una<Record<string, unknown>>(`SELECT contesto FROM public.app_log WHERE contesto ->> 'esito' = 'oblio-eseguito'`)
    expect(c).toEqual({ esito: 'oblio-eseguito', tabella: 'presenze', azione: 'svuota', righe: 3, op: 'admin/wipe:POST' })
    // a mano, la stessa DELETE è rifiutata
    await tre_presenze()
    expect(await messaggio(db.query(`DELETE FROM public.presenze`))).toBe('ANNO_CHIUSO')
  })
})

describe('3.3-3 (d) · la cascade di `DELETE FROM alunni`', () => {
  async function conFigli() {
    await seme(async () => {
      await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, DATE '2026-03-10'), ($1, $2, DATE '2026-03-11')`, [ALUNNO, SEDE])
      await db.query(`INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso)
                      VALUES ($1, $2, 'conferma', 'segreteria', DATE '2025-10-01')`, [ALUNNO, AS2526])
    })
  }
  it('dentro `anno_oblio_attiva()` … `anno_oblio_spegni()` passa e le figlie spariscono', async () => {
    await conFigli()
    await db.exec('BEGIN')
    try {
      await db.query(`SELECT public.anno_oblio_attiva()`)
      await db.query(`DELETE FROM public.alunni WHERE id = $1`, [ALUNNO])
      await db.query(`SELECT public.anno_oblio_spegni()`)
      expect(await una<string>(`SELECT current_setting('anno_chiuso.oblio', true)`)).toBe('off')
      await db.exec('COMMIT')
    } catch (e) { await db.exec('ROLLBACK'); throw e }
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE alunno_id = $1`, [ALUNNO])).toBe('0')
    expect(await una<string>(`SELECT count(*)::text FROM public.frequenze WHERE alunno_id = $1`, [ALUNNO])).toBe('0')
  })
  it('senza l\'interruttore → ANNO_CHIUSO: la cascade non butta via dati in silenzio', async () => {
    await conFigli()
    expect(await messaggio(db.query(`DELETE FROM public.alunni WHERE id = $1`, [ALUNNO]))).toBe('ANNO_CHIUSO')
    expect(await una<string>(`SELECT count(*)::text FROM public.presenze WHERE alunno_id = $1`, [ALUNNO])).toBe('2')
  })
})

describe('3.3-3 · GRANT/REVOKE: nessuna funzione nuova di M3 è eseguibile da `authenticated`', () => {
  const NUOVE: Array<[string, string]> = [
    ['anno_oblio_attiva', ''], ['anno_oblio_spegni', ''],
    ['anno_oblio_riepilogo', 'text, text, bigint, text'],
    ['anno_oblio_scrivi', 'text, text, text, text[], jsonb, text'],
    ['anno_oblio_svuota', 'text, text'],
    ['anno_guardia_verifica', 'public.anno_tabelle, text, jsonb, jsonb, uuid, boolean'],
    ['anno_guardia_osserva_conta', 'text, text, text'],
    ['anno_guardia_osserva_sicura', 'public.anno_tabelle, text, jsonb, jsonb, uuid'],
    ['anno_log_uso_gettone', 'uuid, text, text, text'],
    ['anno_origine_richiesta', ''], ['anno_transitorio_conta', 'text'],
    ['anno_colonne_esenti', 'text'], ['anno_assegna_e_verifica', ''], ['anno_invarianti', ''],
  ]
  for (const [nome, args] of NUOVE) {
    it(`${nome}(${args}): service_role sì, authenticated/anon/PUBLIC no`, async () => {
      const f = `public.${nome}(${args})`
      const r = await db.query<{ a: boolean; n: boolean; s: boolean }>(
        `SELECT has_function_privilege('authenticated', '${f}', 'EXECUTE') AS a,
                has_function_privilege('anon', '${f}', 'EXECUTE') AS n,
                has_function_privilege('service_role', '${f}', 'EXECUTE') AS s`)
      expect(r.rows[0]).toEqual({ a: false, n: false, s: true })
    })
  }
  it('il freno di `execute_sql` non vede una `SELECT public.f()`: per questo l\'allowlist sta nella funzione', async () => {
    // `authenticated` non può chiamarla; e nemmeno una funzione di oblio inesistente passa dall'allowlist
    expect(await messaggio(scrivi('update', 'presenze', 'alunno_id', [ALUNNO], { stato: 'x' }))).toBe('OBLIO_NON_AMMESSO')
  })
})

describe('3.3-3 (ii) · le tre funzioni di oblio ridefinite da M3 (sul TESTO: in PGlite non esistono)', () => {
  const MIGRAZIONI = path.resolve(__dirname, '../../supabase/migrations')
  const leggi = (suffisso: string) => {
    const f = fs.readdirSync(MIGRAZIONI).find((n) => n.endsWith(suffisso))
    if (!f) throw new Error(`migrazione ${suffisso} non trovata`)
    return fs.readFileSync(path.join(MIGRAZIONI, f), 'utf8')
  }
  const M3 = leggi('_anno_scrittura.sql')

  /** L'ultima definizione di una funzione in un file: dal CREATE OR REPLACE al `;` dopo il suo corpo. */
  function definizione(sql: string, nome: string): string {
    const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${nome}\\s*\\(`, 'gi')
    const tutte = [...sql.matchAll(re)]
    const inizio = tutte[tutte.length - 1].index!
    const tag = /AS\s+(\$[a-z_]*\$)/i.exec(sql.slice(inizio))![1]
    const apre = sql.indexOf(tag, inizio)
    const chiude = sql.indexOf(tag, apre + tag.length)
    return sql.slice(inizio, sql.indexOf(';', chiude) + 1)
  }
  /** La definizione dentro il blocco `DO` di M3 che la guarda con `to_regprocedure`. */
  function dentroM3(firma: string): string {
    const i = M3.indexOf(`to_regprocedure('${firma}')`)
    expect(i, `${firma} deve stare dietro un to_regprocedure`).toBeGreaterThan(0)
    const a = M3.indexOf('EXECUTE $def$', i) + 'EXECUTE $def$'.length
    return M3.slice(a, M3.indexOf('$def$;', a))
  }
  const senzaInterruttore = (s: string) => s.split('\n')
    .filter((l) => !/anno_chiuso\.oblio/i.test(l) && !l.includes("Anno scolastico (M3): l'oblio"))
    .join('\n').replace(/\s+/g, ' ').trim()
  /** Il solo corpo, fra i due delimitatori `$…$`: l'intestazione può cambiare forma (prod: `SET search_path TO`). */
  const normalizza = (s: string) => {
    const tag = /\$[a-z_]*\$/i.exec(s)![0]
    const a = s.indexOf(tag) + tag.length
    return s.slice(a, s.lastIndexOf(tag)).replace(/\s+/g, ' ').trim()
  }
  const contaRitorni = (s: string) => (s.match(/^\s*return\b(?!s)/gim) ?? []).length
  const contaSpegni = (s: string) => (s.match(/set_config\('anno_chiuso\.oblio', 'off', true\)/gi) ?? []).length
  const contaAccendi = (s: string) => (s.match(/set_config\('anno_chiuso\.oblio', 'on', true\)/gi) ?? []).length

  const CASI: Array<[string, string, string, string, number]> = [
    // [funzione, firma, file dell'ultima definizione, nome, RETURN]
    ['elimina_alunno_definitivo', 'public.elimina_alunno_definitivo(uuid,boolean,boolean)', '_eliminazioni_in_ordine.sql', 'elimina_alunno_definitivo', 9],
    ['iscrizioni_sanitari_tick', 'public.iscrizioni_sanitari_tick()', '_sanitari_solo_con_copia_presente.sql', 'iscrizioni_sanitari_tick', 1],
    ['presenze_giustificazioni_retention_tick', 'public.presenze_giustificazioni_retention_tick()',
      '_conservazione_grazia_ritiro_e_interruttore.sql', 'presenze_giustificazioni_retention_tick', 2],
  ]
  for (const [nome, firma, file, fn, ritorni] of CASI) {
    it(`${nome}: dietro \`to_regprocedure\`, interruttore acceso in testa e spento prima di OGNI RETURN (${ritorni})`, () => {
      const d = dentroM3(firma)
      expect(contaAccendi(d)).toBe(1)
      expect(contaRitorni(d)).toBe(ritorni)
      expect(contaSpegni(d)).toBe(ritorni)
      // ogni `off` sta subito PRIMA di un return: mai dopo, mai in coda soltanto
      expect(d.match(/set_config\('anno_chiuso\.oblio', 'off', true\);\s*\n\s*return\b(?!s)/gi) ?? []).toHaveLength(ritorni)
    })
    it(`${nome}: il testo è quello dell'ultima definizione nel repo, tolto l'interruttore`, () => {
      const originale = definizione(leggi(file), fn)
      expect(normalizza(senzaInterruttore(dentroM3(firma)))).toBe(normalizza(senzaInterruttore(originale)))
    })
  }
  it('i due job SQL restano com\'erano: nessun `cron.alter_job` e nessun `jobid` in M3 (le funzioni sono nel repo, via (ii))', () => {
    const codice = M3.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(codice).not.toMatch(/alter_job|jobid/i)
  })
})
