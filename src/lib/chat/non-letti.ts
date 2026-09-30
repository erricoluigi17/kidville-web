import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import { aBlocchi, ID_PER_QUERY, RIGHE_MASSIME_POSTGREST } from '@/lib/db/blocchi';
import { zUuid } from '@/lib/validation/common';

/**
 * QUANTI MESSAGGI DI CHAT NON LETTI HA UNA PERSONA — il numero per la barra in basso.
 *
 * Segnalazione del 2026-09-29: «i messaggi dei genitori non arrivano alle maestre». Arrivano.
 * Quello che non arriva è l'ANNUNCIO: fuori dalla pagina «Messaggi» l'app non dice mai che
 * c'è qualcosa da leggere. Le barre in basso di maestre e genitori non hanno un contatore, e
 * `useUnreadNotifications` — l'unico che conta qualcosa — è montato DENTRO la pagina chat,
 * cioè si accende solo dopo che ci sei già andato. Una maestra ha ricevuto due messaggi alle
 * 10:52, ha usato l'app tre volte e li ha visti alle 16:14.
 *
 * Il numero viaggia nella risposta di `GET /api/notifiche`, che la campanella interroga già
 * all'apertura e ogni 60 s: nessuna richiesta HTTP in più, nessun poll nuovo da spegnere. Chi
 * lo mostra sta altrove: lo store `@/components/features/chat/contatore-non-letti` e il badge
 * `BadgeChatNonLetti`.
 *
 * ─── IL PERIMETRO: L'IDENTITÀ DEL GATE, MAI UN INPUT ───────────────────────────────────
 *
 * `utenteId` è SEMPRE `auth.user.id` di un gate già passato — non un `?userId=` di query, non
 * un campo di body, non un header. È questo, e solo questo, che rende sicuro l'`or`
 * interpolato qui sotto: la stringa entra in un filtro PostgREST, e un id che arrivasse dal
 * client potrebbe portarci dentro sintassi propria (`<uuid>,parent_id.not.is.null` allargherebbe
 * l'`or` a tutte le conversazioni di tutte le sedi).
 *
 * E siccome una precondizione scritta solo in un commento non è una difesa, QUI È UNA REGOLA:
 * un `utenteId` che non è un uuid non interroga niente e torna `null` con un warn. Non è
 * sfiducia verso i chiamanti di oggi — è che il costo di sbagliarsi, su una lettura di
 * conversazioni fra famiglie e maestre, non è recuperabile.
 *
 * ─── LA STESSA DEFINIZIONE DI «NON LETTO» DELLA LISTA CHAT ──────────────────────────────
 *
 * Le conversazioni si prendono con lo STESSO `or` di `chat/threads:GET` (`teacher_id` oppure
 * `parent_id`), non con un `eq` sul lato che si presume: chi ha due profili — maestra, e anche
 * genitore della propria figlia — ha thread su entrambi i lati, e un solo `eq` ne conterebbe
 * metà. Il conteggio è quello di `unread_count` nella lista: messaggi dei thread miei, NON
 * scritti da me, con `read_at` nullo. Due definizioni diverse dello stesso numero sono la
 * ricetta per un badge che dice 3 e una lista che ne mostra 1 — e a quel punto non si crede
 * più a nessuno dei due.
 *
 * NON SI CONTA DALLE NOTIFICHE, e non è un dettaglio d'implementazione: una notifica di chat
 * copre una RAFFICA di messaggi (la route dei messaggi ha un debounce per thread), quindi il
 * numero delle notifiche non è il numero dei messaggi. Sarebbe anche un numero volatile:
 * leggere una conversazione ne spegne le notifiche (`segnaLetteNotificheChat`,
 * `@/lib/chat/notifiche-chat`).
 *
 * ─── PERCHÉ RESTITUISCE ANCHE `threadIds` ───────────────────────────────────────────────
 *
 * Gli id delle conversazioni sono il prodotto della prima query: leggerli e buttarli
 * costringerebbe il chiamante a rifare la stessa query. E il chiamante li usa: la consegna
 * «delivered» (`consegnaSeInAttesa`) gira in questa stessa GET, sugli stessi thread e con la
 * stessa identità. Un giro in più sulla route che esiste per non
 * aggiungere giri sarebbe un controsenso. `threadIds` sono i thread LETTI dalla prima query —
 * con o senza messaggi non letti — e con nessuna conversazione è `[]`.
 *
 * ─── PERCHÉ `null` E NON 0 QUANDO QUALCOSA VA STORTO ────────────────────────────────────
 *
 * `null` significa «non lo so», e il client tiene l'ultimo valore noto. Uno 0 di ripiego
 * direbbe «hai letto tutto»: la bugia esatta che questo lavoro esiste per togliere di mezzo,
 * e indistinguibile dal caso vero. Per la stessa ragione un errore su un blocco NON restituisce
 * il parziale: metà del numero è un numero sbagliato, e sbagliato per difetto.
 *
 * ⚠️ DUE TOLLERANZE DICHIARATE, non scoperte a posteriori: `threads ?? []` e `count ?? 0`
 * trattano una risposta senza errore e senza dati come «nessuna conversazione» e «nessun
 * messaggio». È il comportamento della lista chat (`chat/threads:GET` usa `threads ?? []` e
 * `unreadCount ?? 0`), e cambiarlo qui darebbe due numeri diversi sulla stessa schermata. Ma
 * resti chiaro che sono ripieghi: se PostgREST rispondesse `{ data: null, error: null }` —
 * cosa che non fa — il conteggio direbbe 0 invece di «non lo so». I due casi hanno un test
 * ciascuno, così la scelta è visibile invece di essere un `??` di passaggio.
 *
 * NON LANCIA MAI. Il chiamante è `notifiche:GET`, che deve continuare a rispondere 200 con le
 * sue notifiche anche se la chat non si conta: un contorno degradato non è un errore da
 * restituire a chi apre la campanella (e gli E2E si aspettano una risposta ok).
 *
 * NIENTE LOG DI SUCCESSO, per una volta: questa funzione gira a ogni poll della campanella —
 * ogni 60 s, per ogni persona connessa — e non è un evento critico, è la lettura di un
 * contatore. Un `info` per giro sarebbe puro rumore, e su questo canale (`chat` è in
 * `EVENTI_PERSISTITI`) finirebbe anche in tabella, dove la deduplicazione di `app_log`
 * terrebbe il contesto della PRIMA occorrenza del giorno: un conteggio quasi sempre
 * sbagliato. Il segnale di vita del contatore è la riga di `withRoute` della route che lo
 * ospita, che c'è comunque. Si logga solo il guasto, a `warn`.
 *
 * INDICI GIÀ IN TABELLA (baseline), nessuna migrazione da questo passo:
 * `idx_chat_threads_teacher (teacher_id)` e `idx_chat_threads_parent (parent_id)` per l'`or`,
 * `idx_chat_messages_unread (thread_id) WHERE read_at IS NULL` per la `head`-query — che è
 * l'indice parziale giusto: il conteggio filtra proprio su `read_at IS NULL`.
 *
 * ⚠️ FUORI DALLA VISTA DEL LOCK DI SEDE. `isolamento-sede-coverage` scandisce solo
 * `src/app/api`: questa lettura di `chat_threads` non la vede nessuno dei suoi elenchi. Qui è
 * innocua — il perimetro non è la sede ma la PARTECIPAZIONE alla conversazione (`teacher_id`
 * o `parent_id` uguale all'identità del gate) — ma se un domani finisse dentro una route
 * andrebbe dichiarata come le altre letture della chat, con la deroga motivata invece di un
 * silenzio che sembra una dimenticanza.
 *
 * MAI DATI PERSONALI NEI LOG: solo l'operazione, l'esito e i conteggi. Niente uuid di thread,
 * niente uuid di persone, niente testi — nemmeno l'id malformato del caso di rifiuto, che è
 * un dato in arrivo.
 */

