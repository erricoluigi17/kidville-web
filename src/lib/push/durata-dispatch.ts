import { ATTESA_MAX_MS, ATTESE_RITENTATIVO_MS } from '@/lib/push/native-push'
import { BUDGET_RITENTATIVI_MS, LIMITE_LETTURA, SOGLIA_PRESA_MS, TETTO_GIRO_MS } from '@/lib/push/dispatch'
import { ID_PER_QUERY } from '@/lib/db/blocchi'
import { tettoMs } from '@/lib/logging/external'
import { tettoMsArea } from '@/lib/logging/supabase-fetch'

// =============================================================================
// QUANTO DEVE POTER VIVERE UNA FUNZIONE CHE CHIAMA `eseguiDispatch`
//
// Il giro PRENDE le notifiche prima di spedirle. Se la piattaforma lo tronca dopo la presa,
// restano marcate, non partono più e non resta nemmeno una riga di log (vedi «IL PREZZO DELLA
// PRESA» in `./dispatch.ts`). Il tetto del giro (`TETTO_GIRO_MS`) le rimette in coda, ma si
// guarda solo PRIMA di cominciare una notifica: quella in corso quando il tetto passa arriva fino
// in fondo, dispositivo per dispositivo. E il budget dei ritentativi (`BUDGET_RITENTATIVI_MS`) si
// guarda per DISPOSITIVO: un invio nativo che comincia un attimo prima del budget ha ancora tutti
// i suoi ritentativi.
//
// Il conto qui sotto è costruito dai tetti che governano davvero il giro (quelli di FCM e web-push,
// quelli delle aree di Supabase, il numero di blocchi che `LIMITE_LETTURA` e `ID_PER_QUERY`
// impongono), così che chi ne alza uno alzi anche la soglia che il lock in
// `__tests__/lib/push-dispatch-durata.test.ts` pretende da ogni route che chiama il dispatch. Dove
// il conto fa un'ipotesi (dispositivi per utente, blocchi di rimozione) lo dice accanto.
//
// LE LETTURE PRIMA DELLA PRESA NON SI CONTANO, e non per ottimismo: il loro tempo NON HA UN TETTO.
// Sono GET (le notifiche, i dispositivi a blocchi), e postgrest-js ritenta da solo i GET su 503/520
// e sugli errori di rete: fino a 4 tentativi, ognuno al tetto dell'area, con un backoff di 1/2/4 s
// oppure l'attesa del `Retry-After`, che non ha limite superiore (`RETRYABLE_METHODS` in
// `@supabase/postgrest-js`; vedi `verràRitentato` in `@/lib/logging/supabase-fetch`). Una lettura
// sola può durare più di un minuto. Per questo il giro guarda l'orologio SUBITO PRIMA della presa
// (`SOGLIA_PRESA_MS` in `./dispatch.ts`): oltre, non prende niente e chiude. Una Function troncata
// durante le letture non ha preso niente e non perde niente; il conto parte dal controllo.
// Dopo il controllo ci sono solo scritture (PATCH, DELETE) e la RPC del badge (POST), che
// postgrest-js NON ritenta: per quelle il tetto dell'area vale davvero.
//
// Sta in un modulo a parte, e non in `./dispatch.ts`, per una ragione pratica: i test del
// dispatch sostituiscono `native-push` con un finto che non ha le costanti dei ritentativi, e una
// costante calcolata al caricamento di `./dispatch.ts` li romperebbe tutti.
// =============================================================================

/**
 * Quanti dispositivi per destinatario mette in conto il caso peggiore. Misurato il 25/09 su
 * `push_subscriptions`: al massimo 4 per utente (p99: 3). Uno in più di margine. Un utente con
 * più dispositivi di così, nel giro in cui FCM va in timeout su tutti, sfora il conto di 10–20 s
 * per dispositivo in più: con `maxDuration = 300` il margine regge fino a 7.
 */
export const DISPOSITIVI_PER_DESTINATARIO = 5

/** Il tetto di una chiamata a FCM (token OAuth o `messages:send`): quello di `externalFetch`. */
const TETTO_FCM_MS = tettoMs('fcm')

/**
 * Un invio SENZA ritentativi, nel caso peggiore: il token OAuth non è in cache e va in timeout
 * quasi al tetto (una chiamata), poi `messages:send` va in timeout (un'altra). Il web-push è una
 * chiamata sola, ma si prende il più lungo dei due.
 */
export const INVIO_SENZA_RITENTATIVI_MS = Math.max(2 * TETTO_FCM_MS, tettoMs('web-push'))

/**
 * Un invio nativo CON tutti i ritentativi, nel caso peggiore: il token OAuth, poi un tentativo più
 * uno per ciascuna attesa di `ATTESE_RITENTATIVO_MS`, tutti al tetto; e fra un tentativo e l'altro
 * l'attesa più lunga che `sendNativePush` accetta di fare qui dentro (`ATTESA_MAX_MS`, il
 * `Retry-After` di un `429`: oltre, non aspetta e restituisce). Con i valori di oggi:
 * 10 + 3 × 10 + 2 × 10 = 60 s.
 */
export const INVIO_CON_RITENTATIVI_MS =
  TETTO_FCM_MS + (ATTESE_RITENTATIVO_MS.length + 1) * TETTO_FCM_MS + ATTESE_RITENTATIVO_MS.length * ATTESA_MAX_MS

/**
 * Il tetto di UN TENTATIVO di query del giro. Tutte le letture e le scritture su tabella
 * (`.from(...)`: notifiche, `push_subscriptions`) sono area `'db'` in
 * `@/lib/logging/supabase-fetch`; il badge è una RPC, area `'rpc'`. Si chiede il tetto per nome
 * d'area, così una deroga futura in `TETTI_MS_AREA` arriva fin qui da sola. Vale come tetto della
 * QUERY solo per ciò che postgrest-js non ritenta (scritture e RPC in POST): i GET no, vedi la
 * testata.
 */
