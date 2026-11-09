import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.5 · LA FREQUENZA DELL'ANNO PROSSIMO E LA SUA VOCE (migrazione M45c, parte 1), in PGlite vero.
 *
 *  · `anno_registra_frequenza` scrive una frequenza `in_attesa` nell'anno aperto e NON tocca un dato dell'anno in corso;
 *  · `anno_quota_voce` fa nascere (o collega) la voce «Iscrizione» e la collega alla frequenza: pagata + moduli a posto la
 *    portano `iscritto` (lo fa il trigger), eliminata la riporta `in_attesa`;
 *  · il genitore dell'anno prossimo vede la voce della quota e nient'altro di quell'anno;
 *  · i posti sono un avviso (`posti_oltre`), mai un blocco.
 *
 * Banco: la catena fino a M45c sul banco minimo + `SCHEMA_ISCRIZIONE_ANNO`. Il banco non si tocca: le colonne di `alunni` e di
 * `pagamenti` che mancano si aggiungono qui, in `codaPrima`. Ogni prova gira in una transazione che finisce in `ROLLBACK`.
 * Le date sono FISSE (`p_oggi`) dove la prova guarda una data scritta; dove guarda «oggi» è relativa al giorno della transazione.
 * Gli importi (100, 200, 250) sono esempi di prova. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '22222222-2222-4222-8222-222222222223'
const UT = '55555555-5555-4555-8555-555555555551'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const AL3 = '11111111-1111-4111-8111-111111111113'
const ALTRO_SEDE = '11111111-1111-4111-8111-111111111119'
const GEN = '77777777-7777-4777-8777-777777777771'
const GEN2 = '77777777-7777-4777-8777-777777777772'
const DOM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OGGI_FISSO = '2027-02-10'
const FRA_30_GIORNI = '2027-03-12'

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
async function righe<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
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

/** Oggi secondo il database; l'anno attivo di S1 e di S2 si allarga attorno a oggi. Va chiamata DENTRO `inRollback`. */
async function giorni(): Promise<{ oggi: string }> {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40)
      WHERE id = ANY ($1::uuid[])`, [[ANNO_SEDE[`${S1}:2026`], ANNO_SEDE[`${S2}:2026`]]])
  return { oggi: await una<string>(`SELECT public.giorno_roma(now())::text`) }
}
async function nuovoAlunno(id: string, stato: string, sede = S1) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, $3)`, [id, sede, stato])
}
/** Le due quote, un modulo per lista e l'apertura delle iscrizioni del 2027/28 di S1: quanto serve a registrare. */
async function apri(): Promise<string> {
  const a = ANNO_SEDE[`${S1}:2027`]
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
  return a
}
async function sezione27(nome: string, fascia: string | null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, $3, 'infanzia', $4) RETURNING id`,
    [S1, ANNO[2027], nome, fascia])
}
type Registra = {
  alunno?: string; anno?: string; tipo?: string; origine?: string; domanda?: string | null
  sezione?: string | null; ingresso?: string | null; campi?: Rec | null
}
async function registra(o: Registra = {}): Promise<Rec> {
  return una<Rec>(
    `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::date, $8::jsonb)`,
    [o.alunno ?? AL, o.anno ?? ANNO_SEDE[`${S1}:2027`], o.tipo ?? 'nuova', o.origine ?? 'domanda', o.domanda ?? null,
      o.sezione ?? null, o.ingresso ?? null, o.campi === undefined || o.campi === null ? null : JSON.stringify(o.campi)])
}
/** Una frequenza dell'anno prossimo scritta a mano, SENZA voce: serve a provare `anno_quota_voce` con una data fissa. */
async function frequenzaCruda(alunno: string, tipo: 'conferma' | 'nuova', sezione: string | null = null): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, stato, data_ingresso, section_id)
     SELECT $1, s.id, $2, 'segreteria', 'in_attesa', s.inizio, $3 FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
    [alunno, tipo, sezione, ANNO_SEDE[`${S1}:2027`]])
}
const quotaVoce = (frequenza: string, oggi: string | null = OGGI_FISSO) =>
  una<Rec>(`SELECT public.anno_quota_voce($1::uuid, $2::uuid, $3::date)`, [frequenza, UT, oggi])
const frequenza = (id: string) => una<Rec>(`SELECT to_jsonb(f) FROM public.frequenze f WHERE f.id = $1`, [id])
const jsonAlunno = (id: string) => una<Rec>(`SELECT to_jsonb(a) FROM public.alunni a WHERE a.id = $1`, [id])
const jsonAttiva = (id: string) => una<Rec | null>(
  `SELECT to_jsonb(f) FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [id])
