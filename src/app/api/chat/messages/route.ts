import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo';
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers';
import { controparteThread } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery, validationError } from '@/lib/validation/http';
import { zUuid, zLimite } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { marcaConsegnati } from '@/lib/chat/delivered';
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione';
import { assertConversazioneNonSospesa } from '@/lib/chat/sospensione-conversazione';
import { assertTerminiAccettatiSeGenitore } from '@/lib/onboarding/consensi';
import { firmaAllegatiChat, normalizzaAllegatoChat } from '@/lib/chat/allegati';
import { linkConversazione } from '@/lib/chat/link-conversazione';
import { sedeDiAlunno, sedeDiAccount } from '@/lib/anagrafiche/sedi';
import { eseguiDispatch } from '@/lib/push/dispatch';

/**
 * LA DURATA DELLA FUNZIONE, per la push della chat inviata SUBITO (PS3, spec «sei interventi»
 * del 24/09, §3 Notifiche: «dispatch 30 s dopo il messaggio»).
 *
 * La POST programma con `after()` un giro di `eseguiDispatch` 30 secondi dopo il messaggio (vedi
 * `programmaDispatchChat`). `after()` vive dentro il `maxDuration` della route: al default della
 * piattaforma la Function si fermerebbe a metà dell'attesa, oppure a metà del giro — e un giro
 * troncato DOPO la presa atomica lascia le notifiche marcate e mai spedite («IL PREZZO DELLA
 * PRESA» in `src/lib/push/dispatch.ts`). Serve quindi l'attesa PIÙ il caso peggiore del giro:
 * 30 s + `DURATA_MINIMA_FUNZIONE_S` (250 s con i valori di oggi, `src/lib/push/durata-dispatch.ts`)
 * = 280 s. 300 s è il valore della route del cron e delle altre route lunghe del repo.
 *
 * Due lock lo tengono fermo: `__tests__/lib/push-dispatch-durata.test.ts` (≥ il caso peggiore del
 * giro, per ogni route che chiama `eseguiDispatch`) e `__tests__/api/chat-messages-dispatch-anticipato.test.ts`
 * (≥ attesa + caso peggiore, solo per questa). Vale per il segmento intero, quindi anche per la GET:
 * è un tetto, non un costo — la GET finisce quando ha finito. Il numero resta scritto qui perché
 * Next legge la configurazione del segmento senza eseguire il codice.
 */
export const maxDuration = 300

/**
 * Quanto aspetta la push della chat prima di partire. Non subito: le raffiche restano raggruppate.
 * La notifica di una conversazione è UNA (il `debounce` di `notificaEvento` la sostituisce a ogni
 * messaggio), quindi chi scrive tre messaggi in dieci secondi produce una push sola, quella
 * dell'ultimo. I giri programmati dai messaggi successivi trovano la notifica già presa e non
 * spediscono niente: la presa atomica di `eseguiDispatch` impedisce il doppione, anche col cron
 * ogni 5 minuti che parte nello stesso secondo.
 */
const ATTESA_DISPATCH_CHAT_MS = 30_000;

/**
 * Programma, DOPO la risposta, il giro di dispatch anticipato della chat: 30 s di attesa e poi
 * `eseguiDispatch({ origine: 'chat' })`. Nessun effetto sulla risposta: non lancia mai, e la POST
 * risponde 201 senza aspettarlo.
 *
 * I LOG. `eseguiDispatch` scrive già il suo battito sotto `push-dispatch-chat`; qui si scrivono
 * l'avvio (dopo l'attesa) e l'esito visti dalla chat, con il thread: senza, «nessun log» non
 * distinguerebbe «la push è partita» da «`after()` non è mai arrivato in fondo». Evento `push`,
 * persistito. Nel log solo l'uuid del thread e i contatori: mai testo, mai nomi.
 *
 * SE `after()` NON SI PUÒ USARE (fuori da un contesto di richiesta: test, script) si rinuncia al
 * giro anticipato e lo si dice a `warn`: la notifica è in coda e il cron la spedisce entro 5
 * minuti. Non si parte «subito» come ripiego: un giro lanciato senza `after()` sarebbe troncato
 * dalla piattaforma a metà, dopo la presa, cioè la perdita che la presa atomica paga col tempo.
 */
