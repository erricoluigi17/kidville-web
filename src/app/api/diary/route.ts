import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, assertSezioneInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const postBodySchema = z.object({
    alunno_id: zUuid,
    classe_id: zUuid,
    tipo_evento: z.string().min(1),
    // Default dinamico (adesso) calcolato nel codice; accetta ciò che accetta new Date(...).
    timestamp_evento: z.union([z.string(), z.number()]).nullish(),
    note: z.unknown().optional(),
    dettagli: z.unknown().optional(),
});

// Vista insegnante: eventi della classe per una data (default oggi, calcolato nel codice).
const getClasseQuerySchema = z.object({
    classe_id: zUuid,
    date: zDataYMD.optional(),
});

// Vista genitore: ultimi 14 giorni del figlio.
const getAlunnoQuerySchema = z.object({
    alunno_id: zUuid,
});

/**
 * Il 500 di una lettura fallita: **loggato per intero, raccontato per niente**.
 *
 * Qui c'era `NextResponse.json({ error: error.message })` su entrambi i rami, e
 * `error.message` di PostgREST è testo interno: in produzione questa route
 * rispondeva, a un anonimo, «Could not find the table 'public.daily_routines' in
 * the schema cache» — cioè il nome dello schema, il nome della tabella e la
 * conferma che non esiste. Non è una fuga di dati personali, è peggio da
 * correggere dopo: è la mappa con cui si cerca la prossima porta.
 *
 * Il messaggio non si perde, cambia destinatario: `logErrore` porta l'oggetto
 * errore INTERO (`code`, `details`, `hint`), che è ciò che dice PERCHÉ — e senza
 * questa riga, ora che al chiamante non esce più niente, non lo saprebbe nessuno.
 * `withRoute` vedrebbe soltanto «ha risposto 500».
 *
 * Una funzione sola per tutti e due i rami: la lezione del ciclo precedente è
 * che una regola valida per due strade deve vivere in un posto solo, altrimenti
 * si corregge su una e resta rotta sull'altra.
 */
