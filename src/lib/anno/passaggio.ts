import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { segnalaErroreAnnoGestito } from '@/lib/logging/context'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceAnnoDa, type CodiceAnno } from '@/lib/anno/tipi'
import { oggiRoma } from '@/lib/storici/retroattivita'

/**
 * IL PASSAGGIO D'ANNO: l'unica porta TypeScript per le sette funzioni SQL `passaggio_*` (PR 4.8, migrazioni M48a-M48c) e per la
 * lettura del passaggio (`passaggi_anno`, `passaggi_anno_righe`, `passaggi_anno_docenti`). Le route, la pagina e la 4.9 passano da
 * qui e da nessun'altra parte (lo fissa il lock `passaggio-una-porta`, compito 4.8.11).
 *
 * Le funzioni di questo modulo NON LANCIANO MAI e rispondono con un esito:
 *  · `{ ok: true, …campi del jsonb }`: fatta;
 *  · `{ ok: true, saltata: 'schema-indietro' }`: il database non ha ancora la funzione o la tabella (la CI, la finestra del
 *    deploy). Chi chiama prosegue come oggi: un `info` e basta;
 *  · `{ ok: false, codice, dettagli? }`: un codice dell'anno (`PASSAGGIO_NON_PRONTO`, `RIGHE_DA_DECIDERE`…) o
 *    `SCRITTURA_FALLITA` per ogni altro guasto. `dettagli` (solo numeri) sono i conteggi del DETAIL del database, per la route
 *    che li mostra alla segreteria (quante righe da decidere, quante differenze): NON finiscono nei log.
 *
 * ⚠️ Nei log: uuid, codici, numeri. Mai un nome, un codice fiscale, il testo di un errore di Postgres (che può riportare la riga
 * intera): del guasto si logga il solo SQLSTATE. Le chiavi (`tipo`, `esito`, `n`, `entita_id`, `error_code`) sono quelle che il
 * logger lascia in chiaro; qui non se ne aggiunge nessuna.
 *
 * `oggi` (AAAA-MM-GG) si manda al database SOLO se è dato: senza, la funzione usa il giorno di Roma. Il database lo ammette
 * soltanto per le sedi di prova (`PASSAGGIO_OGGI_NON_AMMESSO` altrimenti).
 */

export type CodicePassaggio = CodiceAnno | 'SCRITTURA_FALLITA'

export type EsitoPassaggio<T> =
  | ({ ok: true } & T)
  | { ok: true; saltata: 'schema-indietro' }
  | { ok: false; codice: CodicePassaggio; dettagli?: Record<string, number> }

type EsitoFallito = { ok: true; saltata: 'schema-indietro' } | { ok: false; codice: CodicePassaggio; dettagli?: Record<string, number> }

/** Gli esiti di un bambino nel passaggio (`passaggio_calcola`). */
export const ESITI_PASSAGGIO = ['continua', 'cambia_grado', 'nuova', 'esce', 'non_risposto'] as const
export type EsitoRigaPassaggio = (typeof ESITI_PASSAGGIO)[number]
/** I segnali che la segreteria deve chiudere prima della conferma (elenco chiuso, mai testo libero). */
export const AVVISI_PASSAGGIO = ['ritirato_tendina', 'senza_sezione'] as const
export type AvvisoPassaggio = (typeof AVVISI_PASSAGGIO)[number]
export type StatoPassaggio = 'anteprima' | 'confermato' | 'annullato'
export type OrigineDocente = 'copiata' | 'aggiunta' | 'tolta'

type ErrorePg = { code?: string | null; message?: string | null; details?: string | null } | null | undefined

// ─────────────────────────────────────────────────────────────────────────────────────────────
// gli esiti degli errori
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * I numeri del DETAIL, se PostgREST lo porta come JSON (`{"senza_sezione":3}`). Difensivo: un testo, un array, un JSON rotto o
 * un valore che non è un numero finito non producono niente. Le chiavi sono parole in minuscolo con il trattino basso.
 */
