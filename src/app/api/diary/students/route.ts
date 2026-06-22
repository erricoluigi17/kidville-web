import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';

// GET /api/diary/students?sezione=Girasoli                    → lista classe (tutti)
// GET /api/diary/students?sezione=Girasoli&onlyPresent=true   → solo presenti oggi
// GET /api/diary/students?classeSezione=3A&onlyPresent=true&date=2026-05-17
// GET /api/diary/students?id=uuid                             → singolo alunno
export async function GET(request: NextRequest) {
    const supabase = await createClient();
    const params = request.nextUrl.searchParams;

    const id = params.get('id');
    if (id) {
        const { data: alunno, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, note_mediche, classe_sezione, consenso_privacy')
            .eq('id', id)
            .maybeSingle();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (!alunno) return NextResponse.json(null);

        // Recupera i genitori
        const { data: legami } = await supabase
            .from('legame_genitori_alunni')
            .select('genitore_id')
            .eq('alunno_id', alunno.id);

        let parents: { id: string; nome: string; cognome: string; email: string }[] = [];
        if (legami && legami.length > 0) {
            const parentIds = legami.map(l => l.genitore_id);
            const { data: utenti } = await supabase
                .from('utenti')
                .select('id, nome, cognome, email')
                .in('id', parentIds);
            parents = utenti ?? [];
        }

        return NextResponse.json({
            ...alunno,
            parents
        });
    }

    // ── Modalità insegnante/staff (per sezione): gate ruolo + isolamento per plesso. ──
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;
    const admin = await createAdminClient();
    const plessi = await scuoleDiUtente(admin, auth.user);
    if (plessi.length === 0) return NextResponse.json([]);

    // Supporta sia "sezione" (Girasoli) che "classeSezione" (3A)
    const sezione = params.get('sezione') ?? params.get('classeSezione') ?? 'Girasoli';
    const onlyPresent = params.get('onlyPresent') === 'true';
    const date = params.get('date') ?? new Date().toISOString().split('T')[0];

    const { data: alunni, error } = await admin
        .from('alunni')
        .select('id, nome, cognome, note_mediche, classe_sezione, consenso_privacy')
        .eq('classe_sezione', sezione)
        .in('scuola_id', plessi)
        .order('cognome');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!alunni || alunni.length === 0) {
        return NextResponse.json([]);
    }

    const alunnoIds = alunni.map(a => a.id);

    // Recupera i legami per questi alunni
    const { data: legami } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id, genitore_id')
        .in('alunno_id', alunnoIds);

    // Recupera tutti i genitori collegati
    const parentsMap: Record<string, { id: string; nome: string; cognome: string; email: string }[]> = {};
    if (legami && legami.length > 0) {
        const parentIds = [...new Set(legami.map(l => l.genitore_id))];
        const { data: utenti } = await supabase
            .from('utenti')
            .select('id, nome, cognome, email')
            .in('id', parentIds);

        if (utenti) {
            const utentiMap = new Map(utenti.map(u => [u.id, u]));
            legami.forEach(l => {
                const parent = utentiMap.get(l.genitore_id);
                if (parent) {
                    if (!parentsMap[l.alunno_id]) {
                        parentsMap[l.alunno_id] = [];
                    }
                    parentsMap[l.alunno_id].push({
                        id: parent.id,
                        nome: parent.nome,
                        cognome: parent.cognome,
                        email: parent.email
                    });
                }
            });
        }
    }

    // Arricchisci gli alunni con i genitori
    let enrichedAlunni = alunni.map(a => ({
        ...a,
        parents: parentsMap[a.id] ?? []
    }));

    // Se richiesto, filtra solo gli alunni presenti quel giorno
    if (onlyPresent && enrichedAlunni.length > 0) {
        const { data: presenze, error: prezError } = await supabase
            .from('presenze')
            .select('alunno_id, stato')
            .eq('data', date)
            .in('alunno_id', alunnoIds)
            .in('stato', ['presente', 'ritardo', 'uscita_anticipata']);

        if (prezError) {
            console.error('[/api/diary/students] Errore presenze:', prezError.message);
            return NextResponse.json(enrichedAlunni);
        }

        const presentIds = new Set((presenze ?? []).map(p => p.alunno_id));
        enrichedAlunni = enrichedAlunni.filter(a => presentIds.has(a.id));
    }

    return NextResponse.json(enrichedAlunni);
}
