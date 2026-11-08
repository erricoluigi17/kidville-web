import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.3.5 · `frequenza_segue_classe_alunno` e l'ETL dell'iscrizione (migrazione M43, coda 4.3.5).
 *
 * Dal merge la frequenza dell'anno ATTIVO della sede attuale dell'alunno è la verità e `alunni` ne è la copia.
 * Calendario di prova fisso (`creaAnniFissi`): 2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione.
 * `alunni.stato` e `stato_cambiato_il` non stanno nel banco di base: li aggiunge `codaPrima`, col trigger vero
 * `alunni_traccia_cambio_stato`. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const SEZ_A = '55555555-5555-4555-8555-555555555552'
const SEZ_B = '55555555-5555-4555-8555-555555555553'
const AL = '11111111-1111-4111-8111-111111111111'

let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function alunno(id = AL): Promise<Record<string, unknown>> {
  return una<Record<string, unknown>>(`SELECT to_jsonb(a) FROM public.alunni a WHERE a.id = $1`, [id])
}
async function frequenza(id = AL, sede = S1, anno = 2026): Promise<Record<string, unknown>> {
  return una<Record<string, unknown>>(
    `SELECT to_jsonb(f) FROM public.frequenze f WHERE f.alunno_id = $1 AND f.anno_sede_id = $2`, [id, ANNO_SEDE[`${sede}:${anno}`]])
}
async function nuovoAlunno(id = AL, o: { sede?: string; sezione?: string | null; nome?: string | null; retta?: number } = {}) {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id, classe_sezione, importo_retta_mensile, stato)
     VALUES ($1, $2, $3, $4, $5, 'iscritto')`,
    [id, o.sede ?? S1, o.sezione === undefined ? SEZ_A : o.sezione, o.nome === undefined ? 'Girasoli' : o.nome, o.retta ?? 350])
}
beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M43', completo: true,
    codaPrima: `
      ALTER TABLE public.alunni ADD COLUMN stato varchar(20), ADD COLUMN stato_cambiato_il timestamptz;
      CREATE FUNCTION public.alunni_traccia_cambio_stato() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.stato IS DISTINCT FROM OLD.stato THEN NEW.stato_cambiato_il := now(); END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER alunni_traccia_cambio_stato BEFORE INSERT OR UPDATE OF stato ON public.alunni
        FOR EACH ROW EXECUTE FUNCTION public.alunni_traccia_cambio_stato();
    `,
  })
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
  await db.query(`INSERT INTO public.sections (id, scuola_id, name) VALUES ($1, $2, 'Girasoli'), ($3, $2, 'Margherite')`,
    [SEZ_A, S1, SEZ_B])
}, 120_000)
afterAll(async () => { await db.close() })

describe('4.3.5 · la sezione scelta dalla classe arriva nella frequenza', () => {
  prova('fase B: cambiare classe_sezione sposta section_id di alunni; frequenza_segue_classe_alunno lo porta nella frequenza', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.alunni SET classe_sezione = 'Margherite' WHERE id = $1`, [AL])
      expect((await alunno()).section_id).toBe(SEZ_B) // il trigger BEFORE l'ha risolta dal nome
      await db.query(`SELECT public.frequenza_segue_classe_alunno($1)`, [AL])
      expect((await frequenza()).section_id).toBe(SEZ_B)
    })
  })

  prova('idempotente: una seconda chiamata non cambia niente', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.alunni SET classe_sezione = 'Margherite' WHERE id = $1`, [AL])
      await db.query(`SELECT public.frequenza_segue_classe_alunno($1)`, [AL])
      const una_ = await frequenza()
      await db.query(`SELECT public.frequenza_segue_classe_alunno($1)`, [AL])
      expect(await frequenza()).toEqual(una_)
    })
  })

  prova('interruttore spento (fase A): non fa niente', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.anno_regole SET specchio_frequenze_attivo = false`)
      await db.query(`UPDATE public.alunni SET classe_sezione = 'Margherite' WHERE id = $1`, [AL])
      const prima = (await frequenza()).section_id
      await db.query(`SELECT public.frequenza_segue_classe_alunno($1)`, [AL])
      // in fase A la copia verso la frequenza la fa il trigger di alunni, non questa funzione: qui non ha toccato nulla in più
      expect((await frequenza()).section_id).toBe(prima)
    })
  })

  prova('alunno inesistente: nessun errore', async () => {
    await db.query(`SELECT public.frequenza_segue_classe_alunno($1)`, ['99999999-9999-4999-8999-999999999999'])
  })

  prova('anon e authenticated non possono eseguirla; service_role sì', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', 'public.frequenza_segue_classe_alunno(uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.frequenza_segue_classe_alunno(uuid)', 'EXECUTE') AS auth`)
    expect(r.rows[0]).toEqual({ anon: false, auth: false })
  })

  prova('la funzione del trigger ETL esiste e anon/authenticated non la eseguono', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', 'public.fn_form_submission_etl()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.fn_form_submission_etl()', 'EXECUTE') AS auth`)
    expect(r.rows[0]).toEqual({ anon: false, auth: false })
  })

  prova('propaga_rinomina_sezione, ramo orfani: l’alunno riagganciato ha la stessa sezione anche nella frequenza, e un aggiornamento successivo non lo stacca', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, { sezione: null, nome: null })
      // l'orfano: una classe scritta a mano che nessuna sezione riconosce (la fase B non copia alunni → frequenza)
      await db.query(`UPDATE public.alunni SET classe_sezione = 'Zeta' WHERE id = $1`, [AL])
      expect((await alunno()).section_id).toBeNull()
      expect((await frequenza()).section_id).toBeNull()

      // la sezione deve essere dell'anno attivo della sede, altrimenti la rinomina non riaggancia nessuno
      await db.query(`UPDATE public.sections SET anno_id = (SELECT anno_id FROM public.anni_sede WHERE id = $2) WHERE id = $1`,
        [SEZ_B, ANNO_SEDE[`${S1}:2026`]])
      await db.query(`UPDATE public.sections SET name = 'Zeta' WHERE id = $1`, [SEZ_B])

      expect((await alunno()).section_id).toBe(SEZ_B)
      expect((await frequenza()).section_id).toBe(SEZ_B)

      // una scrittura successiva della frequenza (qui la retta) non riporta indietro la sezione
      await db.query(`UPDATE public.frequenze SET retta_mensile = 400 WHERE alunno_id = $1 AND anno_sede_id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`]])
      expect((await alunno()).section_id).toBe(SEZ_B)
      expect((await frequenza()).section_id).toBe(SEZ_B)
    })
  })
})
