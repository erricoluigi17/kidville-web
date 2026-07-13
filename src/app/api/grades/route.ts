// ⛔ DEPRECATO — API voti "legacy" (voto_numerico, scala Base/Intermedio/Avanzato),
// NON conforme O.M. 3/2025. Route senza consumer UI (l'ex GradesTab è stato
// rimosso il 2026-07-10; la pagina /teacher/register reindirizza a /teacher/primaria).
// La valutazione conforme passa da /api/primaria/valutazioni e
// /api/primaria/prospetto. Conservata come storico (coperta dai test API).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
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
export const GET = withRoute('grades:GET', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunnoId, materia } = q.data;

        const supabase = await createAdminClient();

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
                alunni ( nome, cognome )
            `)
            .order('creato_il', { ascending: false });

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

export const POST = withRoute('grades:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunnoId, materia, tipo, votoNumerico, giudizioTesto } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

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
