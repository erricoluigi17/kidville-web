import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.6 · LA CONFERMA PER L'ANNO PROSSIMO E IL «NON RINNOVA» (migrazione M45c, parte 2), in PGlite vero.
 *
 *  · `anno_conferma` scrive la frequenza `in_attesa` dell'anno aperto a partire da quella viva dell'anno in corso e NON
 *    tocca un dato dell'anno in corso (alunno, classe, frequenza attiva, presenze, sezioni del docente);
 *  · la sezione nuova è la continuazione di quella di partenza, o quella scelta; chi cambia grado la sceglie sempre;
 *  · non riporta la retta personalizzata né la sospensione; riporta i campi di famiglia;
 *  · `anno_non_rinnova` scrive (o azzera) il motivo del solo elenco chiuso, e la conferma resta possibile.
 *
 * Banco: lo stesso di `anno-iscrizione.test.ts` (catena fino a M45c + `SCHEMA_ISCRIZIONE_ANNO`). Il banco non si tocca: le colonne
 * che mancano si aggiungono qui, in `codaPrima`. Ogni prova gira in una transazione che finisce in `ROLLBACK`. Le date sono
 * relative al giorno della transazione (nessuna è scritta nel test). Gli importi (100, 200, 300) sono esempi di prova. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '22222222-2222-4222-8222-222222222223'
const UT = '55555555-5555-4555-8555-555555555551'
const DOC = '66666666-6666-4666-8666-666666666661'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const ALTRA = '11111111-1111-4111-8111-1111111111aa'

type Rec = Record<string, unknown>
let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`
const ANNO: Record<number, string> = {} // anni_scolastici.id

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 40_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il messaggio dell'errore (= il codice), dentro una transazione: un savepoint, così l'errore non la rovina. */
async function errore(sql: string, params: unknown[] = []): Promise<string> {
  await db.exec('SAVEPOINT prima_dell_errore')
  try {
    await db.query(sql, params)
  } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT prima_dell_errore')
    return (e as { message?: string }).message ?? 'senza-messaggio'
  }
  await db.exec('RELEASE SAVEPOINT prima_dell_errore')
  return 'nessun-errore'
}

/** L'anno attivo di S1 e di S2 si allarga attorno a oggi (secondo il database). Va chiamata DENTRO `inRollback`. */
async function giorni() {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40)
      WHERE id = ANY ($1::uuid[])`, [[ANNO_SEDE[`${S1}:2026`], ANNO_SEDE[`${S2}:2026`]]])
}
async function nuovoAlunno(id: string, stato = 'iscritto', sede = S1) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, $3)`, [id, sede, stato])
}
/** Le due quote, un modulo per lista e l'apertura delle iscrizioni del 2027/28 di S1. */
async function apri(): Promise<string> {
  const a = ANNO_SEDE[`${S1}:2027`]
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
  return a
}
async function sezione(anno: number, nome: string, tipo: string, fascia: string | null, continuaDa: string | null = null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [S1, ANNO[anno], nome, tipo, fascia, continuaDa])
}
/** La frequenza viva dell'anno in corso (la scrive lo specchio alla nascita dell'alunno `iscritto`), con la sezione data. */
async function partenza(alunno: string, sezioneId: string | null = null): Promise<string> {
  const id = await una<string>(
    `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id
      WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [alunno])
  if (sezioneId) await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [sezioneId, id])
  return id
}
type Conferma = { frequenza: string; anno?: string; sezione?: string | null; da?: string | null; cambiaGrado?: boolean }
const SQL_CONFERMA =
  `SELECT public.anno_conferma($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::boolean)`
