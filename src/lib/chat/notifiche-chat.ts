import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';

/**
 * LEGGERE UNA CONVERSAZIONE SPEGNE LE SUE NOTIFICHE IN CAMPANELLA.
 *
 * Fino a oggi non le spegneva nessuno. `POST /api/chat/messages` accoda una riga in
 * `notifiche` a ogni messaggio (`chat_docente` se scrive il genitore, `chat_genitore` se
 * scrive la docente, `entita_tipo = 'chat_thread'`, `entita_id = <thread>`), mentre il
 * mark-read — la `PATCH /api/chat/messages/read` e la `GET` con `markRead` — toccava solo
 * `chat_messages.read_at`. Il messaggio risultava letto, la sua notifica no: `letta_il`
 * restava `null` per sempre, perché è la campanella l'unico posto che lo scriveva.
 *
 * MISURATO IN PRODUZIONE IL 2026-09-29, ore 15:49 UTC: su 2.178 notifiche di chat non
 * lette, 1.582 riguardano conversazioni GIÀ LETTE — il 73%. Il numero sulla campanella e
 * sul badge dell'app arrivava a 661 su una persona sola. Un contatore che è sempre gonfio
 * non è un contatore: le maestre lo ignoravano, oppure lo azzeravano con «Segna tutte come
 * lette», e in quel gesto ci finivano dentro anche i messaggi mai aperti. È il guasto per
 * cui i genitori scrivono e nessuno risponde — non perché il messaggio non arrivi, ma
 * perché l'unico segnale che lo annuncia ha smesso di significare qualcosa.
 * ⚠️ Quel conteggio è di UN giorno: è vecchio mentre lo leggi, e si rifà contando le righe
 * (contare è una lettura), mai leggendo cosa c'è dentro — sono conversazioni di famiglie.
 *
 * ─── LA REGOLA, E PERCHÉ È QUESTA ───────────────────────────────────────────────────
 *
 * UN SOLO MESSAGGIO LETTO DI UN THREAD SPEGNE TUTTE LE NOTIFICHE DI CHAT DI QUEL THREAD,
 * per chi legge. È la decisione del titolare — «leggere una conversazione spegne le sue
 * notifiche» — e non è un'approssimazione comoda:
 *
 *  · aprire la conversazione È la presa d'atto della notifica. La notifica non dice «hai
 *    tre messaggi»: dice «vai a guardare questa conversazione». Una volta che ci sei
 *    andato ha finito il suo lavoro, ed è il comportamento di qualunque app di
 *    messaggistica;
 *  · il numero VERO dei non letti non sta nella campanella: lo porta `unread_count` nella
 *    lista delle conversazioni e, dai passi successivi, il contatore su «Messaggi». La
 *    campanella segnala che è successo qualcosa, non quanto;
 *  · l'IntersectionObserver di `ChatMessageArea` manda solo le bolle VISIBILI, quindi una
 *    raffica di foto scorsa a metà spegne comunque la campanella del thread. È voluto: il
 *    thread è stato aperto, e ciò che resta da leggere lo dice `unread_count`.
 *
 * LA MIGRAZIONE DI PULIZIA DEL PASSATO (passo successivo) È PIÙ PRUDENTE, ed è coerente:
 * sulle righe vecchie non si sa se la conversazione sia stata aperta dopo la notifica, lo
 * si sa solo quando non resta nessun messaggio non letto dell'altra parte. Le due regole
 * convergono da sole — la prossima lettura spegne anche quello che la migrazione ha
 * lasciato acceso.
 *
 * LIMITE NOTO, dichiarato invece che nascosto: una notifica INSERITA DOPO questo UPDATE
 * resta accesa fino alla lettura successiva. È la corsa di qualche centinaio di
 * millisecondi fra la POST di chi scrive e la PATCH di chi sta leggendo in diretta. Il
 * rimedio non è qui: è la voce «push inutile per una conversazione già letta», fuori dal
 * perimetro di questo passo.
 *
 * PERCHÉ UN MODULO A SÉ, e non due righe dentro le route. Tre ragioni, tutte già costate:
 *
 *  1. i chiamanti sono DUE (la PATCH per id e la GET per thread) e domani potrebbero
 *     essere tre: l'insieme dei filtri deve stare scritto UNA volta. Un filtro che manca
 *     da un lato — `utente_id`, per esempio — spegne la campanella anche all'altro
 *     partecipante del thread, che non ha letto niente;
 *  2. `@/lib/chat/delivered` non è il posto: parecchi file di test lo sostituiscono per
 *     intero con una factory `vi.mock` che espone solo `marcaConsegnati`, e un nome nuovo
 *     esportato di lì li farebbe esplodere tutti. Si ritrovano con
 *     `grep -rln "vi.mock('@/lib/chat/delivered'" __tests__/`, che è anche il modo di
 *     sapere se il numero è cambiato;
 *  3. deve restare NEUTRO — nessun import di `@/lib/push/*`. È `@/lib/push/dispatch` che
 *     importa di qui `TIPI_NOTIFICA_CHAT` e lo ri-espone col suo nome storico `TIPI_CHAT`,
 *     non il contrario: il dispatch conosce la chat, la chat non conosce la push.
 *
 * NON LANCIA MAI. Il chiamante è una route che ha già fatto il suo lavoro vero (i
 * messaggi sono segnati letti): una campanella che non si spegne è un contorno degradato,
 * non un errore da restituire alla maestra che ha appena aperto la chat. Il guasto però
 * si logga — a `warn`, che sul canale `notifica` è persistito in `app_log` per LIVELLO
 * (`notifica` non è in `EVENTI_PERSISTITI`, quindi l'`info` di routine resta fuori: è una
 * riga per apertura di conversazione, e la deduplicazione di `app_log` tiene il contesto
 * della PRIMA occorrenza del giorno, cioè un conteggio quasi sempre sbagliato).
 *
 * MAI DATI PERSONALI NEI LOG: solo l'operazione, l'esito e i conteggi. Niente nomi,
 * niente testi, niente uuid di thread — il volume non li giustifica.
 */