function erroreLettura(error: unknown): NextResponse {
    logErrore({ operazione: 'diary:GET', stato: 500, evento: 'db' }, error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
}

/**
 * Il gemello del precedente per la SCRITTURA. Il ciclo del 2026-08-02 aveva
 * corretto il GET e lasciato il POST tre righe più su con
 * `NextResponse.json({ error: error.message })`: la stessa mappa dello schema,
 * dalla stessa route, per l'altro verbo. Una regola valida per due strade deve
 * vivere in un posto solo — e qui i posti erano già due dentro lo stesso file.
 */
function erroreScrittura(error: unknown): NextResponse {
    logErrore({ operazione: 'diary:POST', stato: 500, evento: 'db' }, error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
}

// ============================================================
// POST /api/diary — Salva un evento diario (azione docente/staff)
// ============================================================
export const POST = withRoute('diary:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunno_id, classe_id, tipo_evento, timestamp_evento, note, dettagli } = b.data;

        const supabase = await createClient();
        const admin = await createAdminClient();
        const scopeErr = await assertAlunnoInScope(admin, auth.user, alunno_id);
        if (scopeErr) return scopeErr;

        // Calcola il timestamp per la notifica (evento + 10 min buffer)
        const eventTime = timestamp_evento ? new Date(timestamp_evento) : new Date();
        const notificaAt = new Date(eventTime.getTime() + 10 * 60 * 1000);

        const { data, error } = await supabase
            .from('daily_routines')
            .insert({
                alunno_id,
                classe_id,
                tipo_evento,
                timestamp_evento: eventTime.toISOString(),
                note: note ?? null,
                dettagli: dettagli ?? null,
                notifica_programmata_il: notificaAt.toISOString(),
            })
            .select()
            .single();

        if (error) return erroreScrittura(error);

        const { data: al } = await admin.from('alunni').select('section_id, scuola_id').eq('id', alunno_id).maybeSingle();
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'diario', entitaId: data.id, azione: 'insert',
            scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null, valoreDopo: data,
        });
        if (al?.section_id) {
            await notificaTitolariScrittura(admin, { attore: auth.user, sectionId: al.section_id, scuolaId: al?.scuola_id, area: 'diario' });
        }

        return NextResponse.json({ success: true, data }, { status: 201 });

    } catch (err) {
        logErrore({ operazione: 'diary:POST', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// GET /api/diary — Legge gli eventi
// Query params:
//   ?classe_id=<id>&date=YYYY-MM-DD  → per insegnante (eventi della classe oggi)
//   ?alunno_id=<id>                  → per genitore (ultimi 14 giorni del figlio)
//
// ⚠️ IL RAMO `alunno_id` NON AVEVA NESSUN GATE fino al 2026-08-02, e il commento
// «per genitore» descriveva un'intenzione, non un controllo: non c'era nessun
// `require*`. Rispondeva 500 soltanto perché `daily_routines` non esiste in
// produzione — e quel 500 portava fuori il messaggio INTERNO di PostgREST
// («Could not find the table 'public.daily_routines' in the schema cache»), cioè
// un pezzo di mappa dello schema regalato a un anonimo. Il giorno in cui quella
// tabella esistesse, la stessa chiamata avrebbe restituito il diario di
// QUALSIASI bambino a chiunque.
//
// Il ramo `classe_id`, tre righe più su, il gate ce l'aveva. Un gate che sta su
// una strada sola non è un gate: da fuori la route sembra protetta, e per metà
// delle chiamate non lo è. È la forma che `__tests__/architecture/gate-coverage.test.ts`
// chiama `ramo-senza-gate`, ed è nata proprio da qui.
// ============================================================
export const GET = withRoute('diary:GET', async (request: NextRequest) => {
    try {
        const { searchParams } = new URL(request.url);

        const supabase = await createClient();

        if (searchParams.get('classe_id')) {
            // Vista insegnante/staff (azione docente): gate ruolo. Il genitore usa il ramo alunno_id.
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const q = parseQuery(request, getClasseQuerySchema);
            if ('response' in q) return q.response;

            // GATE DI SEDE, non solo di ruolo. `requireDocente` dice «sei del
            // personale»; con TRE plessi non dice «quella sezione è tua». Senza
            // questa riga un educator di Aversa che indicasse l'uuid di una
            // sezione di Cesa superava il ramo e arrivava alla query: l'unica
            // ragione per cui non ne usciva nulla è che `daily_routines` non
            // esiste in produzione. Una falla che non si arma perché la tabella
            // manca resta una falla — si arma da sola il giorno in cui la
            // tabella arriva. Il gemello `diary/entries:GET` l'assert ce l'ha
            // già (`assertClasseNomeInScope`, `soloSezioniAssegnate`): stessa
            // lettura, stesso dato, e finora una sola delle due strade.
            // `assertSezioneInScope` include di suo il vincolo «assegnata»
            // per chi non vede tutte le classi del plesso (cfr. vedeTutteLeClassi).
            const adminScope = await createAdminClient();
            const fuoriSezione = await assertSezioneInScope(adminScope, auth.user, q.data.classe_id);
            if (fuoriSezione) return fuoriSezione;

            const date = q.data.date ?? new Date().toISOString().split('T')[0];
            // Vista insegnante: tutti gli eventi della classe per una data specifica
            const startOfDay = `${date}T00:00:00.000Z`;
            const endOfDay = `${date}T23:59:59.999Z`;

            const { data, error } = await supabase
                .from('daily_routines')
                .select('*')
                .eq('classe_id', q.data.classe_id)
                .gte('timestamp_evento', startOfDay)
                .lte('timestamp_evento', endOfDay)
                .order('timestamp_evento', { ascending: true });

            if (error) return erroreLettura(error);
            return NextResponse.json({ data });

        } else if (searchParams.get('alunno_id')) {
            const q = parseQuery(request, getAlunnoQuerySchema);
            if ('response' in q) return q.response;

            // GATE: identità dalla SESSIONE, poi legame genitore↔figlio a chi è
            // `genitore` e plesso+sezione a chiunque altro. È lo stesso gate del
            // ramo genitore di `diary/entries:GET`, e per la stessa ragione: il
            // diario di un bambino lo leggono la sua famiglia e chi lo ha in
            // carico, nessun altro. Sta DOPO `parseQuery` perché ha bisogno
            // dell'`alunno_id` validato, e prima di qualunque lettura.
            const gate = await requireParentOfStudent(request, q.data.alunno_id);
            if (gate.response) return gate.response;

            // Vista genitore: ultimi 14 giorni per il proprio figlio
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const { data, error } = await supabase
                .from('daily_routines')
                .select('*')
                .eq('alunno_id', q.data.alunno_id)
                .gte('timestamp_evento', fourteenDaysAgo.toISOString())
                .order('timestamp_evento', { ascending: false });

            if (error) return erroreLettura(error);
            return NextResponse.json({ data });

        } else {
            return NextResponse.json(
                { error: 'Parametro classe_id o alunno_id richiesto' },
                { status: 400 }
            );
        }

    } catch (err) {
        logErrore({ operazione: 'diary:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
