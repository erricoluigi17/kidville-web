import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  BAMBINI, DOCENTE_1, DOCENTE_2, SEDE_E2E, SEDE_SIM, SEDE_VERA, UTENTE, creaBancoPassaggio, errore, inRollback, una,
  type BancoPassaggio,
} from '../helpers/passaggio-banco'

/**
 * COMPITO 4.8.7 · M48b, confermare, annullare e rientrare dopo il passaggio. PGlite, un banco per file, ogni prova in una transazione
 * che finisce in ROLLBACK. Solo uuid inventati. Il giorno del passaggio (`b.oggi`) viene dal database, mai scritto qui.
 *
 * Il banco ha due righe con un avviso aperto (il “ritirato” dalla tendina e il cambio di grado senza classe): la conferma le rifiuta
 * finché la segreteria non decide. `prepara` le decide nel modo che lascia ripristinabile tutto: il primo si tiene, il secondo esce.
 */

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio()
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

const anteprima = async () =>
  (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
const correggi = (p: string, alunno: string, esito: string | null, sezione: string | null = null) =>
  b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`, [p, alunno, esito, sezione, UTENTE])
const conferma = (p: string, oggi: string | null = b.oggi) =>
  una<{ passaggio_id: string; gia_confermato: boolean; conteggi: Record<string, number> }>(
    b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const annulla = (p: string, oggi: string | null = b.oggi) =>
  una<{ passaggio_id: string; gia_annullato?: boolean; conteggi?: Record<string, number> }>(
    b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
/** (giro 2, R6) Il giorno dell'inizio le schede passano sulla classe nuova: la ricopia del job orario. */
const oggiE = (d: string) =>
  b.db.exec(`CREATE OR REPLACE FUNCTION public.giorno_roma(p_istante timestamptz) RETURNS date LANGUAGE sql STABLE AS $f$ SELECT DATE '${d}' $f$`)
const ricopia = async (oggi: string = b.inizio, sede: string | null = SEDE_E2E) => {
  await oggiE(oggi) // il giorno vero lo fissa `giorno_roma` dentro la transazione (il ROLLBACK lo toglie)
  return una<{ passaggi: number; schede: number; cambiate: number; archiviati: number; quote: number }>(
    b.db, `SELECT public.passaggio_ricopia_schede($1::date, $2::uuid)`, [oggi, sede])
}
const tardiva = (p: string, alunno: string, sezione: string | null = null, oggi: string | null = b.oggi) =>
  una<{ frequenza_id: string; creata: boolean; quota: string | null; pagamento_id: string | null }>(
    b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date)`, [p, alunno, sezione, UTENTE, oggi])

/** Anteprima + le due decisioni della segreteria: il “ritirato” si tiene, il cambio di grado senza classe esce. */
async function prepara(): Promise<string> {
  const p = await anteprima()
  await correggi(p, BAMBINI.ritiratoTendina, 'continua', null)
  await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce', null)
  return p
}

/** Messaggio e DETAIL di un errore, dentro una transazione (un savepoint). */
async function conDettaglio(sql: string, params: unknown[]): Promise<{ message: string; detail: unknown }> {
  await b.db.exec('SAVEPOINT s_dettaglio')
  try {
    await b.db.query(sql, params)
  } catch (e) {
    await b.db.exec('ROLLBACK TO SAVEPOINT s_dettaglio')
    const x = e as { message?: string; detail?: string }
    let detail: unknown = x.detail ?? null
    try { detail = JSON.parse(x.detail ?? 'null') } catch { /* non è JSON */ }
    return { message: x.message ?? '', detail }
  }
  await b.db.exec('RELEASE SAVEPOINT s_dettaglio')
  return { message: 'nessun-errore', detail: null }
}

/** Tutto quello che il passaggio può toccare, in un testo confrontabile. */
async function fotografia(): Promise<string> {
  const q = async (sql: string, params: unknown[] = []) => JSON.stringify((await b.db.query(sql, params)).rows)
  return [
    await q(`SELECT id, stato, section_id, data_uscita FROM public.frequenze ORDER BY id`),
    await q(`SELECT id, stato, section_id, classe_sezione, (archiviato_il IS NULL) AS vivo FROM public.alunni ORDER BY id`),
    await q(`SELECT id, stato, domande_aperte FROM public.anni_sede ORDER BY id`),
    await q(`SELECT utente_id, section_id FROM public.utenti_sezioni ORDER BY utente_id, section_id`),
  ].join('\n')
}

