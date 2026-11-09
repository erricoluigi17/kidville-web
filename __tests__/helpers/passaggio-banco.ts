import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
  SCHEMA_PASSAGGIO_DIDATTICA, type OpzioniDbPr2,
} from './schema-anno-pglite'

/**
 * IL BANCO DEL PASSAGGIO D'ANNO (PR 4.8, compito 4.8.0).
 *
 * Un PGlite con la catena fino a `M48b`, tre sedi e una popolazione finta che copre TUTTI gli esiti del passaggio. Il banco si
 * costruisce UNA volta per file di prova; ogni prova gira in una transazione che finisce in ROLLBACK (`inRollback`), così i dati
 * restano quelli di partenza. Le conferme, le nuove iscrizioni e il «no» passano dalle funzioni vere della PR 4.5
 * (`anno_conferma`, `anno_registra_frequenza`, `anno_non_rinnova`), mai da INSERT a mano nelle frequenze nuove.
 *
 *  · `SEDE_E2E`  (`e2e00000-…`): la sede del passaggio. Anno 2026/27 `corrente`, 2027/28 `iscrizioni_aperte`.
 *  · `SEDE_SIM`  (`55555555-…`): una seconda sede, messa in `anno_regole.sedi_simulazione`, con due bambini suoi (per provare che la
 *    conferma di una sede non tocca l'altra).
 *  · `SEDE_VERA` (`22222222-…`): una sede «vera» (non di prova e non in simulazione): serve a provare che `p_oggi` non è ammesso.
 *
 * Il giorno del passaggio, `oggi`, è il giorno dopo l'ultimo giorno aperto dell'anno vecchio, LETTO DAL DATABASE: nessuna data del
 * 2027 è scritta qui. Solo uuid inventati, mai dati veri.
 */

export const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000001'
export const SEDE_SIM = '55555555-5555-4555-8555-555555555501'
export const SEDE_VERA = '22222222-2222-4222-8222-222222222201'
/** Chi compie i gesti della segreteria nelle prove. */
export const UTENTE = '99999999-9999-4999-8999-999999999991'
export const DOCENTE_1 = '66666666-6666-4666-8666-666666666661'
export const DOCENTE_2 = '66666666-6666-4666-8666-666666666662'

