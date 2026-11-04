// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'

/**
 * Voti primaria · colonna `periodo_id` e funzione di ricalcolo dei periodi.
 *
 * Il SQL gira in PostgreSQL vero (PGlite), non in un finto: la regola di copertura
 * («il periodo che contiene il giorno, l'ordine piu basso se si sovrappongono») ha una
 * sola formulazione, ed e questa. Le tabelle sono il minimo che la migrazione tocca.
 */

// UUID finti, mai quelli di una sede reale (repo pubblico).
const SEDE_A = '22222222-2222-4222-8222-22222222222a'
const SEDE_B = '22222222-2222-4222-8222-22222222222b'
const CLASSE_A = '33333333-3333-4333-8333-33333333333a'
const CLASSE_B = '33333333-3333-4333-8333-33333333333b'
const QA = '44444444-4444-4444-8444-44444444444a'
const QB = '44444444-4444-4444-8444-44444444444b'
const PB = '44444444-4444-4444-8444-4444444444bb'
const QX = '44444444-4444-4444-8444-4444444444cc'
const V1 = '55555555-5555-4555-8555-555555555501'
const V2 = '55555555-5555-4555-8555-555555555502'
const V3 = '55555555-5555-4555-8555-555555555503'
const V_B = '55555555-5555-4555-8555-5555555555bb'
const G1 = '66666666-6666-4666-8666-666666666601'
const G_B = '66666666-6666-4666-8666-6666666666bb'

const file = readdirSync('supabase/migrations').find((f) => f.endsWith('_voti_periodo_id.sql'))
const MIGRAZIONE = file ? `supabase/migrations/${file}` : null

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TABLE public.scrutinio_periodi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid NOT NULL, anno_scolastico text, nome text,
      ordine int DEFAULT 0, data_inizio date, data_fine date, attivo boolean DEFAULT true
    );
    CREATE TABLE public.sections (id uuid PRIMARY KEY, scuola_id uuid);
    CREATE TABLE public.valutazioni (
      id uuid PRIMARY KEY, section_id uuid, modalita text, data_evento date,
      creato_il timestamptz DEFAULT now()
    );
    CREATE TABLE public.giustifiche_didattiche (
      id uuid PRIMARY KEY, section_id uuid, data date NOT NULL
    );
  `)
  if (!MIGRAZIONE) throw new Error('manca supabase/migrations/*_voti_periodo_id.sql')
  await db.exec(readFileSync(MIGRAZIONE, 'utf8'))
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.valutazioni, public.giustifiche_didattiche, public.sections;
    DELETE FROM public.scrutinio_periodi;
  `)
  await db.query(
    `INSERT INTO public.sections(id, scuola_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid)`,
    [CLASSE_A, SEDE_A, CLASSE_B, SEDE_B],
  )
  await db.query(
    `INSERT INTO public.scrutinio_periodi(id, scuola_id, anno_scolastico, nome, ordine, data_inizio, data_fine) VALUES
       ($1::uuid, $2::uuid, '2025/2026', 'Primo quadrimestre', 1, '2025-09-01', '2026-01-31'),
       ($3::uuid, $2::uuid, '2025/2026', 'Secondo quadrimestre', 2, '2026-02-01', '2026-06-30'),
       ($4::uuid, $5::uuid, '2025/2026', 'Periodo unico', 1, '2025-09-01', '2026-06-30')`,
    [QA, SEDE_A, QB, PB, SEDE_B],
  )
})

afterAll(async () => { await db.close() })

