import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo';
import { rubricaDiFamiglia, rubricaDiOperatore, type EsitoRubrica } from '@/lib/chat/rubrica';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// Gap auth chiuso in M9: il legacy `?userId=` in query resta ACCETTATO dallo
// schema per compatibilità coi client ma viene IGNORATO — l'identità è quella
// del gate (sessione; pattern M4 "parent_id legacy strippato").
const getQuerySchema = z.object({
    userId: zUuid.optional(),
});

/**
 * GET /api/chat/contacts — con chi si può APRIRE una conversazione.
 *
 * ─── COSA È CAMBIATO, E PERCHÉ ───────────────────────────────────────────────
 *
 * «Un genitore deve poter contattare solo le proprie insegnanti, così come le
 * insegnanti possono contattare solo i propri genitori: quando clicchi su nuova
 * chat, non devono proprio comparire le altre persone.»
 *
 * Questa rotta non lo faceva, in due direzioni opposte. Misurato in produzione il
 * 2026-09-07, su 706 genitori e 60 docenti:
 *
 *  · **9 genitori** ricevevano **tutti i 63 docenti di 5 sedi** (Demo ed E2E
 *    comprese, 9 disattivati): bastava che un figlio non avesse `section_id`, o
 *    che la sua sezione non avesse legami, e un fallback restituiva l'anagrafica
 *    intera del personale docente. Non era generosità: erano 63 nomi di persone
 *    che non sono le sue insegnanti.
 *  · **150 genitori** vedevano, fra le «proprie insegnanti», qualcuno che
 *    insegnante non è — in `utenti_sezioni` ci sono 6 righe di `segreteria` e 1 di
 *    `admin` — e **32** vedevano un docente CESSATO.
 *  · **12 docenti su 60** vedevano i genitori di UNA sola delle proprie sezioni:
 *    `.limit(1)` **senza `order`** su `utenti_sezioni`, quindi nemmeno sempre la
 *    stessa. E il filtro sugli alunni era per NOME di classe, che non è una
 *    chiave: dove il testo diverge dal `sections.name`, la rubrica usciva vuota
 *    con un 200 e nessuna riga di log.
 *  · un fallback storico deduceva la sezione della maestra dai **tag delle foto**
 *    che aveva caricato. È sparito: dedurre la classe dai media produce
 *    abbinamenti plausibili e sbagliati, che è peggio del vuoto — il PRD lo dice
 *    già a proposito delle insegnanti senza sezione.
 *
 * La regola vive ora in `@/lib/chat/rubrica`, in un posto solo, e la applica
 * anche `chat/threads:POST` — che è il gate della SCRITTURA. Filtrare la sola
 * vetrina lasciava la porta aperta a chi conosce gli uuid, e gli uuid viaggiano
 * nelle risposte API: di lì sono nati 32 thread fuori sezione, uno al giorno.
 *
 * ─── LA VESTE, NON IL RUOLO NEL DATABASE ────────────────────────────────────
 *
 * La biforcazione guarda `agisceComeGenitore` — la veste ATTIVA — e non più
 * `utenti.role`. Prima una maestra che è anche mamma, passando in veste famiglia,
 * riceveva comunque la rubrica da maestra: **non poteva aprire una chat con le
 * insegnanti di suo figlio**. Sono 9 persone, con 12 legami, 11 dei quali su
 * bambini in sezioni che non insegnano. Il commento che stava qui lo ammetteva e
 * rinviava la cosa come «decisione di prodotto»: la decisione è stata presa, ed è
 * quella coerente con la frase da cui parte questa rotta. `chat/threads:POST` fa
 * già esattamente questa distinzione, quindi la rubrica smette di contraddire il
 * gate che le sta accanto.
 */
