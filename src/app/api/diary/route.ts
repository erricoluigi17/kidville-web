import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope } from '@/lib/auth/scope';
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

        if (error) {
            console.error('Errore inserimento diario:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

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

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ data });

        } else if (searchParams.get('alunno_id')) {
            const q = parseQuery(request, getAlunnoQuerySchema);
            if ('response' in q) return q.response;
            // Vista genitore: ultimi 14 giorni per il proprio figlio
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const { data, error } = await supabase
                .from('daily_routines')
                .select('*')
                .eq('alunno_id', q.data.alunno_id)
                .gte('timestamp_evento', fourteenDaysAgo.toISOString())
                .order('timestamp_evento', { ascending: false });

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
