import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zUuid } from '@/lib/validation/common';

/**
 * GET /api/attendance/daily?data=YYYY-MM-DD&sezione=<classe>
 * Restituisce le presenze del giorno per la sezione indicata.
 *
 * POST /api/attendance/daily
 * Body: { alunno_id, data, stato, orario_entrata?, orario_uscita? }
 * Upsert diretto su Supabase — bypassa Dexie per dati live nel registro mensile.
 */

const getQuerySchema = z.object({
    // default dinamico (oggi) calcolato nell'handler
    data: zDataYMD.optional(),
    // Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
    sezione: z.string().default(''),
});

const STATI_VALIDI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const;

const postBodySchema = z.object({
    alunno_id: zUuid,
    data: zDataYMD,
    stato: z.enum(STATI_VALIDI),
    orario_entrata: z.string().nullable().optional(),
    orario_uscita: z.string().nullable().optional(),
});

export async function GET(request: NextRequest) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const data = q.data.data ?? new Date().toISOString().split('T')[0];
    const sezione = q.data.sezione;

    try {
        // Pattern canonico delle route docente (cfr. diary/entries, agenda):
        // gate applicativo requireDocente + client admin. Con i cookie di
        // sessione il client SSR applicherebbe la RLS come utente, e le policy
        // scolastiche su presenze dipendono da un self-read su `utenti` che la
        // RLS nega → via sessione non funzionerebbero per nessuno.
        const supabase = await createAdminClient();

        const { data: rows, error } = await supabase
            .from('presenze')
            .select(`
                id,
                alunno_id,
                data,
                stato,
                orario_entrata,
                orario_uscita,
                panic_alert,
                alunni!inner ( id, nome, cognome, classe_sezione )
            `)
            .eq('data', data)
            .eq('alunni.classe_sezione', sezione)
            // bound difensivo: 1 riga per alunno/giorno, una sezione non supera mai 500
            .limit(500);

        if (error) {
            console.error('[GET /api/attendance/daily]', JSON.stringify(error));
            // Fallback: ritorna array vuoto invece di 500, per non bloccare la UI
            return NextResponse.json([]);
        }

        return NextResponse.json(rows ?? []);
    } catch (err) {
        console.error('[GET /api/attendance/daily] Unexpected:', err);
        return NextResponse.json([]);
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunno_id, data, stato, orario_entrata, orario_uscita } = b.data;

        const supabase = await createAdminClient();

        // Il record nasce completo di scuola/sezione (fonte: anagrafica alunno):
        // le policy scolastiche su presenze e l'aggregato realtime li richiedono.
        const { data: alunno } = await supabase
            .from('alunni')
            .select('scuola_id, section_id')
            .eq('id', alunno_id)
            .maybeSingle();
        if (!alunno) {
            return NextResponse.json({ error: 'Alunno non trovato.' }, { status: 404 });
        }

        const record = {
            alunno_id,
            data,
            stato,
            orario_entrata: orario_entrata ?? null,
            orario_uscita: orario_uscita ?? null,
            scuola_id: alunno.scuola_id,
            section_id: alunno.section_id,
            aggiornato_il: new Date().toISOString(),
        };

        // Upsert su (alunno_id, data) — un solo record per bambino per giorno
        const { data: result, error } = await supabase
            .from('presenze')
            .upsert(record, { onConflict: 'alunno_id,data' })
            .select()
            .single();

        if (error) {
            console.error('[POST /api/attendance/daily]', JSON.stringify(error));
            return NextResponse.json(
                { error: 'Errore salvataggio presenza.', details: error.message },
                { status: 500 }
            );
        }

        return NextResponse.json(result, { status: 200 });
    } catch (err) {
        console.error('[POST /api/attendance/daily] Unexpected:', err);
        return NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });
    }
}
