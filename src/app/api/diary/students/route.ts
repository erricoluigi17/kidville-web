import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { getGenitoriDiAlunni, getGenitoriDiAlunno } from '@/lib/anagrafiche/legami';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';

// Singolo alunno per id.
const getByIdQuerySchema = z.object({
    id: zUuid,
});

// Lista per sezione: nessun default hardcoded — senza sezione/classeSezione la risposta
// degrada a [] ('' non matcha alcuna classe); date→oggi calcolata nel codice;
// onlyPresent resta stringa confrontata con 'true' (semantica attuale preservata).
const getBySezioneQuerySchema = z.object({
    sezione: z.string().optional(),
    classeSezione: z.string().optional(),
    onlyPresent: z.string().optional(),
    date: zDataYMD.optional(),
});

// GET /api/diary/students?sezione=<classe>                    → lista classe (tutti)
// GET /api/diary/students?sezione=<classe>&onlyPresent=true   → solo presenti oggi
// GET /api/diary/students?classeSezione=3A&onlyPresent=true&date=2026-05-17
// GET /api/diary/students?id=uuid                             → singolo alunno
export const GET = withRoute('diary/students:GET', async (request: NextRequest) => {
    const supabase = await createAdminClient();
    const params = request.nextUrl.searchParams;

    if (params.get('id')) {
        const q = parseQuery(request, getByIdQuerySchema);
        if ('response' in q) return q.response;
        const { data: alunno, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, note_mediche, classe_sezione, consenso_privacy')
            .eq('id', q.data.id)
            .maybeSingle();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (!alunno) return NextResponse.json(null);

        // Recupera i genitori — unione runtime (`legame_genitori_alunni`) +
        // anagrafica (`student_parents` via ponte `parents.auth_user_id`): con la
        // sola runtime i bambini importati dal form pubblico risultavano senza
        // alcun genitore (nessun contatto per la maestra).
        const parentIds = await getGenitoriDiAlunno(supabase, alunno.id);

        let parents: { id: string; nome: string; cognome: string; email: string }[] = [];
        if (parentIds.length > 0) {
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

    const q = parseQuery(request, getBySezioneQuerySchema);
    if ('response' in q) return q.response;
    // Supporta sia "sezione" che "classeSezione"; nessun default a un nome
    // reale: entrambi assenti → '' → 0 alunni → risposta [].
    const sezione = q.data.sezione ?? q.data.classeSezione ?? '';
    const onlyPresent = q.data.onlyPresent === 'true';
    const date = q.data.date ?? new Date().toISOString().split('T')[0];

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

    // Legami per questi alunni, in BLOCCO e dall'unione delle due sorgenti
    // (runtime + anagrafica): 3 query fisse come prima, mai una per alunno.
    const genitoriPerAlunno = await getGenitoriDiAlunni(supabase, alunnoIds);

    // Recupera tutti i genitori collegati
    const parentsMap: Record<string, { id: string; nome: string; cognome: string; email: string }[]> = {};
    const parentIds = [...new Set([...genitoriPerAlunno.values()].flat())];
    if (parentIds.length > 0) {
        const { data: utenti } = await supabase
            .from('utenti')
            .select('id, nome, cognome, email')
            .in('id', parentIds);

        if (utenti) {
            const utentiMap = new Map(utenti.map(u => [u.id, u]));
            for (const [alunnoId, genitoreIds] of genitoriPerAlunno) {
                for (const genitoreId of genitoreIds) {
                    const parent = utentiMap.get(genitoreId);
                    if (!parent) continue;
                    if (!parentsMap[alunnoId]) {
                        parentsMap[alunnoId] = [];
                    }
                    parentsMap[alunnoId].push({
                        id: parent.id,
                        nome: parent.nome,
                        cognome: parent.cognome,
                        email: parent.email
                    });
                }
            }
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
            // `error` benché la risposta sia 200: il filtro `onlyPresent` NON viene applicato e la
            // lista torna con TUTTI gli alunni della classe. Il chiamante ha chiesto «solo i
            // presenti» e riceve anche gli assenti, senza saperlo — una risposta sbagliata è
            // peggio di un errore. L'errore si passa intero (non `.message`): code, details e hint
            // di PostgREST sono ciò che dice perché.
            logEvento('db', 'error', {
                operazione: 'diary/students:GET',
                esito: 'presenze-non-lette-filtro-non-applicato',
            }, prezError);
            return NextResponse.json(enrichedAlunni);
        }

        const presentIds = new Set((presenze ?? []).map(p => p.alunno_id));
        enrichedAlunni = enrichedAlunni.filter(a => presentIds.has(a.id));
    }

    return NextResponse.json(enrichedAlunni);
});