const voce = (id: string) => una<Rec>(`SELECT to_jsonb(p) FROM public.pagamenti p WHERE p.id = $1`, [id])
const voci = (alunno: string) => una<number>(`SELECT count(*)::int FROM public.pagamenti WHERE alunno_id = $1`, [alunno])
const categoriaIscrizione = () => una<string>(`SELECT id FROM public.payment_categories WHERE slug = 'iscrizione' AND is_sistema AND scuola_id IS NULL`)
const inizio27 = () => una<string>(`SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [ANNO_SEDE[`${S1}:2027`]])
async function pagaVoce(id: string) {
  await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = importo WHERE id = $1`, [id])
}
async function spuntaModuli(frequenzaId: string, lista: string) {
  await db.query(
    `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id)
     SELECT $1, m.id FROM public.moduli_richiesti m WHERE m.anno_sede_id = $2 AND m.lista = $3`,
    [frequenzaId, ANNO_SEDE[`${S1}:2027`], lista])
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M45c',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0,
        ADD COLUMN archiviato_il timestamptz,
        ADD COLUMN anonimizzato_il timestamptz;
      -- le colonne di \`pagamenti\` che la voce della quota scrive (come \`crm_quota_passa\`) e il banco minimo non ha
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

describe('anno_registra_frequenza: la frequenza dell’anno aperto', () => {
  prova('una domanda per l’anno aperto crea una frequenza `in_attesa`, e NON cambia l’alunno né la frequenza dell’anno attivo', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'iscritto')
      await apri()
      const prima = { alunno: await jsonAlunno(AL), attiva: await jsonAttiva(AL) }
      expect(prima.attiva, 'lo specchio ha scritto la frequenza dell’anno attivo').not.toBeNull()

      const r = await registra({ alunno: AL, tipo: 'nuova', origine: 'domanda', domanda: null })
      expect(r.creata).toBe(true)
      const f = await frequenza(r.frequenza_id as string)
      expect(f).toMatchObject({ stato: 'in_attesa', tipo: 'nuova', origine: 'domanda', anno_sede_id: ANNO_SEDE[`${S1}:2027`], alunno_id: AL })
      expect(f.data_ingresso).toBe(await inizio27())

      // nemmeno una riga di prima è cambiata: section_id, classe_sezione, importo_retta_mensile, stato…
      expect(await jsonAlunno(AL)).toEqual(prima.alunno)
      expect(await jsonAttiva(AL)).toEqual(prima.attiva)
    })
  })

  prova('rifatta con gli stessi argomenti: `creata:false`, la stessa riga; una domanda data dopo si aggancia', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      await db.query(`INSERT INTO public.enrollment_submissions (id, scuola_id) VALUES ($1, $2)`, [DOM, S1])
      const a = await registra({ alunno: AL })
      const b = await registra({ alunno: AL })
      expect(b).toMatchObject({ creata: false, frequenza_id: a.frequenza_id })
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1`, [AL])).toBe(1)
      expect((await frequenza(a.frequenza_id as string)).domanda_id).toBeNull()

      const c = await registra({ alunno: AL, domanda: DOM })
      expect(c).toMatchObject({ creata: false, frequenza_id: a.frequenza_id })
      expect((await frequenza(a.frequenza_id as string)).domanda_id).toBe(DOM)
    })
  })

  prova('su una frequenza GIA\u0027 esistente una sezione diversa non la cambia, e la risposta lo dice (`sezione_ignorata`) — 4.5.15, M4', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      const prima = await sezione27('PRIMA SEZIONE', null)
      const seconda = await sezione27('SECONDA SEZIONE', null)
      const a = await registra({ alunno: AL, sezione: prima })
      expect(a).not.toHaveProperty('sezione_ignorata')
      // Stessa sezione, o nessuna sezione chiesta: niente da segnalare.
      expect(await registra({ alunno: AL, sezione: prima })).not.toHaveProperty('sezione_ignorata')
      expect(await registra({ alunno: AL })).not.toHaveProperty('sezione_ignorata')
      // Un'altra sezione: la frequenza resta dov'era e la risposta dice che la richiesta e' stata ignorata.
      const b = await registra({ alunno: AL, sezione: seconda })
      expect(b).toMatchObject({ creata: false, frequenza_id: a.frequenza_id, sezione_ignorata: true })
      expect((await frequenza(a.frequenza_id as string)).section_id).toBe(prima)
    })
  })

  prova('un anno `in_preparazione` o `corrente` risponde `ANNO_NON_APERTO`', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const sql = `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'domanda', NULL, NULL, NULL, NULL)`
      expect(await errore(sql, [AL, ANNO_SEDE[`${S1}:2027`]])).toBe('ANNO_NON_APERTO')
      expect(await errore(sql, [AL, ANNO_SEDE[`${S1}:2026`]])).toBe('ANNO_NON_APERTO')
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1`, [AL])).toBe(0)
    })
  })

  prova('parametri sbagliati e sede diversa hanno il loro codice, e non scrivono niente', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(ALTRO_SEDE, 'in_arrivo', S2)
      const a = await apri()
      const sql = `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, $3, $4, NULL, NULL, NULL, NULL)`
      expect(await errore(sql, [AL, a, 'passaggio', 'domanda'])).toBe('PARAMETRO_MANCANTE')
      expect(await errore(sql, [AL, a, 'nuova', 'recupero'])).toBe('PARAMETRO_MANCANTE')
      expect(await errore(sql, ['11111111-1111-4111-8111-1111111111ff', a, 'nuova', 'domanda'])).toBe('PARAMETRO_MANCANTE')
      expect(await errore(sql, [AL, '99999999-9999-4999-8999-999999999999', 'nuova', 'domanda'])).toBe('ANNO_NON_TROVATO')
      expect(await errore(sql, [ALTRO_SEDE, a, 'nuova', 'domanda'])).toBe('SEDE_DIVERSA')
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE anno_sede_id = $1`, [a])).toBe(0)
    })
  })

  prova('`p_campi` è una lista bianca: `retta_mensile` e `usa_pannolino` passano, `sospeso` no', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      const r = await registra({ alunno: AL, campi: { retta_mensile: 321.5, usa_pannolino: true, retta_esente: false, sospeso: true, sospeso_causa: 'altro', stato: 'iscritto' } })
      const f = await frequenza(r.frequenza_id as string)
      expect(f).toMatchObject({ retta_mensile: 321.5, usa_pannolino: true, sospeso: false, sospeso_causa: null, stato: 'in_attesa' })
    })
  })

  prova('un bambino con frequenza di origine `domanda` ritirato viene RIAPERTO da un secondo `registra` (4.5.16 A: una sola strada)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'iscritto')
      await apri()
      const r = await registra({ alunno: AL })
      // il ritiro (4.5.1): la frequenza dell'anno attivo e quella dell'anno aperto si chiudono, lo specchio porta `alunni` a `ritirato`
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE id = $1`, [r.frequenza_id])
      await db.query(
        `UPDATE public.frequenze SET stato = 'ritirato', data_uscita = public.giorno_roma(now())
          WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL, ANNO_SEDE[`${S1}:2026`]])
      expect(await una<string>(`SELECT stato FROM public.alunni WHERE id = $1`, [AL])).toBe('ritirato')

      const di_nuovo = await registra({ alunno: AL })
      // la stessa riga, riaperta: nessuna riga nuova, e lo dice (`riaperta`)
      expect(di_nuovo).toMatchObject({ creata: false, frequenza_id: r.frequenza_id, riaperta: true })
      expect((await frequenza(r.frequenza_id as string)).stato).not.toBe('ritirato')
    })
  })
})

