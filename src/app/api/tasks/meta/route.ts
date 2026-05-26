import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const supabase = await createAdminClient();

        let staff: Array<{ id: string; first_name: string; last_name: string; role: string }> = [];

        // Leggi staff da utenti (educator, coordinator, admin)
        const { data: utentiData, error: utentiErr } = await supabase
            .from('utenti')
            .select('id, nome, cognome, ruolo, first_name, last_name')
            .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore', 'insegnante']);

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
