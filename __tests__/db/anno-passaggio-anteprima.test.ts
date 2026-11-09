import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  BAMBINI, BAMBINI_SIM, DOCENTE_1, DOCENTE_2, SEDE_E2E, SEDE_SIM, UTENTE, creaBancoPassaggio, errore, inRollback, una,
  type BancoPassaggio,
} from '../helpers/passaggio-banco'

/**
 * COMPITO 4.8.1 · M48a, l'anteprima del passaggio e le eccezioni. PGlite, un solo banco per file, ogni prova in una transazione che
 * finisce in ROLLBACK. Solo uuid inventati. Il giorno del passaggio (`b.oggi`) viene dal database, mai scritto qui.
 */

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio()
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

interface Esito {
  passaggio_id: string
  creato: boolean
  righe: Record<'continua' | 'cambia_grado' | 'nuova' | 'esce' | 'non_risposto', number>
  avvisi: Record<'ritirato_tendina' | 'senza_sezione', number>
  docenti: { copiati: number }
  apribile_dal: string
}
interface Riga { alunno_id: string; esito: string; avviso: string | null; eccezione: boolean; sezione_a_id: string | null; frequenza_a_id: string | null; modificata_da: string | null }

const anteprima = (oggi: string | null = null, da = b.da, a = b.a) =>
  una<Esito>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [da, a, UTENTE, oggi])

async function righe(passaggio: string): Promise<Record<string, Riga>> {
  const r = await b.db.query<Riga>(
    `SELECT alunno_id, esito, avviso, eccezione, sezione_a_id, frequenza_a_id, modificata_da FROM public.passaggi_anno_righe WHERE passaggio_id = $1`,
    [passaggio])
  return Object.fromEntries(r.rows.map((x) => [x.alunno_id, x]))
}

const correggi = (p: string, alunno: string, esito: string | null, sezione: string | null) =>
  una<{ alunno_id: string; esito: string; eccezione: boolean }>(
    b.db, `SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`, [p, alunno, esito, sezione, UTENTE])
const correggiErrore = (p: string, alunno: string, esito: string | null, sezione: string | null) =>
  errore(b.db, `SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid)`, [p, alunno, esito, sezione, UTENTE])

/** Tutto quello che l'anteprima NON deve cambiare, in un solo testo confrontabile. */
async function fotografia(): Promise<string> {
  const q = async (sql: string, params: unknown[] = []) => JSON.stringify((await b.db.query(sql, params)).rows)
  return [
    await q(`SELECT id, stato, section_id, data_uscita FROM public.frequenze ORDER BY id`),
    await q(`SELECT id, stato, section_id FROM public.alunni ORDER BY id`),
    await q(`SELECT id, stato, domande_aperte FROM public.anni_sede ORDER BY id`),
    await q(`SELECT public.anno_attivo($1) AS a`, [SEDE_E2E]),
    await q(`SELECT * FROM public.sezioni_visibili_docente($1) ORDER BY section_id`, [DOCENTE_1]),
    await q(`SELECT * FROM public.sezioni_visibili_docente($1) ORDER BY section_id`, [DOCENTE_2]),
    await q(`SELECT utente_id, section_id FROM public.utenti_sezioni ORDER BY utente_id, section_id`),
  ].join('\n')
}