const TETTO_DB_MS = tettoMsArea('db')
const TETTO_RPC_MS = tettoMsArea('rpc')

/**
 * Quanti blocchi di `ID_PER_QUERY` servono, al massimo, per coprire le `LIMITE_LETTURA` notifiche
 * di un giro. Vale per la presa e per il ritorno in coda, che girano su
 * `aBlocchi(…, ID_PER_QUERY)` (anche la lettura dei dispositivi, ma quella sta prima del controllo
 * di `SOGLIA_PRESA_MS` e non entra nel conto). Con i valori di oggi: 500 / 100 = 5.
 */
export const BLOCCHI = Math.ceil(LIMITE_LETTURA / ID_PER_QUERY)

/**
 * Dopo l'ultima notifica: il ritorno in coda, a blocchi, e la rimozione dei dispositivi morti.
 * Il ritorno NON si interrompe al primo errore: prova tutti i blocchi (ognuno riuscito sono
 * notifiche salvate) e solo dopo scrive la riga d'errore, quindi nel caso peggiore spende un tetto
 * per ciascuno dei `BLOCCHI`. È proprio lo scenario lento (FCM in timeout, tetto del giro
 * superato, fino a 500 `rinviate_per_tempo`) a riempirlo. Poi almeno un blocco di rimozione.
 * Con i valori di oggi: (5 + 1) × 15 = 90 s.
 *
 * Limite dichiarato: la rimozione può avere più di un blocco (i dispositivi morti di un giro
 * possono superare `ID_PER_QUERY`). Il conto ne mette in conto uno: più blocchi TUTTI al tetto,
 * dopo un ritorno in coda anch'esso tutto al tetto, sono un database fermo, e il margine fra
 * questa soglia e il `maxDuration` delle route è quello che resta per quel caso.
 */
export const CHIUSURA_MS = (BLOCCHI + 1) * TETTO_DB_MS

/**
 * Il giro lento PRIMA del ciclo degli invii. Le letture (GET, ritentate da postgrest-js, senza un
 * tetto calcolabile: vedi la testata) le ferma il controllo di `SOGLIA_PRESA_MS` subito prima della
 * presa: oltre la soglia il giro chiude senza prendere niente. Il caso peggiore parte quindi da un
 * controllo passato un attimo prima della soglia: poi fino a `BLOCCHI` blocchi di presa e la RPC
 * del badge, tutti al tetto (nessuno è ritentato). Arrivato al ciclo, il tetto del giro è passato:
 * nessun invio, e TUTTE le prese tornano in coda (`BLOCCHI` scritture); niente dispositivi morti da
 * rimuovere, perché non è partito niente. Con i valori di oggi: 40 + 5 × 15 + 15 + 5 × 15 = 205 s.
 */
export const GIRO_LENTO_PRIMA_DEL_CICLO_MS =
  SOGLIA_PRESA_MS + BLOCCHI * TETTO_DB_MS + TETTO_RPC_MS + BLOCCHI * TETTO_DB_MS

/**
 * Il caso peggiore di un giro, in millisecondi: il più lungo di tre scenari.
 *
 *  · La notifica comincia un attimo prima del BUDGET: il primo dispositivo ha tutti i
 *    ritentativi, gli altri `DISPOSITIVI_PER_DESTINATARIO − 1` nessuno; poi la chiusura. Con i
 *    valori di oggi: 20 + 60 + 4 × 20 + 90 = 250 s.
 *  · La notifica comincia un attimo prima del TETTO: nessun ritentativo, ma tutti i dispositivi;
 *    poi la chiusura. Con i valori di oggi: 40 + 5 × 20 + 90 = 230 s.
 *  · Il giro è lento PRIMA del ciclo (`GIRO_LENTO_PRIMA_DEL_CICLO_MS`): 205 s.
 *
 * I primi due si contano da `t0`, quindi comprendono già le fasi prima del ciclo che ci sono
 * state: un ciclo che comincia prima del budget o del tetto ha avuto letture più brevi di così.
 * Con i valori di oggi il massimo è il primo, 250 s. (Era 255 s finché il giro lento contava le
 * letture «tutte al tetto»: un conto che i ritentativi di postgrest-js sui GET smentivano. Scende
 * perché le letture ora sono fermate dal controllo prima della presa, non perché si sia tolto un
 * margine.)
 */
export const CASO_PEGGIORE_GIRO_MS = Math.max(
  BUDGET_RITENTATIVI_MS +
    INVIO_CON_RITENTATIVI_MS +
    (DISPOSITIVI_PER_DESTINATARIO - 1) * INVIO_SENZA_RITENTATIVI_MS +
    CHIUSURA_MS,
  TETTO_GIRO_MS + DISPOSITIVI_PER_DESTINATARIO * INVIO_SENZA_RITENTATIVI_MS + CHIUSURA_MS,
  GIRO_LENTO_PRIMA_DEL_CICLO_MS,
)

/**
 * Il `maxDuration` minimo, in SECONDI, di ogni route che chiama `eseguiDispatch`. Il lock in
 * `__tests__/lib/push-dispatch-durata.test.ts` lo pretende; un valore letterale nella route resta
 * obbligatorio, perché Next legge la configurazione del segmento senza eseguire il codice.
 */
export const DURATA_MINIMA_FUNZIONE_S = Math.ceil(CASO_PEGGIORE_GIRO_MS / 1_000)
