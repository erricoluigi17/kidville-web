import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo';
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers';
import { controparteThread } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zPaginazione } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { marcaConsegnati } from '@/lib/chat/delivered';
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione';
import { assertConversazioneNonSospesa } from '@/lib/chat/sospensione-conversazione';
import { assertTerminiAccettatiSeGenitore } from '@/lib/onboarding/consensi';
import { firmaAllegatiChat, normalizzaAllegatoChat } from '@/lib/chat/allegati';
import { sedeDiAlunno, sedeDiAccount } from '@/lib/anagrafiche/sedi';

// markRead='' è ammesso per retro-compatibilità: equivale ad assente (nessun mark-read).
const getQuerySchema = z.object({
    threadId: zUuid,
    markRead: zUuid.or(z.literal('')).optional(),
    ...zPaginazione.shape,
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

// GET /api/chat/messages?threadId=xxx&limit=50&offset=0&markRead=userId
// Lista messaggi per un thread con paginazione
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
        const { threadId, limit, offset } = q.data;
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

        // Recupera messaggi
        const { data, error, count } = await supabase
            .from('chat_messages')
            .select('*', { count: 'exact' })
            .eq('thread_id', threadId)
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            logErrore({ operazione: 'chat/messages:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // In tabella c'è il PERCORSO nel bucket privato: il link firmato lo
        // genera la lettura, a tempo, dietro al gate appena superato (S32). Una
        // sola chiamata allo Storage per pagina, mai una per messaggio.
        const messages = await firmaAllegatiChat(supabase, data ?? [], 'chat/messages:GET');

        return NextResponse.json({ messages, total: count ?? 0 });
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
                    link: controparte.versoGenitore ? '/parent/chat' : '/teacher/chat',
                    entitaTipo: 'chat_thread',
                    entitaId: thread_id,
                    bufferMin: 0,
                    debounce: true,
                });
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