async function conferma(o: Conferma): Promise<Rec> {
  return una<Rec>(SQL_CONFERMA, [o.frequenza, o.anno ?? ANNO_SEDE[`${S1}:2027`], o.sezione ?? null, o.da ?? UT, o.cambiaGrado ?? false])
}
const frequenza = (id: string) => una<Rec>(`SELECT to_jsonb(f) FROM public.frequenze f WHERE f.id = $1`, [id])
const jsonAlunno = (id: string) => una<Rec>(`SELECT to_jsonb(a) FROM public.alunni a WHERE a.id = $1`, [id])
const voce = (id: string) => una<Rec>(`SELECT to_jsonb(p) FROM public.pagamenti p WHERE p.id = $1`, [id])
const conta = (sql: string, params: unknown[] = []) => una<number>(`SELECT count(*)::int FROM (${sql}) x`, params)
const frequenzeNuovoAnno = (alunno: string) =>
  conta(`SELECT 1 FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, ANNO_SEDE[`${S1}:2027`]])
const nonRinnova = (frequenzaId: string, attivo: boolean, motivo: string | null) =>
  una<Rec>(`SELECT public.anno_non_rinnova($1::uuid, $2::boolean, $3, $4::uuid)`, [frequenzaId, attivo, motivo, UT])

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M45c',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0,
        ADD COLUMN archiviato_il timestamptz,
        ADD COLUMN anonimizzato_il timestamptz;
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid;
    `,
  })
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string; anno_id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) {
    ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
    ANNO[x.anno_inizio] = x.anno_id
  }
}, 120_000)
afterAll(async () => { await db?.close() })

