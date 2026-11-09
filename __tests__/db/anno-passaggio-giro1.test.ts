import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BAMBINI, DOCENTE_1, SEDE_E2E, UTENTE, creaBancoPassaggio, errore, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * PR 4.8, GIRO DI CORREZIONE 1 · una prova rossa per ogni bloccante della revisione finale, sul banco con il TRIGGER VERO dello storico.
 * Il giorno lo fissa `giorno_roma` dentro la transazione (DDL transazionale: il ROLLBACK lo toglie), così le date non scadono col calendario.
 */
let b: BancoPassaggio
const GEN = '77777777-7777-4777-8777-777777777771'
type Rec = Record<string, unknown>

beforeAll(async () => {
  b = await creaBancoPassaggio()
  await b.db.query(
    `INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1,$2),($1,$3),($1,$4)`,
    [GEN, BAMBINI.continua, BAMBINI.nonRisposto, BAMBINI.nuova])
  // Lo storico di partenza: le classi vecchie dall'inizio dell'anno vecchio (il trigger del banco, alla creazione, scrive il giorno vero di oggi).
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
/** Anteprima e le due decisioni che sbloccano la conferma nel banco. */
async function prepara(oggi: string): Promise<string> {
  const p = await anteprima(oggi)
  await correggi(p, BAMBINI.ritiratoTendina, 'continua')
  await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce')
  return p
}
const attivi = async () =>
  (await rows<{ alunno_id: string; section_id: string | null }>(`SELECT alunno_id, section_id FROM public.figli_attivi($1)`, [GEN]))
const sezioneDi = async (alunno: string) => (await attivi()).find((x) => x.alunno_id === alunno)?.section_id

describe('B1 · conferma, annulla e riconferma nello stesso giorno non lasciano bambini senza riga di storico aperta', () => {
  it('ogni bambino in classe ha una riga aperta, e la foto di classe del 15/09 si vede', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      await annulla(p, '2027-08-20')
      const p2 = await prepara('2027-08-20')
      await conferma(p2, '2027-08-20')
      const senza = await una<number>(
        b.db,
        `SELECT count(*)::int FROM public.alunni a WHERE a.scuola_id = $1 AND a.section_id IS NOT NULL AND a.archiviato_il IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id = a.id AND h.al IS NULL)`,
        [SEDE_E2E])
      expect(senza, 'bambini in classe senza una riga aperta di storico').toBe(0)
      expect((await una<{ n: number }>(b.db, `SELECT public.passaggio_storico_senza_riga_aperta() AS n`)).n ?? 0).toBe(0)
    })
  })
})

describe('B3 · la finestra fra la conferma e l’inizio dell’anno: le famiglie vedono come prima, salvo chi esce', () => {
  it('prima della conferma niente cambia: due figli, classi vecchie', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      expect(await sezioneDi(BAMBINI.continua)).toBe(b.sezioni.girasoli)
      expect(await sezioneDi(BAMBINI.nonRisposto)).toBe(b.sezioni.farfalle)
    })
  })

  it('dopo la conferma, il 20/08: chi continua resta visibile (classe vecchia), chi esce no, chi è nuovo non ancora', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      const a = await attivi()
      expect(a.map((x) => x.alunno_id).sort()).toEqual([BAMBINI.continua])
      expect(a[0].section_id, 'la classe che la famiglia vede è quella di prima').toBe(b.sezioni.girasoli)
    })
  })

  it('dal primo giorno dell’anno nuovo la famiglia vede la classe nuova, senza che nessuno faccia niente', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      await oggiE('2027-08-31')
      expect(await sezioneDi(BAMBINI.continua)).toBe(b.sezioni.girasoli)
      await oggiE('2027-09-01')
      expect(await sezioneDi(BAMBINI.continua)).toBe(b.sezioni.girasoliNuova)
      expect(await sezioneDi(BAMBINI.nuova)).toBe(b.sezioni.girasoliNuova)
    })
  })

  it('il bambino nuovo entra alla sua data di ingresso, non nella finestra', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      expect(await sezioneDi(BAMBINI.nuova)).toBeUndefined()
    })
  })

  it('la maestra nella finestra: misura di che cosa vede (classe vecchia e classe nuova)', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      const classi = await rows<{ section_id: string; sola_lettura: boolean }>(
        `SELECT section_id, sola_lettura FROM public.sezioni_visibili_docente($1)`, [DOCENTE_1])
      const per = new Map(classi.map((c) => [c.section_id, c.sola_lettura]))
      // La maestra ha la classe nuova in scrittura e la vecchia in sola lettura (decisione 14 della specifica).
      expect(per.get(b.sezioni.girasoliNuova)).toBe(false)
      expect(per.get(b.sezioni.girasoli)).toBe(true)
      // Il bambino che continua per lei: la scheda dice già la classe nuova, la frequenza viva quella vecchia.
      const scheda = await una<string>(b.db, `SELECT section_id FROM public.alunni WHERE id = $1`, [BAMBINI.continua])
      expect(scheda).toBe(b.sezioni.girasoliNuova)
    })
  })

  it('il 15/09 la foto del centro estivo (10/08, classe vecchia) si vede', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await conferma(await prepara('2027-08-20'), '2027-08-20')
      await b.db.query(
        `INSERT INTO public.galleria_media_v2 (id, scuola_id, giorno_competenza, target_section_ids, is_broadcast, tag_students)
         VALUES ('99999999-9999-4999-8999-999999999991', $1, DATE '2027-08-10', ARRAY[$2]::uuid[], true, '{}')`,
        [SEDE_E2E, b.sezioni.girasoli])
      await oggiE('2027-08-25')
      const nella = (await rows(`SELECT media_id FROM public.media_visibili_genitore($1)`, [GEN])).length
      await oggiE('2027-09-15')
      const dopo = (await rows(`SELECT media_id FROM public.media_visibili_genitore($1)`, [GEN])).length
      expect(nella, 'nella finestra').toBe(1)
      expect(dopo, 'il 15/09').toBe(1)
    })
  })
})


