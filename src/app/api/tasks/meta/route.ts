import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const supabase = await createAdminClient();

        let staff: Array<{ id: string; first_name: string; last_name: string; role: string }> = [];

        // 1. Tenta il recupero dello staff da 'adults'
        const { data: adultsData, error: adultsErr } = await supabase
            .from('adults')
            .select('id, first_name, last_name, role')
            .in('role', ['admin', 'coordinator', 'educator']);

        if (!adultsErr && adultsData && adultsData.length > 0) {
            staff = adultsData.map(a => ({
                id: a.id,
                first_name: a.first_name,
                last_name: a.last_name,
                role: a.role
            }));
        } else {
            console.warn('Tabella adults non disponibile o vuota. Eseguo fallback su tabelle utenti e parents per lo staff.');
            
            const staffMap = new Map<string, { id: string; first_name: string; last_name: string; role: string }>();

            // 1. Leggi da utenti
            const { data: utentiData, error: utentiErr } = await supabase
                .from('utenti')
                .select('id, nome, cognome, ruolo, first_name, last_name, role')
                .in('ruolo', ['maestra', 'admin', 'coordinator', 'coordinatore', 'insegnante']);

            if (!utentiErr && utentiData) {
                utentiData.forEach(u => {
                    const first = u.first_name || u.nome || '';
                    const last = u.last_name || u.cognome || '';
                    let roleStr = 'educator';
                    const rawRole = u.role || u.ruolo || '';
                    if (rawRole === 'admin') roleStr = 'admin';
                    else if (rawRole === 'coordinator' || rawRole === 'coordinatore') roleStr = 'coordinator';
                    staffMap.set(u.id, {
                        id: u.id,
                        first_name: first,
                        last_name: last,
                        role: roleStr
                    });
                });
            }

            // 2. Leggi da parents (dove insegnanti hanno citizenship = 'educator' / 'coordinator' / 'admin')
            const { data: parentsData, error: parentsErr } = await supabase
                .from('parents')
                .select('id, first_name, last_name, citizenship')
                .in('citizenship', ['educator', 'coordinator', 'admin']);

            if (!parentsErr && parentsData) {
                parentsData.forEach(p => {
                    if (!staffMap.has(p.id)) {
                        staffMap.set(p.id, {
                            id: p.id,
                            first_name: p.first_name || '',
                            last_name: p.last_name || '',
                            role: p.citizenship || 'educator'
                        });
                    }
                });
            }

            staff = Array.from(staffMap.values());
        }

        // 2. Recupera tutti gli alunni attivi
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

        // 3. Recupera tutte le sezioni
        const { data: sections, error: secErr } = await supabase
            .from('sections')
            .select('name')
            .order('name', { ascending: true });

        // Se le sezioni non esistono nel DB o danno errore, usiamo fallback statici o deduplicati dagli alunni
        let classes = ['Girasoli', 'Margherite', 'Tulipani', 'Coccinelle'];
        if (!secErr && sections && sections.length > 0) {
            classes = sections.map(s => s.name);
        } else if (students.length > 0) {
            // Se fallisce sections ma abbiamo gli alunni, estraiamo le sezioni uniche dagli alunni
            const uniqueClasses = Array.from(new Set(students.map(s => s.classe_sezione).filter(Boolean)));
            if (uniqueClasses.length > 0) {
                classes = uniqueClasses as string[];
            }
        }

        return NextResponse.json({
            staff,
            students,
            classes
        });
    } catch (error) {
        console.error('Errore API GET /api/tasks/meta:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
