import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';

// ============================================================
// GET /api/locker/requests
// Query:
//   ?alunno_id=<id>     → richieste per un alunno (genitore)
//   ?classe_sezione=<s> → richieste per tutta la sezione (insegnante)
//   ?stato=pending      → filtra per stato (opzionale)
// ============================================================
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const alunnoId = searchParams.get('alunno_id');
        const classeSezione = searchParams.get('classe_sezione');
        const stato = searchParams.get('stato');

        const supabase = await createAdminClient();

        if (alunnoId) {
            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .eq('alunno_id', alunnoId)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json(data);

        } else if (classeSezione) {
            // Ramo docente/staff: gate ruolo + isolamento per plesso.
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const admin = await createAdminClient();
            const plessi = await scuoleDiUtente(admin, auth.user);
            if (plessi.length === 0) return NextResponse.json([]);

            // Ottieni gli alunni della sezione (solo dei propri plessi)
            const { data: alunni } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classeSezione)
                .eq('stato', 'iscritto')
                .in('scuola_id', plessi);

            if (!alunni || alunni.length === 0) return NextResponse.json([]);
            const ids = alunni.map(a => a.id);

            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .in('alunno_id', ids)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json(data);
        }

        return NextResponse.json(
            { error: 'Parametro alunno_id o classe_sezione richiesto' },
            { status: 400 }
        );
    } catch (err) {
        console.error('Errore GET /api/locker/requests:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// PATCH /api/locker/requests — Genitore "Preso in carico"
// Body: { id, stato: 'acknowledged' | 'fulfilled' }
// ============================================================
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, stato } = body;

        if (!id || !stato) {
            return NextResponse.json(
                { error: 'Campi obbligatori: id, stato' },
                { status: 400 }
            );
        }

        const validStates = ['acknowledged', 'fulfilled'];
        if (!validStates.includes(stato)) {
            return NextResponse.json(
                { error: `Stato non valido. Ammessi: ${validStates.join(', ')}` },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        const updates: Record<string, unknown> = { stato };
        if (stato === 'acknowledged') {
            updates.preso_in_carico_il = new Date().toISOString();
        }

        const { data, error } = await supabase
            .from('locker_requests')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json(data);
    } catch (err) {
        console.error('Errore PATCH /api/locker/requests:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