export const GET = withRoute('chat/contacts:GET', async (request: Request) => {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const userId = auth.user.id;

    try {
        const supabase = await createAdminClient();
        const comeGenitore = agisceComeGenitore(auth.user);

        const esito: EsitoRubrica = comeGenitore
            ? await rubricaDiFamiglia(supabase, userId)
            : await rubricaDiOperatore(supabase, auth.user);

        // PostgREST non lancia: senza questo ramo una lettura rotta uscirebbe come
        // «non hai nessun contatto», e la rubrica resterebbe vuota senza che
        // nessuna riga lo dica. Vale su ENTRAMBI i rami: fino a oggi il 500 ce
        // l'aveva solo quello della maestra.
        if (esito.errore) {
            return NextResponse.json(
                { error: 'La rubrica non si è potuta caricare.', codice: 'RUBRICA_NON_DISPONIBILE' },
                { status: 500 },
            );
        }

        // I contatti con cui una conversazione è già aperta non si ripropongono:
        // la si riprende dalla lista, non se ne apre una seconda (la tripla
        // `(teacher_id, parent_id, student_id)` è UNIQUE).
        const { data: threadEsistenti, error: erroreThread } = await supabase
            .from('chat_threads')
            .select('teacher_id, parent_id, student_id')
            .or(`teacher_id.eq.${userId},parent_id.eq.${userId}`);
        if (erroreThread) {
            logErrore({ operazione: 'chat/contacts:GET', stato: 500, evento: 'db' }, erroreThread);
            return NextResponse.json(
                { error: 'La rubrica non si è potuta caricare.', codice: 'RUBRICA_NON_DISPONIBILE' },
                { status: 500 },
            );
        }
        const esistenti = threadEsistenti ?? [];

        const contacts = esito.voci
            .filter((v) => !esistenti.some((t) =>
                comeGenitore
                    ? t.parent_id === userId && t.teacher_id === v.utenteId && t.student_id === v.alunno.id
                    : t.teacher_id === userId && t.parent_id === v.utenteId && t.student_id === v.alunno.id,
            ))
            .map((v) => ({
                user_id: v.utenteId,
                user_name: '',
                user_role: comeGenitore ? 'maestra' : 'genitore',
                student_id: v.alunno.id,
                student_name: `${v.alunno.nome ?? ''} ${v.alunno.cognome ?? ''}`.trim(),
                sezione: v.alunno.classeSezione ?? '',
                // Sede del LEGAME (quella dell'alunno), non dell'operatore: con più
                // plessi «2 ANNI» non identifica una classe, e una lista di persone
                // senza sede è indistinguibile da quella di un altro plesso.
                scuola_id: v.alunno.scuolaId,
            }));

        // I nomi in blocco, alla fine e su un insieme già filtrato: nessuna N+1, e
        // nessun nome letto per una persona che poi non compare in elenco.
        const daNominare = [...new Set(contacts.map((c) => c.user_id))];
        if (daNominare.length > 0) {
            const { data: persone } = await supabase
                .from('utenti')
                .select('id, nome, cognome, first_name, last_name')
                .in('id', daNominare);
            const perId = new Map(((persone ?? []) as Array<{ id: string; nome: string | null; cognome: string | null; first_name: string | null; last_name: string | null }>).map((p) => [p.id, p]));
            for (const c of contacts) {
                const p = perId.get(c.user_id);
                c.user_name = p ? `${p.first_name || p.nome || ''} ${p.last_name || p.cognome || ''}`.trim() : '';
            }
        }

        /**
         * PERCHÉ LA ROTTA DICE ANCHE *PERCHÉ* È VUOTA.
         *
         * Finora, a elenco vuoto, il genitore leggeva «Hai già una conversazione con
         * tutte le maestre disponibili! 🎉» e la docente il suo gemello. Dopo questa
         * stretta quelle frasi toccherebbero anche chi non ha **nessun** contatto
         * possibile — 23 genitori, di cui **20 di una sola sezione**, la
         * `Sezione delle Meraviglie (NIDO)` di Cesa, che ha 20 iscritti e zero
         * educator attivi. Dire loro «li hai già contattati tutti», con un'emoji,
         * sarebbe una bugia.
         *
         * Il campo è ADDITIVO: chi legge solo `contacts` non se ne accorge. È lo
         * stesso schema già in produzione su `/api/parent/students` (`in_attesa` +
         * `motivo_assenza`).
         */
        const motivo = contacts.length === 0
            ? (esito.motivoVuota ?? (esistenti.length > 0 ? 'tutti-gia-contattati' : null))
            : null;

        if (motivo && motivo !== 'tutti-gia-contattati') {
            // `warn` e non `info`: è la riga con cui, fra due mesi, «i 23 genitori
            // sono diventati cinquanta?» si risponde con una query invece che con
            // un'opinione. `tipo` e non `motivo`: `motivo` è una chiave REDATTA.
            logEvento('chat', 'warn', {
                operazione: 'chat/contacts:GET',
                esito: 'rubrica-vuota',
                tipo: motivo,
                utente: userId,
            });
        }

        return NextResponse.json({
            contacts,
            existing_count: esistenti.length,
            motivo,
        });
    } catch (error) {
        logErrore({ operazione: 'chat/contacts:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
