// ⛔ DEPRECATO — API voti "legacy" (voto_numerico, scala Base/Intermedio/Avanzato),
// NON conforme O.M. 3/2025. Route senza consumer UI (l'ex GradesTab è stato
// rimosso il 2026-07-10; la pagina /teacher/register reindirizza a /teacher/primaria).
// La valutazione conforme passa da /api/primaria/valutazioni e
// /api/primaria/prospetto. Conservata come storico (coperta dai test API).

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, resolveScuoleAttive, sezioniVisibili } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// '' è ammesso per retro-compatibilità: ?alunnoId= (vuoto) equivale ad assente (nessun filtro).
const getQuerySchema = z.object({
    alunnoId: zUuid.or(z.literal('')).optional(),
    materia: z.string().optional(),
});

const postBodySchema = z
    .object({
        alunnoId: zUuid,
        materia: z.string().min(1, 'materia è obbligatoria'),
        tipo: z.string().nullish(),
        // Legacy: il voto può arrivare come numero o stringa numerica (il DB lo casta).
        votoNumerico: z.union([z.number(), z.string()]).nullish(),
        giudizioTesto: z.string().nullish(),
    })
    .refine((b) => Boolean(b.votoNumerico) || Boolean(b.giudizioTesto), {
        message: 'Serve almeno votoNumerico o giudizioTesto',
        path: ['votoNumerico'],
    });

// GET /api/grades?alunnoId=xxx&materia=Italiano
// Recupera i voti di un alunno (opzionalmente filtrati per materia)
export const GET = withRoute('grades:GET', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunnoId, materia } = q.data;

        const supabase = await createAdminClient();

        // Isolamento. `?alunnoId=` era libero, e SENZA parametro la route
        // restituiva TUTTE le valutazioni di tutte le sedi.
        if (alunnoId) {
            const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId);
            if (fuoriScope) return fuoriScope;
        }
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        let query = supabase
            .from('valutazioni')
            .select(`
                id,
                alunno_id,
                materia,
                tipo,
                voto_numerico,
                giudizio_testo,
                pubblicato,
                creato_il,
                alunni!inner ( nome, cognome, scuola_id, section_id )
            `)
            .in('alunni.scuola_id', plessi)
            .order('creato_il', { ascending: false });

        // L'educator vede le sole sezioni assegnate (decisione del 2026-07-30).
        const mieSezioni = await sezioniVisibili(supabase, auth.user);
        if (mieSezioni) query = query.in('alunni.section_id', mieSezioni);

        if (alunnoId) {
            query = query.eq('alunno_id', alunnoId);
        }
        if (materia) {
            query = query.eq('materia', materia);
        }

        const { data, error } = await query;

        if (error) {
            logErrore({ operazione: 'grades:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Errore nel recupero delle valutazioni' }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        logErrore({ operazione: 'grades:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

export const POST = withRoute('grades:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunnoId, materia, tipo, votoNumerico, giudizioTesto } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        // Isolamento sulla SCRITTURA: si registrava una valutazione su un bambino
        // di un'altra sede conoscendone l'uuid.
        const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId);
        if (fuoriScope) return fuoriScope;

        // L'autore/valutatore è l'utente del gate (identità risolta server-side).
        const maestraId = auth.user.id;

        // Inseriamo il voto. 'pubblicato' è false di default (nel DB).
        // Il buffer notifica sarà gestito tramite job asincrono su Supabase
        const { data, error: dbError } = await supabase
            .from('valutazioni')
            .insert({
                alunno_id: alunnoId,
                maestra_id: maestraId,
                materia,
                tipo,
                voto_numerico: votoNumerico,
                giudizio_testo: giudizioTesto,
                pubblicato: false
            })
            .select()
            .single();

        if (dbError) {
            logErrore({ operazione: 'grades:POST', stato: 500, evento: 'db' }, dbError);
            return NextResponse.json({ error: 'Errore nel salvataggio della valutazione' }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        logErrore({ operazione: 'grades:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
