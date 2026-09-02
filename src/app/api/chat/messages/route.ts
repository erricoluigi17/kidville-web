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
        const { data: thread, error: threadErr } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id')
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
                const [nome, mittente] = await Promise.all([
                    nomeUtente(supabase, sender_id),
                    supabase.from('utenti').select('scuola_id').eq('id', sender_id).maybeSingle(),
                ]);
                await notificaEvento(supabase, {
                    tipo: controparte.versoGenitore ? 'chat_genitore' : 'chat_docente',
                    scuolaId: (mittente.data?.scuola_id as string | undefined) ?? null,
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
