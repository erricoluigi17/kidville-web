import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Una riga di `video_outbox` così come la restituisce `video_outbox_claim`
 * (`to_jsonb` dell'intera riga, dopo l'incremento di `attempts`).
 *
 * I cinque campi in cima li leggono tutti. `payload` e `created_at` ci sono sempre nella
 * risposta vera, ma sono dichiarati facoltativi perché non tutti i doppi di collaudo li
 * riempiono: chi li usa (un destinatario che decide «questo evento è troppo vecchio»)
 * deve controllarli.
 */
export type EventoOutbox = {
  id: string
  intent_id: string
  revision: number
  event_type: string
  /** Quante volte l'evento è stato preso, questa compresa. A 25 va in quarantena. */
  attempts: number
  /** Identificatori e codici, mai testo libero: il vincolo `video_outbox_payload_minimo_chk` lo impone. */
  payload?: Record<string, unknown>
  /** ISO: quando l'evento è nato. */
  created_at?: string
}

/**
 * L'esito di una consegna. `consegnato: true` chiude l'evento (`video_outbox_sent`);
 * `consegnato: false` lo rimette in attesa col suo backoff (`video_outbox_fail`), e `codice`
 * è il codice d'errore che il database registra: `^[A-Z][A-Z0-9_]{0,79}$`, altrimenti la RPC
 * rifiuta con `BAD_INPUT` e l'evento resta con la lease di prima.
 */
export type EsitoConsegna = { consegnato: boolean; codice?: string }

/** Ciò che il consumo dice a un destinatario di sé: oggi solo come si presenta nei log. */
export type ContestoConsegna = {
  /** Il campo `operazione` dei log di questo giro: `video-retention`, o il nome del chiamante. */
  operazione: string
}

/**
 * Chi consegna un tipo di evento. Può fare qualunque cosa, ma deve restituire un
 * `EsitoConsegna`: non deve dichiarare «consegnato» ciò che non ha consegnato, perché
 * `video_outbox_sent` toglie l'evento dalla coda per sempre.
 *
 * Se lancia, il consumo lo registra come un fallimento (`DESTINATARIO_ECCEZIONE`) e passa
 * all'evento dopo: un destinatario rotto non deve fermare quelli che stanno dietro.
 */
export type Destinatario = (
  supabase: SupabaseClient,
  evento: EventoOutbox,
  contesto: ContestoConsegna,
) => Promise<EsitoConsegna>

/** Un destinatario per tipo di evento. Vedi `destinatari.ts`. */
export type RegistroDestinatari = Readonly<Record<string, Destinatario>>

/** Il conto di un giro di consumo. */
export type EsitoOutbox = {
  /** `ok`, oppure perché il giro non è partito: `schema-assente`, `claim-fallito`, `claim-rifiutato`, `nessun-tipo` (`non-eseguito` è il valore di partenza di chi non ha ancora girato). */
  esito: string
  /** Gli eventi che il claim ha preso, di qualunque tipo. */
  presi: number
  /** Quelli consegnati e chiusi con `video_outbox_sent`. */
  inviati: number
  /** Quelli rimessi in attesa, più quelli la cui chiusura non è andata a buon fine. */
  falliti: number
  /** Fra i falliti, quelli di un tipo che nessun destinatario sa consegnare. */
  senzaDestinatario: number
  /**
   * Presi ma fuori dal filtro `tipi`: non consegnati e non falliti. Con il filtro NEL claim vale
   * sempre zero; se non lo è, il database non lo applica e il consumo l'ha già gridato
   * (`outbox-evento-fuori-filtro`).
   */
  saltati: number
}