const frequenza = async (alunno: string, anno: string) =>
  (await b.db.query<{ id: string; stato: string; section_id: string | null; data_uscita: string | null; tipo: string | null; origine: string; continua_da: string | null }>(
    `SELECT id, stato, section_id, data_uscita::text, tipo, origine, continua_da FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, anno])).rows[0]
const alunno = async (id: string) =>
  (await b.db.query<{ stato: string; section_id: string | null; archiviato: boolean }>(
    `SELECT stato, section_id, (archiviato_il IS NOT NULL) AS archiviato FROM public.alunni WHERE id = $1`, [id])).rows[0]
const statoAnno = async (id: string) =>
  (await b.db.query<{ stato: string; domande_aperte: boolean }>(`SELECT stato, domande_aperte FROM public.anni_sede WHERE id = $1`, [id])).rows[0]

describe('passaggio_conferma: i cancelli', () => {
  it('con un avviso aperto → RIGHE_DA_DECIDERE, con i conteggi nel DETAIL', async () => {
    await inRollback(b.db, async () => {
      const p = await anteprima()
      const e = await conDettaglio(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
      expect(e.message).toBe('RIGHE_DA_DECIDERE')
      expect(e.detail).toEqual({ senza_sezione: 1, ritirato_tendina: 1 })
    })
  })

  it('nel giorno dell’ultimo giorno aperto, o prima → PASSAGGIO_TROPPO_PRESTO', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      const ultimo = await una<string>(b.db, `SELECT ultimo_giorno_aperto::text FROM public.anni_sede WHERE id = $1`, [b.da])
      expect(await errore(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, ultimo])).toBe('PASSAGGIO_TROPPO_PRESTO')
      expect((await statoAnno(b.da)).stato).toBe('corrente')
    })
  })

  it('un passaggio che non c’è → PASSAGGIO_NON_TROVATO; annullato → PASSAGGIO_NON_MODIFICABILE', async () => {
    await inRollback(b.db, async () => {
      expect(await errore(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, ['00000000-0000-4000-8000-00000000dead', UTENTE, b.oggi])).toBe('PASSAGGIO_NON_TROVATO')
      const p = await anteprima()
      await annulla(p)
      expect(await errore(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])).toBe('PASSAGGIO_NON_MODIFICABILE')
    })
  })

  it('l’anteprima non regge più (una conferma registrata dopo) → ANTEPRIMA_VECCHIA, e rifatta si conferma', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      const freq = await una<string>(b.db, `SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nonRisposto, b.da])
      await b.db.query(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL::uuid, $3::uuid, false)`, [freq, b.a, UTENTE])
      const e = await conDettaglio(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
      expect(e.message).toBe('ANTEPRIMA_VECCHIA')
      expect(e.detail).toEqual({ righe_diverse: 1 })
      expect((await statoAnno(b.a)).stato, 'niente è cambiato').toBe('iscrizioni_aperte')
      await anteprima()
      expect((await conferma(p)).gia_confermato).toBe(false)
    })
  })

  it('`p_oggi` su una sede vera → PASSAGGIO_OGGI_NON_AMMESSO e niente cambia', async () => {
    await inRollback(b.db, async () => {
      const p = await una<string>(
        b.db,
        `INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id) VALUES ($1, $2, $3) RETURNING id`,
        [SEDE_VERA, b.vera.da, b.vera.a])
      const prima = await fotografia()
      for (const f of ['passaggio_conferma', 'passaggio_annulla']) {
        expect(await errore(b.db, `SELECT public.${f}($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi]), f).toBe('PASSAGGIO_OGGI_NON_AMMESSO')
      }
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, NULL::uuid, $3::uuid, $4::date)`, [p, BAMBINI.no, UTENTE, b.oggi]))
        .toBe('PASSAGGIO_OGGI_NON_AMMESSO')
      expect(await fotografia()).toBe(prima)
    })
  })

  it('l’anno nuovo non più aperto → PASSAGGIO_NON_PRONTO', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [b.a])
      expect(await errore(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])).toBe('PASSAGGIO_NON_PRONTO')
    })
  })
})

describe('passaggio_conferma', () => {
  it('cambia l’anno attivo, scrive la storia degli stati e chiude le domande del vecchio', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      expect(await una<string>(b.db, `SELECT public.anno_attivo($1)::text`, [SEDE_E2E])).toBe(b.da)
      await conferma(p)
      expect(await statoAnno(b.da)).toEqual({ stato: 'in_chiusura', domande_aperte: false })
      expect((await statoAnno(b.a)).stato).toBe('corrente')
      expect(await una<string>(b.db, `SELECT public.anno_attivo($1)::text`, [SEDE_E2E])).toBe(b.a)
      const storia = await b.db.query<{ anno_sede_id: string; stato: string; da: string }>(
        `SELECT anno_sede_id, stato, da FROM public.anni_sede_stati WHERE anno_sede_id = ANY ($1::uuid[]) AND da = $2 ORDER BY dal, stato`, [[b.da, b.a], UTENTE])
      expect(storia.rows.map((x) => x.stato)).toEqual(expect.arrayContaining(['corrente', 'in_chiusura']))
      const stato = await b.db.query<{ stato: string; confermato_da: string }>(`SELECT stato, confermato_da FROM public.passaggi_anno WHERE id = $1`, [p])
      expect(stato.rows[0]).toEqual({ stato: 'confermato', confermato_da: UTENTE })
    })
  })

  it('ogni bambino finisce dove l’anteprima diceva', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await correggi(p, BAMBINI.continuaB, 'continua', b.sezioni.girasoliNuova)
      const r = await conferma(p)
      expect(r.conteggi).toEqual({ continuano: 4, nuovi: 3, usciti: 3, cambia_grado: 1, docenti_copiati: 2 })

      // (giro 2, R6) Fra la conferma e l'inizio la scheda NON si sposta: chi continua è ancora sulla classe vecchia, chi è nuovo è «in arrivo».
      expect((await alunno(BAMBINI.continua)).section_id, 'prima dell’inizio').toBe(b.sezioni.girasoli)
      expect((await alunno(BAMBINI.nuova)).stato, 'prima dell’inizio').toBe('in_arrivo')
      const giro = await ricopia()
      expect(giro.passaggi).toBe(1)
      expect((await ricopia()).passaggi, 'idempotente: rifatta non trova niente').toBe(0)

      const fine = await una<string>(b.db, `SELECT fine::text FROM public.anni_sede WHERE id = $1`, [b.da])
      // chi esce: la frequenza vecchia si chiude alla fine dell'anno, la scheda segue
      for (const nome of ['no', 'nonRisposto', 'cambiaGradoSenzaSezione'] as const) {
        const f = await frequenza(BAMBINI[nome], b.da)
        expect({ nome, stato: f.stato, uscita: f.data_uscita }).toEqual({ nome, stato: 'uscito', uscita: fine })
        expect((await alunno(BAMBINI[nome])).stato, nome).toBe('ritirato')
      }
      // chi continua: la frequenza nuova è viva e la scheda porta la classe nuova
      expect((await alunno(BAMBINI.continua)).section_id).toBe(b.sezioni.girasoliNuova)
      expect((await alunno(BAMBINI.continuaB)).section_id, 'la classe scelta a mano').toBe(b.sezioni.girasoliNuova)
      expect((await frequenza(BAMBINI.continuaB, b.a)).section_id).toBe(b.sezioni.girasoliNuova)
      expect((await frequenza(BAMBINI.continuaAltraSezione, b.a)).section_id).toBe(b.sezioni.girasoliNuova)
      expect((await alunno(BAMBINI.cambiaGradoConSezione)).section_id).toBe(b.sezioni.primaria)
      // i nuovi: l'“in arrivo” è arrivato
      for (const nome of ['nuova', 'ritornato', 'inArrivoConConferma'] as const) {
        expect((await alunno(BAMBINI[nome])).stato, nome).toBe('iscritto')
      }
      // il “ritirato” dalla tendina, tenuto dalla segreteria: «continua» è una decisione esplicita, la scheda torna iscritta (giro 1, R2)
      expect((await alunno(BAMBINI.ritiratoTendina)).stato).toBe('iscritto')
      expect((await frequenza(BAMBINI.ritiratoTendina, b.a)).stato).toBe('in_attesa')
      // chi non era nel passaggio non si tocca
      expect((await frequenza(BAMBINI.ritiratoArchiviato, b.da)).stato).toBe('ritirato')
    })
  })

  it('i docenti entrano nelle classi nuove, e la didattica segue', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`INSERT INTO public.materie (scuola_id, section_id, nome, codice) VALUES ($1, $2, 'Italiano', 'ita')`, [SEDE_E2E, b.sezioni.girasoli])
      const p = await prepara()
      await conferma(p)
      const righe = await b.db.query<{ utente_id: string; section_id: string }>(
        `SELECT utente_id, section_id FROM public.utenti_sezioni WHERE section_id = ANY ($1::uuid[]) ORDER BY utente_id`, [[b.sezioni.girasoliNuova, b.sezioni.farfalleNuova]])
      expect(righe.rows).toEqual([
        { utente_id: DOCENTE_1, section_id: b.sezioni.girasoliNuova },
        { utente_id: DOCENTE_2, section_id: b.sezioni.farfalleNuova },
      ])
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.materie WHERE section_id = $1`, [b.sezioni.girasoliNuova])).toBe(1)
    })
  })

  it('un “esce” scelto a mano ritira anche la frequenza nuova viva', async () => {
    await inRollback(b.db, async () => {
      const p = await anteprima()
      await correggi(p, BAMBINI.ritiratoTendina, 'esce', null)
      await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce', null)
      await correggi(p, BAMBINI.continuaB, 'esce', null)
      await conferma(p)
      const f = await frequenza(BAMBINI.continuaB, b.a)
      expect(f.stato).toBe('ritirato')
      expect(f.data_uscita).not.toBeNull()
      expect((await frequenza(BAMBINI.continuaB, b.da)).stato).toBe('uscito')
      expect((await alunno(BAMBINI.continuaB)).stato).toBe('ritirato')
    })
  })

  it('rifatta: gia_confermato e nessuna scrittura', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      const uno = await conferma(p)
      expect(uno.gia_confermato).toBe(false)
      const prima = await fotografia()
      const due = await conferma(p)
      expect(due.gia_confermato).toBe(true)
      expect(due.conteggi).toEqual(uno.conteggi)
      expect(await fotografia()).toBe(prima)
    })
  })

  it('non tocca le altre sedi', async () => {
    await inRollback(b.db, async () => {
      const prima = JSON.stringify([
        (await b.db.query(`SELECT id, stato, domande_aperte FROM public.anni_sede WHERE scuola_id = ANY ($1::uuid[]) ORDER BY id`, [[SEDE_SIM, SEDE_VERA]])).rows,
        (await b.db.query(`SELECT id, stato, data_uscita FROM public.frequenze WHERE scuola_id = ANY ($1::uuid[]) ORDER BY id`, [[SEDE_SIM, SEDE_VERA]])).rows,
      ])
      await conferma(await prepara())
      expect(JSON.stringify([
        (await b.db.query(`SELECT id, stato, domande_aperte FROM public.anni_sede WHERE scuola_id = ANY ($1::uuid[]) ORDER BY id`, [[SEDE_SIM, SEDE_VERA]])).rows,
        (await b.db.query(`SELECT id, stato, data_uscita FROM public.frequenze WHERE scuola_id = ANY ($1::uuid[]) ORDER BY id`, [[SEDE_SIM, SEDE_VERA]])).rows,
      ])).toBe(prima)
    })
  })

  it('le invarianti dell’anno non peggiorano con la conferma', async () => {
    await inRollback(b.db, async () => {
      const elenco = async () => {
        const r = await b.db.query<{ invariante: string; tabella: string; righe: number }>(`SELECT * FROM public.anno_invarianti()`)
        return r.rows.filter((x) => Number(x.righe) > 0).map((x) => `${x.invariante}|${x.tabella}|${x.righe}`).sort()
      }
      const p = await prepara()
      const prima = await elenco()
      await conferma(p)
      expect(await elenco(), 'nessuna invariante nuova rotta').toEqual(prima)
    })
  })

  it('un solo anno `corrente` per sede, anche se il vecchio era già in chiusura', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [b.da])
      await conferma(await prepara())
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.anni_sede WHERE scuola_id = $1 AND stato = 'corrente'`, [SEDE_E2E])).toBe(1)
      expect((await statoAnno(b.da)).stato).toBe('in_chiusura')
    })
  })

  it('o cambia tutto o non cambia niente: un guasto a metà strada lascia il database com’era', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      const prima = await fotografia()
      // un guasto al passo 6: l'anno vecchio non può più passare a `in_chiusura`
      await b.db.exec(`ALTER TABLE public.anni_sede ADD CONSTRAINT prova_guasto CHECK (stato <> 'in_chiusura')`)
      expect(await errore(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])).not.toBe('nessun-errore')
      await b.db.exec(`ALTER TABLE public.anni_sede DROP CONSTRAINT prova_guasto`)
      expect(await fotografia(), 'le uscite e i docenti del passo 2-3 sono tornati indietro').toBe(prima)
    })
  })
})

describe('passaggio_annulla', () => {
  it('riporta tutto com’era: anni, frequenze, schede e docenti', async () => {
    await inRollback(b.db, async () => {
      const prima0 = await fotografia()
      const p = await prepara()
      await conferma(p)
      expect(await fotografia()).not.toBe(prima0)
      const r = await annulla(p)
      expect(r.gia_annullato).toBeUndefined()
      expect(await statoAnno(b.da)).toEqual({ stato: 'corrente', domande_aperte: true })
      expect((await statoAnno(b.a)).stato).toBe('iscrizioni_aperte')
      expect((await frequenza(BAMBINI.no, b.da)).stato).toBe('iscritto')
      expect((await frequenza(BAMBINI.no, b.da)).data_uscita).toBeNull()
      expect((await alunno(BAMBINI.no)).archiviato).toBe(false)
      expect((await frequenza(BAMBINI.cambiaGradoSenzaSezione, b.a)).stato, 'il ritiro per eccezione è disfatto').toBe('in_attesa')
      expect(await una<string>(b.db, `SELECT stato FROM public.passaggi_anno WHERE id = $1`, [p])).toBe('annullato')
      // i bambini “nuovi” tornano “in arrivo”, senza classe
      for (const nome of ['nuova', 'ritornato', 'inArrivoConConferma'] as const) {
        const a = await alunno(BAMBINI[nome])
        expect({ nome, stato: a.stato, classe: a.section_id }).toEqual({ nome, stato: 'in_arrivo', classe: null })
      }
      expect(await fotografia()).toBe(prima0)
    })
  })

  it('rifatta: gia_annullato', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      await annulla(p)
      expect((await annulla(p)).gia_annullato).toBe(true)
    })
  })

  it('un’anteprima si scarta', async () => {
    await inRollback(b.db, async () => {
      const p = await anteprima()
      const prima = await fotografia()
      await annulla(p)
      expect(await una<string>(b.db, `SELECT stato FROM public.passaggi_anno WHERE id = $1`, [p])).toBe('annullato')
      expect(await fotografia()).toBe(prima)
      // e se ne può fare un'altra
      expect(await anteprima()).not.toBe(p)
    })
  })

  it('con righe d’uso nel nuovo anno → PASSAGGIO_NON_ANNULLABILE, con i conteggi per tabella, e niente cambia', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      const inizio = await una<string>(b.db, `SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [b.a])
      await b.db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3), ($1, $2, $3::date + 1)`, [BAMBINI.continua, SEDE_E2E, inizio])
      const prima = await fotografia()
      const e = await conDettaglio(`SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])
      expect(e.message).toBe('PASSAGGIO_NON_ANNULLABILE')
      expect(e.detail).toEqual({ presenze: 2 })
      expect(await fotografia()).toBe(prima)
      expect(await una<string>(b.db, `SELECT stato FROM public.passaggi_anno WHERE id = $1`, [p])).toBe('confermato')
    })
  })

  it('le copie didattiche restano', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`INSERT INTO public.materie (scuola_id, section_id, nome, codice) VALUES ($1, $2, 'Italiano', 'ita')`, [SEDE_E2E, b.sezioni.girasoli])
      const p = await prepara()
      await conferma(p)
      await annulla(p)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.materie WHERE section_id = $1`, [b.sezioni.girasoliNuova])).toBe(1)
    })
  })

  it('toglie solo le assegnazioni dei docenti che la conferma ha scritto', async () => {
    await inRollback(b.db, async () => {
      // DOCENTE_1 era già sulla classe nuova prima del passaggio: l'annullamento non la deve togliere
      await b.db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOCENTE_1, b.sezioni.girasoliNuova])
      const p = await prepara()
      await conferma(p)
      await annulla(p)
      const classi = await b.db.query<{ utente_id: string; section_id: string }>(
        `SELECT utente_id, section_id FROM public.utenti_sezioni WHERE section_id = ANY ($1::uuid[]) ORDER BY utente_id`, [[b.sezioni.girasoliNuova, b.sezioni.farfalleNuova]])
      expect(classi.rows).toEqual([{ utente_id: DOCENTE_1, section_id: b.sezioni.girasoliNuova }])
    })
  })

  it('il vecchio non torna `corrente` se era già in chiusura, o se oggi è oltre la fine', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [b.da])
      const p = await prepara()
      await conferma(p)
      await annulla(p)
      expect((await statoAnno(b.da)).stato).toBe('in_chiusura')
      expect((await statoAnno(b.a)).stato).toBe('iscrizioni_aperte')
    })
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      const dopo = await una<string>(b.db, `SELECT (fine + 1)::text FROM public.anni_sede WHERE id = $1`, [b.da])
      await annulla(p, dopo)
      expect((await statoAnno(b.da)).stato).toBe('in_chiusura')
    })
  })
})

describe('passaggio_conferma_tardiva', () => {
  it('prima della conferma → PASSAGGIO_NON_PRONTO; su chi continua → RIGA_NON_VALIDA', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, NULL::uuid, $3::uuid, $4::date)`, [p, BAMBINI.no, UTENTE, b.oggi])).toBe('PASSAGGIO_NON_PRONTO')
      await conferma(p)
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, NULL::uuid, $3::uuid, $4::date)`, [p, BAMBINI.continua, UTENTE, b.oggi])).toBe('RIGA_NON_VALIDA')
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, NULL::uuid, $3::uuid, $4::date)`, [p, BAMBINI.ritiratoArchiviato, UTENTE, b.oggi])).toBe('RIGA_NON_VALIDA')
    })
  })

  it('dopo l’inizio: crea la frequenza di conferma nella continuazione della classe, con la voce della quota, e la scheda torna viva', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      await ricopia() // da qui `giorno_roma` è il giorno dell'inizio
      expect((await alunno(BAMBINI.no)).archiviato).toBe(true)
      const r = await tardiva(p, BAMBINI.no, null, b.inizio)
      expect(r.creata).toBe(true)
      expect(r.quota).toBe('creata')
      expect(r.pagamento_id).not.toBeNull()
      const f = await frequenza(BAMBINI.no, b.a)
      const vecchia = await frequenza(BAMBINI.no, b.da)
      expect({ tipo: f.tipo, origine: f.origine, stato: f.stato, sezione: f.section_id, continua_da: f.continua_da }).toEqual({
        tipo: 'conferma', origine: 'passaggio', stato: 'in_attesa', sezione: b.sezioni.girasoliNuova, continua_da: vecchia.id })
      expect(vecchia.stato, 'la storia dell’anno vecchio resta').toBe('uscito')
      expect(await alunno(BAMBINI.no)).toMatchObject({ stato: 'iscritto', archiviato: false, section_id: b.sezioni.girasoliNuova })
      expect(await una<boolean>(b.db, `SELECT eccezione FROM public.passaggi_anno_righe WHERE passaggio_id = $1 AND alunno_id = $2`, [p, BAMBINI.no])).toBe(true)
    })
  })

  it('(giro 2, N3) nella finestra la tardiva entra all’inizio: la scheda resta com’è, la voce nasce con la ricopia', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      const r = await tardiva(p, BAMBINI.no)
      expect(r.creata).toBe(true)
      expect(r.quota, 'la voce non nasce su una scheda archiviata').toBe('rimandata_all_inizio')
      expect((await frequenza(BAMBINI.no, b.a)).stato).toBe('in_attesa')
      expect((await alunno(BAMBINI.no)).archiviato, 'fino all’inizio la scheda resta ritirata').toBe(true)
      const giro = await ricopia()
      expect(giro.quote, 'la ricopia crea la voce rimasta').toBe(1)
      expect(await alunno(BAMBINI.no)).toMatchObject({ stato: 'iscritto', archiviato: false, section_id: b.sezioni.girasoliNuova })
      expect(await una<string | null>(b.db, `SELECT quota_pagamento_id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.no, b.a])).not.toBeNull()
    })
  })

  it('rifatta: creata false, nessuna seconda voce', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      const uno = await tardiva(p, BAMBINI.nonRisposto)
      const due = await tardiva(p, BAMBINI.nonRisposto)
      expect(due).toMatchObject({ frequenza_id: uno.frequenza_id, creata: false, pagamento_id: uno.pagamento_id })
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nonRisposto, b.a])).toBe(1)
    })
  })

  it('riapre la frequenza nuova ritirata da un “esce” scelto a mano', async () => {
    await inRollback(b.db, async () => {
      const p = await anteprima()
      await correggi(p, BAMBINI.ritiratoTendina, 'esce', null)
      await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce', null)
      await correggi(p, BAMBINI.continuaB, 'esce', null)
      await conferma(p)
      expect((await frequenza(BAMBINI.continuaB, b.a)).stato).toBe('ritirato')
      const r = await tardiva(p, BAMBINI.continuaB)
      expect(r.creata).toBe(true)
      const f = await frequenza(BAMBINI.continuaB, b.a)
      expect(f.stato).toBe('in_attesa')
      expect(f.data_uscita).toBeNull()
      expect(f.section_id).toBe(b.sezioni.farfalleNuova)
    })
  })

  it('una scheda anonimizzata non rientra', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      await b.db.query(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = $1`, [BAMBINI.no])
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, NULL::uuid, $3::uuid, $4::date)`, [p, BAMBINI.no, UTENTE, b.oggi])).toBe('RIGA_NON_VALIDA')
    })
  })

  it('una classe scelta a mano vale; di un’altra sede o di un altro anno no', async () => {
    await inRollback(b.db, async () => {
      const p = await prepara()
      await conferma(p)
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date)`, [p, BAMBINI.no, b.sezioni.simNuova, UTENTE, b.oggi])).toBe('SEDE_DIVERSA')
      expect(await errore(b.db, `SELECT public.passaggio_conferma_tardiva($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date)`, [p, BAMBINI.no, b.sezioni.girasoli, UTENTE, b.oggi])).toBe('SEZIONE_DI_ALTRO_ANNO')
      const r = await tardiva(p, BAMBINI.no, b.sezioni.farfalleNuova)
      expect((await frequenza(BAMBINI.no, b.a)).section_id).toBe(b.sezioni.farfalleNuova)
      expect(r.creata).toBe(true)
    })
  })
})