function dettagliNumerici(details: unknown): Record<string, number> | undefined {
  if (typeof details !== 'string' || details.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(details)
  } catch {
    // il DETAIL non è JSON (un testo del database): non si legge e non si logga, `dettagli` resta assente
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const fuori: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (/^[a-z][a-z0-9_]*$/.test(k) && typeof v === 'number' && Number.isFinite(v)) fuori[k] = v
  }
  return Object.keys(fuori).length > 0 ? fuori : undefined
}

/** Un errore che ha fermato l'operazione: schema indietro → info; dell'anno → warn col codice; altro → logErrore col solo SQLSTATE. */
function esitoDaErrore(error: ErrorePg, operazione: string, entitaId: string): EsitoFallito {
  if (schemaAnnoIndietro(error)) {
    logEvento('anno-scolastico', 'info', { tipo: 'passaggio-schema-indietro', operazione, error_code: error?.code ?? undefined })
    return { ok: true, saltata: 'schema-indietro' }
  }
  const codice = codiceAnnoDa(error?.message)
  if (codice) {
    logEvento('anno-scolastico', 'warn', { tipo: 'passaggio-rifiutato', error_code: codice, entita_id: entitaId })
    // Gestito qui, fail-open: la rete di `withRoute` non deve tradurlo se la route risponde 500 per altro.
    segnalaErroreAnnoGestito(codice)
    const dettagli = dettagliNumerici(error?.details)
    return dettagli ? { ok: false, codice, dettagli } : { ok: false, codice }
  }
  // Solo il codice di Postgres: il messaggio di un CHECK riporta la riga intera.
  logErrore({ operazione }, new Error(`passaggio:${error?.code ?? 'senza-codice'}`))
  return { ok: false, codice: 'SCRITTURA_FALLITA' }
}

const eOggetto = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d)
const eStringa = (d: unknown): d is string => typeof d === 'string' && d.length > 0

