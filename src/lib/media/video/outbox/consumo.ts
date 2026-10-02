import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'

import { DESTINATARI, destinatarioDi } from './destinatari'
import { codiceDi, schemaAssente, type EsitoRpc } from './rpc'
import type { ContestoConsegna, EsitoConsegna, EsitoOutbox, EventoOutbox, RegistroDestinatari } from './tipi'

/** Per quanto si tiene la lease degli eventi presi, se il chiamante non dice altro. */
export const LEASE_PREDEFINITA_SECONDI = 120

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
   * Solo questi tipi. Assente = tutti, come fa la retention.
   *
   * ⚠️ IL FILTRO È APPLICATO DOPO IL CLAIM, e va saputo. `video_outbox_claim` non conosce i
   * tipi: prende i `limite` eventi prendibili più vecchi, di qualunque tipo. Quelli fuori dal
   * filtro restano nelle mani di chi li ha presi — lease di `leaseSecondi` e `attempts` + 1
   * — senza essere né consegnati né falliti (non si chiamano `video_outbox_sent` né
   * `video_outbox_fail`, e nessun destinatario li vede). Tornano prendibili alla scadenza
   * della lease: non si perdono, ma ogni giro filtrato ne consuma un tentativo e può
   * occupare il posto di un evento che gli compete. Un elenco vuoto non prende niente.
   *
   * Per prendere SOLO i propri servirebbe un claim che filtri nel database (un overload di
   * `video_outbox_claim` con un elenco di tipi): la chiamata qui sotto è l'unico punto da cambiare.
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
 * Chiama le tre RPC che esistono già, senza riscriverne nessuna: la lease, il backoff e la
 * quarantena sono decisioni del database, e due copie della stessa decisione divergono il
 * giorno in cui qualcuno ne corregge una sola. In particolare, qui NON si calcola né
 * l'attesa né il tetto dei tentativi:
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
  const { data, error } = await supabase.rpc('video_outbox_claim', {
    p_lease_owner: proprietario,
    p_lease_seconds: leaseSecondi,
    p_limite: limite,
  })

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
      // Non è di questo consumatore: non si consegna, non si fallisce e non si grida. Chi ha
      // il destinatario lo prenderà quando la lease scade.
      saltati += 1
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
  // filtrato: senza filtro il conto è sempre zero, e la riga resta quella di sempre.
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
