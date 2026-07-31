import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertClasseNomeInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
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
    // La sede scelta nel SedeSelector (R70): finora non viaggiava mai, e con tre
    // plessi il nome-classe da solo non dice più di quale sede si parli.
    scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
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
        const alunnoId = q.data.id;

        // Il gate sta PRIMA della lettura — e prima non c'era affatto: `requireDocente`
        // era invocato solo DOPO il `return` di questo ramo, quindi bastava conoscere (o
        // indovinare) un uuid per ottenere `note_mediche` di un minore, la sua classe e
        // le email dei suoi genitori SENZA alcuna credenziale. Verificato in produzione
        // il 2026-07-30: rispondeva 200 a una richiesta anonima.
        //
        // Genitore  → legame genitore↔figlio (`legame_genitori_alunni` +
        //             `student_parents`).
        // Staff     → l'alunno deve essere nel proprio plesso, e per `educator` nelle
        //             proprie sezioni.
        // `cuoca`   → non è genitore e non ha sezioni assegnate: viene negata.
        //             Nessun ruolo resta scoperto.
        //
        // Le tre righe qui sopra le fa TUTTE `requireParentOfStudent`. Fino al
        // 2026-07-31 ne faceva una sola — il legame di famiglia — e questa route
        // era l'UNICA delle venti che ci aggiungeva `assertAlunnoInScope` a mano.
        // Ora che il presidio sta nel gate quel giro è stato tolto: non per
        // risparmiare due query, ma perché una difesa duplicata QUI insegna al
        // prossimo lettore che il gate da solo non basta — ed è esattamente la
        // convinzione che ha lasciato scoperte le altre diciannove.
        const auth = await requireParentOfStudent(request, alunnoId);
        if (auth.response) return auth.response;

        const { data: alunno, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, note_mediche, classe_sezione, consenso_privacy')
            .eq('id', alunnoId)
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

    // ── Modalità insegnante/staff (per sezione): gate ruolo + gate classe + isolamento per plesso. ──
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;
    const admin = await createAdminClient();

    const q = parseQuery(request, getBySezioneQuerySchema);
    if ('response' in q) return q.response;
    // Supporta sia "sezione" che "classeSezione"; nessun default a un nome
    // reale: entrambi assenti → nessuna lettura → risposta [] (contratto storico:
    // la UI chiama questa route anche prima di aver risolto la classe).
    const sezione = q.data.sezione ?? q.data.classeSezione ?? '';
    if (!sezione) return NextResponse.json([]);
    const onlyPresent = q.data.onlyPresent === 'true';
    const date = q.data.date ?? new Date().toISOString().split('T')[0];

    // GATE prima di qualunque lettura. `requireDocente` verifica il RUOLO, non
    // la classe: senza `soloSezioniAssegnate` un educator poteva chiedere
    // qualunque nome di classe del proprio plesso e ricevere `note_mediche`,
    // nome e cognome dei bambini di una sezione non sua. Il modello (PRD §3/§12,
    // decisione del 2026-07-30) dice: educator → SOLO le sezioni assegnate.
    // Admin/coordinator/segreteria non sono toccati: vedono tutto il plesso.
    const scopeErr = await assertClasseNomeInScope(admin, auth.user, sezione, { soloSezioniAssegnate: true });
    if (scopeErr) return scopeErr;

    // FILTRO, complemento del gate: il gate impedisce di NOMINARE una classe
    // altrui, il filtro impedisce che l'omonimia porti dentro i bambini
    // dell'altra sede. `resolveScuoleAttive` (non `scuoleDiUtente`) perché il
    // SedeSelector deve contare: prima qui il cookie non veniva nemmeno letto.
    const attive = await resolveScuoleAttive(request, admin, auth.user);
    const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
        azione: 'diary/students:GET', utente: auth.user.id, ruolo: auth.user.role,
    });
    if (sede.response) return sede.response;
    const plessi = sede.plessi ?? [];
    if (plessi.length === 0) return NextResponse.json([]);

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
