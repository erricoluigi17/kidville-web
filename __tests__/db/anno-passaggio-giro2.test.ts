import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BAMBINI, DOCENTE_1, DOCENTE_2, SEDE_E2E, UTENTE, creaBancoPassaggio, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * PR 4.8, GIRO DI CORREZIONE 2 · una prova per ogni bloccante rimasto aperto (B3, B5, B6) e per le decisioni R6, R7 e R8.
 * Il banco ha il trigger vero dello storico. Il giorno lo fissa `giorno_roma` dentro la transazione (il ROLLBACK lo toglie).
 *
 * R6: lo specchio `frequenze` → `alunni` copia la frequenza dell'anno VISIBILE. Fra la conferma e l'inizio dell'anno nuovo la scheda NON
 * si sposta; il giorno dell'inizio la ricopia (`passaggio_ricopia_schede`, il job orario) la porta sulla classe nuova.
 */
let b: BancoPassaggio
const GEN = '77777777-7777-4777-8777-777777777772'
type Rec = Record<string, unknown>

beforeAll(async () => {
  b = await creaBancoPassaggio()
  await b.db.query(
    `INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1,$2),($1,$3),($1,$4)`,
    [GEN, BAMBINI.continua, BAMBINI.nonRisposto, BAMBINI.nuova])
  await b.db.exec(`UPDATE public.alunni_classi_storico SET dal = DATE '2026-09-01'`)
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

const rows = async <T = Rec>(sql: string, p: unknown[] = []) => (await b.db.query<T>(sql, p)).rows
const oggiE = (d: string) =>
  b.db.exec(`CREATE OR REPLACE FUNCTION public.giorno_roma(p_istante timestamptz) RETURNS date LANGUAGE sql STABLE AS $f$ SELECT DATE '${d}' $f$`)
const anteprima = async (oggi: string) =>
  (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [b.da, b.a, UTENTE, oggi])).passaggio_id
const correggi = (p: string, alunno: string, esito: string, sezione: string | null = null) =>
  b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`, [p, alunno, esito, sezione, UTENTE])
const conferma = (p: string, oggi: string) => una<Rec>(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const annulla = (p: string, oggi: string) => una<Rec>(b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const ricopia = async (oggi: string) => {
  await oggiE(oggi)
  return una<Rec>(b.db, `SELECT public.passaggio_ricopia_schede($1::date, $2::uuid)`, [oggi, SEDE_E2E])
}
async function prepara(oggi: string): Promise<string> {
  const p = await anteprima(oggi)
  await correggi(p, BAMBINI.ritiratoTendina, 'continua')
  await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce')
  return p
}
const scheda = async (id: string) =>
  (await rows<{ stato: string; section_id: string | null; archiviato: boolean }>(
    `SELECT stato, section_id, (archiviato_il IS NOT NULL) AS archiviato FROM public.alunni WHERE id = $1`, [id]))[0]
async function conDetail(sql: string, params: unknown[]): Promise<{ message: string; detail: unknown }> {
  await b.db.exec('SAVEPOINT s_g2')
  try {
    await b.db.query(sql, params)
  } catch (e) {
    await b.db.exec('ROLLBACK TO SAVEPOINT s_g2')
    const x = e as { message?: string; detail?: string }
    let detail: unknown = x.detail ?? null
    try { detail = JSON.parse(x.detail ?? 'null') } catch { /* non JSON */ }
    return { message: x.message ?? '', detail }
  }
  await b.db.exec('RELEASE SAVEPOINT s_g2')
  return { message: 'nessun-errore', detail: null }
}

describe('B3 · R6 · la foto messa DOPO la conferma, e la scheda che segue l’anno visibile', () => {
  it('la foto del centro estivo messa sulla classe vecchia dopo la conferma si vede nella finestra, il 01/09 e il 15/09', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      // DOPO la conferma: una foto del 10/08 sulla classe vecchia
      await b.db.query(
        `INSERT INTO public.galleria_media_v2 (id, scuola_id, giorno_competenza, target_section_ids, is_broadcast, tag_students)
         VALUES ('99999999-9999-4999-8999-999999999992', $1, DATE '2027-08-10', ARRAY[$2]::uuid[], true, '{}')`,
        [SEDE_E2E, b.sezioni.girasoli])
      const conta = async (giorno: string) => {
        await oggiE(giorno)
        return (await rows(`SELECT media_id FROM public.media_visibili_genitore($1)`, [GEN])).length
      }
      expect(await conta('2027-08-25'), 'nella finestra').toBe(1)
      await ricopia('2027-09-01')
      expect(await conta('2027-09-01'), 'il giorno dell’inizio').toBe(1)
      expect(await conta('2027-09-15'), 'il 15/09').toBe(1)
    })
  })

  it('fra la conferma e l’inizio la scheda non si sposta; all’inizio la ricopia la porta sulla classe nuova e lascia lo storico giusto', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      expect((await scheda(BAMBINI.continua)).section_id).toBe(b.sezioni.girasoli)
      expect((await scheda(BAMBINI.nuova)).stato).toBe('in_arrivo')
      const r = await ricopia('2027-09-01')
      expect(r.passaggi).toBe(1)
      expect(Number(r.cambiate)).toBeGreaterThan(0)
      expect(await scheda(BAMBINI.continua)).toMatchObject({ section_id: b.sezioni.girasoliNuova, archiviato: false })
      expect((await scheda(BAMBINI.nuova)).stato).toBe('iscritto')
      const storico = await rows<{ section_id: string; dal: string; al: string | null }>(
        `SELECT section_id, dal::text, al::text FROM public.alunni_classi_storico WHERE alunno_id = $1 ORDER BY dal, al NULLS LAST`, [BAMBINI.continua])
      expect(storico.map((x) => [x.section_id, x.dal, x.al])).toEqual([
        [b.sezioni.girasoli, '2026-09-01', '2027-09-01'],
        [b.sezioni.girasoliNuova, '2027-09-01', null],
      ])
      // il successo si logga, con i soli numeri
      const log = await rows<{ contesto: { campi: Rec } }>(`SELECT contesto FROM public.app_log WHERE fingerprint LIKE 'passaggio-schede-ricopiate:%'`)
      expect(log).toHaveLength(1)
      expect(Number(log[0].contesto.campi.n_schede)).toBeGreaterThan(0)
      // idempotente
      expect((await ricopia('2027-09-01')).passaggi).toBe(0)
    })
  })

  it('chi è stato archiviato nella finestra non torna in classe con la ricopia', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      await b.db.query(`UPDATE public.alunni SET archiviato_il = now() + interval '1 hour', stato = 'ritirato' WHERE id = $1`, [BAMBINI.continua])
      const r = await ricopia('2027-09-01')
      expect(Number(r.archiviati)).toBe(1)
      expect(await scheda(BAMBINI.continua)).toMatchObject({ stato: 'ritirato', archiviato: true })
      expect(await una<string>(b.db, `SELECT stato FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.continua, b.a])).toBe('ritirato')
    })
  })
})