describe('anno_quota_voce: la voce della quota', () => {
  prova('nessuna voce: nasce dal listino (importo, categoria, competenza, scadenza, visibilità) e si collega', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      const f = await frequenzaCruda(AL, 'nuova')
      const r = await quotaVoce(f)
      expect(r.esito).toBe('creata')
      const v = await voce(r.pagamento_id as string)
      expect(v).toMatchObject({
        alunno_id: AL, scuola_id: S1, importo: 200, stato: 'da_pagare', tipo: 'singolo', obbligatorio: true,
        categoria_id: await categoriaIscrizione(), periodo_competenza: await inizio27(),
        scadenza: FRA_30_GIORNI, visibile_dal: OGGI_FISSO, creato_da: UT,
      })
      const etichetta = await una<string>(`SELECT etichetta_breve FROM public.anni_scolastici WHERE id = $1`, [ANNO[2027]])
      expect(v.descrizione).toBe(`Iscrizione ${etichetta}`)
      expect((await frequenza(f)).quota_pagamento_id).toBe(r.pagamento_id)
    })
  })

  prova('la quota di una conferma è `quota_conferma`; la scadenza del listino vince sui trenta giorni', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'iscritto')
      await apri()
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, DATE '2027-05-31')`, [ANNO_SEDE[`${S1}:2027`]])
      const r = await quotaVoce(await frequenzaCruda(AL, 'conferma'))
      expect(await voce(r.pagamento_id as string)).toMatchObject({ importo: 100, scadenza: '2027-05-31' })
    })
  })

  prova('una riga per la fascia della sezione batte quella senza fascia', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      const a = await apri()
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', 'infanzia', 250, NULL)`, [a])
      const infanzia = await sezione27('Girasoli', 'infanzia')
      const nido = await sezione27('Delfini', 'nido_1')
      const conFascia = await quotaVoce(await frequenzaCruda(AL, 'nuova', infanzia))
      const altraFascia = await quotaVoce(await frequenzaCruda(AL2, 'nuova', nido))
      expect((await voce(conFascia.pagamento_id as string)).importo).toBe(250)
      expect((await voce(altraFascia.pagamento_id as string)).importo, 'la riga senza fascia vale per le altre fasce').toBe(200)
    })
  })

  prova('nessuna riga di listino: `senza_listino` e nessuna voce', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, NULL, NULL)`, [a])
      const f = await frequenzaCruda(AL, 'nuova')
      expect(await quotaVoce(f)).toEqual({ esito: 'senza_listino', pagamento_id: null })
      expect(await voci(AL)).toBe(0)
      expect((await frequenza(f)).quota_pagamento_id).toBeNull()
    })
  })

  prova('una voce esistente della famiglia per quell’anno: `collegata`, nessun doppione (anche senza competenza, con scadenza nell’anno)', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      await apri()
      const cat = await categoriaIscrizione()
      const conCompetenza = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza)
         SELECT $1, $2, 'Iscrizione', 90, s.inizio + 20, $3, s.inizio FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
        [AL, S1, cat, ANNO_SEDE[`${S1}:2027`]])
      const senzaCompetenza = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id)
         SELECT $1, $2, 'Iscrizione', 90, s.inizio + 20, $3 FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
        [AL2, S1, cat, ANNO_SEDE[`${S1}:2027`]])
      const r = await quotaVoce(await frequenzaCruda(AL, 'nuova'))
      const r2 = await quotaVoce(await frequenzaCruda(AL2, 'nuova'))
      expect(r).toEqual({ esito: 'collegata', pagamento_id: conCompetenza })
      expect(r2).toEqual({ esito: 'collegata', pagamento_id: senzaCompetenza })
      expect(await voci(AL)).toBe(1)
      expect(await voci(AL2)).toBe(1)
    })
  })

  prova('la voce dell’anno prima non conta: ne nasce una nuova', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      await db.query(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza)
         SELECT $1, $2, 'Iscrizione anno prima', 90, s.inizio + 20, $3, s.inizio FROM public.anni_sede s WHERE s.id = $4`,
        [AL, S1, await categoriaIscrizione(), ANNO_SEDE[`${S1}:2026`]])
      const r = await quotaVoce(await frequenzaCruda(AL, 'nuova'))
      expect(r.esito).toBe('creata')
      expect(await voci(AL)).toBe(2)
    })
  })

  prova('due voci: `piu_voci`, nessuna scelta e nessuna voce nuova', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      for (const n of [1, 2]) {
        await db.query(
          `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza)
           SELECT $1, $2, 'Iscrizione ' || $5::text, 90, s.inizio + 20, $3, s.inizio FROM public.anni_sede s WHERE s.id = $4`,
          [AL, S1, await categoriaIscrizione(), ANNO_SEDE[`${S1}:2027`], n])
      }
      const f = await frequenzaCruda(AL, 'nuova')
      expect(await quotaVoce(f)).toEqual({ esito: 'piu_voci', pagamento_id: null })
      expect(await voci(AL)).toBe(2)
      expect((await frequenza(f)).quota_pagamento_id).toBeNull()
    })
  })

  prova('già collegata: `gia_collegata` e nessun doppione; una frequenza non viva non riceve una voce nuova', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      await apri()
      const f = await frequenzaCruda(AL, 'nuova')
      const prima = await quotaVoce(f)
      expect(prima.esito).toBe('creata')
      expect(await quotaVoce(f)).toEqual({ esito: 'gia_collegata', pagamento_id: prima.pagamento_id })
      expect(await voci(AL)).toBe(1)

      const chiusa = await frequenzaCruda(AL2, 'nuova')
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE id = $1`, [chiusa])
      expect(await errore(`SELECT public.anno_quota_voce($1::uuid, $2::uuid, $3::date)`, [chiusa, UT, OGGI_FISSO])).toBe('FREQUENZA_NON_VIVA')
      expect(await voci(AL2)).toBe(0)
    })
  })

  prova('la voce pagata porta la frequenza a `iscritto` solo se i moduli sono completi', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      await apri()
      // moduli ancora da spuntare: la quota pagata da sola non basta
      const a = await registra({ alunno: AL })
      await pagaVoce(a.pagamento_id as string)
      expect(await frequenza(a.frequenza_id as string)).toMatchObject({ quota_saldata: true, moduli_completi: false, stato: 'in_attesa' })
      await spuntaModuli(a.frequenza_id as string, 'nuova')
      expect(await frequenza(a.frequenza_id as string)).toMatchObject({ quota_saldata: true, moduli_completi: true, stato: 'iscritto' })

      // moduli spuntati prima della quota: lo stesso, nell'altro ordine
      const b = await registra({ alunno: AL2 })
      await spuntaModuli(b.frequenza_id as string, 'nuova')
      expect((await frequenza(b.frequenza_id as string)).stato).toBe('in_attesa')
      await pagaVoce(b.pagamento_id as string)
      expect((await frequenza(b.frequenza_id as string)).stato).toBe('iscritto')
    })
  })

  prova('la voce eliminata (DELETE) riporta la frequenza `in_attesa`, senza errori', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      const r = await registra({ alunno: AL })
      await spuntaModuli(r.frequenza_id as string, 'nuova')
      await pagaVoce(r.pagamento_id as string)
      expect((await frequenza(r.frequenza_id as string)).stato).toBe('iscritto')

      await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [r.pagamento_id])
      expect(await frequenza(r.frequenza_id as string)).toMatchObject({ stato: 'in_attesa', quota_pagamento_id: null, quota_saldata: false })
    })
  })
})

describe('anno_registra_frequenza + anno_quota_voce insieme', () => {
  prova('la registrazione crea anche la voce e ne riporta l’esito', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await apri()
      const r = await registra({ alunno: AL, tipo: 'nuova' })
      expect(r).toMatchObject({ creata: true, quota: 'creata', posti_oltre: false })
      expect((await voce(r.pagamento_id as string)).importo).toBe(200)
      // rifatta: la voce non raddoppia
      const di_nuovo = await registra({ alunno: AL, tipo: 'nuova' })
      expect(di_nuovo).toMatchObject({ creata: false, quota: 'gia_collegata', pagamento_id: r.pagamento_id })
      expect(await voci(AL)).toBe(1)
    })
  })

  prova('listino vuoto al momento della registrazione: `senza_listino`; la voce nasce al rilancio', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, NULL, NULL)`, [a])
      expect(await registra({ alunno: AL })).toMatchObject({ creata: true, quota: 'senza_listino', pagamento_id: null })
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 220, NULL)`, [a])
      expect(await registra({ alunno: AL })).toMatchObject({ creata: false, quota: 'creata' })
      expect(await voci(AL)).toBe(1)
    })
  })
})

describe('il genitore dell’anno prossimo vede la voce della quota e nient’altro di quell’anno', () => {
  async function vistePer(genitore: string): Promise<string[]> {
    return (await righe<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_genitore($1)`, [genitore])).map((x) => x.voce_id)
  }
  /** Una voce di retta dell'anno aperto, che nessuna frequenza ha per quota: la famiglia non deve vederla. */
  async function retta2027(alunno: string): Promise<string> {
    const cat = await una<string>(`INSERT INTO public.payment_categories (scuola_id, nome, slug) VALUES (NULL, 'Retta di prova', 'retta-prova') RETURNING id`)
    return una<string>(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza, visibile_dal)
       SELECT $1, $2, 'Retta di prova', 300, s.inizio + 40, $3, s.inizio, public.giorno_roma(now()) FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
      [alunno, S1, cat, ANNO_SEDE[`${S1}:2027`]])
  }

  prova('col figlio che continua: la voce della quota sì, la retta dell’anno aperto no, quelle di quest’anno come prima', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      await nuovoAlunno(AL, 'iscritto')
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN, AL])
      const dellAnnoInCorso = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, periodo_competenza, visibile_dal)
         VALUES ($1, $2, 'Retta in corso', 300, $3::date, $3::date, $3::date) RETURNING id`, [AL, S1, oggi])
      expect(await vistePer(GEN)).toEqual([dellAnnoInCorso])

      await apri()
      const non_visibile = await retta2027(AL)
      const r = await registra({ alunno: AL, tipo: 'conferma', origine: 'conferma' })
      const viste = await vistePer(GEN)
      expect(viste.sort()).toEqual([dellAnnoInCorso, r.pagamento_id as string].sort())
      expect(viste).not.toContain(non_visibile)
    })
  })

  prova('col figlio unico `in_arrivo`: nessun figlio attivo, e la voce della quota sì', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL3, 'in_arrivo')
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN2, AL3])
      await apri()
      const non_visibile = await retta2027(AL3)
      const r = await registra({ alunno: AL3, tipo: 'nuova' })
      expect(await righe(`SELECT alunno_id FROM public.figli_attivi($1)`, [GEN2])).toHaveLength(0)
      expect(await vistePer(GEN2)).toEqual([r.pagamento_id])
      expect(await vistePer(GEN2)).not.toContain(non_visibile)
    })
  })

  prova('foto, chat e avvisi del figlio non cambiano: le funzioni di visibilità danno lo stesso insieme prima e dopo', async () => {
    await inRollback(async () => {
      const { oggi } = await giorni()
      await nuovoAlunno(AL, 'iscritto')
      await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN, AL])
      await db.query(`INSERT INTO public.galleria_media_v2 (scuola_id, is_broadcast, giorno_competenza) VALUES ($1, true, $2::date)`, [S1, oggi])
      await db.query(`INSERT INTO public.avvisi (scuola_id, target_scope, scadenza_avviso) VALUES ($1, 'globale', now() + interval '30 days')`, [S1])
      await db.query(`INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3)`, [UT, GEN, AL])
      const istantanea = async () => {
        const s = async (da: string) =>
          (await righe<{ x: unknown }>(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS x FROM ${da} t`, [GEN]))[0].x
        return { media: await s('public.media_visibili_genitore($1)'), avvisi: await s('public.avvisi_visibili_genitore($1)'), thread: await s('public.thread_visibili($1)') }
      }
      const prima = await istantanea()
      for (const insieme of Object.values(prima)) expect((insieme as unknown[]).length, 'la prova guarda un insieme non vuoto').toBeGreaterThan(0)

      await apri()
      await registra({ alunno: AL, tipo: 'conferma', origine: 'conferma' })
      expect(await istantanea()).toEqual(prima)
    })
  })
})

