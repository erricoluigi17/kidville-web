import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zUuid } from '@/lib/validation/common';
import { assertClasseNomeInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi } from '@/lib/notifiche/destinatari';

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

        // La classe deve appartenere ai plessi del docente (niente scritture su classi altrui)
        const classeScope = await assertClasseNomeInScope(supabase, auth.user, classeSezione);
        if (classeScope) return classeScope;

        const maestraId = auth.user.id;

        // Deriva lo scuola_id server-side dalla sezione risolta ENTRO i plessi consentiti,
        // ignorando lo scuolaId grezzo del client (regola d'oro: mai fidarsi del client).
        const plessi = await scuoleDiUtente(supabase, auth.user);
        const { data: sezioneRow } = await supabase
            .from('sections')
            .select('id, scuola_id')
            .eq('name', classeSezione)
            .in('scuola_id', plessi)
            .limit(1)
            .maybeSingle();
        // Se scuolaId del client è tra i plessi consentiti lo rispettiamo, altrimenti la sede
        // deriva dalla sezione; ultimo fallback: primo plesso accessibile.
        const finalScuolaId =
            (scuolaId && plessi.includes(scuolaId) ? scuolaId : undefined) ??
            sezioneRow?.scuola_id ??
            plessi[0];

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

        // Notifica ai genitori della classe (best-effort) SOLO se ci sono
        // compiti assegnati (l'argomento da solo non è un evento per famiglie).
        // Stesso tipo/toggle del registro primaria; debounce sull'uuid della
        // sezione: i salvataggi ora-per-ora collassano in una notifica sola
        // (entita_id è uuid: niente chiavi sintetiche).
        if (compiti) {
            try {
                const destinatari = await genitoriDiClassi(supabase, finalScuolaId, [classeSezione]);
                await notificaEvento(supabase, {
                    tipo: 'compiti',
                    scuolaId: finalScuolaId ?? null,
                    utenteIds: destinatari,
                    titolo: `Compiti assegnati — ${classeSezione}`,
                    corpo: compiti.slice(0, 140),
                    link: '/parent/compiti',
                    entitaTipo: 'registro',
                    entitaId: (sezioneRow?.id as string | undefined) ?? null,
                    bufferMin: 10,
                    debounce: true,
                });
            } catch (e) {
                console.error('Notifica compiti fallita (non bloccante):', e);
            }
        }

        return NextResponse.json({ success: true, data: registroRow });

    } catch (error) {
        console.error('Errore API POST Lezioni:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
