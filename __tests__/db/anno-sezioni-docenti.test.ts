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
