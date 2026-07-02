import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';

export const dynamic = 'force-dynamic';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso

export async function GET(request: Request) {
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
            console.error('Errore recupero staff da utenti:', utentiErr);
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
            console.error('Errore recupero alunni metadata:', studErr);
        }

        // Recupera tutte le sezioni
        const { data: sections, error: secErr } = await supabase
            .from('sections')
            .select('name')
            .in('scuola_id', plessi)
            .order('name', { ascending: true });

        let classes = ['Girasoli', 'Margherite', 'Tulipani', 'Coccinelle'];
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
        console.error('Errore API GET /api/tasks/meta:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