describe('passaggio_anteprima: un bambino per ogni esito', () => {
  it('ogni bambino del banco finisce nella riga giusta', async () => {
    await inRollback(b.db, async () => {
      const r = await anteprima()
      const x = await righe(r.passaggio_id)
      const atteso: Record<string, [string, string | null]> = {
        continua: ['continua', null],
        continuaB: ['continua', null],
        continuaAltraSezione: ['continua', null],
        nuova: ['nuova', null],
        no: ['esce', null],
        nonRisposto: ['non_risposto', null],
        ritiratoTendina: ['continua', 'ritirato_tendina'],
        ritornato: ['nuova', null],
        inArrivoConConferma: ['nuova', null],
        cambiaGradoConSezione: ['cambia_grado', null],
        cambiaGradoSenzaSezione: ['cambia_grado', 'senza_sezione'],
      }
      for (const [nome, [esito, avviso]] of Object.entries(atteso)) {
        const riga = x[BAMBINI[nome as keyof typeof BAMBINI]]
        expect(riga, nome).toBeDefined()
        expect({ nome, esito: riga.esito, avviso: riga.avviso }).toEqual({ nome, esito, avviso })
      }
      expect(x[BAMBINI.ritiratoArchiviato], 'archiviato senza iscrizione nuova: fuori dal passaggio').toBeUndefined()
      expect(Object.keys(x)).toHaveLength(Object.keys(atteso).length)
      expect(Object.keys(x).includes(BAMBINI_SIM.continua), 'l’altra sede non entra').toBe(false)
    })
  })

  it('le sezioni nuove sono quelle delle frequenze nuove', async () => {
    await inRollback(b.db, async () => {
      const x = await righe((await anteprima()).passaggio_id)
      expect(x[BAMBINI.continua].sezione_a_id).toBe(b.sezioni.girasoliNuova)
      expect(x[BAMBINI.continuaB].sezione_a_id).toBe(b.sezioni.farfalleNuova)
      expect(x[BAMBINI.continuaAltraSezione].sezione_a_id).toBe(b.sezioni.girasoliNuova)
      expect(x[BAMBINI.cambiaGradoConSezione].sezione_a_id).toBe(b.sezioni.primaria)
      expect(x[BAMBINI.cambiaGradoSenzaSezione].sezione_a_id).toBeNull()
      expect(x[BAMBINI.no].sezione_a_id).toBeNull()
      expect(x[BAMBINI.nonRisposto].sezione_a_id).toBeNull()
    })
  })

  it('il risultato conta righe e avvisi, e mostra a parte i “non risposto”', async () => {
    await inRollback(b.db, async () => {
      const r = await anteprima()
      expect(r.creato).toBe(true)
      expect(r.righe).toEqual({ continua: 4, cambia_grado: 2, nuova: 3, esce: 1, non_risposto: 1 })
      expect(r.avvisi).toEqual({ ritirato_tendina: 1, senza_sezione: 1 })
      expect(r.apribile_dal).toBe(b.oggi)
    })
  })

  it('un bambino con la scheda “in arrivo” e una frequenza nuova è `nuova`, anche se la sua frequenza è di tipo conferma', async () => {
    await inRollback(b.db, async () => {
      const x = await righe((await anteprima()).passaggio_id)
      expect(x[BAMBINI.inArrivoConConferma].esito).toBe('nuova')
      expect(x[BAMBINI.nuova].esito).toBe('nuova')
    })
  })

  it('un ex alunno archiviato che torna “in arrivo” è `nuova`, non `esce`', async () => {
    await inRollback(b.db, async () => {
      const x = await righe((await anteprima()).passaggio_id)
      expect(x[BAMBINI.ritornato].esito).toBe('nuova')
    })
  })

  it('il “ritirato” dalla tendina con la frequenza nuova viva ha un avviso e NON è `esce`', async () => {
    await inRollback(b.db, async () => {
      const x = await righe((await anteprima()).passaggio_id)
      expect(x[BAMBINI.ritiratoTendina].esito).not.toBe('esce')
      expect(x[BAMBINI.ritiratoTendina].avviso).toBe('ritirato_tendina')
    })
  })

  it('il “ritirato” dalla tendina SENZA frequenza nuova viva esce', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`UPDATE public.alunni SET stato = 'ritirato' WHERE id = $1`, [BAMBINI.nonRisposto])
      const x = await righe((await anteprima()).passaggio_id)
      expect(x[BAMBINI.nonRisposto].esito).toBe('esce')
    })
  })
})