const uuidBambino = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`

/** I dodici bambini della sede del passaggio, uno per caso. Il valore è l'`alunni.id`. */
export const BAMBINI = {
  /** Gira da A a Girasoli': `continua` con la continuazione. */
  continua: uuidBambino(1),
  /** Da B a Farfalle': `continua` con la continuazione. */
  continuaB: uuidBambino(2),
  /** Da B, confermato scegliendo a mano la sezione Girasoli': `continua` ma non nella continuazione. */
  continuaAltraSezione: uuidBambino(3),
  /** `in_arrivo`, iscritto da nuovo a Girasoli': `nuova`. */
  nuova: uuidBambino(4),
  /** Da A, con il «no» della famiglia: `esce`. */
  no: uuidBambino(5),
  /** Da B, senza nessuna risposta: `non_risposto`. */
  nonRisposto: uuidBambino(6),
  /** Da A, confermato, poi messo «ritirato» dalla tendina della scheda: `continua` con `avviso = ritirato_tendina`. */
  ritiratoTendina: uuidBambino(7),
  /** Archiviato nell'anno vecchio, senza iscrizione nuova: non compare nel passaggio. */
  ritiratoArchiviato: uuidBambino(8),
  /** Ex alunno archiviato che torna `in_arrivo` con una iscrizione nuova: `nuova`, non `esce`. */
  ritornato: uuidBambino(9),
  /** Confermato, poi archiviato e riattivato `in_arrivo`: la sua frequenza nuova è di tipo `conferma` ma lui non frequenta: `nuova`. */
  inArrivoConConferma: uuidBambino(10),
  /** Da C (ultima classe dell'infanzia) alla primaria, con la classe scelta: `cambia_grado`. */
  cambiaGradoConSezione: uuidBambino(11),
  /** Da C, confermato senza classe nuova: `cambia_grado` con `avviso = senza_sezione`. */
  cambiaGradoSenzaSezione: uuidBambino(12),
} as const
export type NomeBambino = keyof typeof BAMBINI

/** I due bambini della sede di simulazione. */
export const BAMBINI_SIM = {
  continua: uuidBambino(21),
  nonRisposto: uuidBambino(22),
} as const

export interface BancoPassaggio {
  db: PGlite
  /** `anni_sede.id` dell'anno vecchio e del nuovo della sede del passaggio. */
  da: string
  a: string
  /** Gli stessi, per la sede di simulazione e per la sede «vera». */
  sim: { da: string; a: string }
  vera: { da: string; a: string }
  /** `anni_scolastici.id` del vecchio e del nuovo. */
  annoDa: string
  annoA: string
  sezioni: {
    /** Dell'anno vecchio. */
    girasoli: string; farfalle: string; stelline: string
    /** Dell'anno nuovo: le continuazioni (create dall'apertura delle iscrizioni) e una classe di primaria senza continuazione. */
    girasoliNuova: string; farfalleNuova: string; primaria: string
    /** Sede di simulazione. */
    simVecchia: string; simNuova: string
  }
  /** Il giorno del passaggio: il giorno dopo l'ultimo giorno aperto dell'anno vecchio (AAAA-MM-GG), letto dal database. */
  oggi: string
  /** (giro 2, R6) Il giorno dell'`inizio` dell'anno nuovo (AAAA-MM-GG), letto dal database: da lì le schede passano sulla classe nuova. */
  inizio: string
}

export interface OpzioniBancoPassaggio {
  /** Fin dove si applica la catena. Default `M48b` (tutte e tre). */
  fino?: OpzioniDbPr2['fino']
  /**
   * Con le tabelle grandi (`SCHEMA_PR2` e `SCHEMA_PR2_RIEMPIMENTO`), come `anno-m45-fumo`: default `true`, perché M45e (il CRM) vuole
   * `crm_bambini` e la catena del passaggio viene dopo di lei. Con `false` la catena si ferma prima di M45e e il banco ha la galleria
   * del genitore invece di quella povera del riempimento.
   */
  completo?: boolean
  /** SQL accodato alla `codaPrima` (colonne e tabelle che la prova vuole in più). */
  codaPrima?: string
}

type Rec = Record<string, unknown>

export async function una<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/** Esegue `fn` dentro una transazione che finisce SEMPRE in ROLLBACK. */
export async function inRollback(db: PGlite, fn: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN')
  try {
    await fn()
  } finally {
    await db.exec('ROLLBACK')
  }
}

/** Il messaggio dell'errore (= il codice) dentro una transazione: un savepoint, così l'errore non la rovina. */
export async function errore(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
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

async function annoSede(db: PGlite, sede: string, annoInizio: number): Promise<{ id: string; annoId: string }> {
  const r = await db.query<{ id: string; anno_id: string }>(
    `SELECT s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [sede, annoInizio])
  return { id: r.rows[0].id, annoId: r.rows[0].anno_id }
}

/** Le due quote, un modulo per lista e l'apertura delle iscrizioni dell'anno `a` (le funzioni della PR 4.5). */
async function apri(db: PGlite, a: string): Promise<void> {
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UTENTE])
}

async function sezione(db: PGlite, sede: string, annoId: string, nome: string, tipo: 'infanzia' | 'primaria', continuaDa: string | null = null) {
  return una<string>(
    db,
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da) VALUES ($1, $2, $3, $4::text::public.school_type_enum, $4::text, $5) RETURNING id`,
    [sede, annoId, nome, tipo, continuaDa])
}

async function nuovoAlunno(db: PGlite, id: string, sede: string, stato: 'iscritto' | 'in_arrivo', sezioneId: string | null) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato, section_id) VALUES ($1, $2, $3, $4)`, [id, sede, stato, sezioneId])
}

