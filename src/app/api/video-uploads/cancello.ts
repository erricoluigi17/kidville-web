import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente } from '@/lib/auth/scope'
import type { CanaleVideo } from '@/lib/media/video/contratto'

import { logVideo, rispostaVideo } from './risposte'

/**
 * IL CANCELLO APPLICATIVO DELLA PIPELINE VIDEO — chi sei, dove stai scrivendo,
 * con quale ambito. In TypeScript, in un posto solo, per TUTTI i verbi.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * I DUE CANCELLI, E DOVE PASSA IL CONFINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * · **Applicativo** (questo file): ruolo, sede, ambito. Riusa i presidi che il
 *   repository ha già — `requireDocente` nelle route, `resolveScuolaScrittura`
 *   e `scuoleDiUtente` qui — e NON esiste da nessun'altra parte. In particolare
 *   non esiste in SQL: le RPC girano a `service_role` e non sanno né chi sta
 *   chiamando né quali plessi gli appartengano. Riscrivere lì questa logica
 *   vorrebbe dire due verità che invecchiano separatamente.
 *
 * · **Transazionale** (le RPC `video_*`): un solo vincitore, revisione corrente,
 *   job pronti, target non cambiato, `fence_epoch`. Sono cose che si possono
 *   sapere SOLO sotto lock, e nessun controllo in TypeScript le può garantire:
 *   fra il `SELECT` della route e la sua scrittura c'è una finestra in cui un
 *   altro processo può aver già vinto.
 *
 * Il ponte fra i due è che la route attraversa il cancello applicativo e chiama
 * la RPC **nella stessa richiesta**; la RPC rifiuta se nel frattempo è cambiato
 * qualcosa. Nessuno dei due può fare il mestiere dell'altro.
 *
 * ⚠️ E il cancello applicativo è **uno solo**, chiamato da ogni handler. Il
 * difetto che questo file esiste per non ripetere è già costato in questo
 * repository: una copia del gate scritta dentro un handler proteggeva la `POST`
 * e lasciava scoperta la `PATCH` accanto — due strade, e su una non c'era
 * nessuno. `sedeAncoraPropria` è chiamata da un punto solo (`leggiIntento`) e
 * vale quindi per il `GET` e per tutte e quattro le azioni del `PATCH`.
 *
 * ⚠️ CHE COSA *NON* STA QUI, e perché. La risoluzione della sede di una SCRITTURA
 * NUOVA (`resolveScuolaScrittura`) resta scritta dentro l'handler della `POST`.
 * Non è una svista ed è l'unico punto in cui questo file si ferma: quella
 * chiamata ha un solo chiamante — non c'è nessuna seconda copia da cui
 * divergere — e soprattutto `isolamento-sede-coverage.test.ts` la cerca per NOME
 * dentro il corpo dell'handler, perché una funzione `SECURITY DEFINER` non
 * riceve nessun filtro addosso. Nasconderla dietro un helper non renderebbe il
 * codice più sicuro: renderebbe cieco il lock che lo sorveglia — misurato, e non
 * dedotto: il primo giro l'ha segnalata come `rpc-senza-sede`.
 */

/** Chi può aprire un contenuto SENZA sede, cioè valido per tutti e tre i plessi. */
const RUOLI_AMBITO_GLOBALE = ['admin', 'coordinator'] as const

/** Confronto fra uuid senza distinzione di maiuscole, come fa `@/lib/auth/scope`. */
function stessaSede(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * L'AMBITO GLOBALE — l'unica sede assente ammessa, e chi può dichiararla.
 *
 * Non è un'omissione: è una dichiarazione. Lo pretende anche il database
 * (`video_intents_scuola_scope_chk` ammette `scuola_id IS NULL` solo con
 * `payload->>'scope' = 'global'`); qui si aggiunge la parte che il database non
 * può conoscere, cioè CHI può prenderla.
 *
 * ⚠️ Perché la Direzione e non chi insegna: un contenuto senza sede esce su tutti
 * e tre i plessi. È la stessa regola del broadcast della Galleria, dove la
 * comunicazione a un'intera sede è riservata ad admin e coordinatore, e nasce
 * dallo stesso rilievo: una regola di perimetro applicata dal client non è una
 * regola. V09 potrà stringerla ancora (la pubblicazione ha gate suoi), non
 * allargarla.
 *
 * Vive qui, e non nei due handler, perché il ruolo ammesso deve essere lo stesso
 * quando l'intento si APRE e quando lo si CONFERMA: due elenchi divergerebbero, e
 * il secondo è quello che decide se una cosa viene pubblicata.
 */
export function ambitoGlobaleNegato(
  user: AppUser,
  canale: CanaleVideo,
  tipo: string,
  operazione: string,
): NextResponse | null {
  if ((RUOLI_AMBITO_GLOBALE as readonly string[]).includes(user.role)) return null
  logVideo(canale, 'warn', {
    operazione,
    esito: 'ambito-globale-negato',
    tipo,
    utente: user.id,
    ruolo: user.role,
  })
  return rispostaVideo('VIDEO_NON_AUTORIZZATO', 403)
}

/**
 * LA SEDE DI UN INTENTO GIÀ APERTO È ANCORA FRA LE MIE?
 *
 * Il piano lo chiede per esteso: «pubblicazione solo pronta e già confermata, con
 * **riverifica dei permessi correnti**». I permessi si valutano quando si apre
 * l'intento, ma fra quel momento e la conferma passano minuti — e in questo
 * repository lo spostamento di sede di un membro del personale è un'operazione
 * reale (`admin/staff:PATCH`, 2026-09-04). Un'insegnante uscita da un plesso non
 * deve poter concludere né seguire un caricamento rimasto lì dentro.
 *
 * La proprietà della riga la verifica la RPC (`OWNER_MISMATCH`), e la lettura la
 * filtra già per `owner_id`: qui si verifica la SEDE, che la RPC non può
 * conoscere.
 */
export async function sedeAncoraPropria(opzioni: {
  supabase: SupabaseClient
  user: AppUser
  canale: CanaleVideo
  scuolaIdIntento: string | null
  operazione: string
}): Promise<{ response?: NextResponse }> {
  const { supabase, user, canale, scuolaIdIntento, operazione } = opzioni

  if (scuolaIdIntento === null) {
    // Ambito globale: non c'è una sede da confrontare, c'è un ruolo — ed è lo
    // stesso elenco con cui l'intento era stato aperto.
    const negato = ambitoGlobaleNegato(user, canale, 'intento-globale', operazione)
    return negato ? { response: negato } : {}
  }

  const proprie = await scuoleDiUtente(supabase, user)
  if (proprie.some((id) => stessaSede(id, scuolaIdIntento))) return {}

  // `warn` e non `info`: è un accesso negato a dati di un'altra sede, cioè un
  // segnale di sicurezza. Solo uuid, ruolo e conteggi — mai un nome.
  logVideo(canale, 'warn', {
    operazione,
    esito: 'intento-fuori-sede',
    tipo: 'sede-intento-non-accessibile',
    utente: user.id,
    ruolo: user.role,
    sede_richiesta: scuolaIdIntento,
    accessibili: proprie.length,
  })
  return { response: rispostaVideo('VIDEO_NON_AUTORIZZATO', 403) }
}