describe('passaggio_anteprima: non cambia niente di quello che si vede', () => {
  it('visibilità, sezioni, stati e anno attivo sono identici prima e dopo', async () => {
    await inRollback(b.db, async () => {
      const prima = await fotografia()
      await anteprima()
      await anteprima()
      expect(await fotografia()).toBe(prima)
    })
  })

  it('scrive solo nelle tre tabelle del passaggio', async () => {
    await inRollback(b.db, async () => {
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno`)).toBe(0)
      await anteprima()
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno`)).toBe(1)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno WHERE stato = 'anteprima'`)).toBe(1)
    })
  })
})

describe('passaggio_anteprima: rifatta', () => {
  it('due volte: stesso passaggio, stesse righe, creato:false', async () => {
    await inRollback(b.db, async () => {
      const uno = await anteprima()
      const prima = await righe(uno.passaggio_id)
      const due = await anteprima()
      expect(due.passaggio_id).toBe(uno.passaggio_id)
      expect(due.creato).toBe(false)
      expect(await righe(due.passaggio_id)).toEqual(prima)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno`)).toBe(1)
    })
  })

  it('dopo una conferma registrata da “Conferme” la riga passa da `non_risposto` a `continua`', async () => {
    await inRollback(b.db, async () => {
      const uno = await anteprima()
      expect((await righe(uno.passaggio_id))[BAMBINI.nonRisposto].esito).toBe('non_risposto')
      const freq = await una<string>(b.db, `SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nonRisposto, b.da])
      await b.db.query(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL::uuid, $3::uuid, false)`, [freq, b.a, UTENTE])
      const due = await anteprima()
      expect(due.passaggio_id).toBe(uno.passaggio_id)
      const x = (await righe(due.passaggio_id))[BAMBINI.nonRisposto]
      expect(x.esito).toBe('continua')
      expect(x.sezione_a_id).toBe(b.sezioni.farfalleNuova)
    })
  })

  it('un bambino che esce dal giro (la sua iscrizione nuova è ritirata e lui non frequentava) sparisce dalle righe', async () => {
    await inRollback(b.db, async () => {
      const uno = await anteprima()
      expect((await righe(uno.passaggio_id))[BAMBINI.nuova]).toBeDefined()
      await b.db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE alunno_id = $1 AND anno_sede_id = $2`, [BAMBINI.nuova, b.a])
      const due = await anteprima()
      expect((await righe(due.passaggio_id))[BAMBINI.nuova]).toBeUndefined()
    })
  })

  it('con un passaggio annullato se ne può fare uno nuovo; uno solo per coppia non annullato', async () => {
    await inRollback(b.db, async () => {
      const uno = await anteprima()
      await b.db.query(`UPDATE public.passaggi_anno SET stato = 'annullato', annullato_il = now() WHERE id = $1`, [uno.passaggio_id])
      const due = await anteprima()
      expect(due.creato).toBe(true)
      expect(due.passaggio_id).not.toBe(uno.passaggio_id)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno WHERE stato <> 'annullato'`)).toBe(1)
    })
  })

  it('su un passaggio già confermato → PASSAGGIO_GIA_CONFERMATO', async () => {
    await inRollback(b.db, async () => {
      const uno = await anteprima()
      await b.db.query(`UPDATE public.passaggi_anno SET stato = 'confermato', confermato_il = now() WHERE id = $1`, [uno.passaggio_id])
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).toBe('PASSAGGIO_GIA_CONFERMATO')
    })
  })
})