describe('anno_conferma: la frequenza dell’anno prossimo', () => {
  prova('una conferma per l’anno prossimo non cambia la classe di oggi', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const f26 = await partenza(AL, s26)
      await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOC, s26])
      await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, section_id, data) VALUES ($1, $2, $3, public.giorno_roma(now()))`, [AL, S1, s26])
      await apri()
      const istantanea = async () => ({
        alunno: await jsonAlunno(AL),
        attiva: await frequenza(f26),
        presenze: await una<Rec[]>(`SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) FROM public.presenze p WHERE p.alunno_id = $1`, [AL]),
        sezioniDocente: await una<Rec[]>(
          `SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.section_id), '[]'::jsonb) FROM public.sezioni_visibili_docente($1) v`, [DOC]),
      })
      const prima = await istantanea()
      expect(prima.alunno.section_id, 'la partenza ha davvero una classe').toBe(s26)
      expect((prima.sezioniDocente as Rec[]).length).toBeGreaterThan(0)

      const r = await conferma({ frequenza: f26 })
      expect(r.creata).toBe(true)
      expect(await frequenza(r.frequenza_id as string)).toMatchObject({
        stato: 'in_attesa', tipo: 'conferma', origine: 'conferma', continua_da: f26, anno_sede_id: ANNO_SEDE[`${S1}:2027`], alunno_id: AL,
      })

      expect(await istantanea(), 'alunno, frequenza attiva, presenze ed elenco del docente identici').toEqual(prima)
    })
  })

  prova('la sezione nuova è la continuazione di quella di partenza', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const s27 = await sezione(2027, 'Girasoli', 'infanzia', 'infanzia', s26)
      await sezione(2027, 'Farfalle', 'infanzia', 'infanzia')
      const f26 = await partenza(AL, s26)
      await apri()
      const r = await conferma({ frequenza: f26 })
      expect((await frequenza(r.frequenza_id as string)).section_id).toBe(s27)
      expect(r.cambia_grado).toBe(false)
    })
  })

  prova('una sezione scelta vince sulla continuazione', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      await sezione(2027, 'Girasoli', 'infanzia', 'infanzia', s26)
      const altra = await sezione(2027, 'Farfalle', 'infanzia', 'infanzia')
      const f26 = await partenza(AL, s26)
      await apri()
      const r = await conferma({ frequenza: f26, sezione: altra })
      expect((await frequenza(r.frequenza_id as string)).section_id).toBe(altra)
    })
  })

  prova('senza continuazione la sezione è NULL e la conferma passa', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      // `apri` copia le sezioni dell'anno in corso (con la loro continuazione): la sezione di partenza nasce DOPO, così non ne ha una
      await apri()
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      await sezione(2027, 'Farfalle', 'infanzia', 'infanzia') // esiste, ma non continua nessuna
      const f26 = await partenza(AL, s26)
      const r = await conferma({ frequenza: f26 })
      expect(r.creata).toBe(true)
      expect((await frequenza(r.frequenza_id as string)).section_id).toBeNull()
    })
  })

  prova('la conferma rifatta non crea né una seconda frequenza né una seconda voce', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      const a = await conferma({ frequenza: f26 })
      const b = await conferma({ frequenza: f26 })
      expect(b).toMatchObject({ creata: false, frequenza_id: a.frequenza_id, pagamento_id: a.pagamento_id })
      expect(await frequenzeNuovoAnno(AL)).toBe(1)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL])).toBe(1)
    })
  })

  prova('la voce nasce dal listino e porta chi l’ha creata (`creato_da`)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      const r = await conferma({ frequenza: f26, da: UT })
      expect(r.quota).toBe('creata')
      expect(await voce(r.pagamento_id as string)).toMatchObject({ alunno_id: AL, importo: 100, creato_da: UT, stato: 'da_pagare' })
      expect((await frequenza(r.frequenza_id as string)).quota_pagamento_id).toBe(r.pagamento_id)
    })
  })

  prova('chi non passa `p_da` a `anno_registra_frequenza` continua a funzionare (voce senza autore)', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      const a = await apri()
      const senza = await una<Rec>(
        `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'domanda', NULL, NULL, NULL, NULL)`, [AL, a])
      expect((await voce(senza.pagamento_id as string)).creato_da).toBeNull()
      const con = await una<Rec>(
        `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'segreteria', NULL, NULL, NULL, NULL, $3::uuid)`,
        [AL2, a, UT])
      expect((await voce(con.pagamento_id as string)).creato_da).toBe(UT)
    })
  })
})

describe('anno_conferma: chi cambia grado', () => {
  prova('cambia grado senza sezione → `SEZIONE_OBBLIGATORIA`, e non scrive niente', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      await sezione(2027, 'Girasoli', 'infanzia', 'infanzia', s26) // la continuazione c'è, ma chi cambia grado non la prende
      const f26 = await partenza(AL, s26)
      await apri()
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S1}:2027`], null, UT, true])).toBe('SEZIONE_OBBLIGATORIA')
      expect(await frequenzeNuovoAnno(AL)).toBe(0)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL])).toBe(0)
    })
  })

  prova('con la sezione della primaria passa, e la quota viene dalla fascia primaria', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const prim = await sezione(2027, 'Prima A', 'primaria', 'primaria')
      const f26 = await partenza(AL, s26)
      const a = await apri()
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', 'primaria', 300, NULL)`, [a])
      const r = await conferma({ frequenza: f26, sezione: prim, cambiaGrado: true })
      expect(r.cambia_grado).toBe(true)
      expect(await voce(r.pagamento_id as string)).toMatchObject({ importo: 300 })
      const f = await frequenza(r.frequenza_id as string)
      expect(f).toMatchObject({ section_id: prim, retta_mensile: null })
    })
  })

  prova('`cambia_grado` è vero anche quando `school_type` o `fascia` delle due sezioni differiscono', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      const infanzia = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const nido = await sezione(2026, 'Delfini', 'nido', 'nido_2')
      const prim = await sezione(2027, 'Prima A', 'primaria', 'primaria')
      const inf27 = await sezione(2027, 'Farfalle', 'infanzia', 'infanzia')
      await apri()
      const a = await conferma({ frequenza: await partenza(AL, infanzia), sezione: prim })
      expect(a.cambia_grado, 'infanzia → primaria').toBe(true)
      const b = await conferma({ frequenza: await partenza(AL2, nido), sezione: inf27 })
      expect(b.cambia_grado, 'nido_2 → infanzia: cambiano la scuola e la fascia').toBe(true)
    })
  })

  prova('una sezione dell’anno sbagliato è respinta dal database', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const f26 = await partenza(AL, s26)
      await apri()
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S1}:2027`], s26, UT, false])).toBe('SEZIONE_DI_ALTRO_ANNO')
      expect(await frequenzeNuovoAnno(AL)).toBe(0)
    })
  })
})

describe('anno_conferma: i rifiuti', () => {
  prova('una partenza `ritirata` → `FREQUENZA_NON_VIVA`', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE id = $1`, [f26])
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S1}:2027`], null, UT, false])).toBe('FREQUENZA_NON_VIVA')
      expect(await frequenzeNuovoAnno(AL)).toBe(0)
    })
  })

  prova('la frequenza dell’anno prossimo chiusa per altro (trasferito) non si riapre da qui: `FREQUENZA_NON_VIVA`, e nessuna voce nuova (la RITIRATA sì, dal 4.5.15: vedi anno-ritiro-conferma)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      const r = await conferma({ frequenza: f26 })
      await db.query(`UPDATE public.frequenze SET stato = 'trasferito', data_uscita = data_ingresso WHERE id = $1`, [r.frequenza_id])
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S1}:2027`], null, UT, false])).toBe('FREQUENZA_NON_VIVA')
      expect((await frequenza(r.frequenza_id as string)).stato).toBe('trasferito')
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL])).toBe(1)
    })
  })

  prova('un anno di un’altra sede → `SEDE_DIVERSA`', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S2}:2027`], null, UT, false])).toBe('SEDE_DIVERSA')
      expect(await frequenzeNuovoAnno(AL)).toBe(0)
    })
  })

  prova('un anno non aperto → `ANNO_NON_APERTO`', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      // il 2027/28 di S1 è `in_preparazione`: le iscrizioni non sono mai state aperte
      expect(await errore(SQL_CONFERMA, [f26, ANNO_SEDE[`${S1}:2027`], null, UT, false])).toBe('ANNO_NON_APERTO')
      expect(await frequenzeNuovoAnno(AL)).toBe(0)
    })
  })

  prova('parametri che non esistono e una partenza che è già l’anno nuovo', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      const a = await apri()
      expect(await errore(SQL_CONFERMA, ['99999999-9999-4999-8999-999999999999', a, null, UT, false])).toBe('PARAMETRO_MANCANTE')
      expect(await errore(SQL_CONFERMA, [f26, '99999999-9999-4999-8999-999999999999', null, UT, false])).toBe('ANNO_NON_TROVATO')
      const nuova = (await conferma({ frequenza: f26 })).frequenza_id as string
      expect(await errore(SQL_CONFERMA, [nuova, a, null, UT, false]), 'confermare la frequenza dell’anno nuovo con se stessa').toBe('ANNO_NON_COERENTE')
    })
  })
})

describe('anno_conferma: cosa si riporta', () => {
  prova('una retta personalizzata non si riporta, e il risultato lo dice', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      const personalizzata = await partenza(AL)
      const dal_listino = await partenza(AL2)
      await db.query(`UPDATE public.frequenze SET retta_mensile = 321.5 WHERE id = $1`, [personalizzata])
      await apri()
      const a = await conferma({ frequenza: personalizzata })
      const b = await conferma({ frequenza: dal_listino })
      expect(a.retta_personalizzata_precedente).toBe(true)
      expect(b.retta_personalizzata_precedente).toBe(false)
      expect((await frequenza(a.frequenza_id as string)).retta_mensile).toBeNull()
    })
  })

  prova('la sospensione non si riporta; i campi di famiglia sì', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(ALTRA)
      const f26 = await partenza(AL)
      await db.query(
        `UPDATE public.frequenze
            SET sospeso = true, sospeso_causa = 'morosita', sospeso_il = now(),
                usa_pannolino = true, giorno_scadenza_pagamenti = 5, retta_esente = true,
                retta_a_carico_di = $2, intestatario_fatture = '{"tipo":"prova"}'::jsonb
          WHERE id = $1`, [f26, ALTRA])
      await apri()
      const r = await conferma({ frequenza: f26 })
      expect(await frequenza(r.frequenza_id as string)).toMatchObject({
        sospeso: false, sospeso_causa: null, sospeso_il: null,
        usa_pannolino: true, giorno_scadenza_pagamenti: 5, retta_esente: true, retta_a_carico_di: ALTRA,
        intestatario_fatture: { tipo: 'prova' },
      })
    })
  })

  prova('i posti sono un avviso: oltre il numero la conferma passa e `posti_oltre` è vero', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const s27 = await sezione(2027, 'Girasoli', 'infanzia', 'infanzia', s26)
      const f1 = await partenza(AL, s26)
      const f2 = await partenza(AL2, s26)
      const a = await apri()
      await db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', 1, 'Autorizzazione di prova')`, [a])
      const primo = await conferma({ frequenza: f1 })
      const secondo = await conferma({ frequenza: f2 })
      expect(primo.posti_oltre).toBe(false)
      expect(secondo.posti_oltre).toBe(true)
      expect((await frequenza(secondo.frequenza_id as string)).section_id).toBe(s27)
    })
  })
})

