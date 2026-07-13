import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

export const dynamic = 'force-dynamic';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso

export const GET = withRoute('tasks/meta:GET', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const supabase = await createAdminClient();
        const plessi = await scuoleDiUtente(supabase, auth.user);
        if (plessi.length === 0) return NextResponse.json({ staff: [], students: [], classes: [] });

        let staff: Array<{ id: string; first_name: string; last_name: string; role: string }> = [];

        // Leggi staff da utenti (educator, coordinator, admin) del/i proprio/i plesso/i
        const { data: utentiData, error: utentiErr } = await supabase
            .from('utenti')
            .select('id, nome, cognome, ruolo, first_name, last_name')
            .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore', 'insegnante'])
            .in('scuola_id', plessi);

        if (!utentiErr && utentiData) {
            staff = utentiData.map(u => {
                const first = u.first_name || u.nome || '';
                const last = u.last_name || u.cognome || '';
                let roleStr = 'educator';
                const rawRole = u.ruolo || '';
                if (rawRole === 'admin') roleStr = 'admin';
                else if (rawRole === 'coordinator' || rawRole === 'coordinatore') roleStr = 'coordinator';
                return { id: u.id, first_name: first, last_name: last, role: roleStr };
            });
        } else if (utentiErr) {
            // `error` benché la risposta sia 200: la route degrada a `staff: []`, cioè il
            // selettore degli assegnatari si apre VUOTO e sembra una scuola senza personale.
            // Un elenco vuoto per un guasto è indistinguibile da un elenco vuoto per davvero:
            // questa riga è l'unica cosa che li separa.
            logEvento('db', 'error', {
                operazione: 'tasks/meta:GET',
                esito: 'staff-non-letto',
            }, utentiErr);
        }

        // Recupera tutti gli alunni attivi
        let students: Array<{ id: string; nome: string; cognome: string; classe_sezione: string }> = [];
        const { data: studentsData, error: studErr } = await supabase
            .from('alunni')
            .select('id, nome, cognome, classe_sezione')
            .eq('stato', 'iscritto')
            .in('scuola_id', plessi)
            .order('cognome', { ascending: true });

        if (!studErr && studentsData) {
            students = studentsData;
        } else {
            // Come sopra: senza alunni il selettore resta vuoto e la 200 mente. `studErr ??
            // undefined` perché questo ramo scatta anche con `studentsData` nullo e NESSUN errore:
            // passare `null` al logger produrrebbe un messaggio «null», che non descrive niente.
            logEvento('db', 'error', {
                operazione: 'tasks/meta:GET',
                esito: 'alunni-non-letti',
            }, studErr ?? undefined);
        }

        // Recupera tutte le sezioni
        const { data: sections, error: secErr } = await supabase
            .from('sections')
            .select('name')
            .in('scuola_id', plessi)
            .order('name', { ascending: true });

        // Nessun elenco hardcoded: senza sezioni né alunni il selettore resta vuoto.
        let classes: string[] = [];
        if (!secErr && sections && sections.length > 0) {
            classes = sections.map(s => s.name);
        } else if (students.length > 0) {
            const uniqueClasses = Array.from(new Set(students.map(s => s.classe_sezione).filter(Boolean)));
            if (uniqueClasses.length > 0) {
                classes = uniqueClasses as string[];
            }
        }

        return NextResponse.json({ staff, students, classes });
    } catch (error) {
        logErrore({ operazione: 'tasks/meta:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