describe('anno_conta_posti: un avviso, mai un blocco', () => {
  prova('oltre il numero autorizzato `posti_oltre` è vero e la frequenza nasce lo stesso', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      await nuovoAlunno(AL3, 'in_arrivo')
      const a = await apri()
      await db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', 1, 'delibera di prova')`, [a])
      await db.query(`SELECT public.anno_posti_imposta($1, 'nido_1', 5, NULL)`, [a])
      const girasoli = await sezione27('Girasoli', 'infanzia')

      const primo = await registra({ alunno: AL, sezione: girasoli })
      expect(primo.posti_oltre).toBe(false)
      const secondo = await registra({ alunno: AL2, sezione: girasoli })
      expect(secondo).toMatchObject({ creata: true, posti_oltre: true })
      expect(await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [secondo.frequenza_id])).toBe('in_attesa')
      const senza = await registra({ alunno: AL3 })
      expect(senza.posti_oltre, 'senza sezione non c’è una fascia da superare').toBe(false)

      const conteggio = await righe<{ fascia: string; iscritti: string; posti: number | null; oltre: boolean }>(
        `SELECT fascia, iscritti::text, posti, oltre FROM public.anno_conta_posti($1) ORDER BY fascia`, [a])
      expect(conteggio).toEqual([
        { fascia: 'infanzia', iscritti: '2', posti: 1, oltre: true },
        { fascia: 'nido_1', iscritti: '0', posti: 5, oltre: false },
        { fascia: 'senza_sezione', iscritti: '1', posti: null, oltre: false },
      ])
    })
  })

  prova('un ritirato non occupa un posto', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', 1, NULL)`, [a])
      const girasoli = await sezione27('Girasoli', 'infanzia')
      const r = await registra({ alunno: AL, sezione: girasoli })
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE id = $1`, [r.frequenza_id])
      expect(await una<string>(`SELECT iscritti::text FROM public.anno_conta_posti($1) WHERE fascia = 'infanzia'`, [a])).toBe('0')
    })
  })
})

describe('anno_quota_collega (per il CRM, 4.5.9)', () => {
  prova('collega la voce dello stesso alunno se la frequenza non ne ha; mai quella di un altro; mai sopra una già scelta', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      await nuovoAlunno(AL2, 'in_arrivo')
      await apri()
      const sua = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'Quota', 90, DATE '2027-09-30') RETURNING id`, [AL, S1])
      const altrui = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'Quota', 90, DATE '2027-09-30') RETURNING id`, [AL2, S1])
      const f = await frequenzaCruda(AL, 'nuova')
      const collega = (voceId: string) => una<boolean>(`SELECT public.anno_quota_collega($1::uuid, $2::uuid)`, [f, voceId])

      expect(await collega(altrui)).toBe(false)
      expect((await frequenza(f)).quota_pagamento_id).toBeNull()
      expect(await collega(sua)).toBe(true)
      expect((await frequenza(f)).quota_pagamento_id).toBe(sua)
      expect(await collega(sua), 'rifatto è lo stesso esito').toBe(true)
      const altra = await una<string>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'Altra', 90, DATE '2027-09-30') RETURNING id`, [AL, S1])
      expect(await collega(altra)).toBe(false)
      expect((await frequenza(f)).quota_pagamento_id).toBe(sua)
      expect(await una<boolean>(`SELECT public.anno_quota_collega($1::uuid, $2::uuid)`, ['99999999-9999-4999-8999-999999999999', sua])).toBe(false)
    })
  })
})

describe('permessi: solo `service_role`', () => {
  prova('anon e authenticated non possono eseguire le quattro funzioni', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      const chiamate = [
        `SELECT public.anno_registra_frequenza('${AL}', '${a}', 'nuova', 'domanda', NULL, NULL, NULL, NULL)`,
        `SELECT public.anno_quota_voce('${AL}', NULL, NULL)`,
        `SELECT public.anno_quota_collega('${AL}', '${AL}')`,
        `SELECT * FROM public.anno_conta_posti('${a}')`,
      ]
      for (const ruolo of ['anon', 'authenticated']) {
        for (const sql of chiamate) {
          await db.exec(`SET LOCAL ROLE ${ruolo}`)
          const e = await errore(sql)
          await db.exec('RESET ROLE')
          expect(e, `${ruolo}: ${sql.slice(0, 50)}`).toMatch(/permission denied/)
        }
      }
    })
  })
})