describe('anno_non_rinnova: il «no» della famiglia', () => {
  prova('scrive il motivo dell’elenco chiuso e `attivo:false` lo azzera', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      const r = await nonRinnova(f26, true, 'trasloco')
      expect(r).toMatchObject({ frequenza_id: f26, non_rinnova: true })
      const f = await frequenza(f26)
      expect(f.non_rinnova_motivo).toBe('trasloco')
      expect(f.non_rinnova_il).not.toBeNull()

      const annullato = await nonRinnova(f26, false, 'altro')
      expect(annullato).toMatchObject({ frequenza_id: f26, non_rinnova: false })
      expect(await frequenza(f26)).toMatchObject({ non_rinnova_il: null, non_rinnova_motivo: null })
    })
  })

  prova('il motivo può mancare; un motivo fuori elenco è respinto e non scrive niente', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await nonRinnova(f26, true, null)
      expect(await frequenza(f26)).toMatchObject({ non_rinnova_motivo: null })
      expect((await frequenza(f26)).non_rinnova_il).not.toBeNull()
      await nonRinnova(f26, false, null)

      const sql = `SELECT public.anno_non_rinnova($1::uuid, true, $2, $3::uuid)`
      expect(await errore(sql, [f26, 'testo libero qualunque', UT])).toBe('PARAMETRO_MANCANTE')
      expect(await frequenza(f26)).toMatchObject({ non_rinnova_il: null, non_rinnova_motivo: null })
      expect(await errore(sql, ['99999999-9999-4999-8999-999999999999', 'altro', UT])).toBe('PARAMETRO_MANCANTE')
    })
  })

  prova('una frequenza già chiusa non si segna: `FREQUENZA_NON_VIVA`', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE id = $1`, [f26])
      expect(await errore(`SELECT public.anno_non_rinnova($1::uuid, true, 'altro', $2::uuid)`, [f26, UT])).toBe('FREQUENZA_NON_VIVA')
    })
  })

  prova('dopo «non rinnova» la conferma è ancora possibile (cambio di idea), e la partenza non si tocca', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const f26 = await partenza(AL)
      await apri()
      await nonRinnova(f26, true, 'altra_scuola')
      const prima = await frequenza(f26)
      const r = await conferma({ frequenza: f26 })
      expect(r.creata).toBe(true)
      expect(await frequenza(f26), 'la conferma non riscrive la frequenza dell’anno in corso').toEqual(prima)
    })
  })

  prova('non rinnova non cambia classe né stato dell’alunno', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli', 'infanzia', 'infanzia')
      const f26 = await partenza(AL, s26)
      const prima = await jsonAlunno(AL)
      await nonRinnova(f26, true, 'fine_ciclo')
      expect(await jsonAlunno(AL)).toEqual(prima)
    })
  })
})

describe('permessi', () => {
  prova('le due funzioni sono di `service_role`, non di chi chiama dal sito', async () => {
    const r = await db.query<{ proname: string; anon: boolean; auth: boolean; pubblico: boolean; servizio: boolean }>(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pubblico,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS servizio
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('anno_conferma', 'anno_non_rinnova', 'anno_registra_frequenza')`)
    expect(r.rows.map((x) => x.proname).sort()).toEqual(['anno_conferma', 'anno_non_rinnova', 'anno_registra_frequenza'])
    for (const x of r.rows) {
      expect(x, x.proname).toMatchObject({ anon: false, auth: false, pubblico: false, servizio: true })
    }
  })
})