/**
 * I DUE TIPI DI NOTIFICA DELLA CHAT, nell'ordine in cui li scrive `chat/messages:POST`.
 *
 * Stanno qui e non in `@/lib/push/dispatch` perché adesso li usano in due: il dispatch,
 * per l'eccezione che porta la chat in push anche allo staff, e questo modulo, per sapere
 * quali righe spegnere. Duplicarli significherebbe che un terzo tipo di chat, aggiunto
 * domani, resta fuori da uno dei due elenchi — e da quello sbagliato non si vede: la
 * campanella continuerebbe a non spegnersi, in silenzio. Per questo il dispatch non tiene
 * una propria copia: importa questa costante e la ri-espone come `TIPI_CHAT`, che è il
 * nome con cui la conoscono i suoi chiamanti e il suo lock.
 * Il lock `__tests__/lib/push-dispatch-presa.test.ts` confronta l'elenco con i letterali
 * `tipo:` scritti nella route dei messaggi, commenti esclusi — e verifica che le due
 * costanti siano lo STESSO oggetto, non due elenchi uguali per caso.
 */
export const TIPI_NOTIFICA_CHAT = ['chat_genitore', 'chat_docente'] as const;

/** Il valore di `notifiche.entita_tipo` con cui la chat marca le proprie righe. */
export const ENTITA_CHAT_THREAD = 'chat_thread';

interface SegnaLetteParams {
    /** Chi ha letto. Senza questo filtro si spegne la campanella anche alla controparte. */
    utenteId: string;
    /** I thread letti (deduplicati qui: i chiamanti passano i thread dei messaggi). */
    threadIds: string[];
    /** `<path relativo a src/app/api>:<METODO>` del chiamante, per i log. */
    operazione: string;
}

/**
 * Segna `letta_il` sulle notifiche di chat ancora accese dei thread indicati, per un solo
 * utente. Ritorna QUANTE righe ha spento: è il numero che dice se il collegamento
 * funziona, e senza di lui «la campanella non si spegne» resterebbe un'opinione.
 */
export async function segnaLetteNotificheChat(
    supabase: SupabaseClient,
    { utenteId, threadIds, operazione }: SegnaLetteParams,
): Promise<number> {
    // `filter(Boolean)` prima del dedup: un thread_id nullo o vuoto non deve costruire un
    // `.in('entita_id', [null])`, che per PostgREST è una query valida e sbagliata.
    const ids = [...new Set((threadIds ?? []).filter(Boolean))];

    // Nessun bersaglio → NESSUNA query. Il DB è quello di produzione: una scrittura a
    // vuoto per ogni richiesta che non ha niente da segnare è puro costo.
    if (ids.length === 0) return 0;

    // Un solo istante per tutti i blocchi: la lettura è UN atto, non uno per blocco.
    const adesso = new Date().toISOString();
    let totale = 0;

    try {
        // A BLOCCHI, perché PostgREST mette `.in()` in QUERY STRING e non nel corpo (vedi
        // `@/lib/db/blocchi`: oltre il tetto la richiesta torna 414). Qui i thread sono
        // quelli di una schermata sola, ma il tetto non è cosmetico — è ciò che impedisce
        // a questa correzione di rompersi da sé il giorno in cui un client manda l'intera
        // rubrica in un colpo.
        for (const blocco of aBlocchi(ids, ID_PER_QUERY)) {
            // `.select('id')` per CONTARE le righe toccate, ed è l'idioma già in uso sulla
            // stessa tabella (`@/lib/notifiche/triggers.ts`). Va per ULTIMO: dopo
            // `.select()` il builder non espone più `.eq()`.
            const res = await supabase
                .from('notifiche')
                .update({ letta_il: adesso })
                .eq('utente_id', utenteId)
                .in('tipo', [...TIPI_NOTIFICA_CHAT])
                .eq('entita_tipo', ENTITA_CHAT_THREAD)
                .in('entita_id', blocco)
                .is('letta_il', null)
                .select('id');

            // PostgREST NON lancia: ritorna `{ error }`. Un try/catch attorno a questa
            // `await` non scatterebbe mai — si controlla SEMPRE il valore di ritorno.
            if (res.error) {
                logEvento('notifica', 'warn', {
                    operazione,
                    esito: 'notifiche-chat-non-segnate-lette',
                }, res.error);
                break;
            }
            totale += (res.data ?? []).length;
        }
    } catch (e) {
        // Guasto di TRASPORTO (il fetch caduto, non una risposta di PostgREST): il `try`
        // copre solo questo, e non tace — un catch che non logga è un bug.
        logEvento('notifica', 'warn', {
            operazione,
            esito: 'notifiche-chat-non-segnate-lette',
        }, e);
    }

    // IL SUCCESSO SI LOGGA (AGENTS.md, regola 5). Senza questa riga «nessun log» non
    // distinguerebbe «le campanelle si spengono» da «lo spegnimento non parte più»: è
    // esattamente l'ambiguità in cui questo difetto è vissuto, e in cui tornerebbe a
    // vivere il giorno in cui un filtro sbagliato smette di trovare righe.
    if (totale > 0) {
        logEvento('notifica', 'info', {
            operazione,
            esito: 'notifiche-chat-segnate-lette',
            n: totale,
        });
    }

    return totale;
}