async function voto(id: string, sezione: string, dataEvento: string | null, creatoIl: string | null, modalita: string | null = 'sintetico') {
  await db.query(
    `INSERT INTO public.valutazioni(id, section_id, modalita, data_evento, creato_il)
     VALUES ($1::uuid, $2::uuid, $3, $4::date, coalesce($5::timestamptz, now()))`,
    [id, sezione, modalita, dataEvento, creatoIl],
  )
}
async function impreparato(id: string, sezione: string, data: string) {
  await db.query(`INSERT INTO public.giustifiche_didattiche(id, section_id, data) VALUES ($1::uuid, $2::uuid, $3::date)`, [id, sezione, data])
}
async function ricalcola(sede: string | null = SEDE_A) {
  const q = await db.query<{ r: { valutazioni: number; impreparati: number } }>(
    'SELECT public.primaria_ricalcola_periodi($1::uuid) AS r', [sede])
  return q.rows[0].r
}
async function periodoDi(tabella: 'valutazioni' | 'giustifiche_didattiche', id: string) {
  const q = await db.query<{ p: string | null }>(`SELECT periodo_id AS p FROM public.${tabella} WHERE id = $1::uuid`, [id])
  return q.rows[0].p
}

describe('voti primaria · periodo_id e ricalcolo · SQL eseguito in PostgreSQL isolato PGlite', () => {
  it('aggiunge periodo_id su entrambe le tabelle, con indice e ON DELETE SET NULL', async () => {
    const colonne = await db.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'periodo_id' ORDER BY table_name`)
    expect(colonne.rows).toEqual([
      { table_name: 'giustifiche_didattiche', is_nullable: 'YES' },
      { table_name: 'valutazioni', is_nullable: 'YES' },
    ])
    const indici = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('valutazioni_periodo_id_idx', 'giustifiche_didattiche_periodo_id_idx') ORDER BY indexname`)
    expect(indici.rows.map((r) => r.indexname)).toEqual(['giustifiche_didattiche_periodo_id_idx', 'valutazioni_periodo_id_idx'])

    await voto(V1, CLASSE_A, '2025-10-15', null)
    await impreparato(G1, CLASSE_A, '2025-10-15')
    await ricalcola()
    expect(await periodoDi('valutazioni', V1)).toBe(QA)
    expect(await periodoDi('giustifiche_didattiche', G1)).toBe(QA)
    await db.query('DELETE FROM public.scrutinio_periodi WHERE id = $1::uuid', [QA])
    expect(await periodoDi('valutazioni', V1)).toBeNull()
    expect(await periodoDi('giustifiche_didattiche', G1)).toBeNull()
  })

  it('assegna per data_evento, e per il giorno di Roma di creato_il quando manca', async () => {
    await voto(V1, CLASSE_A, '2025-10-15', null)
    // 23:30 UTC del 31/01 = 00:30 del 1° febbraio a Roma: secondo quadrimestre.
    await voto(V2, CLASSE_A, null, '2026-01-31T23:30:00Z')
    await impreparato(G1, CLASSE_A, '2026-03-02')
    expect(await ricalcola()).toEqual({ valutazioni: 2, impreparati: 1 })
    expect(await periodoDi('valutazioni', V1)).toBe(QA)
    expect(await periodoDi('valutazioni', V2)).toBe(QB)
    expect(await periodoDi('giustifiche_didattiche', G1)).toBe(QB)
  })

  it('periodi sovrapposti: vince l’ordine più basso', async () => {
    await db.query(
      `INSERT INTO public.scrutinio_periodi(id, scuola_id, anno_scolastico, nome, ordine, data_inizio, data_fine)
       VALUES ($1::uuid, $2::uuid, '2025/2026', 'Periodo sovrapposto', 0, '2026-01-15', '2026-02-15')`, [QX, SEDE_A])
    await voto(V1, CLASSE_A, '2026-02-01', null)
    await ricalcola()
    expect(await periodoDi('valutazioni', V1)).toBe(QX)
    // Non e la data d'inizio a decidere: se QX passa a un ordine piu alto di QB, vince QB
    // anche se QX comincia prima.
    await db.query('UPDATE public.scrutinio_periodi SET ordine = 3 WHERE id = $1::uuid', [QX])
    expect(await ricalcola()).toEqual({ valutazioni: 1, impreparati: 0 })
    expect(await periodoDi('valutazioni', V1)).toBe(QB)
  })

  it('un periodo con una sola data non copre niente', async () => {
    await db.query('UPDATE public.scrutinio_periodi SET data_fine = NULL WHERE id = $1::uuid', [QA])
    await voto(V1, CLASSE_A, '2025-10-15', null)
    await impreparato(G1, CLASSE_A, '2025-10-15')
    expect(await ricalcola()).toEqual({ valutazioni: 0, impreparati: 0 })
    expect(await periodoDi('valutazioni', V1)).toBeNull()
    expect(await periodoDi('giustifiche_didattiche', G1)).toBeNull()
    // Vale anche al contrario: solo la data di fine.
    await db.query('UPDATE public.scrutinio_periodi SET data_inizio = NULL, data_fine = $2::date WHERE id = $1::uuid', [QA, '2026-01-31'])
    expect(await ricalcola()).toEqual({ valutazioni: 0, impreparati: 0 })
    expect(await periodoDi('valutazioni', V1)).toBeNull()
  })

  it('non tocca un’altra sede né le valutazioni con modalita NULL', async () => {
    await voto(V1, CLASSE_A, '2025-10-15', null)
    await voto(V3, CLASSE_A, '2025-10-16', null, null)
    await voto(V_B, CLASSE_B, '2025-10-15', null)
    await impreparato(G_B, CLASSE_B, '2025-10-15')
    expect(await ricalcola(SEDE_A)).toEqual({ valutazioni: 1, impreparati: 0 })
    expect(await periodoDi('valutazioni', V1)).toBe(QA)
    expect(await periodoDi('valutazioni', V3)).toBeNull()
    expect(await periodoDi('valutazioni', V_B)).toBeNull()
    expect(await periodoDi('giustifiche_didattiche', G_B)).toBeNull()
    // La sede B si ricalcola da sé, sul proprio periodo.
    expect(await ricalcola(SEDE_B)).toEqual({ valutazioni: 1, impreparati: 1 })
    expect(await periodoDi('valutazioni', V_B)).toBe(PB)
  })

  it('seconda chiamata: 0 righe cambiate', async () => {
    await voto(V1, CLASSE_A, '2025-10-15', null)
    await impreparato(G1, CLASSE_A, '2026-03-02')
    expect(await ricalcola()).toEqual({ valutazioni: 1, impreparati: 1 })
    expect(await ricalcola()).toEqual({ valutazioni: 0, impreparati: 0 })
  })

  it('spostate le date, chi esce da ogni periodo torna NULL', async () => {
    await voto(V1, CLASSE_A, '2025-10-15', null)
    await impreparato(G1, CLASSE_A, '2025-10-15')
    await ricalcola()
    expect(await periodoDi('valutazioni', V1)).toBe(QA)
    // Il primo quadrimestre ora comincia a novembre: ottobre non e coperto da nessuno.
    await db.query(`UPDATE public.scrutinio_periodi SET data_inizio = '2025-11-01' WHERE id = $1::uuid`, [QA])
    expect(await ricalcola()).toEqual({ valutazioni: 1, impreparati: 1 })
    expect(await periodoDi('valutazioni', V1)).toBeNull()
    expect(await periodoDi('giustifiche_didattiche', G1)).toBeNull()
  })

  it('p_scuola_id NULL → errore 22004', async () => {
    await expect(ricalcola(null)).rejects.toMatchObject({ code: '22004' })
  })

  it('la eseguono solo il service role: anon e authenticated no', async () => {
    const firma = 'public.primaria_ricalcola_periodi(uuid)'
    const { rows } = await db.query<{ a: boolean; u: boolean; s: boolean }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') a,
              has_function_privilege('authenticated', $1, 'EXECUTE') u,
              has_function_privilege('service_role', $1, 'EXECUTE') s`, [firma])
    expect(rows[0]).toEqual({ a: false, u: false, s: true })
  })
})
