import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'

import { DESTINATARI, destinatarioDi } from './destinatari'
import { codiceDi, schemaAssente, type EsitoRpc } from './rpc'
import type { ContestoConsegna, EsitoConsegna, EsitoOutbox, EventoOutbox, RegistroDestinatari } from './tipi'

/** Per quanto si tiene la lease degli eventi presi, se il chiamante non dice altro. */
export const LEASE_PREDEFINITA_SECONDI = 120

/**
 * I TIPI CHE CONSUMA SOLO IL RUNNER, e che la retention non prende mai (decisione dell'orchestratore,
 * spec §8.1, 02/10/2026).
 *
 * `gallery.auto_publish` accoda una PUBBLICAZIONE: copia di un video in galleria, RPC, notifiche. Non è
 * una ricevuta da millisecondi come gli altri tipi: se la retention la consegnasse, una raffica di
 * pubblicazioni sforerebbe i 25 eventi e i 120 secondi di lease con cui gira (lavoro doppio e
 * `LEASE_MISMATCH`). La consegna è del runner, che gira subito dopo ogni `ready` e a ogni giro; se il
 * runner è fermo non si converte niente, quindi una seconda rete sulle sole pubblicazioni non
 * aggiungerebbe nulla.
 *
 * È l'UNICO posto in cui si dice quali tipi sono del runner: la retention ricava i suoi da qui e dal
 * registro, senza elencarli a mano.
 */
export const TIPI_SOLO_DEL_RUNNER: readonly string[] = Object.freeze(['gallery.auto_publish'])

/**
 * I tipi che la retention consuma: TUTTI quelli registrati, meno quelli che consuma solo il runner.
 *
 * Si ricava dal registro e non si scrive a mano, così un tipo nuovo registrato in `destinatari.ts` entra
 * da solo fra quelli della retention e nessuno deve ricordarsi di aggiungerlo a un secondo elenco.
 * Un tipo NON registrato non è qui, quindi con il filtro nel claim la retention non lo prende più
 * (prima lo prendeva e lo gridava a ogni giro): lo vede `video_riconciliazione.outbox_in_ritardo`, e
 * il lock di famiglia di `__tests__/api/gdpr-retention-video.test.ts` impedisce che qualcuno lo scriva
 * nella coda senza averlo registrato.
 *
 * ⚠️ Il database accetta da 1 a 20 tipi (`BAD_INPUT` oltre): i registrati oggi sono quattro, e un test
 * pretende che restino sotto il tetto.
 */
export function tipiDellaRetention(registro: RegistroDestinatari = DESTINATARI): string[] {
  return Object.keys(registro).filter((tipo) => !TIPI_SOLO_DEL_RUNNER.includes(tipo))
}

/** Il conto di un giro che non è partito: il punto di partenza di ogni esito, e il valore iniziale di chi lo legge in un `finally`. */
export const OUTBOX_NON_ESEGUITO: EsitoOutbox = Object.freeze({
  esito: 'non-eseguito',
  presi: 0,
  inviati: 0,
  falliti: 0,
  senzaDestinatario: 0,
  saltati: 0,
})

export type OpzioniConsumoOutbox = {
  /**
   * Come questo giro si presenta in `app_log` (campo `operazione`): `video-retention` per la
   * retention, il nome del chiamante per gli altri. Passa anche ai destinatari, così le righe
   * di un giro portano tutte la stessa etichetta.
   */
  operazione: string
  /**
   * Quanti eventi si prendono al massimo in questo giro. Il database accetta da 1 a 100 e
   * rifiuta il resto con `BAD_INPUT` (esito `claim-rifiutato`).
   */
  limite: number
  /**
   * Solo questi tipi. Assente = tutti.
   *
   * IL FILTRO STA NEL CLAIM (secondario #1 della PR 1, chiuso dal file C della PR 2). Con un elenco si
   * chiama l'OVERLOAD a quattro argomenti, e il database prende SOLO gli eventi di quei tipi: gli altri
   * restano liberi, con `attempts` e lease invariati, e li prende chi li sa consegnare. Prima il filtro
   * si applicava DOPO il claim (che non conosceva i tipi): un consumatore filtrato si trovava in mano
   * gli eventi altrui, li teneva in lease senza consegnarli né fallirli, e li portava alla quarantena in
   * circa due ore; un evento suo poteva restare dietro `limite` eventi che non erano suoi.
   *
   * Senza elenco si chiama la versione a tre argomenti, com'è sempre stata. Un elenco vuoto non prende
   * niente (e si grida: è un errore di chi chiama). Il database accetta da 1 a 20 tipi.
   */
  tipi?: readonly string[]
  /**
   * Per quanto si tiene la lease degli eventi presi: da 1 a 1800 secondi (fuori, il database
   * rifiuta con `BAD_INPUT`). Parte per tutti gli eventi nel momento del claim, e gli eventi si
   * consegnano UNO DOPO L'ALTRO: deve coprire il lavoro di tutto il giro (nel caso peggiore
   * `limite` volte il destinatario più lento), o un altro consumatore riprende un evento mentre
   * il primo lo sta ancora aspettando. Predefinito `LEASE_PREDEFINITA_SECONDI`.
   */
  leaseSecondi?: number
  /** Il registro dei destinatari. Predefinito `DESTINATARI`; passarne un altro serve ai collaudi. */
  destinatari?: RegistroDestinatari
}

