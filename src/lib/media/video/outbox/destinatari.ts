import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'

import { codiceDi } from './rpc'
import type { ContestoConsegna, Destinatario, EsitoConsegna, EventoOutbox, RegistroDestinatari } from './tipi'

/**
 * I DESTINATARI DEGLI EVENTI DI `video_outbox`, uno per tipo — e L'UNICO POSTO in cui si
 * registra un tipo nuovo.
 *
 * Il registro è condiviso da chiunque consumi la coda (`consumo.ts`): oggi la retention
 * (`/api/gdpr/retention-video`, ogni dieci minuti, tutti i tipi) e, appena avrà un tipo
 * suo, il runner (a ogni giro, solo i tipi che gli competono). Un tipo si dichiara una
 * volta qui, e qualunque consumatore lo sa consegnare: la lease del claim
 * (`video_outbox_claim`) impedisce che due lo facciano insieme.
 *
 * ─── PERCHÉ UN REGISTRO E NON UNO `switch` ─────────────────────────────────
 *
 * Perché il caso che conta non è quello noto: è il tipo SENZA destinatario. La testata di
 * `video_outbox_fail`
 * (`20260916190200_video_intent_lifecycle.sql:1430-1448`) racconta la misura che l'ha
 * scritta: venticinque tentativi bruciati in sedici millisecondi, e l'evento che dice
 * «aggancia questo video alla sua News» non riprovato mai più. Qui un tipo sconosciuto
 * viene messo in attesa con il suo backoff e **gridato** (`error`), non cancellato e non
 * dichiarato inviato. Poi, a venticinque tentativi, va in quarantena — e
 * `video_riconciliazione` la conta, così «nessuno lo consegnerà mai» è un numero e non una
 * scoperta.
 *
 * ─── I TRE TIPI CHE ESISTONO OGGI ──────────────────────────────────────────
 *
 * `intent.superseded` e `intent.revoked` li emette il database
 * (`20260916190200_video_intent_lifecycle.sql`, gli INSERT in `video_outbox` di
 * `:1093` e `:1242`), e il loro effetto POST-COMMIT è scritto accanto all'emissione: «la
 * revisione superata porta con sé i propri originali, che nessuno pubblicherà più: **la
 * retention deve saperlo**, o quei file restano sette giorni in più di quanto serva». Il
 * destinatario di quei due eventi, quindi, è la retention stessa — e la consegna è la
 * RICEVUTA: si verifica che ogni job di quell'intent abbia davvero una scadenza, cioè che
 * l'effetto dichiarato dentro la transazione sia sopravvissuto al commit. Se non ce l'ha,
 * l'evento NON è consegnato: si riprova, e il codice dice cosa cercare.
 *
 * `gallery.published` lo scrive `POST /api/gallery` (V08) attraverso
 * `video_intent_finalize`. Fino al 2026-09-24 qui non aveva un destinatario: dal 18 al
 * 23/09 tredici eventi hanno gridato `outbox-senza-destinatario` a ogni giro e sono finiti
 * in quarantena (`attempts` 25) con `DESTINATARIO_ASSENTE`. La sessione che rilascia
 * questa correzione li rimette in circolo una volta, a mano (consegna 2b, D14).
 *
 * ⚠️ PER UN TIPO NUOVO il posto in cui scrivere il destinatario è questo oggetto, una riga
 * per tipo. Finché non c'è, quel tipo grida a ogni giro invece di essere consegnato per
 * finta — e il lock di famiglia in `__tests__/api/gdpr-retention-video.test.ts` diventa
 * rosso appena qualcuno lo scrive in `video_outbox` con un letterale (in una migrazione, o
 * come argomento di una RPC) senza averlo registrato qui.
 */
export const DESTINATARI: RegistroDestinatari = {
  'intent.superseded': ricevutaRetention,
  'intent.revoked': ricevutaRetention,
  // V08 (`src/app/api/gallery/route.ts`, la RPC che accoda questo tipo). La
  // notifica ai genitori parte già SINCRONA in quella richiesta: un secondo avviso
  // da qui sarebbe un doppione. L'effetto dopo il commit che resta è la retention:
  // `video_intent_finalize` pubblica solo con tutti i job `ready` e verificati, e
  // un job `ready` ha per vincolo la scadenza dell'originale
  // (`video_jobs_ready_chk`). La ricevuta lo verifica.
  'gallery.published': ricevutaRetention,
}

/**
 * Il destinatario di un tipo, o `undefined` se il registro non lo conosce.
 *
 * ⚠️ `Object.hasOwn` e non `registro[tipo]`: `event_type` arriva dal database, e il suo
 * vincolo (`^[a-z][a-z0-9_.-]*$`) ammette `constructor`. Con una lettura diretta un evento di
 * quel tipo troverebbe la funzione `Object` ereditata dal prototipo e la chiamerebbe come se
 * fosse un destinatario: l'evento fallirebbe con un codice (`CONSEGNA_FALLITA`) che non dice
 * la cosa vera, e il grido «nessun destinatario» non partirebbe mai.
 */
export function destinatarioDi(registro: RegistroDestinatari, tipo: string): Destinatario | undefined {
  return Object.hasOwn(registro, tipo) ? registro[tipo] : undefined
}

/**
 * La ricevuta della retention: ogni job dell'intent dell'evento ha una scadenza, o
 * è già uscito.
 *
 * `head: true` con `count: 'exact'`: si chiede un NUMERO, non le righe. Da questa
 * query non esce nessun percorso e nessun mime — sono video di minori, e un elenco
 * che non serve è un elenco che può finire in un log.
 */
export async function ricevutaRetention(
  supabase: SupabaseClient,
  evento: EventoOutbox,
  contesto: ContestoConsegna,
): Promise<EsitoConsegna> {
  const { count, error } = await supabase
    .from('video_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('intent_id', evento.intent_id)
    .is('original_delete_after', null)
    .is('original_deleted_at', null)

  if (error) {
    logEvento(
      'cron',
      'error',
      { operazione: contesto.operazione, esito: 'outbox-ricevuta-fallita', error_code: codiceDi(error) },
      error,
    )
    return { consegnato: false, codice: 'RICEVUTA_NON_LETTA' }
  }
  if ((count ?? 0) > 0) {
    // L'effetto dichiarato dentro la transazione non c'è: quei job sono
    // invisibili all'indice della retention. Non si consegna, e il giro
    // successivo — dopo `video_retention_scadenze` — troverà la rete già tesa.
    logEvento('cron', 'error', {
      operazione: contesto.operazione,
      esito: 'outbox-originali-senza-scadenza',
      intent_id: evento.intent_id,
      n_righe: count ?? 0,
      msg: `${contesto.operazione}: l'intent dell'evento ha ancora job senza scadenza dell'originale`,
    })
    return { consegnato: false, codice: 'ORIGINALI_SENZA_SCADENZA' }
  }
  return { consegnato: true }
}
