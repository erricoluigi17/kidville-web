import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.3.1 · `sezioni_visibili_docente` e `sezioni_docente_anno_attivo`.
 *
 * Calendario di prova fisso (`creaAnniFissi`): 2025/26 chiuso, 2026/27 corrente, 2027/28 in_preparazione.
 * Una sezione per anno (più una seconda del 2027/28 per le iscrizioni aperte). Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const DOCENTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SENZA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const S_2526 = '55555555-5555-4555-8555-555555555551'
const S_2627 = '55555555-5555-4555-8555-555555555552'
const S_2728 = '55555555-5555-4555-8555-555555555553'
const S_2728_B = '55555555-5555-4555-8555-555555555554'

let db: PGlite
const ANNO: Record<number, string> = {}

async function sezioniDi(docente: string): Promise<Array<{ section_id: string; sola_lettura: boolean }>> {
  const r = await db.query<{ section_id: string; sola_lettura: boolean }>(
    `SELECT section_id, sola_lettura FROM public.sezioni_visibili_docente($1) ORDER BY section_id`, [docente])
  return r.rows
}
async function assegna(docente: string, sezione: string) {
  await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [docente, sezione])
}
async function statoAnno(anno: number, stato: string) {
  await db.query(
    `UPDATE public.anni_sede s SET stato = $3
       FROM public.anni_scolastici y WHERE y.id = s.anno_id AND y.anno_inizio = $2 AND s.scuola_id = $1`, [SEDE, anno, stato])
}
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M43' })
  const anni = await db.query<{ anno_inizio: number; anno_id: string }>(
    `SELECT y.anno_inizio, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1`, [SEDE])
  const idAnno = (n: number) => anni.rows.find((x) => x.anno_inizio === n)!.anno_id
  for (const n of [2025, 2026, 2027]) ANNO[n] = idAnno(n)
  // Il registro orario non sta nel banco di base: ne serve una copia con le colonne che la propagazione legge.
  await db.exec(`CREATE TABLE IF NOT EXISTS public.registro_orario (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, classe_sezione text, section_id uuid,
    data date NOT NULL, ora_lezione int NOT NULL, anno_id uuid)`)
  // Idem per le tabelle dei destinatari: nel banco non ci sono (o non hanno l'anno). Niente trigger dell'anno qui.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.galleria_media_v2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid, target_classes text[],
      anno_id uuid, giorno_competenza date);
    CREATE TABLE IF NOT EXISTS public.news_posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, target_classes text[]);
    CREATE TABLE IF NOT EXISTS public.forms_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, target_classes text[] DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS public.mensa_class_menu_assignment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, classe text NOT NULL,
      attivo_dal date NOT NULL DEFAULT DATE '2026-09-01')`)
  const crea = (id: string, nome: string, anno: string) =>
    db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, $3, $4)`, [id, SEDE, nome, anno])
  await crea(S_2526, 'Girasoli', idAnno(2025))
  await crea(S_2627, 'Girasoli', idAnno(2026))
  await crea(S_2728, 'Girasoli', idAnno(2027))
  await crea(S_2728_B, 'Margherite', idAnno(2027))
}, 120_000)
afterAll(async () => { await db.close() })

