/**
 * LA CODA `video_outbox`, E CHI LA CONSUMA.
 *
 * Un motore solo (`consumaOutbox`) e un registro solo (`DESTINATARI`), condivisi da chiunque
 * debba consegnare gli eventi accodati dentro le transazioni del database: la retention
 * (`/api/gdpr/retention-video`, tutti i tipi registrati tranne quelli del runner, ogni dieci
 * minuti) e il runner (solo i tipi suoi, a ogni giro). I due si dividono i tipi NEL claim.
 *
 *   · per consumare:             `consumaOutbox(supabase, { operazione, limite, tipi? })`
 *   · per registrare un tipo:    una riga in `DESTINATARI` (`./destinatari.ts`)
 *   · per sapere chi prende cosa: `tipiDellaRetention()` e `TIPI_SOLO_DEL_RUNNER` (`./consumo.ts`)
 *
 * Non c'è un secondo posto in cui chiamare `video_outbox_claim`, `video_outbox_sent` o
 * `video_outbox_fail`: due consumi diversi sullo stesso schema di lease sono due decisioni
 * diverse sullo stesso evento.
 */
export {
  consumaOutbox,
  LEASE_PREDEFINITA_SECONDI,
  OUTBOX_NON_ESEGUITO,
  TIPI_SOLO_DEL_RUNNER,
  tipiDellaRetention,
  type OpzioniConsumoOutbox,
} from './consumo'
export { DESTINATARI, destinatarioDi, ricevutaRetention } from './destinatari'
export { CODICI_SCHEMA_ASSENTE, codiceDi, schemaAssente, type EsitoRpc } from './rpc'
export type {
  ContestoConsegna,
  Destinatario,
  EsitoConsegna,
  EsitoOutbox,
  EventoOutbox,
  RegistroDestinatari,
} from './tipi'
