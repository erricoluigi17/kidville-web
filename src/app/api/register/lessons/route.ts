import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zUuid } from '@/lib/validation/common';

const getQuerySchema = z.object({
    classeSezione: z.string().min(1),
    data: zDataYMD,
});

const postBodySchema = z.object({
    classeSezione: z.string().min(1),
    // '' e null oggi ricadono sul fallback (prima scuola dal DB), quindi restano ammessi
    scuolaId: z.union([zUuid, z.literal('')]).nullish(),
    data: zDataYMD,
    // oggi: qualsiasi valore truthy (numero ≠ 0 o stringa non vuota); il CHECK 1..8 resta al DB
    oraLezione: z.union([z.number().refine((n) => n !== 0), z.string().min(1)]),
    materia: z.string().min(1),
    argomento: z.string().nullish(),
    compiti: z.string().nullish(),
    dataConsegnaCompiti: z.union([zDataYMD, z.literal('')]).nullish(),
});

// GET /api/register/lessons?classeSezione=3A&data=2026-05-13
// Gate docente (M5.6): la route era raggiungibile senza identità post-M4.
export async function GET(request: Request) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { classeSezione, data } = q.data;

        const supabase = await createAdminClient();

        const { data: registroRows, error } = await supabase
            .from('registro_orario')
            .select(`
                id,
                ora_lezione,
                materia,
                argomento,
                compiti,
                data_consegna_compiti,
                media_url,
                firme_docenti (
                    id,
                    maestra_id,
                    tipo_compresenza,
                    firmato_il
                )
            `)
            .eq('classe_sezione', classeSezione)
            .eq('data', data)
            .order('ora_lezione', { ascending: true });

        if (error) {
            console.error('Errore GET registro_orario:', error);
            return NextResponse.json({ error: 'Errore nel recupero delle lezioni', details: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data: registroRows });

    } catch (error) {
        console.error('Errore API GET Lezioni:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/register/lessons
// Body: { classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti }
// Gate docente (M5.6): scrittura su registro_orario; la firma usa l'identità
// risolta dal gate (niente fallback dev post-M4).
export async function POST(request: Request) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    try {
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti } = b.data;

        // Admin client per bypassare RLS (stesso pattern delle altre API del progetto)
        const supabase = await createAdminClient();

        const maestraId = auth.user.id;

        // Recupera scuola_id se non fornito (prende il primo disponibile dal DB)
        let finalScuolaId = scuolaId;
        if (!finalScuolaId) {
            const { data: school } = await supabase
                .from('schools')
                .select('id')
                .limit(1)
                .single();
            finalScuolaId = school?.id;
        }

        // UPSERT su registro_orario
        const { data: registroRow, error: registroError } = await supabase
            .from('registro_orario')
            .upsert({
                scuola_id: finalScuolaId,
                classe_sezione: classeSezione,
                data,
                ora_lezione: oraLezione,
                materia,
                argomento: argomento || null,
                compiti: compiti || null,
                data_consegna_compiti: dataConsegnaCompiti || null,
            }, {
                onConflict: 'classe_sezione,data,ora_lezione',
            })
            .select()
            .single();

        if (registroError) {
            console.error('Errore UPSERT registro_orario:', registroError);
            return NextResponse.json({ error: 'Errore nel salvataggio della lezione', details: registroError.message }, { status: 500 });
        }

        // INSERT firma del docente (UPSERT per gestire duplicati)
        const { error: firmaError } = await supabase
            .from('firme_docenti')
            .upsert({
                registro_id: registroRow.id,
                maestra_id: maestraId,
                tipo_compresenza: 'principale',
            }, {
                onConflict: 'registro_id,maestra_id',
            });

        if (firmaError) {
            console.error('Errore INSERT firma_docente:', firmaError);
            // Non blocchiamo il flusso: il registro è già salvato
        }

        return NextResponse.json({ success: true, data: registroRow });

    } catch (error) {
        console.error('Errore API POST Lezioni:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