/** La frequenza viva dell'anno in corso (la scrive lo specchio alla nascita dell'alunno `iscritto`). */
async function frequenzaVecchia(db: PGlite, alunno: string, da: string): Promise<string> {
  return una<string>(db, `SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, da])
}

async function conferma(db: PGlite, freq: string, a: string, sezioneId: string | null = null, cambiaGrado = false): Promise<Rec> {
  return una<Rec>(db, `SELECT public.anno_conferma($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::boolean)`, [freq, a, sezioneId, UTENTE, cambiaGrado])
}

async function nuovaIscrizione(db: PGlite, alunno: string, a: string, sezioneId: string): Promise<void> {
  await db.query(
    `SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'segreteria', NULL, $3::uuid, NULL, '{}'::jsonb, $4::uuid)`,
    [alunno, a, sezioneId, UTENTE])
}

/** Archivia nell'anno vecchio: la frequenza si chiude e lo specchio porta la scheda a `ritirato` con `archiviato_il`. */
async function archivia(db: PGlite, alunno: string, da: string): Promise<void> {
  await db.query(
    `UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, da])
}

/** Un ex alunno archiviato che torna per l'anno nuovo: la scheda è `in_arrivo`, senza classe e non più archiviata. */
async function riattivaInArrivo(db: PGlite, alunno: string): Promise<void> {
  await db.query(`UPDATE public.alunni SET stato = 'in_arrivo', archiviato_il = NULL, section_id = NULL, classe_sezione = NULL WHERE id = $1`, [alunno])
}