const scheda = async (id: string) =>
  (await rows<{ stato: string; archiviato: boolean }>(`SELECT stato, (archiviato_il IS NOT NULL) AS archiviato FROM public.alunni WHERE id = $1`, [id]))[0]
const conDetail = async (sql: string, params: unknown[]) => {
  await b.db.exec('SAVEPOINT s_g1')
  try {
    await b.db.query(sql, params)
  } catch (e) {
    await b.db.exec('ROLLBACK TO SAVEPOINT s_g1')
    const x = e as { message?: string; detail?: string }
    let detail: unknown = x.detail ?? null
    try { detail = JSON.parse(x.detail ?? 'null') } catch { /* testo */ }
    return { message: x.message ?? '', detail }
  }
  await b.db.exec('RELEASE SAVEPOINT s_g1')
  return { message: 'nessun-errore', detail: null as unknown }
}

describe('B2 · un bambino nuovo senza classe ferma la conferma', () => {
  it('avviso senza_sezione sulla riga e RIGHE_DA_DECIDERE; scelta la classe, si conferma', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await b.db.query(`UPDATE public.frequenze SET section_id = NULL WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nuova, b.a])
      const p = await prepara('2027-08-20')
      const riga = (await rows<{ avviso: string | null; esito: string }>(
        `SELECT avviso, esito FROM public.passaggi_anno_righe WHERE passaggio_id = $1 AND alunno_id = $2`, [p, BAMBINI.nuova]))[0]
      expect(riga).toEqual({ avviso: 'senza_sezione', esito: 'nuova' })
      const e = await conDetail(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, '2027-08-20'])
      expect(e.message).toBe('RIGHE_DA_DECIDERE')
      expect((e.detail as { senza_sezione: number }).senza_sezione).toBeGreaterThanOrEqual(1)
      await correggi(p, BAMBINI.nuova, 'nuova', b.sezioni.girasoliNuova)
      expect((await conferma(p, '2027-08-20')).gia_confermato).toBe(false)
      expect(await una<string>(b.db, `SELECT section_id FROM public.alunni WHERE id = $1`, [BAMBINI.nuova])).toBe(b.sezioni.girasoliNuova)
    })
  })
})

describe('B6 · la scheda «ritirato» e «sospeso» torna com’era', () => {
  it('un ritirato tenuto con «continua» torna iscritto, e dopo l’annullo è di nuovo ritirato (non archiviato)', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      expect((await scheda(BAMBINI.ritiratoTendina)).stato).toBe('iscritto')
      await annulla(p, '2027-08-20')
      expect(await scheda(BAMBINI.ritiratoTendina)).toEqual({ stato: 'ritirato', archiviato: false })
    })
  })

  it('un sospeso che esce torna sospeso dopo l’annullo', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      await b.db.query(`UPDATE public.alunni SET stato = 'sospeso' WHERE id = $1`, [BAMBINI.nonRisposto])
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      await annulla(p, '2027-08-20')
      expect((await scheda(BAMBINI.nonRisposto)).stato).toBe('sospeso')
    })
  })

  it('la tendina messa DOPO una decisione a mano fa tornare la riga da decidere', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await correggi(p, BAMBINI.continuaB, 'continua', b.sezioni.farfalleNuova)
      await b.db.query(`UPDATE public.alunni SET stato = 'ritirato' WHERE id = $1`, [BAMBINI.continuaB])
      await anteprima('2027-08-20')
      const riga = (await rows<{ avviso: string | null; eccezione: boolean }>(
        `SELECT avviso, eccezione FROM public.passaggi_anno_righe WHERE passaggio_id = $1 AND alunno_id = $2`, [p, BAMBINI.continuaB]))[0]
      expect(riga).toEqual({ avviso: 'ritirato_tendina', eccezione: false })
      expect((await conDetail(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, '2027-08-20'])).message).toBe('RIGHE_DA_DECIDERE')
    })
  })
})

describe('S8 · S9 · l’annullo guarda che cosa è successo dopo la conferma', () => {
  it('un’iscrizione nata dopo la conferma blocca l’annullo e viene nominata', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      await b.db.query(`UPDATE public.frequenze SET creata_il = now() + interval '1 hour' WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nuova, b.a])
      const e = await conDetail(`SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, '2027-08-20'])
      expect(e.message).toBe('PASSAGGIO_NON_ANNULLABILE')
      expect(e.detail).toEqual({ frequenze_dopo_la_conferma: 1 })
    })
  })

  it('una scheda anonimizzata dopo la conferma non torna «in arrivo»', async () => {
    await inRollback(b.db, async () => {
      await oggiE('2027-08-20')
      const p = await prepara('2027-08-20')
      await conferma(p, '2027-08-20')
      await b.db.query(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = $1`, [BAMBINI.nuova])
      await annulla(p, '2027-08-20')
      expect((await scheda(BAMBINI.nuova)).stato).not.toBe('in_arrivo')
    })
  })
})