describe('B5 · la conferma ricontrolla le copie dei docenti; R7 gli archiviati', () => {
  const nelleNuove = (u: string, s: string) =>
    una<number>(b.db, `SELECT count(*)::int FROM public.utenti_sezioni WHERE utente_id = $1 AND section_id = $2`, [u, s])

  it('la maestra tolta dalla classe vecchia dopo l’anteprima non prende la classe nuova, anche senza «Ricalcola»', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno_docenti WHERE passaggio_id = $1 AND utente_id = $2 AND origine = 'copiata'`, [p, DOCENTE_1])).toBeGreaterThan(0)
      await b.db.query(`DELETE FROM public.utenti_sezioni WHERE utente_id = $1 AND section_id = $2`, [DOCENTE_1, b.sezioni.girasoli])
      await conferma(p, '2027-08-20')
      expect(await nelleNuove(DOCENTE_1, b.sezioni.girasoliNuova)).toBe(0)
      expect(await nelleNuove(DOCENTE_2, b.sezioni.farfalleNuova), 'chi segue ancora la classe vecchia la prende').toBe(1)
    })
  })

  it('un docente archiviato dopo l’anteprima non entra nella classe nuova', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await b.db.query(`UPDATE public.utenti SET archiviato_il = now() WHERE id = $1`, [DOCENTE_2])
      await conferma(p, '2027-08-20')
      expect(await nelleNuove(DOCENTE_2, b.sezioni.farfalleNuova)).toBe(0)
    })
  })
})

describe('B6 · la tendina «ritirato» e «sospeso»: eccezioni, sospeso, annullo', () => {
  it('una tendina «ritirato» comparsa DOPO la scelta a mano ferma la conferma (ANTEPRIMA_VECCHIA), anche sulle righe in eccezione', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      // scelta a mano su un bambino sano, poi la tendina «ritirato» compare senza che nessuno ricalcoli
      await correggi(p, BAMBINI.continuaB, 'continua', b.sezioni.girasoliNuova)
      await b.db.query(`UPDATE public.alunni SET stato = 'ritirato' WHERE id = $1`, [BAMBINI.continuaB])
      const e = await conDetail(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, '2027-08-20'])
      expect(e.message).toBe('ANTEPRIMA_VECCHIA')
    })
  })

  it('il sospeso dà l’avviso; «continua» a mano riporta la scheda a iscritto; l’annullo la rimette sospesa', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await b.db.query(`UPDATE public.alunni SET stato = 'sospeso' WHERE id = $1`, [BAMBINI.continuaB])
      const p = await prepara('2027-08-20')
      const riga = (await rows<{ avviso: string | null }>(`SELECT avviso FROM public.passaggi_anno_righe WHERE passaggio_id = $1 AND alunno_id = $2`, [p, BAMBINI.continuaB]))[0]
      expect(riga.avviso, 'avviso sul sospeso').toBe('ritirato_tendina')
      const bloccata = await conDetail(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, '2027-08-20'])
      expect(bloccata.message).toBe('RIGHE_DA_DECIDERE')
      await correggi(p, BAMBINI.continuaB, 'continua', b.sezioni.farfalleNuova)
      await conferma(p, '2027-08-20')
      expect((await scheda(BAMBINI.continuaB)).stato).toBe('iscritto')
      await annulla(p, '2027-08-20')
      expect((await scheda(BAMBINI.continuaB)).stato).toBe('sospeso')
    })
  })

  it('P23 · chi viene archiviato dopo la conferma resta archiviato con l’annullo', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      await b.db.query(`UPDATE public.alunni SET archiviato_il = now() + interval '1 hour', stato = 'ritirato' WHERE id = $1`, [BAMBINI.ritiratoTendina])
      await annulla(p, '2027-08-20')
      expect(await scheda(BAMBINI.ritiratoTendina)).toMatchObject({ stato: 'ritirato', archiviato: true })
    })
  })
})

describe('R8 · l’invariante dello storico è dentro anno_invarianti()', () => {
  it('compare con la riga 15 e si accende quando un bambino in classe perde la riga aperta', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const conta = async () =>
        Number((await rows<{ righe: string }>(`SELECT righe FROM public.anno_invarianti() WHERE invariante = '15'`))[0]?.righe)
      expect(await conta(), 'la riga esiste e vale zero').toBe(0)
      await b.db.query(`DELETE FROM public.alunni_classi_storico WHERE alunno_id = $1 AND al IS NULL`, [BAMBINI.continua])
      expect(await conta()).toBeGreaterThan(0)
    })
  })
})