/** Somma i soli numeri finiti, per le chiavi date (o per tutte). */
function somma(o: unknown, chiavi?: readonly string[]): number {
  if (!eOggetto(o)) return 0
  let n = 0
  for (const [k, v] of Object.entries(o)) {
    if (chiavi && !chiavi.includes(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) n += v
  }
  return n
}

/**
 * Chiama una funzione `passaggio_*` e ne controlla l'esito. `valida` dice se il jsonb ha la forma attesa; `logSuccesso` scrive
 * il log del successo. Il `{ error }` di PostgREST si controlla, non si lancia; se il client lancia davvero (rete) → guasto.
 */
async function chiama<T extends object>(
  supabase: SupabaseClient,
  funzione: string,
  args: Record<string, unknown>,
  entitaId: string,
  valida: (d: unknown) => d is T,
  logSuccesso: (d: T) => void,
): Promise<EsitoPassaggio<T>> {
  const operazione = `anno/passaggio:${funzione}`
  try {
    const { data, error } = await supabase.rpc(funzione, args)
    if (error) return esitoDaErrore(error, operazione, entitaId)
    if (!valida(data)) {
      logErrore({ operazione }, new Error('passaggio:risposta-inattesa'))
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }
    logSuccesso(data)
    return { ok: true, ...data }
  } catch (err) {
    // il client ha lanciato (rete, configurazione): chi chiama non deve cadere per questo
    logErrore({ operazione }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

/** `p_oggi` solo se c'è: senza, il database usa il giorno di Roma. */
const conOggi = (oggi: string | null | undefined): { p_oggi?: string } => (oggi ? { p_oggi: oggi } : {})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// le sei scritture
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** I campi del jsonb di `passaggio_anteprima`. */
export type RisultatoAnteprima = {
  passaggio_id: string
  /** `false` = esisteva già un'anteprima viva e si è ricalcolata. */
  creato: boolean
  righe: Partial<Record<EsitoRigaPassaggio, number>>
  avvisi?: Partial<Record<AvvisoPassaggio, number>>
  docenti?: { copiati?: number }
  /** AAAA-MM-GG: dal quel giorno il passaggio si può confermare. */
  apribile_dal?: string
}
export type EsitoAnteprima = EsitoPassaggio<RisultatoAnteprima>

export type AnteprimaArgs = {
  /** `anni_sede.id` dell'anno attivo. */
  daAnnoSedeId: string
  /** `anni_sede.id` dell'anno con le iscrizioni aperte. */
  aAnnoSedeId: string
  /** Chi la chiede (`utenti.id`). */
  da: string
  /** AAAA-MM-GG, solo per le sedi di prova. */
  oggi?: string | null
}

const eAnteprima = (d: unknown): d is RisultatoAnteprima => eOggetto(d) && eStringa(d.passaggio_id) && typeof d.creato === 'boolean'

/** Calcola (o ricalcola) l'anteprima del passaggio. Scrive solo le tre tabelle del passaggio, mai la scuola vera. */
export async function anteprimaPassaggio(supabase: SupabaseClient, a: AnteprimaArgs): Promise<EsitoAnteprima> {
  return chiama(
    supabase,
    'passaggio_anteprima',
    { p_da_anno_sede: a.daAnnoSedeId, p_a_anno_sede: a.aAnnoSedeId, p_da: a.da, ...conOggi(a.oggi) },
    // il passaggio può non esistere ancora: l'entità è l'anno nuovo
    a.aAnnoSedeId,
    eAnteprima,
    (d) => logEvento('anno-scolastico', 'info', {
      tipo: 'passaggio-anteprima',
      esito: d.creato ? 'creata' : 'esistente',
      n: somma(d.righe),
      entita_id: d.passaggio_id,
    }),
  )
}

export type RisultatoCorrezione = { alunno_id: string; esito: EsitoRigaPassaggio; eccezione: boolean }
export type EsitoCorrezione = EsitoPassaggio<RisultatoCorrezione>

export type CorreggiRigaArgs = {
  passaggioId: string
  alunnoId: string
  /** `continua | cambia_grado | nuova` con un'altra sezione, oppure `esce`. Il resto è `RIGA_NON_VALIDA`. */
  esito: EsitoRigaPassaggio
  /** La sezione nuova, se si cambia quella. */
  sezioneId?: string | null
  da: string
}

const eCorrezione = (d: unknown): d is RisultatoCorrezione => eOggetto(d) && eStringa(d.alunno_id) && eStringa(d.esito)

/** Corregge a mano la riga di un bambino (la sezione, o l'uscita). Non logga un successo per bambino: sono gesti, non eventi. */
export async function correggiRigaPassaggio(supabase: SupabaseClient, a: CorreggiRigaArgs): Promise<EsitoCorrezione> {
  return chiama(
    supabase,
    'passaggio_riga_correggi',
    { p_passaggio: a.passaggioId, p_alunno: a.alunnoId, p_esito: a.esito, p_sezione: a.sezioneId ?? null, p_da: a.da },
    a.passaggioId,
    eCorrezione,
    () => undefined,
  )
}

export type RisultatoDocente = { utente_id?: string; sezione_a_id?: string; origine?: OrigineDocente }
export type EsitoDocente = EsitoPassaggio<RisultatoDocente>

export type ImpostaDocenteArgs = {
  passaggioId: string
  utenteId: string
  sezioneId: string
  /** `aggiunta` mette il docente sulla sezione nuova; `tolta` lo toglie (a una `copiata` la marca, non la cancella). */
  origine: 'aggiunta' | 'tolta'
  da: string
}

const eDocente = (d: unknown): d is RisultatoDocente => eOggetto(d)

/** Aggiunge o toglie un docente dalla sezione nuova, nell'anteprima. */
export async function impostaDocentePassaggio(supabase: SupabaseClient, a: ImpostaDocenteArgs): Promise<EsitoDocente> {
  return chiama(
    supabase,
    'passaggio_docente_imposta',
    { p_passaggio: a.passaggioId, p_utente: a.utenteId, p_sezione: a.sezioneId, p_origine: a.origine, p_da: a.da },
    a.passaggioId,
    eDocente,
    () => undefined,
  )
}

export type ConteggiConferma = {
  continuano?: number
  nuovi?: number
  usciti?: number
  cambia_grado?: number
  docenti_copiati?: number
}
export type RisultatoConferma = { passaggio_id: string; gia_confermato: boolean; conteggi: ConteggiConferma }
export type EsitoConfermaPassaggio = EsitoPassaggio<RisultatoConferma>

export type ConfermaPassaggioArgs = { passaggioId: string; da: string; oggi?: string | null }

const eConferma = (d: unknown): d is RisultatoConferma =>
  eOggetto(d) && eStringa(d.passaggio_id) && typeof d.gia_confermato === 'boolean'

/** I bambini toccati dalla conferma (non i docenti): il `n` del log. */
const CHIAVI_BAMBINI_CONFERMA = ['continuano', 'nuovi', 'usciti', 'cambia_grado'] as const

/** Conferma il passaggio: il giorno dopo la fine dell'anno vecchio cambia l'anno attivo. Idempotente (`gia_confermato`). */
export async function confermaPassaggio(supabase: SupabaseClient, a: ConfermaPassaggioArgs): Promise<EsitoConfermaPassaggio> {
  return chiama(
    supabase,
    'passaggio_conferma',
    { p_passaggio: a.passaggioId, p_da: a.da, ...conOggi(a.oggi) },
    a.passaggioId,
    eConferma,
    (d) => logEvento('anno-scolastico', 'info', {
      tipo: 'passaggio-confermato',
      esito: d.gia_confermato ? 'gia_confermato' : 'confermato',
      n: somma(d.conteggi, CHIAVI_BAMBINI_CONFERMA),
      entita_id: d.passaggio_id,
    }),
  )
}

export type RisultatoAnnulla = { passaggio_id: string; gia_annullato?: boolean; conteggi?: Record<string, number> }
export type EsitoAnnulla = EsitoPassaggio<RisultatoAnnulla>

export type AnnullaPassaggioArgs = { passaggioId: string; da: string; oggi?: string | null }

const eAnnulla = (d: unknown): d is RisultatoAnnulla => eOggetto(d) && eStringa(d.passaggio_id)

/** Annulla il passaggio, se nel nuovo anno non c'è ancora niente d'uso (`PASSAGGIO_NON_ANNULLABILE` con i conteggi in `dettagli`). */
export async function annullaPassaggio(supabase: SupabaseClient, a: AnnullaPassaggioArgs): Promise<EsitoAnnulla> {
  return chiama(
    supabase,
    'passaggio_annulla',
    { p_passaggio: a.passaggioId, p_da: a.da, ...conOggi(a.oggi) },
    a.passaggioId,
    eAnnulla,
    (d) => logEvento('anno-scolastico', 'info', {
      tipo: 'passaggio-annullato',
      esito: d.gia_annullato === true ? 'gia_annullato' : 'annullato',
      entita_id: d.passaggio_id,
    }),
  )
}

export type RisultatoTardiva = {
  frequenza_id: string
  creata: boolean
  quota?: string | null
  pagamento_id?: string | null
}
export type EsitoTardiva = EsitoPassaggio<RisultatoTardiva>

export type ConfermaTardivaArgs = {
  passaggioId: string
  alunnoId: string
  /** Assente = la continuazione della sezione di partenza. */
  sectionId?: string | null
  da: string
  oggi?: string | null
}

const eTardiva = (d: unknown): d is RisultatoTardiva => eOggetto(d) && eStringa(d.frequenza_id) && typeof d.creata === 'boolean'

/** La famiglia che aveva detto «no» (o non aveva risposto) conferma dopo il passaggio: nasce la frequenza nel nuovo anno. */
export async function confermaTardiva(supabase: SupabaseClient, a: ConfermaTardivaArgs): Promise<EsitoTardiva> {
  return chiama(
    supabase,
    'passaggio_conferma_tardiva',
    { p_passaggio: a.passaggioId, p_alunno: a.alunnoId, p_section: a.sectionId ?? null, p_da: a.da, ...conOggi(a.oggi) },
    a.passaggioId,
    eTardiva,
    (d) => logEvento('anno-scolastico', 'info', {
      tipo: 'passaggio-conferma-tardiva',
      esito: d.creata ? 'creata' : 'esistente',
      n: 1,
      entita_id: d.frequenza_id,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// la lettura
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Una riga del passaggio: SOLO uuid e stati. I nomi li compone la pagina dai due campi di `alunni` e dall'elenco delle sezioni. */
export type RigaLettaPassaggio = {
  alunno_id: string
  esito: EsitoRigaPassaggio
  avviso: AvvisoPassaggio | null
  eccezione: boolean
  sezione_da_id: string | null
  sezione_a_id: string | null
  frequenza_a_id: string | null
}
export type DocenteLettoPassaggio = { utente_id: string; sezione_a_id: string; origine: OrigineDocente }
export type PassaggioLetto = {
  id: string
  stato: StatoPassaggio
  conteggi: Record<string, number>
  /** AAAA-MM-GG: il giorno dopo l'ultimo giorno aperto dell'anno vecchio; `null` se non si riesce a leggerlo. */
  apribile_dal: string | null
  /** AAAA-MM-GG: il primo giorno dell'anno NUOVO (`anni_sede.inizio`); dal quel giorno le famiglie vedono la classe nuova. `null` se non si legge. */
  inizio_anno_nuovo: string | null
  /** (giro 3, NS8) AAAA-MM-GG (giorno di Roma): il giorno della conferma. Se è dopo l'inizio, lo storico delle classi nuove parte da qui. `null` se non c'è. */
  confermato_il?: string | null
}
/** (giro 1, S19) I numeri che la pagina vuole a ogni correzione, in UNA risposta: righe per esito, righe con un avviso aperto e le prime da decidere. */
export type ContatoriPassaggio = {
  esiti: Record<EsitoRigaPassaggio, number>
  avvisi: Record<AvvisoPassaggio, number>
  /** Le righe con un avviso (senza doppioni), al più `daDecidereMax` per avviso. */
  daDecidere: RigaLettaPassaggio[]
  /**
   * (giro 2, S5) Le voci di quota ancora da pagare (`da_pagare`, `parziale`, `scaduto`) sulle frequenze nuove di chi ESCE: il passaggio non le tocca, la
   * segreteria deve saperlo. `null` = non si è potuto contare (la pagina non dice un numero inventato).
   */
  quoteSuUsciti: number | null
}
export type LetturaPassaggio = {
  passaggio: PassaggioLetto | null
  righe: RigaLettaPassaggio[]
  /** Il totale delle righe che passano il filtro (conteggio esatto del database), non quelle della pagina. */
  totale: number
  docenti: DocenteLettoPassaggio[]
  /** Solo se richiesti (`FiltriLettura.contatori`). */
  contatori?: ContatoriPassaggio
  /**
   * (giro 3, NS1) Il nome della classe di PARTENZA (dell'anno vecchio) per ogni `sezione_da_id` delle righe della pagina e dei «da decidere»:
   * l'elenco delle sezioni che la pagina conosce è quello dell'anno nuovo, e senza questo la colonna «Da» diceva «nessuna classe» a chi una
   * classe ce l'ha. Solo id di sezione e nome della classe (un nome di classe non è un dato di persona). Assente/vuoto = la pagina ripiega.
   */
  classi_da?: Record<string, string>
}
export type EsitoLettura = EsitoPassaggio<LetturaPassaggio>

export type FiltriLettura = {
  esito?: EsitoRigaPassaggio | null
  avviso?: AvvisoPassaggio | null
  /** Da 1. */
  pagina: number
  /** Righe per pagina: da 1 a `TETTO_MASSIMO`. */
  tetto: number
  /** Se > 0, la risposta porta anche i `contatori` (al più questo numero di righe «da decidere» per avviso, tetto `TETTO_MASSIMO`). */
  contatori?: number
}

/** Quanto può chiedere al massimo una pagina. */
export const TETTO_MASSIMO = 200

const OP_LETTURA = 'anno/passaggio:leggiPassaggio'
const OP_NOMI = 'anno/passaggio:leggiNomiDelPassaggio'
const COLONNE_RIGA = 'alunno_id, esito, avviso, eccezione, sezione_da_id, sezione_a_id, frequenza_a_id'

/** Il giorno dopo `AAAA-MM-GG`, o `null` se la data non è una data. */
function giornoDopo(giorno: unknown): string | null {
  if (typeof giorno !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(giorno)) return null
  const t = Date.parse(`${giorno}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t + 86_400_000).toISOString().slice(0, 10)
}

/** I soli numeri finiti di un jsonb (i conteggi): un testo o un oggetto annidato non passano. */
function soloNumeri(o: unknown): Record<string, number> {
  const fuori: Record<string, number> = {}
  if (!eOggetto(o)) return fuori
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) fuori[k] = v
  return fuori
}

export type NomeDelPassaggio = { id: string; nome: string; cognome: string }
export type EsitoNomi = EsitoPassaggio<{ nomi: NomeDelPassaggio[] }>

/**
 * (giro 1, S20) Nome, cognome e classe dei SOLI bambini che hanno una riga in questo passaggio, fra gli `ids` chiesti (al più `TETTO_MASSIMO`).
 * Niente codice fiscale, niente note: la pagina deve stampare un nome, non scaricare l'anagrafica. Un uuid che non è una riga del
 * passaggio non compare. NON LANCIA MAI; ogni `{ error }` si controlla (schema indietro → `saltata`; altro → `SCRITTURA_FALLITA`).
 */
export async function leggiNomiDelPassaggio(supabase: SupabaseClient, passaggioId: string, ids: readonly string[]): Promise<EsitoNomi> {
  const guasto = (e: ErrorePg) => esitoDaErrore(e, OP_NOMI, passaggioId)
  try {
    const cercati = Array.from(new Set(ids)).slice(0, TETTO_MASSIMO)
    if (cercati.length === 0) return { ok: true, nomi: [] }
    const righe = await supabase.from('passaggi_anno_righe').select('alunno_id').eq('passaggio_id', passaggioId).in('alunno_id', cercati)
    if (righe.error) return guasto(righe.error)
    const ammessi = ((righe.data ?? []) as Array<{ alunno_id: string }>).map((r) => r.alunno_id)
    if (ammessi.length === 0) return { ok: true, nomi: [] }
    const alunni = await supabase.from('alunni').select('id, nome, cognome').in('id', ammessi)
    if (alunni.error) return guasto(alunni.error)
    return {
      ok: true,
      nomi: ((alunni.data ?? []) as Array<{ id: string; nome: string | null; cognome: string | null }>).map((a) => ({
        id: a.id,
        nome: a.nome ?? '',
        cognome: a.cognome ?? '',
      })),
    }
  } catch (err) {
    logErrore({ operazione: OP_NOMI }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

/**
 * Il passaggio NON annullato verso l'anno nuovo, con le sue righe (una pagina, il totale è quello del filtro) e i suoi docenti.
 * `annoSedeNuovoId` è l'anno nuovo, quello della rotta. Nessun passaggio → `passaggio: null`. Solo uuid e stati. NON LANCIA MAI;
 * ogni `{ error }` si controlla (schema indietro → `saltata`; altro → `SCRITTURA_FALLITA` col solo SQLSTATE).
 */
export async function leggiPassaggio(supabase: SupabaseClient, annoSedeNuovoId: string, f: FiltriLettura): Promise<EsitoLettura> {
  const guasto = (e: ErrorePg) => esitoDaErrore(e, OP_LETTURA, annoSedeNuovoId)
  try {
    const tetto = Math.min(TETTO_MASSIMO, Math.max(1, Math.trunc(Number.isFinite(f.tetto) ? f.tetto : 1)))
    const pagina = Math.max(1, Math.trunc(Number.isFinite(f.pagina) ? f.pagina : 1))
    const da = (pagina - 1) * tetto

    const p = await supabase
      .from('passaggi_anno')
      .select('id, stato, conteggi, da_anno_sede_id, confermato_il')
      .eq('a_anno_sede_id', annoSedeNuovoId)
      .neq('stato', 'annullato')
      .maybeSingle()
    if (p.error) return guasto(p.error)
    const riga = p.data as { id: string; stato: StatoPassaggio; conteggi: unknown; da_anno_sede_id: string; confermato_il?: string | null } | null
    if (!riga) return { ok: true, passaggio: null, righe: [], totale: 0, docenti: [] }

    const vecchio = await supabase.from('anni_sede').select('ultimo_giorno_aperto').eq('id', riga.da_anno_sede_id).maybeSingle()
    if (vecchio.error) return guasto(vecchio.error)
    const apribileDal = giornoDopo((vecchio.data as { ultimo_giorno_aperto?: unknown } | null)?.ultimo_giorno_aperto)
    const nuovo = await supabase.from('anni_sede').select('inizio').eq('id', annoSedeNuovoId).maybeSingle()
    if (nuovo.error) return guasto(nuovo.error)
    const inizioRaw = (nuovo.data as { inizio?: unknown } | null)?.inizio
    const inizioAnnoNuovo = typeof inizioRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(inizioRaw) ? inizioRaw.slice(0, 10) : null

    let q = supabase.from('passaggi_anno_righe').select(COLONNE_RIGA, { count: 'exact' }).eq('passaggio_id', riga.id)
    if (f.esito) q = q.eq('esito', f.esito)
    if (f.avviso) q = q.eq('avviso', f.avviso)
    // L'ordine è sugli uuid: stabile fra una pagina e l'altra, e non ordina per nome di bambino.
    const righe = await q.order('alunno_id', { ascending: true }).range(da, da + tetto - 1)
    if (righe.error) return guasto(righe.error)

    const docenti = await supabase
      .from('passaggi_anno_docenti')
      .select('utente_id, sezione_a_id, origine')
      .eq('passaggio_id', riga.id)
      .order('utente_id', { ascending: true })
    if (docenti.error) return guasto(docenti.error)

    let contatori: ContatoriPassaggio | undefined
    const max = Math.min(TETTO_MASSIMO, Math.trunc(f.contatori ?? 0))
    if (max > 0) {
      const perEsito = await Promise.all(
        ESITI_PASSAGGIO.map((e) => supabase.from('passaggi_anno_righe').select('alunno_id', { count: 'exact', head: true }).eq('passaggio_id', riga.id).eq('esito', e)),
      )
      const perAvviso = await Promise.all(
        AVVISI_PASSAGGIO.map((a) =>
          supabase.from('passaggi_anno_righe').select(COLONNE_RIGA, { count: 'exact' }).eq('passaggio_id', riga.id).eq('avviso', a).order('alunno_id', { ascending: true }).range(0, max - 1),
        ),
      )
      const rotto = [...perEsito, ...perAvviso].find((r) => r.error)
      if (rotto?.error) return guasto(rotto.error)
      const esiti = {} as Record<EsitoRigaPassaggio, number>
      ESITI_PASSAGGIO.forEach((e, i) => { esiti[e] = perEsito[i].count ?? 0 })
      const avvisi = {} as Record<AvvisoPassaggio, number>
      const viste = new Set<string>()
      const daDecidere: RigaLettaPassaggio[] = []
      AVVISI_PASSAGGIO.forEach((a, i) => {
        avvisi[a] = perAvviso[i].count ?? 0
        for (const r of (perAvviso[i].data ?? []) as unknown as RigaLettaPassaggio[]) {
          if (viste.has(r.alunno_id)) continue
          viste.add(r.alunno_id)
          daDecidere.push({
            alunno_id: r.alunno_id,
            esito: r.esito,
            avviso: r.avviso ?? null,
            eccezione: r.eccezione === true,
            sezione_da_id: r.sezione_da_id ?? null,
            sezione_a_id: r.sezione_a_id ?? null,
            frequenza_a_id: r.frequenza_a_id ?? null,
          })
        }
      })
      // (giro 2, S5) Le quote ancora da pagare su chi esce: la frequenza nuova di chi esce → la sua voce di quota → lo stato del pagamento.
      // Tre letture a blocchi; una che cade non ferma la pagina (il numero è `null`) ma si registra.
      let quoteSuUsciti: number | null = 0
      const uscenti = await supabase
        .from('passaggi_anno_righe')
        .select('frequenza_a_id')
        .eq('passaggio_id', riga.id)
        .eq('esito', 'esce')
        .not('frequenza_a_id', 'is', null)
        .range(0, TETTO_MASSIMO * 5 - 1)
      if (uscenti.error) {
        logErrore({ operazione: OP_LETTURA }, uscenti.error)
        quoteSuUsciti = null
      } else {
        const freq = ((uscenti.data ?? []) as Array<{ frequenza_a_id: string | null }>).map((x) => x.frequenza_a_id).filter((x): x is string => !!x)
        for (let i = 0; i < freq.length && quoteSuUsciti !== null; i += 100) {
          const quote = await supabase.from('frequenze').select('quota_pagamento_id').in('id', freq.slice(i, i + 100)).not('quota_pagamento_id', 'is', null)
          if (quote.error) {
            logErrore({ operazione: OP_LETTURA }, quote.error)
            quoteSuUsciti = null
            break
          }
          const voci = ((quote.data ?? []) as Array<{ quota_pagamento_id: string | null }>).map((x) => x.quota_pagamento_id).filter((x): x is string => !!x)
          if (voci.length === 0) continue
          const aperte = await supabase.from('pagamenti').select('id', { count: 'exact', head: true }).in('id', voci).in('stato', ['da_pagare', 'parziale', 'scaduto'])
          if (aperte.error) {
            logErrore({ operazione: OP_LETTURA }, aperte.error)
            quoteSuUsciti = null
            break
          }
          quoteSuUsciti += aperte.count ?? 0
        }
      }
      contatori = { esiti, avvisi, daDecidere, quoteSuUsciti }
    }

    // (giro 3, NS1) I nomi delle classi di partenza. Una lettura che cade non ferma la pagina: la colonna ripiega sull'elenco che ha già.
    const idDa = new Set<string>()
    for (const r of [...((righe.data ?? []) as RigaLettaPassaggio[]), ...(contatori?.daDecidere ?? [])]) {
      if (typeof r.sezione_da_id === 'string') idDa.add(r.sezione_da_id)
    }
    const classiDa: Record<string, string> = {}
    if (idDa.size > 0) {
      const nomi = await supabase.from('sections').select('id, name').in('id', [...idDa])
      if (nomi.error) {
        logErrore({ operazione: OP_LETTURA }, new Error(`sections:${nomi.error.code ?? 'senza-codice'}`))
      } else {
        for (const x of (nomi.data ?? []) as Array<{ id: string; name: string | null }>) {
          if (typeof x.id === 'string' && typeof x.name === 'string') classiDa[x.id] = x.name
        }
      }
    }

    return {
      ok: true,
      classi_da: classiDa,
      passaggio: {
        id: riga.id, stato: riga.stato, conteggi: soloNumeri(riga.conteggi), apribile_dal: apribileDal, inizio_anno_nuovo: inizioAnnoNuovo,
        confermato_il: typeof riga.confermato_il === 'string' && !Number.isNaN(Date.parse(riga.confermato_il)) ? oggiRoma(new Date(riga.confermato_il)) : null,
      },
      righe: ((righe.data ?? []) as RigaLettaPassaggio[]).map((r) => ({
        alunno_id: r.alunno_id,
        esito: r.esito,
        avviso: r.avviso ?? null,
        eccezione: r.eccezione === true,
        sezione_da_id: r.sezione_da_id ?? null,
        sezione_a_id: r.sezione_a_id ?? null,
        frequenza_a_id: r.frequenza_a_id ?? null,
      })),
      totale: righe.count ?? 0,
      docenti: ((docenti.data ?? []) as DocenteLettoPassaggio[]).map((d) => ({
        utente_id: d.utente_id,
        sezione_a_id: d.sezione_a_id,
        origine: d.origine,
      })),
      ...(contatori ? { contatori } : {}),
    }
  } catch (err) {
    logErrore({ operazione: OP_LETTURA }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}
