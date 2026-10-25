import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, resolveScuoleAttive, sezioniVisibili } from '@/lib/auth/scope';
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';
import { rispostaGuastoDb } from '@/lib/db/guasto';
import { rispostaErroreInterno } from '@/lib/api/errore-interno';

// '' è ammesso per retro-compatibilità: ?alunnoId= (vuoto) equivale ad assente (nessun filtro).
const getQuerySchema = z.object({
    alunnoId: zUuid.or(z.literal('')).optional(),
});

const postBodySchema = z.object({
    alunnoIds: z.array(zUuid).min(1, 'alunnoIds è obbligatorio e non può essere vuoto'),
    categoria: z.string().min(1, 'categoria è obbligatoria'),
    testo: z.string().min(1, 'testo è obbligatorio'),
    richiedeFirma: z.boolean().nullish(),
});

// GET /api/notes?alunnoId=xxx
// Recupera le note disciplinari di un alunno
export const GET = withRoute('notes:GET', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunnoId } = q.data;

        const supabase = await createAdminClient();

        // Isolamento. `?alunnoId=` era libero, e SENZA parametro la route
        // restituiva TUTTE le note disciplinari di tutte le sedi — il contenuto
        // più delicato che un docente scrive su un bambino. `!inner` perché il
        // filtro sulla risorsa embedded scarti davvero la riga padre.
        if (alunnoId) {
            const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId);
            if (fuoriScope) return fuoriScope;
        }
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        let query = supabase
            .from('note_disciplinari')
            .select(`
                id,
                alunno_id,
                maestra_id,
                categoria,
                testo,
                richiede_firma,
                firmata_il,
                firmata_da,
                creato_il,
                alunni!inner ( nome, cognome, classe_sezione, scuola_id, section_id )
            `)
            .in('alunni.scuola_id', plessi)
            .order('creato_il', { ascending: false });

        // L'educator vede le sole sezioni assegnate (decisione del 2026-07-30);
        // admin/coordinator/segreteria tutte quelle del proprio plesso.
        const mieSezioni = await sezioniVisibili(supabase, auth.user);
        if (mieSezioni) query = query.in('alunni.section_id', mieSezioni);

        if (alunnoId) {
            query = query.eq('alunno_id', alunnoId);
        }

        const { data, error } = await query;

        // Il testo di PostgREST resta nel log: nella risposta c'era come `details`.
        if (error) return rispostaGuastoDb('notes:GET', 'db:note_disciplinari', error);

        return NextResponse.json({ success: true, data });

    } catch (error) {
        return rispostaErroreInterno('notes:GET', error);
    }
});

// POST /api/notes
// Body: { alunnoIds: string[], categoria, testo, richiedeFirma }
export const POST = withRoute('notes:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunnoIds, categoria, testo, richiedeFirma } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        // Isolamento sulla SCRITTURA: `alunnoIds` arriva dal client e non era
        // verificato. Si scriveva una nota disciplinare — e si notificavano i
        // genitori — su bambini di un'altra sede. Un id fuori scope fa fallire
        // l'intera richiesta: una scrittura parziale su un elenco di minori
        // sarebbe peggio di un rifiuto.
        for (const aid of alunnoIds) {
            const fuoriScope = await assertAlunnoInScope(supabase, auth.user, aid);
            if (fuoriScope) return fuoriScope;
        }

        // L'autore della nota è l'utente del gate (identità risolta server-side).
        const maestraId = auth.user.id;

        // Crea una nota per ogni alunno selezionato
        const noteRows = alunnoIds.map((alunnoId) => ({
            alunno_id: alunnoId,
            maestra_id: maestraId,
            categoria,
            testo,
            richiede_firma: richiedeFirma ?? false,
        }));

        const { data, error: dbError } = await supabase
            .from('note_disciplinari')
            .insert(noteRows)
            .select(`
                id,
                alunno_id,
                maestra_id,
                categoria,
                testo,
                richiede_firma,
                firmata_il,
                creato_il,
                alunni ( nome, cognome, classe_sezione )
            `);

        if (dbError) return rispostaGuastoDb('notes:POST', 'db:note_disciplinari', dbError, 'scrittura');

        // Notifica ai genitori (best-effort) — allineata al registro primaria:
        // stesso tipo/toggle (nota / nota_firma) e stesso buffer 10'.
        try {
            await enqueueNotifichePerAlunni(supabase, {
                alunnoIds,
                tipo: richiedeFirma ? 'nota_firma' : 'nota',
                titolo: richiedeFirma ? 'Nuova nota — richiesta firma' : 'Nuova nota',
                corpo: testo.slice(0, 140),
                link: '/parent/diary',
                entitaTipo: 'nota',
            });
        } catch (e) {
            // La nota è scritta: rispondere 500 inviterebbe a scriverla due volte. Ma i genitori non la
            // vedranno arrivare, e fino al 20/10 nessuno lo sapeva: il catch era muto.
            logEvento('notifica', 'error', {
                operazione: 'notes:POST',
                esito: 'notifica-genitori-non-accodata',
            }, e);
        }

        return NextResponse.json({ success: true, data, count: data?.length ?? 0 });

    } catch (error) {
        return rispostaErroreInterno('notes:POST', error);
    }
});