/** Quello che la funzione sa dire quando è riuscita a contare. Vedi la testata. */
export interface ChatNonLetti {
    /** Messaggi non letti, sommati su tutti i blocchi. */
    totale: number;
    /** Le conversazioni dell'utente lette dalla prima query, per chi deve riusarle. */
    threadIds: string[];
}

/**
 * Legge i messaggi di chat non letti di una persona, e i thread su cui li ha cercati.
 * Ritorna `null` quando non è stato possibile saperlo — `null` è «non lo so», un `totale: 0`
 * è «hai letto tutto»: vedi la testata, la differenza è tutto il punto di questo modulo.
 *
 * @param utenteId Identità del GATE (`auth.user.id`), mai un input del client. Se non è un
 *                 uuid la funzione rifiuta: nessuna query, `null`, un warn.
 * @param operazione `<path relativo a src/app/api>:<METODO>` del chiamante, per i log.
 */
export async function leggiChatNonLetti(
    supabase: SupabaseClient,
    utenteId: string,
    operazione: string,
): Promise<ChatNonLetti | null> {
    // La precondizione della testata, controllata. `zUuid` è la definizione del repo: un
    // secondo formato di uuid scritto qui a mano sarebbe una divergenza silenziosa.
    if (!zUuid.safeParse(utenteId).success) {
        logEvento('chat', 'warn', { operazione, esito: 'chat-non-letti-utente-non-valido' });
        return null;
    }

    try {
        // Le conversazioni dell'utente, dai DUE lati: lo stesso filtro della lista chat.
        const { data: threads, error } = await supabase
            .from('chat_threads')
            .select('id')
            .or(`teacher_id.eq.${utenteId},parent_id.eq.${utenteId}`);

        // PostgREST NON lancia: ritorna `{ error }`, e lo fa ANCHE quando il fetch cade —
        // in quel caso l'errore ha `code: ''` e `status: 0` (postgrest-js 2.112,
        // `dist/index.mjs`). Si controlla quindi SEMPRE il valore di ritorno; il `try` qui
        // attorno è per l'imprevisto, non per la rete. Vedi il `catch` in fondo.
        if (error) {
            logEvento('chat', 'warn', { operazione, esito: 'chat-non-letti-non-contati' }, error);
            return null;
        }

        // `?? []`: tolleranza dichiarata in testata, non un `??` di passaggio.
        const threadIds = (threads ?? []).map((t) => t.id as string);

        // Nessuna conversazione → nessuna seconda query. È il caso di quasi tutti i genitori
        // nuovi, e gira a ogni poll di ogni persona connessa. `aBlocchi([])` non produrrebbe
        // blocchi comunque: questa uscita anticipata non serve a impedire una query, serve a
        // dire in una riga che il caso è previsto — e a non dipendere da quel dettaglio.
        if (threadIds.length === 0) return { totale: 0, threadIds: [] };

        if (threadIds.length >= RIGHE_MASSIME_POSTGREST) {
            logEvento('chat', 'warn', {
                operazione,
                esito: 'chat-non-letti-thread-troncati',
                n: threadIds.length,
            });
            // Si prosegue sui thread che ci sono: un numero un po' basso, con la sua riga di
            // log che lo dichiara, vale più di nessun numero.
        }

        let totale = 0;

        // A BLOCCHI, perché PostgREST mette `.in()` in QUERY STRING e non nel corpo (vedi
        // `@/lib/db/blocchi`: oltre il tetto la richiesta torna 414). Una `head`-query per
        // blocco: `count: 'exact'` senza trasferire nessuna riga.
        for (const blocco of aBlocchi(threadIds, ID_PER_QUERY)) {
            const { count, error: errBlocco } = await supabase
                .from('chat_messages')
                .select('id', { count: 'exact', head: true })
                .in('thread_id', blocco)
                .neq('sender_id', utenteId)
                .is('read_at', null);

            if (errBlocco) {
                logEvento('chat', 'warn', { operazione, esito: 'chat-non-letti-non-contati' }, errBlocco);
                // MAI IL PARZIALE: la somma dei blocchi già andati a buon fine è un numero
                // sbagliato per difetto, e sarebbe indistinguibile da quello giusto. Nemmeno i
                // soli `threadIds`: il chiamante userebbe un elenco senza sapere che il
                // conteggio è mancato.
                return null;
            }

            // `?? 0`: seconda tolleranza dichiarata in testata.
            totale += count ?? 0;
        }

        return { totale, threadIds };
    } catch (e) {
        // L'IMPREVISTO, non il fetch caduto: quello arriva in `{ error }` con `code: ''` e lo
        // gestiscono i due rami sopra. Qui finisce ciò che nessuno ha previsto — un client
        // sostituito, un builder che cambia forma, un bug del logger — e non deve uscire da
        // questo modulo, che promette di non lanciare. Non tace: un catch che non logga è un bug.
        logEvento('chat', 'warn', { operazione, esito: 'chat-non-letti-non-contati' }, e);
        return null;
    }
}