/** Un banco del passaggio, con la popolazione descritta in testa al file. */
export async function creaBancoPassaggio(opzioni: OpzioniBancoPassaggio = {}): Promise<BancoPassaggio> {
  const o = { ...opzioni, completo: opzioni.completo ?? true }
  // Con `completo` le tabelle grandi portano già `importo_retta_mensile` e `archiviato_il`: manca solo l'oblio.
  const colonne = `
    ALTER TABLE public.alunni
      ${o.completo ? '' : 'ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0, ADD COLUMN archiviato_il timestamptz,'}
      ADD COLUMN anonimizzato_il timestamptz;
    ALTER TABLE public.pagamenti
      ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
      ADD COLUMN gruppo text,
      ADD COLUMN creato_da uuid;
  `
  // ── S32 · Il TRIGGER VERO di produzione dello storico delle classi (`storici_traccia_classe`, `pg_get_functiondef` del 2026-11-09,
  // sola lettura), con le colonne vere della tabella. Con `completo` il banco ha una tabella povera (`alunni_classi_storico` senza
  // `section_id`): senza il trigger il passaggio non scriveva mai lo storico e una riga rotta (B1) restava verde. M48b ne sostituisce
  // il corpo con la correzione; qui nasce com'è in produzione, così la prova vede il difetto prima e la correzione dopo.
  const storico = o.completo ? `
    ALTER TABLE public.galleria_media_v2
      ADD COLUMN tag_students uuid[] NOT NULL DEFAULT '{}'::uuid[],
      ADD COLUMN is_broadcast boolean DEFAULT false,
      ADD COLUMN eliminato_il timestamptz;
    ALTER TABLE public.alunni_classi_storico
      ADD COLUMN section_id uuid NOT NULL,
      ADD COLUMN section_nome text NOT NULL DEFAULT '',
      ADD COLUMN fonte text NOT NULL DEFAULT 'attuale',
      ADD CONSTRAINT storico_al_dopo_dal CHECK (al IS NULL OR al >= dal),
      ADD CONSTRAINT storico_fonte CHECK (fonte IN ('attuale', 'presenza', 'staff', 'trasferimento')),
      ADD CONSTRAINT storico_unica UNIQUE (alunno_id, scuola_id, section_id, dal, fonte);
    CREATE OR REPLACE FUNCTION public.storici_traccia_classe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
    declare giorno date := (now() at time zone 'Europe/Rome')::date;
    begin
      if TG_OP='UPDATE' and new.section_id is not distinct from old.section_id and new.scuola_id is not distinct from old.scuola_id
        and new.archiviato_il is not distinct from old.archiviato_il then return new; end if;
      if TG_OP='UPDATE' then
        update public.alunni_classi_storico set al=greatest(dal,giorno)
        where alunno_id=new.id and al is null;
      end if;
      if new.section_id is not null and new.anonimizzato_il is null and new.archiviato_il is null then
        insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,fonte)
        values(new.id,new.scuola_id,new.section_id,coalesce((select name from public.sections where id=new.section_id),''),giorno,'trasferimento') on conflict do nothing;
      end if;
      return new;
    end $function$;
    CREATE TRIGGER storici_traccia_classe AFTER INSERT OR UPDATE OF section_id, scuola_id, archiviato_il ON public.alunni
      FOR EACH ROW EXECUTE FUNCTION public.storici_traccia_classe();
  ` : ''
  const db = await creaDbAnnoPr2({
    sedi: [SEDE_E2E, SEDE_SIM, SEDE_VERA],
    fino: o.fino ?? 'M48b',
    completo: o.completo,
    codaPrima:
      (o.completo ? '' : SCHEMA_GALLERIA_GENITORE) + SCHEMA_ISCRIZIONE_ANNO + SCHEMA_PASSAGGIO_DIDATTICA + colonne + storico + (o.codaPrima ?? ''),
  })
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)

  await db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [SEDE_SIM])

  const e2e = { da: await annoSede(db, SEDE_E2E, 2026), a: await annoSede(db, SEDE_E2E, 2027) }
  const sim = { da: await annoSede(db, SEDE_SIM, 2026), a: await annoSede(db, SEDE_SIM, 2027) }
  const vera = { da: await annoSede(db, SEDE_VERA, 2026), a: await annoSede(db, SEDE_VERA, 2027) }

  // ── La sede del passaggio: classi vecchie, docenti, apertura delle iscrizioni (che copia le classi), poi le classi che non hanno
  // continuazione (la terza dell'infanzia e la prima della primaria).
  const girasoli = await sezione(db, SEDE_E2E, e2e.da.annoId, 'Girasoli', 'infanzia')
  const farfalle = await sezione(db, SEDE_E2E, e2e.da.annoId, 'Farfalle', 'infanzia')
  await apri(db, e2e.a.id)
  const stelline = await sezione(db, SEDE_E2E, e2e.da.annoId, 'Stelline', 'infanzia')
  const figlie = await db.query<{ id: string; continua_da: string }>(
    `SELECT id, continua_da FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [SEDE_E2E, e2e.a.annoId])
  const girasoliNuova = figlie.rows.find((r) => r.continua_da === girasoli)!.id
  const farfalleNuova = figlie.rows.find((r) => r.continua_da === farfalle)!.id
  const primaria = await sezione(db, SEDE_E2E, e2e.a.annoId, 'Prima A', 'primaria')

  // In produzione `utenti.archiviato_il` c'è (docente revocato): il banco ha solo la chiave, la colonna si aggiunge qui (giro 2, R7).
  await db.query(`ALTER TABLE public.utenti ADD COLUMN IF NOT EXISTS archiviato_il timestamptz`)
  for (const d of [DOCENTE_1, DOCENTE_2]) await db.query(`INSERT INTO public.utenti (id) VALUES ($1)`, [d])
  await db.query(
    `INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2), ($1, $3), ($4, $5)`,
    [DOCENTE_1, girasoli, stelline, DOCENTE_2, farfalle])

  const f = (b: string) => frequenzaVecchia(db, b, e2e.da.id)
  await nuovoAlunno(db, BAMBINI.continua, SEDE_E2E, 'iscritto', girasoli)
  await conferma(db, await f(BAMBINI.continua), e2e.a.id)

  await nuovoAlunno(db, BAMBINI.continuaB, SEDE_E2E, 'iscritto', farfalle)
  await conferma(db, await f(BAMBINI.continuaB), e2e.a.id)

  await nuovoAlunno(db, BAMBINI.continuaAltraSezione, SEDE_E2E, 'iscritto', farfalle)
  await conferma(db, await f(BAMBINI.continuaAltraSezione), e2e.a.id, girasoliNuova)

  await nuovoAlunno(db, BAMBINI.nuova, SEDE_E2E, 'in_arrivo', null)
  await nuovaIscrizione(db, BAMBINI.nuova, e2e.a.id, girasoliNuova)

  await nuovoAlunno(db, BAMBINI.no, SEDE_E2E, 'iscritto', girasoli)
  await db.query(`SELECT public.anno_non_rinnova($1::uuid, true, 'altro', $2::uuid)`, [await f(BAMBINI.no), UTENTE])

  await nuovoAlunno(db, BAMBINI.nonRisposto, SEDE_E2E, 'iscritto', farfalle)

  await nuovoAlunno(db, BAMBINI.ritiratoTendina, SEDE_E2E, 'iscritto', girasoli)
  await conferma(db, await f(BAMBINI.ritiratoTendina), e2e.a.id)
  await db.query(`UPDATE public.alunni SET stato = 'ritirato' WHERE id = $1`, [BAMBINI.ritiratoTendina])

  await nuovoAlunno(db, BAMBINI.ritiratoArchiviato, SEDE_E2E, 'iscritto', girasoli)
  await archivia(db, BAMBINI.ritiratoArchiviato, e2e.da.id)

  await nuovoAlunno(db, BAMBINI.ritornato, SEDE_E2E, 'iscritto', girasoli)
  await archivia(db, BAMBINI.ritornato, e2e.da.id)
  await riattivaInArrivo(db, BAMBINI.ritornato)
  await nuovaIscrizione(db, BAMBINI.ritornato, e2e.a.id, girasoliNuova)

  await nuovoAlunno(db, BAMBINI.inArrivoConConferma, SEDE_E2E, 'iscritto', girasoli)
  await conferma(db, await f(BAMBINI.inArrivoConConferma), e2e.a.id)
  await archivia(db, BAMBINI.inArrivoConConferma, e2e.da.id)
  await riattivaInArrivo(db, BAMBINI.inArrivoConConferma)

  await nuovoAlunno(db, BAMBINI.cambiaGradoConSezione, SEDE_E2E, 'iscritto', stelline)
  await conferma(db, await f(BAMBINI.cambiaGradoConSezione), e2e.a.id, primaria, true)

  await nuovoAlunno(db, BAMBINI.cambiaGradoSenzaSezione, SEDE_E2E, 'iscritto', stelline)
  await conferma(db, await f(BAMBINI.cambiaGradoSenzaSezione), e2e.a.id, null, false)

  // ── La sede di simulazione: una classe e due bambini.
  const simVecchia = await sezione(db, SEDE_SIM, sim.da.annoId, 'Coccinelle', 'infanzia')
  await apri(db, sim.a.id)
  const simNuova = (await una<string>(db, `SELECT id FROM public.sections WHERE scuola_id = $1 AND anno_id = $2 AND continua_da = $3`,
    [SEDE_SIM, sim.a.annoId, simVecchia]))
  await nuovoAlunno(db, BAMBINI_SIM.continua, SEDE_SIM, 'iscritto', simVecchia)
  await conferma(db, await frequenzaVecchia(db, BAMBINI_SIM.continua, sim.da.id), sim.a.id)
  await nuovoAlunno(db, BAMBINI_SIM.nonRisposto, SEDE_SIM, 'iscritto', simVecchia)

  const oggi = await una<string>(db, `SELECT (ultimo_giorno_aperto + 1)::text FROM public.anni_sede WHERE id = $1`, [e2e.da.id])
  const inizio = await una<string>(db, `SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [e2e.a.id])

  return {
    db, da: e2e.da.id, a: e2e.a.id, annoDa: e2e.da.annoId, annoA: e2e.a.annoId,
    sim: { da: sim.da.id, a: sim.a.id }, vera: { da: vera.da.id, a: vera.a.id },
    sezioni: { girasoli, farfalle, stelline, girasoliNuova, farfalleNuova, primaria, simVecchia, simNuova },
    oggi, inizio,
  }
}