describe('sezioni_visibili_docente', () => {
  prova('il docente vede la sezione dell’anno corrente e non può modificarla soltanto se non è corrente', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2627)
      expect(await sezioniDi(DOCENTE)).toEqual([{ section_id: S_2627, sola_lettura: false }])
    })
  })

  prova('vede in sola lettura la sezione dell’anno prima, se assegnata', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2526)
      expect(await sezioniDi(DOCENTE)).toEqual([{ section_id: S_2526, sola_lettura: true }])
    })
  })

  prova('non vede le sezioni di un anno in_preparazione', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2728)
      expect(await sezioniDi(DOCENTE)).toEqual([])
    })
  })

  prova('non vede le sezioni di un anno con iscrizioni_aperte', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2728_B)
      await statoAnno(2027, 'iscrizioni_aperte')
      const st = await db.query<{ stato: string }>(
        `SELECT s.stato FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
          WHERE y.anno_inizio = 2027 AND s.scuola_id = $1`, [SEDE])
      expect(st.rows[0].stato).toBe('iscrizioni_aperte')
      expect(await sezioniDi(DOCENTE)).toEqual([])
    })
  })

  prova('dopo il passaggio (anno_sede.stato=corrente) la stessa sezione compare scrivibile', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2627)
      await assegna(DOCENTE, S_2728)
      expect(await sezioniDi(DOCENTE)).toEqual([{ section_id: S_2627, sola_lettura: false }])
      await statoAnno(2026, 'in_chiusura')
      await statoAnno(2027, 'corrente')
      expect(await sezioniDi(DOCENTE)).toEqual([
        { section_id: S_2627, sola_lettura: true },
        { section_id: S_2728, sola_lettura: false },
      ])
    })
  })

  prova('un docente senza assegnazioni non vede niente', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2627)
      expect(await sezioniDi(SENZA)).toEqual([])
    })
  })

  prova('sezioni_docente_anno_attivo restituisce solo le scrivibili', async () => {
    await inRollback(async () => {
      await assegna(DOCENTE, S_2526)
      await assegna(DOCENTE, S_2627)
      await assegna(DOCENTE, S_2728)
      const r = await db.query<{ section_id: string }>(`SELECT section_id FROM public.sezioni_docente_anno_attivo($1)`, [DOCENTE])
      expect(r.rows.map((x) => x.section_id)).toEqual([S_2627])
    })
  })

  prova('authenticated e anon non possono eseguire le funzioni', async () => {
    const r = await db.query<{ ruolo: string; f: string; ok: boolean }>(`
      SELECT ruolo, f, has_function_privilege(ruolo, f, 'EXECUTE') AS ok
        FROM unnest(ARRAY['authenticated', 'anon']) ruolo,
             unnest(ARRAY['public.sezioni_visibili_docente(uuid)', 'public.sezioni_docente_anno_attivo(uuid)']) f`)
    expect(r.rows).toHaveLength(4)
    expect(r.rows.filter((x) => x.ok)).toEqual([])
  })

  prova('la migrazione si riapplica senza errori (idempotente)', async () => {
    await applicaPr2(db, 'M43')
    await inRollback(async () => {
      await assegna(DOCENTE, S_2627)
      expect(await sezioniDi(DOCENTE)).toEqual([{ section_id: S_2627, sola_lettura: false }])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COMPITO 4.3.3 · `propaga_rinomina_sezione` per anno (Ruling R-43-4).
// Con `anno_id`: si propaga alle righe dell'anno della sezione, sempre.
// Senza `anno_id` (alunni, news, moduli, menu di mensa): solo se la sezione è dell'anno attivo.
// ─────────────────────────────────────────────────────────────────────────────
describe('propaga_rinomina_sezione per anno', () => {
  async function sezione(nome: string, anno: number): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, $2, $3) RETURNING id`, [SEDE, nome, ANNO[anno]])
    return r.rows[0].id
  }
  async function avviso(anno: number, classi: string[]): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.avvisi (scuola_id, target_classes, anno_id, giorno_competenza)
       VALUES ($1, $2, $3, make_date($4, 10, 5)) RETURNING id`, [SEDE, classi, ANNO[anno], anno])
    return r.rows[0].id
  }
  async function news(classi: string[]): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.news_posts (scuola_id, target_classes) VALUES ($1, $2) RETURNING id`, [SEDE, classi])
    return r.rows[0].id
  }
  async function galleria(anno: number, classi: string[]): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.galleria_media_v2 (scuola_id, target_classes, anno_id, giorno_competenza)
       VALUES ($1, $2, $3, make_date($4, 10, 5)) RETURNING id`, [SEDE, classi, ANNO[anno], anno])
    return r.rows[0].id
  }
  async function registro(anno: number, nome: string, sez: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.registro_orario (scuola_id, classe_sezione, section_id, data, ora_lezione, anno_id)
       VALUES ($1, $2, $3, DATE '2026-10-05', 1, $4) RETURNING id`, [SEDE, nome, sez, ANNO[anno]])
    return r.rows[0].id
  }
  async function alunno(sez: string, nome: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.alunni (scuola_id, section_id, classe_sezione) VALUES ($1, $2, $3) RETURNING id`, [SEDE, sez, nome])
    return r.rows[0].id
  }
  const classi = async (tab: string, id: string) =>
    (await db.query<{ t: string[] }>(`SELECT target_classes AS t FROM public.${tab} WHERE id = $1`, [id])).rows[0].t
  const nomeRegistro = async (id: string) =>
    (await db.query<{ c: string }>(`SELECT classe_sezione AS c FROM public.registro_orario WHERE id = $1`, [id])).rows[0].c
  const nomeAlunno = async (id: string) =>
    (await db.query<{ c: string }>(`SELECT classe_sezione AS c FROM public.alunni WHERE id = $1`, [id])).rows[0].c
  const rinomina = (id: string, nome: string) =>
    db.query(`UPDATE public.sections SET name = $2 WHERE id = $1`, [id, nome])

  prova('rinominare una sezione del 2027/28 non tocca avvisi, alunni e news dell’anno corrente', async () => {
    await inRollback(async () => {
      const corr = await sezione('1A', 2026)
      const futura = await sezione('1A ', 2027)
      const av = await avviso(2026, ['1A'])
      const nw = await news(['1A'])
      const al = await alunno(corr, '1A')
      await rinomina(futura, '1B')
      expect(await classi('avvisi', av)).toEqual(['1A'])
      expect(await classi('news_posts', nw)).toEqual(['1A'])
      expect(await nomeAlunno(al)).toBe('1A')
    })
  })

  prova('rinominare una sezione del 2027/28 propaga alle tabelle con anno_id di quell’anno (e solo a quelle)', async () => {
    await inRollback(async () => {
      const corr = await sezione('1A', 2026)
      const futura = await sezione('1A ', 2027)
      const avFut = await avviso(2027, ['1A', '2A'])
      const avCorr = await avviso(2026, ['1A'])
      const gFut = await galleria(2027, ['1A'])
      const gCorr = await galleria(2026, ['1A'])
      const rFut = await registro(2027, '1A ', futura)
      const rCorr = await registro(2026, '1A', corr)
      await rinomina(futura, '1B')
      expect(await classi('avvisi', avFut)).toEqual(['1B', '2A'])
      expect(await classi('galleria_media_v2', gFut)).toEqual(['1B'])
      expect(await nomeRegistro(rFut)).toBe('1B')
      expect(await classi('avvisi', avCorr)).toEqual(['1A'])
      expect(await classi('galleria_media_v2', gCorr)).toEqual(['1A'])
      expect(await nomeRegistro(rCorr)).toBe('1A')
    })
  })

  prova('rinominare una sezione dell’anno attivo propaga a tutte le tabelle', async () => {
    await inRollback(async () => {
      const corr = await sezione('1A', 2026)
      const av = await avviso(2026, ['1A'])
      const nw = await news(['1A', '3A'])
      const g = await galleria(2026, ['1A'])
      const r = await registro(2026, '1A', corr)
      const al = await alunno(corr, '1A')
      await rinomina(corr, '1C')
      expect(await classi('avvisi', av)).toEqual(['1C'])
      expect(await classi('news_posts', nw)).toEqual(['1C', '3A'])
      expect(await classi('galleria_media_v2', g)).toEqual(['1C'])
      expect(await nomeRegistro(r)).toBe('1C')
      expect(await nomeAlunno(al)).toBe('1C')
    })
  })

  prova('rinominare una sezione di un anno chiuso tocca solo le tabelle con anno_id di quell’anno', async () => {
    await inRollback(async () => {
      const corr = await sezione('1A', 2026)
      const passata = await sezione('1A ', 2025)
      const avPass = await avviso(2025, ['1A'])
      const avCorr = await avviso(2026, ['1A'])
      const nw = await news(['1A'])
      const al = await alunno(corr, '1A')
      const rPass = await registro(2025, '1A ', passata)
      await rinomina(passata, '1D')
      expect(await classi('avvisi', avPass)).toEqual(['1D'])
      expect(await nomeRegistro(rPass)).toBe('1D')
      expect(await classi('avvisi', avCorr)).toEqual(['1A'])
      expect(await classi('news_posts', nw)).toEqual(['1A'])
      expect(await nomeAlunno(al)).toBe('1A')
    })
  })

  prova('registra in app_log se la sezione era dell’anno attivo', async () => {
    await inRollback(async () => {
      const futura = await sezione('1A', 2027)
      await rinomina(futura, '1B')
      const r = await db.query<{ a: boolean }>(
        `SELECT (contesto->>'sezione_anno_attivo')::boolean AS a FROM public.app_log
          WHERE fingerprint = $1`, ['db:rinomina-sezione:' + futura])
      expect(r.rows).toEqual([{ a: false }])
    })
  })
})
