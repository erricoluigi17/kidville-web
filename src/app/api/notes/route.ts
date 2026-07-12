import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

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
export async function GET(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunnoId } = q.data;

        const supabase = await createAdminClient();

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
                alunni ( nome, cognome, classe_sezione )
            `)
            .order('creato_il', { ascending: false });

        if (alunnoId) {
            query = query.eq('alunno_id', alunnoId);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Errore GET note_disciplinari:', error);
            return NextResponse.json({ error: 'Errore nel recupero delle note', details: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error('Errore API GET Note:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/notes
// Body: { alunnoIds: string[], categoria, testo, richiedeFirma }
export async function POST(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunnoIds, categoria, testo, richiedeFirma } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

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

        if (dbError) {
            console.error('Errore INSERT note_disciplinari:', dbError);
            return NextResponse.json({ error: 'Errore nel salvataggio della nota', details: dbError.message }, { status: 500 });
        }

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
        } catch { /* non bloccare */ }

        return NextResponse.json({ success: true, data, count: data?.length ?? 0 });

    } catch (error) {
        console.error('Errore API POST Note:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
