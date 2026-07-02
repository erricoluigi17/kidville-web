import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';

/**
 * GET /api/attendance/daily?data=YYYY-MM-DD&sezione=Girasoli
 * Restituisce le presenze del giorno per la sezione indicata.
 *
 * POST /api/attendance/daily
 * Body: { alunno_id, data, stato, orario_entrata?, orario_uscita? }
 * Upsert diretto su Supabase — bypassa Dexie per dati live nel registro mensile.
 */

export async function GET(request: NextRequest) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const data = searchParams.get('data') ?? new Date().toISOString().split('T')[0];
    const sezione = searchParams.get('sezione') ?? 'Girasoli';

    try {
        const supabase = await createClient();

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

        const body = await request.json();
        const { alunno_id, data, stato, orario_entrata, orario_uscita } = body;

        if (!alunno_id || !data || !stato) {
            return NextResponse.json(
                { error: 'Campi obbligatori: alunno_id, data, stato' },
                { status: 400 }
            );
        }

        const STATI_VALIDI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'];
        if (!STATI_VALIDI.includes(stato)) {
            return NextResponse.json(
                { error: `Stato non valido. Valori ammessi: ${STATI_VALIDI.join(', ')}` },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        const record = {
            alunno_id,
            data,
            stato,
            orario_entrata: orario_entrata ?? null,
            orario_uscita: orario_uscita ?? null,
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