/**
 * Consuma `video_outbox`: prende fino a `limite` eventi con la lease, li consegna al
 * destinatario del loro tipo e chiude ciascuno — consegnato (`video_outbox_sent`) oppure
 * rimesso in attesa (`video_outbox_fail`) — con la STESSA lease con cui l'ha preso.
 *
 * Chiama le RPC che esistono già — il claim (a tre argomenti, o con l'elenco dei tipi a quattro),
 * `sent` e `fail` — senza riscriverne nessuna: la lease, il backoff e la quarantena sono decisioni del
 * database, e due copie della stessa decisione divergono il giorno in cui qualcuno ne corregge una
 * sola. In particolare, qui NON si calcola né l'attesa né il tetto dei tentativi:
 *
 *   · il backoff è di `video_outbox_fail`, che non rilascia la lease ma la sposta avanti
 *     (5 s, poi il doppio a ogni tentativo, fino a 900): un consumatore che ridrena subito
 *     non brucia i 25 tentativi in sedici millisecondi;
 *   · la quarantena è il filtro `attempts < 25` del claim: a venticinque prese l'evento non
 *     torna più, e `video_riconciliazione` lo conta (`outbox_in_quarantena`).
 *
 * Un tipo senza destinatario NON si dichiara inviato: si grida (`error`) e si chiude con
 * `DESTINATARIO_ASSENTE`, quindi va in attesa col suo backoff e, a venticinque prese, in
 * quarantena. Cancellarlo o dichiararlo consegnato lo farebbe sparire dalla coda senza che
 * nessuno l'abbia gestito.
 *
 * Non lancia: il valore di ritorno di ogni RPC è controllato (PostgREST non lancia, ritorna
 * `{ error }`) e un destinatario che lancia è registrato come un fallimento dell'evento, non
 * come la fine del giro. Gli eventi critici loggano anche il SUCCESSO: a zero, la riga
 * `outbox-svuotato` è la sola differenza fra «coda vuota» e «non si drena più».
 */
