import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// ============================================================
// POST /api/diary — Salva un evento diario
// ============================================================
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { alunno_id, classe_id, tipo_evento, timestamp_evento, note, dettagli } = body;

        if (!alunno_id || !classe_id || !tipo_evento) {
            return NextResponse.json(
                { error: 'Campi obbligatori mancanti: alunno_id, classe_id, tipo_evento' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

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

        return NextResponse.json({ success: true, data }, { status: 201 });

    } catch (err) {
        console.error('Errore POST /api/diary:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// GET /api/diary — Legge gli eventi
// Query params:
//   ?classe_id=<id>&date=YYYY-MM-DD  → per insegnante (eventi della classe oggi)
//   ?alunno_id=<id>                  → per genitore (ultimi 14 giorni del figlio)
// ============================================================
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const classeId = searchParams.get('classe_id');
        const alunnoId = searchParams.get('alunno_id');
        const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0];

        const supabase = await createClient();

        if (classeId) {
            // Vista insegnante: tutti gli eventi della classe per una data specifica
            const startOfDay = `${date}T00:00:00.000Z`;
            const endOfDay = `${date}T23:59:59.999Z`;

            const { data, error } = await supabase
                .from('daily_routines')
                .select('*')
                .eq('classe_id', classeId)
                .gte('timestamp_evento', startOfDay)
                .lte('timestamp_evento', endOfDay)
                .order('timestamp_evento', { ascending: true });

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ data });

        } else if (alunnoId) {
            // Vista genitore: ultimi 14 giorni per il proprio figlio
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const { data, error } = await supabase
                .from('daily_routines')
                .select('*')
                .eq('alunno_id', alunnoId)
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
        console.error('Errore GET /api/diary:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