function programmaDispatchChat(threadId: string): void {
    const operazione = 'chat/messages:POST';
    const giro = async (): Promise<void> => {
        try {
            await new Promise<void>((fatto) => setTimeout(fatto, ATTESA_DISPATCH_CHAT_MS));
            logEvento('push', 'info', {
                operazione,
                esito: 'dispatch-anticipato-avviato',
                threadId,
                msg: `${operazione}: dispatch anticipato della chat avviato`,
            });
            const esito = await eseguiDispatch({ origine: 'chat' });
            if (esito.stato === 500) {
                // Il guasto è già scritto da `eseguiDispatch` con i dettagli (righe
                // `push-dispatch-chat`); qui si dice solo che riguardava la chat. Il 500 NON dice
                // che fine ha fatto questa notifica: può essere ancora in coda (lettura fallita
                // prima della presa), già spedita (presa parziale, o rimozione delle subscription
                // fallita dopo l'invio), marcata e bloccata (ritorno in coda fallito) o ignota
                // (eccezione). Per questo il messaggio non promette un recupero dal cron: vale solo
                // che le notifiche NON prese restano in coda.
                logEvento('push', 'error', {
                    operazione,
                    esito: 'dispatch-anticipato-fallito',
                    threadId,
                    msg: `${operazione}: dispatch anticipato della chat fallito (dettagli nelle righe push-dispatch-chat); le notifiche non prese restano in coda per il cron`,
                });
                return;
            }
            if ('non_configurato' in esito.data) {
                // Configurazione mancante = `error` (regola 4 di AGENTS.md).
                logEvento('push', 'error', {
                    operazione,
                    esito: 'dispatch-anticipato-non-configurato',
                    threadId,
                    msg: `${operazione}: dispatch anticipato della chat senza canali push configurati`,
                });
                return;
            }
            logEvento('push', 'info', {
                operazione,
                esito: 'dispatch-anticipato-ok',
                threadId,
                notifiche: esito.data.notifiche,
                inviate: esito.data.inviate,
                native_inviate: esito.data.native_inviate,
                fallite: esito.data.fallite,
                gia_prese: esito.data.gia_prese,
                rimesse_in_coda: esito.data.rimesse_in_coda,
                msg: `${operazione}: dispatch anticipato della chat concluso`,
            });
        } catch (err) {
            // `eseguiDispatch` non lancia: qui arriva solo l'imprevisto (il timer, il logger).
            logEvento('push', 'error', {
                operazione,
                esito: 'dispatch-anticipato-eccezione',
                threadId,
                msg: `${operazione}: dispatch anticipato della chat interrotto da un'eccezione`,
            }, err);
        }
    };
    try {
        after(giro);
    } catch (err) {
        logEvento('push', 'warn', {
            operazione,
            esito: 'dispatch-anticipato-non-programmato',
            threadId,
            msg: `${operazione}: after() non disponibile, la push della chat parte col cron (entro 5 minuti)`,
        }, err);
    }
}

// markRead='' è ammesso per retro-compatibilità: equivale ad assente (nessun mark-read).
const getQuerySchema = z.object({
    threadId: zUuid,
    markRead: zUuid.or(z.literal('')).optional(),
    /** Quanti messaggi, contando dal più NUOVO. Stesso intervallo e stesso default di prima (1-200, 50). */
    limit: zLimite({ predefinito: 50, max: 200 }),
    /** Il messaggio più vecchio che il client ha già in mano: si restituisce la pagina prima di lui. */
    primaDi: zUuid.optional(),
    /**
     * RIFIUTATO, non ignorato. Fino al 2026-09-14 `offset` contava dalla TESTA della conversazione;
     * oggi la lettura parte dalla coda, e lo stesso numero vorrebbe dire un'altra cosa. Nessun client
     * lo manda: se ne arriva uno, è un client vecchio o un errore, e il 400 lo dice invece di
     * rispondere in silenzio con una pagina diversa da quella chiesta.
     */
    offset: z.never('Parametro «offset» non più supportato: per i messaggi precedenti usa «primaDi»').optional(),
});