export async function consumaOutbox(
  supabase: SupabaseClient,
  opzioni: OpzioniConsumoOutbox,
): Promise<EsitoOutbox> {
  const { operazione, limite, tipi } = opzioni
  const leaseSecondi = opzioni.leaseSecondi ?? LEASE_PREDEFINITA_SECONDI
  const registro = opzioni.destinatari ?? DESTINATARI
  const contesto: ContestoConsegna = { operazione }

  if (tipi !== undefined && tipi.length === 0) {
    // Un filtro vuoto non può mai corrispondere a niente: prendere eventi per saltarli tutti
    // ne consumerebbe un tentativo ciascuno per nulla. È un errore di chi chiama, e si dice.
    logEvento('cron', 'error', {
      operazione,
      esito: 'outbox-nessun-tipo',
      msg: `${operazione}: il filtro sui tipi di video_outbox è vuoto, nessun evento preso`,
    })
    return { ...OUTBOX_NON_ESEGUITO, esito: 'nessun-tipo' }
  }
  const miei = tipi === undefined ? null : new Set(tipi)

  const proprietario = crypto.randomUUID()
  // Il filtro passa al database, che lo applica DENTRO il claim: nessun evento altrui viene preso,
  // quindi nessuno resta in lease senza essere consegnato. Senza filtro i tre argomenti di sempre: due
  // firme senza default, perché con un default una chiamata a tre argomenti combacerebbe con entrambe e
  // PostgREST risponderebbe PGRST203 (funzione ambigua).
  const argomentiClaim = {
    p_lease_owner: proprietario,
    p_lease_seconds: leaseSecondi,
    p_limite: limite,
  }
  const { data, error } = await supabase.rpc(
    'video_outbox_claim',
    miei === null ? argomentiClaim : { ...argomentiClaim, p_tipi: [...miei] },
  )

  if (error) {
    logEvento(
      'cron',
      schemaAssente(error) ? 'warn' : 'error',
      { operazione, esito: 'outbox-claim-fallito', error_code: codiceDi(error) },
      error,
    )
    return { ...OUTBOX_NON_ESEGUITO, esito: schemaAssente(error) ? 'schema-assente' : 'claim-fallito' }
  }

  const risposta = (data ?? null) as EsitoRpc | null
  if (risposta?.ok !== true) {
    logEvento('cron', 'error', {
      operazione,
      esito: 'outbox-claim-rifiutato',
      error_code: typeof risposta?.code === 'string' ? risposta.code : 'sconosciuto',
      msg: `${operazione}: video_outbox_claim ha rifiutato la richiesta`,
    })
    return { ...OUTBOX_NON_ESEGUITO, esito: 'claim-rifiutato' }
  }

  const eventi = Array.isArray(risposta.eventi) ? (risposta.eventi as EventoOutbox[]) : []
  let inviati = 0
  let falliti = 0
  let senzaDestinatario = 0
  let saltati = 0

  for (const evento of eventi) {
    if (miei !== null && !miei.has(evento.event_type)) {
      // NON PUÒ SUCCEDERE: il claim filtrato non consegna eventi fuori dall'elenco. Se succede, il
      // database che risponde non applica il filtro (un overload sbagliato, una versione vecchia della
      // funzione), e l'evento è ormai in lease con un tentativo in più. Non si consegna — non è di
      // questo consumatore — e non si fallisce, ma NON si tace: tornerà prendibile alla scadenza della
      // lease, e senza questa riga il vecchio difetto (eventi altrui tenuti in lease fino alla
      // quarantena) tornerebbe invisibile.
      saltati += 1
      logEvento('cron', 'error', {
        operazione,
        esito: 'outbox-evento-fuori-filtro',
        intent_id: evento.intent_id,
        n_tentativi: evento.attempts,
        msg: `${operazione}: il claim filtrato di video_outbox ha restituito un evento fuori dai tipi richiesti: il filtro non è applicato dal database`,
      })
      continue
    }

    const destinatario = destinatarioDi(registro, evento.event_type)
    let consegna: EsitoConsegna
    if (destinatario === undefined) {
      senzaDestinatario += 1
      // Configurazione mancante = livello `error`, mai `info` (AGENTS.md,
      // regola 4). Un evento che nessuno sa consegnare è esattamente questo:
      // un pezzo di configurazione che manca, e che a venticinque tentativi
      // porterà l'evento in quarantena per sempre.
      logEvento('cron', 'error', {
        operazione,
        esito: 'outbox-senza-destinatario',
        intent_id: evento.intent_id,
        n_tentativi: evento.attempts,
        msg: `${operazione}: nessun destinatario per un evento di video_outbox; alla venticinquesima prova finirà in quarantena`,
      })
      consegna = { consegnato: false, codice: 'DESTINATARIO_ASSENTE' }
    } else {
      try {
        consegna = await destinatario(supabase, evento, contesto)
      } catch (eccezione) {
        // Un destinatario che lancia non ferma il giro: quello che sta dietro nella coda
        // non ha colpa, e l'evento tornerà col suo backoff come ogni altro fallimento. Lasciarla
        // salire lascerebbe in lease tutti gli eventi presi e non ancora lavorati.
        logEvento(
          'cron',
          'error',
          {
            operazione,
            esito: 'outbox-consegna-eccezione',
            intent_id: evento.intent_id,
            n_tentativi: evento.attempts,
            msg: `${operazione}: il destinatario di un evento di video_outbox ha lanciato un'eccezione`,
          },
          eccezione,
        )
        consegna = { consegnato: false, codice: 'DESTINATARIO_ECCEZIONE' }
      }
    }

    const rpc = consegna.consegnato ? 'video_outbox_sent' : 'video_outbox_fail'
    const argomenti = consegna.consegnato
      ? { p_evento_id: evento.id, p_lease_owner: proprietario }
      : {
          p_evento_id: evento.id,
          p_lease_owner: proprietario,
          p_error_code: consegna.codice ?? 'CONSEGNA_FALLITA',
        }
    const { data: esitoRpc, error: erroreRpc } = await supabase.rpc(rpc, argomenti)

    if (erroreRpc) {
      logEvento(
        'cron',
        'error',
        {
          operazione,
          esito: 'outbox-chiusura-fallita',
          error_code: codiceDi(erroreRpc),
          intent_id: evento.intent_id,
        },
        erroreRpc,
      )
      falliti += 1
      continue
    }
    if ((esitoRpc as EsitoRpc | null)?.ok !== true) {
      logEvento('cron', 'error', {
        operazione,
        esito: 'outbox-chiusura-rifiutata',
        error_code:
          typeof (esitoRpc as EsitoRpc | null)?.code === 'string'
            ? ((esitoRpc as EsitoRpc).code as string)
            : 'sconosciuto',
        intent_id: evento.intent_id,
        msg: `${operazione}: la RPC di chiusura dell'evento ha rifiutato`,
      })
      falliti += 1
      continue
    }

    if (consegna.consegnato) inviati += 1
    else falliti += 1
  }

  // Gli eventi critici loggano anche il SUCCESSO: a zero, questo `info` è la sola
  // differenza fra «coda vuota» e «non si drena più». `n_saltati` c'è solo quando il giro è
  // filtrato: senza filtro il conto è sempre zero, e la riga resta quella di sempre. Con il filtro
  // nel claim vale sempre zero, e se non lo è lo ha già gridato `outbox-evento-fuori-filtro`.
  logEvento('cron', 'info', {
    operazione,
    esito: 'outbox-svuotato',
    n_righe: eventi.length,
    n_inviati: inviati,
    n_falliti: falliti,
    n_senza_destinatario: senzaDestinatario,
    ...(miei === null ? {} : { n_saltati: saltati }),
  })

  return { esito: 'ok', presi: eventi.length, inviati, falliti, senzaDestinatario, saltati }
}