describe('misura: la conferma su 400 bambini', () => {
  it('quanto ci mette la transazione unica (il numero va nell’esito)', async () => {
    await inRollback(b.db, async () => {
      const N = 400
      // 400 bambini finti nella classe vecchia, 300 confermati dalla famiglia e 100 senza risposta
      await b.db.query(
        `INSERT INTO public.alunni (id, scuola_id, stato, section_id)
         SELECT ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, $1, 'iscritto', $2 FROM generate_series(1, $3) g`,
        [SEDE_E2E, b.sezioni.girasoli, N])
      await b.db.query(
        `SELECT public.anno_conferma(f.id, $2::uuid, NULL::uuid, $3::uuid, false)
           FROM public.frequenze f
          WHERE f.anno_sede_id = $1 AND f.alunno_id::text LIKE 'aaaaaaaa-aaaa-4aaa-8aaa-%'
            AND right(f.alunno_id::text, 12)::int <= 300`,
        [b.da, b.a, UTENTE])
      const p = await prepara()
      const t0 = performance.now()
      const r = await conferma(p)
      const ms = Math.round(performance.now() - t0)
      // il numero resta nel log del test: lo legge chi scrive l'esito
      process.stdout.write(`MISURA passaggio_conferma su ${N} bambini finti (PGlite): ${ms} ms\n`)
      expect(r.conteggi.continuano).toBeGreaterThanOrEqual(300)
      expect(r.conteggi.usciti).toBeGreaterThanOrEqual(100)
      expect(ms).toBeLessThan(60_000)
    })
  }, 180_000)
})