const postBodySchema = z.object({
    thread_id: zUuid,
    // Retro-compatibilità: i client storici lo mandano ancora, ma il mittente è
    // SOLO l'utente del gate (anti-impersonazione). Tollerato, mai usato.
    sender_id: zUuid.optional(),
    content: z.string().min(1, 'content è obbligatorio'),
    attachment_url: z.string().nullish(),
    attachment_type: z.string().nullish(),
});

// GET /api/chat/messages?threadId=xxx&limit=50&primaDi=<id>&markRead=userId
// Gli ULTIMI `limit` messaggi di un thread (dal più vecchio al più nuovo), o la pagina prima di `primaDi`.
export const GET = withRoute('chat/messages:GET', async (request: Request) => {
    try {
        // Gate identità IN TESTA: mai lettura anonima o da non-partecipante. Prima
        // la verifica del partecipante era annidata in `if (markRead)`: senza
        // `markRead` chiunque otteneva 200 con TUTTI i messaggi del thread (IDOR su
        // PII di minori). Ora l'identità viene SOLO dal gate.
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const uid = auth.user.id;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { threadId, limit, primaDi } = q.data;
        // `markRead` resta solo un TRIGGER opt-in del mark-read (usato dalla pagina
        // admin/messaggi): il suo VALORE è ignorato, l'identità è `uid` dal gate.
        const vuoleMarkRead = Boolean(q.data.markRead);

        const supabase = await createAdminClient();

        // ── Autorizzazione: SEMPRE, non più solo col mark-read ──────────────
        // Carica il thread e verifica che il richiedente ne sia partecipante
        // (teacher_id o parent_id). 404 se non esiste, 403 se non partecipante.
        const { data: thread, error: threadErr } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id')
            .eq('id', threadId)
            .maybeSingle();

        if (threadErr) {
            logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, threadErr);
            return NextResponse.json({ error: threadErr.message }, { status: 500 });
        }
        if (!thread) {
            return NextResponse.json({ error: 'Thread non trovato' }, { status: 404 });
        }
        if (thread.teacher_id !== uid && thread.parent_id !== uid) {
            // IDOR sventato: utente autenticato ma NON partecipante del thread.
            // Nel log solo uuid (threadId), nessun PII; withRoute registra il 403.
            logEvento('chat', 'info', {
                operazione: 'chat/messages:GET',
                esito: 'non-partecipante',
                threadId,
            });
            return NextResponse.json(
                { error: 'Non sei autorizzato a leggere questo thread' },
                { status: 403 }
            );
        }

        // ── Il cursore: DOPO il controllo di partecipazione, PRIMA di ogni scrittura ──
        // Il client manda l'id del messaggio più vecchio che ha in mano; l'istante lo legge il
        // server, al microsecondo, dal database. `thread_id` nella stessa lettura: un id di un altro
        // thread risponde come un id inesistente (nessun oracolo), e una richiesta respinta non
        // segna letto niente perché il mark-read viene dopo.
        let cursore: { id: string; created_at: string } | null = null;
        if (primaDi) {
            const { data: riga, error: cursoreErr } = await supabase
                .from('chat_messages')
                .select('id, created_at')
                .eq('id', primaDi)
                .eq('thread_id', threadId)
                .maybeSingle();
            if (cursoreErr) {
                logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, cursoreErr);
                return NextResponse.json(
                    { error: 'Non è stato possibile leggere i messaggi precedenti. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
                    { status: 500 }
                );
            }
            // Una riga senza istante non ha un «prima»: stesso 400 dell'id che non c'è.
            if (!riga?.created_at) {
                return validationError([
                    { path: ['primaDi'], message: 'Il messaggio di riferimento non appartiene a questa conversazione' },
                ]);
            }
            cursore = { id: String(riga.id), created_at: String(riga.created_at) };
        }

        if (vuoleMarkRead) {
            // PRIMA del mark-read: consegna (delivered_at) di tutto il thread, in una query
            // SEPARATA. Mai unita al mark-read: sul DB E2E la colonna delivered_at non esiste
            // e un update congiunto porterebbe giù anche il mark-read qui sotto.
            // Identità = `uid` dal gate (mai il valore di markRead in query).
            await marcaConsegnati(supabase, { userId: uid, threadIds: [threadId] });

            // Segna come letti i messaggi dell'interlocutore. PostgREST NON lancia:
            // si controlla il valore di ritorno. Best-effort: il mark-read è accessorio
            // alla lettura → si logga (mai swallow) ma NON si fa fallire la GET.
            const { error: readErr } = await supabase
                .from('chat_messages')
                .update({ read_at: new Date().toISOString() })
                .eq('thread_id', threadId)
                .neq('sender_id', uid)
                .is('read_at', null);
            if (readErr) {
                logEvento('chat', 'error', {
                    operazione: 'chat/messages:GET',
                    esito: 'mark-read-fallito',
                }, readErr);
            }
        }

        /**
         * ─── SI LEGGE LA CODA, E SI PAGINA ALL'INDIETRO (C2, 2026-09-14) ─────────────────────
         *
         * Fino al 2026-09-14 questa `select` ordinava dal più VECCHIO e si fermava a 50: di ogni
         * conversazione arrivavano i 50 messaggi più vecchi, e dal cinquantunesimo in poi niente.
         * Misurato in produzione il 2026-09-14: 7 thread oltre i 50 messaggi (il più lungo 68), 48
         * messaggi mai mostrati a nessuno e 45 mai letti. Fra i messaggi con più di 24 ore, quelli
         * oltre il cinquantesimo erano non letti nel 93,8% dei casi, quelli entro il cinquantesimo
         * nell'1,7%: la firma di un messaggio mai mostrato. È la segnalazione del titolare: la notifica
         * arriva, si apre la chat, e il messaggio nuovo non c'è.
         *
         * La lettura dalla coda era già stata scritta e TOLTA il 2026-09-07 (`74ecf831`), perché
         * `e2e/chat.spec.ts` era diventato rosso nella stessa consegna; il commento che stava qui
         * chiedeva, per rimetterla, «prima un test che crei davvero un thread con più di 50
         * messaggi». La causa di quel rosso era un'altra (il click perso durante l'invio,
         * `085d5bfe`), e il test adesso c'è due volte: `__tests__/api/chat-messages-coda.test.ts`,
         * con un database finto che ordina e pagina davvero, ed `e2e/chat-precedenti.spec.ts`, che
         * in CI semina 60 messaggi e prova la sintassi su un PostgREST vero.
         *
         * ─── PERCHÉ UN CURSORE (KEYSET) E NON `offset` ───────────────────────────────────────
         *
         * «Carica messaggi precedenti» chiede la pagina prima del messaggio più vecchio in mano. Con
         * un `offset` contato dalla coda, ogni messaggio arrivato fra la prima pagina e il click
         * sposterebbe la finestra: un messaggio ripetuto, o uno saltato. Il keyset su
         * `(created_at, id)` non scivola: «più vecchi di QUESTO messaggio» resta vero qualunque cosa
         * arrivi dopo. `offset` è rifiutato (vedi lo schema), non tenuto con un altro significato.
         *
         * ─── PERCHÉ LO SPAREGGIO SULL'ID ─────────────────────────────────────────────────────
         *
         * Due messaggi con lo stesso `created_at` esistono. Con il solo `created_at.lt` quello col
         * pareggio sul confine di pagina sparirebbe: non sta nella pagina di prima (non è «minore»)
         * e non è stato mostrato. L'ordine è quindi `created_at DESC, id DESC`, lo stesso con cui il
         * client ordina (`confrontaMessaggi`), e il cursore dice «prima di» su entrambe le chiavi.
         * L'istante sta fra VIRGOLETTE: contiene `.`, `:` e `+`, che nella sintassi di `.or()` di
         * PostgREST sono separatori.
         *
         * `total` è il numero di righe che soddisfano i filtri: senza cursore, tutto il thread (come
         * prima); con il cursore, quelle più vecchie di lui. `precedenti` è quanti ne restano prima
         * della pagina restituita — è ciò che accende il pulsante.
         *
         * `admin/messaggi` (la scheda «Con i genitori») usa questa stessa GET senza parametri: ottiene
         * la coda senza modifiche. La supervisione (`/api/admin/chat/messages`) è un'altra rotta.
         */
        let lettura = supabase
            .from('chat_messages')
            .select('*', { count: 'exact' })
            .eq('thread_id', threadId);
        if (cursore) {
            const istante = `"${cursore.created_at}"`;
            lettura = lettura.or(`created_at.lt.${istante},and(created_at.eq.${istante},id.lt.${cursore.id})`);
        }
        const { data, error, count } = await lettura
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(0, limit - 1);

        if (error) {
            logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Dal più NUOVO al più vecchio per prendere la coda; al client si restituisce in ordine di
        // lettura, dal più vecchio al più nuovo.
        const pagina = [...(data ?? [])].reverse();

        // In tabella c'è il PERCORSO nel bucket privato: il link firmato lo
        // genera la lettura, a tempo, dietro al gate appena superato (S32). Una
        // sola chiamata allo Storage per pagina, mai una per messaggio.
        const messages = await firmaAllegatiChat(supabase, pagina, 'chat/messages:GET');
        const totale = count ?? 0;

        if (cursore) {
            // Il SUCCESSO di «Carica messaggi precedenti»: `withRoute` non persiste i 2xx, e senza
            // questa riga «nessun log» non distinguerebbe «nessuno lo usa» da «non funziona». Solo
            // col cursore: la finestra normale è anche il polling, e scriverebbe una riga ogni 30 s.
            logEvento('chat', 'info', { operazione: 'chat/messages:GET', esito: 'precedenti-caricati' });
        }

        return NextResponse.json({ messages, total: totale, precedenti: Math.max(0, totale - pagina.length) });
    } catch (error) {
        logErrore({ operazione: 'chat/messages:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

/** Le tre colonne del thread che servono a questa route: due per il permesso, una per la sede. */
type ThreadChat = { teacher_id: string | null; parent_id: string | null; student_id: string | null };

/**
 * LA SEDE DI UNA CONVERSAZIONE È QUELLA DEL SUO BAMBINO, NON QUELLA DI CHI SCRIVE.
 *
 * ─── COS'ERA, E PERCHÉ ERA SBAGLIATO ─────────────────────────────────────────
 * Fino al 2026-09-03 la notifica di un nuovo messaggio nasceva con
 * `utenti.scuola_id` DEL MITTENTE, letta apposta con una query che per giunta non
 * controllava `{ error }`. Ma un genitore può avere due figli in due plessi —
 * `parents` non ha `scuola_id`, ed è una scelta esplicita (vedi
 * `admin/parents/route.ts`) — quindi `utenti.scuola_id` di un genitore è al più
 * UNA delle sue sedi: quella con cui l'account è nato. Scrivendo alla maestra
 * dell'ALTRO figlio, la notifica nasceva col plesso sbagliato. Lo stesso vale per
 * un docente che lavora su più plessi.
 *
 * Misurato in produzione il 2026-09-03: **639 account genitore su 639** hanno
 * `utenti.scuola_id` valorizzata — la lettura sbagliata non falliva mai, quindi
 * decideva sempre — e in 6 di loro contraddice almeno un figlio.
 *
 * ─── NON È UN'ETICHETTA, DECIDE SE LA SPINTA PARTE ───────────────────────────
 * `notificaEvento` gira la sede a `isNotificaAbilitata(supabase, tipo, scuolaId)`,
 * che legge i toggle di QUEL plesso. Con la sede sbagliata è l'interruttore di
 * Giugliano a decidere se parte la notifica di un messaggio che riguarda un
 * bambino di Aversa — e la route risponde 201 comunque.
 *
 * ─── IL DATO CHE CE L'HA DAVVERO ─────────────────────────────────────────────
 * Il bambino del thread NON è ambiguo: una conversazione parla sempre di UN
 * bambino, e quel bambino ha UN plesso. Ripiego dichiarato: la sede dell'account
 * del DOCENTE del thread — lo staff una sede propria ce l'ha sempre, i genitori
 * no. `scuolaUnicaReale` NON entra in questa catena: è deprecata e con tre sedi
 * risponde sempre `null`, cioè costerebbe una query per un anello morto.
 *
 * Best-effort per costruzione: il messaggio è GIÀ in tabella quando si arriva
 * qui. Nessun ramo può far fallire l'invio — ma nessuno può nemmeno tacere.
 */
async function sedeDelThread(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    thread: ThreadChat,
    threadId: string,
): Promise<string | null> {
    // Le due letture (bambino → plesso, account del docente → plesso) stanno in
    // `@/lib/anagrafiche/sedi`: erano scritte identiche in tre route, e in questo
    // repo una regola valida per più strade vive in un posto solo. Lì dentro c'è
    // anche il controllo di `{ error }` — PostgREST non lancia — e la riga di log
    // che distingue «non ha un plesso» da «non ho potuto leggerlo».
    const ctx = { gruppo: 'chat', operazione: 'chat/messages:POST', extra: { threadId } };

    if (thread.student_id) {
        const sede = await sedeDiAlunno(supabase, thread.student_id, ctx);
        if (sede) return sede;
    }

    // Ripiego: il DOCENTE del thread, mai il mittente. Lo staff una sede propria
    // ce l'ha sempre, i genitori no — e chiederla a chi preme è il difetto che
    // questa funzione esiste per aver chiuso.
    if (thread.teacher_id) {
        const sede = await sedeDiAccount(supabase, thread.teacher_id, ctx);
        if (sede) return sede;
    }

    // Senza plesso la notifica parte lo stesso — il destinatario è una persona
    // precisa (la controparte del thread), non `staffScuola(sede)` — ma i toggle
    // di plesso non si applicano e la riga non entra nei conteggi per sede.
    // `error` perché a mancare è la NOSTRA anagrafica, non un dato dell'utente.
    logEvento('chat', 'error', {
        operazione: 'chat/messages:POST',
        esito: 'sede-non-attribuibile',
        threadId,
    });
    return null;
}

// POST /api/chat/messages
// Body: { thread_id, sender_id, content, attachment_url?, attachment_type? }
export const POST = withRoute('chat/messages:POST', async (request: Request) => {
    try {
        // Gate identità IN TESTA: il mittente è SEMPRE l'utente del gate, MAI il
        // `sender_id` del body (che prima permetteva l'impersonazione).
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const sender_id = auth.user.id;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        // `sender_id` del body è tollerato dallo schema ma IGNORATO (anti-spoof).
        const { thread_id, content, attachment_url, attachment_type } = b.data;

        const supabase = await createAdminClient();

        // Sospensione moroso (DL-021 · M4): il genitore con un figlio sospeso non
        // può inviare messaggi (azione di servizio). Solo la SCRITTURA: la lettura
        // (GET) resta libera. Identità dal gate, mai dal body. Su un docente il
        // guard è trasparente (nessun legame genitore↔alunno).
        const sospesoErr = await assertGenitoreNonSospeso(supabase, sender_id);
        if (sospesoErr) return sospesoErr;

        // Autorizzazione: il mittente deve essere partecipante del thread indicato
        // (teacher_id o parent_id). Senza, un utente autenticato poteva iniettare
        // messaggi in conversazioni altrui.
        // `student_id` non è una colonna «già che ci siamo»: è il dato da cui si
        // ricava la SEDE della notifica, più in basso. Il thread si legge qui
        // comunque, per l'autorizzazione: portarselo dietro costa zero, mentre
        // una seconda lettura della stessa riga sarebbe una query in più su ogni
        // messaggio inviato.
        const { data: thread, error: threadErr } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id, student_id')
            .eq('id', thread_id)
            .maybeSingle();

        if (threadErr) {
            logErrore({ operazione: 'chat/messages:POST', stato: 500, evento: 'db' }, threadErr);
            return NextResponse.json({ error: threadErr.message }, { status: 500 });
        }
        if (!thread) {
            return NextResponse.json({ error: 'Thread non trovato' }, { status: 404 });
        }
        if (thread.teacher_id !== sender_id && thread.parent_id !== sender_id) {
            logEvento('chat', 'info', {
                operazione: 'chat/messages:POST',
                esito: 'non-partecipante',
                threadId: thread_id,
            });
            return NextResponse.json(
                { error: 'Non sei autorizzato a scrivere in questo thread' },
                { status: 403 }
            );
        }

        // ── Guardie UGC 1:1 (C5) — dopo l'autorizzazione al thread, prima dell'insert ──
        // (a) Conversazione SOSPESA (bidirezionale, dichiarata): chi è `sospesa_verso`
        //     non può inviare nuovi messaggi; chi ha sospeso sì. Storico append-only in
        //     `conversazioni_sospensioni`. Solo la SCRITTURA: la lettura resta libera.
        const conversazioneSospesaErr = await assertConversazioneNonSospesa(
            supabase,
            thread_id,
            sender_id
        );
        if (conversazioneSospesaErr) return conversazioneSospesaErr;

        // (b) Gate TERMINI (art. 1341 c.c.): chi scrive COME FAMIGLIA e non ha accettato
        //     i Termini non produce UGC. Trasparente per chi scrive dal posto del docente.
        //     Identità dal gate, MAI dal body.
        //
        //     ⚠️ QUI PASSAVA `auth.user.role`, cioè la VESTE, e il gate si saltava
        //     semplicemente non cambiandola. Quattro insegnanti hanno insieme
        //     `utenti.ruolo = 'educator'` e il ponte `parents.auth_user_id`: una di loro
        //     che scrivesse nella chat della PROPRIA famiglia senza commutare il cookie
        //     occupava il posto `parent_id` del thread — cioè scriveva da genitore a
        //     tutti gli effetti — e questo gate la trattava da staff.
        //
        //     `agisceComeGenitore` da solo non basterebbe: guarda lo stesso cookie. È il
        //     SECONDO termine a chiudere il buco, e non è una furbizia — è la domanda
        //     giusta: non «di che ruolo sei», ma «da quale posto di questo thread stai
        //     scrivendo». Il thread è già letto qui sopra per l'autorizzazione: costa zero.
        const scriveComeFamiglia =
            agisceComeGenitore(auth.user) || thread.parent_id === auth.user.id;
        const terminiErr = await assertTerminiAccettatiSeGenitore(
            supabase,
            sender_id,
            scriveComeFamiglia
        );
        if (terminiErr) return terminiErr;

        // ── L'allegato si ARCHIVIA come percorso, non come link firmato (S32) ──
        // Fino al 2026-08-01 qui entrava — e restava — l'URL firmato a 365 giorni
        // prodotto da `chat/upload`: un link permanente al certificato di un
        // minore, in chiaro in tabella e valido fuori da ogni gate.
        //
        // `normalizzaAllegatoChat` risponde `null` anche per gli indirizzi che
        // NON sono del bucket `chat-allegati`: prima `attachment_url` era una
        // `z.string()` qualunque, e un utente autenticato poteva far caricare al
        // browser di una famiglia un indirizzo scelto da lui (pixel di
        // tracciamento). Un valore c'è ma non è nostro → 400, e NIENTE va in
        // tabella.
        let allegatoPercorso: string | null = null;
        if (attachment_url != null && attachment_url.trim() !== '') {
            allegatoPercorso = normalizzaAllegatoChat(attachment_url);
            if (allegatoPercorso === null) {
                // `warn`: non è un errore d'uso, è qualcuno che prova a mettere un
                // indirizzo altrui dentro la conversazione di una famiglia. Nel log
                // solo uuid: il valore respinto potrebbe essere lungo, e in questo
                // repo un percorso è una credenziale.
                logEvento('chat', 'warn', {
                    operazione: 'chat/messages:POST',
                    esito: 'allegato-fuori-bucket',
                    threadId: thread_id,
                });
                return NextResponse.json(
                    {
                        error: 'Allegato non valido: si possono inviare solo i file caricati dalla chat',
                        codice: 'ALLEGATO_NON_VALIDO',
                    },
                    { status: 400 }
                );
            }
        }

        // Inserisci messaggio (sender_id = utente del gate, mai dal body)
        const { data, error } = await supabase
            .from('chat_messages')
            .insert({
                thread_id,
                sender_id,
                content,
                attachment_url: allegatoPercorso,
                attachment_type: attachment_type ?? null,
            })
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'chat/messages:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Aggiorna last_message_at sul thread
        await supabase
            .from('chat_threads')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', thread_id);

        // Notifica alla controparte del thread (best-effort). Privacy: il corpo
        // NON contiene il testo del messaggio, solo il nome del mittente. Il
        // debounce per thread collassa le raffiche in un'unica notifica.
        try {
            const controparte = await controparteThread(supabase, thread_id, sender_id);
            if (controparte) {
                const [nome, sedeConversazione] = await Promise.all([
                    nomeUtente(supabase, sender_id),
                    sedeDelThread(supabase, thread as ThreadChat, thread_id),
                ]);
                await notificaEvento(supabase, {
                    tipo: controparte.versoGenitore ? 'chat_genitore' : 'chat_docente',
                    scuolaId: sedeConversazione,
                    utenteIds: [controparte.utenteId],
                    titolo: 'Nuovo messaggio in chat',
                    corpo: nome ? `Hai un nuovo messaggio da ${nome}` : 'Hai un nuovo messaggio',
                    // Il link APRE LA CONVERSAZIONE (2026-09-15): prima portava alla sola lista, e chi
                    // toccava la notifica doveva cercare la famiglia giusta. L'area è il posto che la
                    // controparte occupa nel thread — il server non sa quale veste sia attiva sul suo
                    // telefono: per chi ha due profili la riscrive il client (`instradaLinkNotifica`).
                    // La push nativa (`data.url`) e il dispatch web (`url: n.link`) lo portano com'è.
                    link: linkConversazione(controparte.versoGenitore ? 'parent' : 'teacher', thread_id),
                    entitaTipo: 'chat_thread',
                    entitaId: thread_id,
                    bufferMin: 0,
                    debounce: true,
                });
                // La push parte SUBITO (30 s), non al prossimo giro del cron (fino a 5 minuti:
                // 2,8' di ritardo medio misurato il 24/09). Solo DOPO l'accodamento: il giro
                // spedisce ciò che trova in coda. Non lancia e non tocca la risposta.
                programmaDispatchChat(thread_id);
            }
        } catch (e) {
            // `error` benché il messaggio sia salvato (201): la controparte non riceve la spinta,
            // quindi il messaggio resta lì finché non apre la chat per caso. In una chat
            // scuola↔famiglia il recapito È la funzione: una notifica mai accodata è un messaggio
            // di fatto non consegnato.
            logEvento('notifica', 'error', {
                operazione: 'chat/messages:POST',
                esito: 'notifica-controparte-non-accodata',
            }, e);
        }

        // La risposta al mittente porta il link FIRMATO: la sua bolla mostra
        // l'anteprima subito, senza aspettare il ricarico. In tabella resta il
        // percorso — sono due cose diverse, ed è tutto il punto dello step.
        const [messaggio] = await firmaAllegatiChat(supabase, [data], 'chat/messages:POST');

        return NextResponse.json(messaggio, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'chat/messages:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