describe('passaggio_riga_correggi', () => {
  it('cambia la sezione, mette l’eccezione e chiude l’avviso “senza sezione”', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      expect((await righe(p))[BAMBINI.cambiaGradoSenzaSezione].avviso).toBe('senza_sezione')
      const r = await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'cambia_grado', b.sezioni.primaria)
      expect(r).toEqual({ alunno_id: BAMBINI.cambiaGradoSenzaSezione, esito: 'cambia_grado', eccezione: true })
      const x = (await righe(p))[BAMBINI.cambiaGradoSenzaSezione]
      expect(x.sezione_a_id).toBe(b.sezioni.primaria)
      expect(x.avviso).toBeNull()
      expect(x.eccezione).toBe(true)
      expect(x.modificata_da).toBe(UTENTE)
    })
  })

  it('l’avviso del “ritirato” si chiude quando la segreteria decide', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await correggi(p, BAMBINI.ritiratoTendina, 'esce', null)
      const x = (await righe(p))[BAMBINI.ritiratoTendina]
      expect(x.esito).toBe('esce')
      expect(x.avviso).toBeNull()
      expect(x.eccezione).toBe(true)
      expect(x.frequenza_a_id, 'la frequenza nuova viva resta indicata: la conferma la ritira').not.toBeNull()
    })
  })

  it('una sezione di grado diverso cambia l’esito in `cambia_grado` e una dello stesso grado in `continua`', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await correggi(p, BAMBINI.continua, 'continua', b.sezioni.primaria)
      expect((await righe(p))[BAMBINI.continua].esito).toBe('cambia_grado')
      await correggi(p, BAMBINI.continua, 'cambia_grado', b.sezioni.farfalleNuova)
      expect((await righe(p))[BAMBINI.continua].esito).toBe('continua')
    })
  })

  it('la correzione di una sezione sopravvive a un’anteprima rifatta', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await correggi(p, BAMBINI.continuaB, 'continua', b.sezioni.girasoliNuova)
      await anteprima()
      const x = (await righe(p))[BAMBINI.continuaB]
      expect(x.sezione_a_id).toBe(b.sezioni.girasoliNuova)
      expect(x.eccezione).toBe(true)
    })
  })

  it('una sezione sparita fa tornare la riga al calcolo', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      const effimera = await una<string>(
        b.db,
        `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Effimera', 'infanzia'::public.school_type_enum, 'infanzia') RETURNING id`,
        [SEDE_E2E, b.annoA])
      await correggi(p, BAMBINI.continuaB, 'continua', effimera)
      expect((await righe(p))[BAMBINI.continuaB].sezione_a_id).toBe(effimera)
      await b.db.query(`DELETE FROM public.sections WHERE id = $1`, [effimera])
      await anteprima()
      const x = (await righe(p))[BAMBINI.continuaB]
      expect(x.sezione_a_id).toBe(b.sezioni.farfalleNuova)
      expect(x.eccezione).toBe(false)
    })
  })

  it('un “esce” scelto a mano sopravvive a un’anteprima rifatta', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await correggi(p, BAMBINI.continuaB, 'esce', null)
      await anteprima()
      const x = (await righe(p))[BAMBINI.continuaB]
      expect(x.esito).toBe('esce')
      expect(x.eccezione).toBe(true)
    })
  })

  it('`nuova → esce` e `esce → continua` (e `non_risposto → continua`) sono RIGA_NON_VALIDA', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      expect(await correggiErrore(p, BAMBINI.nuova, 'esce', null)).toBe('RIGA_NON_VALIDA')
      expect(await correggiErrore(p, BAMBINI.no, 'continua', null)).toBe('RIGA_NON_VALIDA')
      expect(await correggiErrore(p, BAMBINI.nonRisposto, 'continua', null)).toBe('RIGA_NON_VALIDA')
      expect(await correggiErrore(p, BAMBINI.continua, 'banana', null)).toBe('RIGA_NON_VALIDA')
      expect(await correggiErrore(p, BAMBINI.no, 'esce', b.sezioni.girasoliNuova), 'una sezione a chi esce non ha senso').toBe('RIGA_NON_VALIDA')
      expect(await correggiErrore(p, BAMBINI.ritiratoArchiviato, 'esce', null), 'chi non è nel passaggio').toBe('RIGA_NON_VALIDA')
      // nessuna di queste ha lasciato una eccezione
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno_righe WHERE eccezione`)).toBe(0)
    })
  })

  it('una sezione di un’altra sede → SEDE_DIVERSA; di un altro anno → SEZIONE_DI_ALTRO_ANNO; inesistente → RIGA_NON_VALIDA', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      expect(await correggiErrore(p, BAMBINI.continua, 'continua', b.sezioni.simNuova)).toBe('SEDE_DIVERSA')
      expect(await correggiErrore(p, BAMBINI.continua, 'continua', b.sezioni.girasoli)).toBe('SEZIONE_DI_ALTRO_ANNO')
      expect(await correggiErrore(p, BAMBINI.continua, 'continua', '00000000-0000-4000-8000-00000000dead')).toBe('RIGA_NON_VALIDA')
    })
  })

  it('un passaggio che non c’è → PASSAGGIO_NON_TROVATO; non più in anteprima → PASSAGGIO_NON_MODIFICABILE', async () => {
    await inRollback(b.db, async () => {
      expect(await correggiErrore('00000000-0000-4000-8000-00000000dead', BAMBINI.continua, 'continua', null)).toBe('PASSAGGIO_NON_TROVATO')
      const p = (await anteprima()).passaggio_id
      await b.db.query(`UPDATE public.passaggi_anno SET stato = 'confermato', confermato_il = now() WHERE id = $1`, [p])
      expect(await correggiErrore(p, BAMBINI.continua, 'continua', b.sezioni.girasoliNuova)).toBe('PASSAGGIO_NON_MODIFICABILE')
    })
  })
})

describe('docenti del passaggio', () => {
  const docenti = async (p: string) =>
    (await b.db.query<{ utente_id: string; sezione_a_id: string; origine: string }>(
      `SELECT utente_id, sezione_a_id, origine FROM public.passaggi_anno_docenti WHERE passaggio_id = $1 ORDER BY utente_id, sezione_a_id`, [p])).rows
  const imposta = (p: string, u: string, s: string, o: string) =>
    una<Record<string, unknown>>(b.db, `SELECT public.passaggio_docente_imposta($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`, [p, u, s, o, UTENTE])
  const impostaErrore = (p: string, u: string, s: string, o: string) =>
    errore(b.db, `SELECT public.passaggio_docente_imposta($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`, [p, u, s, o, UTENTE])

  it('copia i docenti della sezione vecchia sulla sua continuazione, una volta sola', async () => {
    await inRollback(b.db, async () => {
      const r = await anteprima()
      // DOCENTE_1 è su Girasoli (ha continuazione) e su Stelline (non ce l'ha), DOCENTE_2 su Farfalle.
      expect(await docenti(r.passaggio_id)).toEqual([
        { utente_id: DOCENTE_1, sezione_a_id: b.sezioni.girasoliNuova, origine: 'copiata' },
        { utente_id: DOCENTE_2, sezione_a_id: b.sezioni.farfalleNuova, origine: 'copiata' },
      ])
      expect(r.docenti.copiati).toBe(2)
      const due = await anteprima()
      expect((await docenti(due.passaggio_id)).length).toBe(2)
      expect(due.docenti.copiati).toBe(2)
    })
  })

  it('chi è già assegnato alla sezione nuova non compare', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOCENTE_1, b.sezioni.girasoliNuova])
      const r = await anteprima()
      expect(await docenti(r.passaggio_id)).toEqual([{ utente_id: DOCENTE_2, sezione_a_id: b.sezioni.farfalleNuova, origine: 'copiata' }])
    })
  })

  it('`tolta` marca una copiata senza cancellarla, `aggiunta` la ripristina, e un’anteprima rifatta le rispetta', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      const r1 = await imposta(p, DOCENTE_1, b.sezioni.girasoliNuova, 'tolta')
      expect(r1).toMatchObject({ utente_id: DOCENTE_1, sezione_a_id: b.sezioni.girasoliNuova, origine: 'tolta' })
      expect((await docenti(p)).find((x) => x.utente_id === DOCENTE_1)?.origine).toBe('tolta')
      await anteprima()
      expect((await docenti(p)).find((x) => x.utente_id === DOCENTE_1)?.origine, 'rifatta, resta tolta').toBe('tolta')
      await imposta(p, DOCENTE_1, b.sezioni.girasoliNuova, 'aggiunta')
      expect((await docenti(p)).find((x) => x.utente_id === DOCENTE_1)?.origine).toBe('aggiunta')
    })
  })

  it('una aggiunta nuova (un docente su un’altra classe) crea la riga', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await imposta(p, DOCENTE_2, b.sezioni.girasoliNuova, 'aggiunta')
      expect(await docenti(p)).toContainEqual({ utente_id: DOCENTE_2, sezione_a_id: b.sezioni.girasoliNuova, origine: 'aggiunta' })
    })
  })

  it('la sezione dev’essere del nuovo anno e della stessa sede; l’origine un valore ammesso', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      expect(await impostaErrore(p, DOCENTE_1, b.sezioni.girasoli, 'aggiunta')).toBe('SEZIONE_DI_ALTRO_ANNO')
      expect(await impostaErrore(p, DOCENTE_1, b.sezioni.simNuova, 'aggiunta')).toBe('SEDE_DIVERSA')
      expect(await impostaErrore(p, DOCENTE_1, b.sezioni.girasoliNuova, 'copiata')).toBe('RIGA_NON_VALIDA')
    })
  })

  it('su un passaggio non più in anteprima → PASSAGGIO_NON_MODIFICABILE', async () => {
    await inRollback(b.db, async () => {
      const p = (await anteprima()).passaggio_id
      await b.db.query(`UPDATE public.passaggi_anno SET stato = 'confermato', confermato_il = now() WHERE id = $1`, [p])
      expect(await impostaErrore(p, DOCENTE_1, b.sezioni.girasoliNuova, 'tolta')).toBe('PASSAGGIO_NON_MODIFICABILE')
    })
  })
})

describe('passaggio_anteprima: i cancelli', () => {
  it('`p_oggi` su una sede vera → PASSAGGIO_OGGI_NON_AMMESSO e nessuna riga scritta', async () => {
    await inRollback(b.db, async () => {
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [b.vera.da, b.vera.a, UTENTE, b.oggi]))
        .toBe('PASSAGGIO_OGGI_NON_AMMESSO')
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.passaggi_anno`)).toBe(0)
    })
  })

  it('una sede in simulazione ammette `p_oggi`; la sede di prova (e2e) pure', async () => {
    await inRollback(b.db, async () => {
      const r = await una<Esito>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [b.sim.da, b.sim.a, UTENTE, b.oggi])
      expect(r.righe).toEqual({ continua: 1, cambia_grado: 0, nuova: 0, esce: 0, non_risposto: 1 })
      expect(await anteprima(b.oggi)).toMatchObject({ creato: true })
      const x = await b.db.query(`SELECT scuola_id FROM public.passaggi_anno ORDER BY scuola_id::text`)
      expect(x.rows.map((y) => (y as { scuola_id: string }).scuola_id)).toEqual([SEDE_SIM, SEDE_E2E])
    })
  })

  it('“a” che non ha le iscrizioni aperte → PASSAGGIO_NON_PRONTO', async () => {
    await inRollback(b.db, async () => {
      // l'anno nuovo della sede «vera» non è stato aperto
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.vera.da, b.vera.a, UTENTE])).toBe('PASSAGGIO_NON_PRONTO')
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [b.a])
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).toBe('PASSAGGIO_NON_PRONTO')
    })
  })

  it('“da” che non è l’anno attivo, sedi diverse, o anni in ordine inverso → PASSAGGIO_NON_PRONTO', async () => {
    await inRollback(b.db, async () => {
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.sim.da, b.a, UTENTE])).toBe('PASSAGGIO_NON_PRONTO')
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.a, b.da, UTENTE])).toBe('PASSAGGIO_NON_PRONTO')
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.da, UTENTE])).toBe('PASSAGGIO_NON_PRONTO')
    })
  })

  it('un anno che non esiste → ANNO_NON_TROVATO', async () => {
    await inRollback(b.db, async () => {
      expect(await errore(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, ['00000000-0000-4000-8000-00000000dead', b.a, UTENTE])).toBe('ANNO_NON_TROVATO')
    })
  })

  it('le funzioni sono chiuse al pubblico e aperte solo al service_role', async () => {
    for (const f of ['passaggio_calcola(uuid, uuid)', 'passaggio_anteprima(uuid, uuid, uuid, date)', 'passaggio_riga_correggi(uuid, uuid, text, uuid, uuid)', 'passaggio_docente_imposta(uuid, uuid, uuid, text, uuid)']) {
      const r = await b.db.query<{ a: boolean; s: boolean }>(
        `SELECT has_function_privilege('anon', '${f.replace(/'/g, '')}', 'EXECUTE') AS a, has_function_privilege('service_role', '${f}', 'EXECUTE') AS s`)
      expect(r.rows[0], f).toEqual({ a: false, s: true })
    }
  })
})
