import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/educator-sections?userId=xxx
// Returns the section names that a given educator is assigned to
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ sectionNames: [] });
        }

        const supabase = await createAdminClient();

        // Get role from utenti first
        const { data: utente } = await supabase
            .from('utenti')
            .select('ruolo, role')
            .eq('id', userId)
            .maybeSingle();

        let rawRole = utente?.role || utente?.ruolo || '';

        // Fallback: check parents table (stock teachers stored there with citizenship field)
        if (!rawRole) {
            const { data: parentEntry } = await supabase
                .from('parents')
                .select('citizenship')
                .eq('id', userId)
                .maybeSingle();
            if (parentEntry) rawRole = parentEntry.citizenship || '';
        }

        // Normalize role
        let normalizedRole = 'educator';
        if (rawRole === 'admin') normalizedRole = 'admin';
        else if (rawRole === 'coordinator' || rawRole === 'coordinatore') normalizedRole = 'coordinator';
        else if (rawRole === 'maestra' || rawRole === 'insegnante' || rawRole === 'educator') normalizedRole = 'educator';

        const isManager = normalizedRole === 'admin' || normalizedRole === 'coordinator';

        // Managers can see all classes
        if (isManager) {
            const { data: sections } = await supabase
                .from('sections')
                .select('name')
                .order('name');
            return NextResponse.json({
                sectionNames: sections?.map((s: { name: string }) => s.name) || [],
                role: normalizedRole
            });
        }

        // Educators: get their assigned sections
        const { data: educatorSections } = await supabase
            .from('educator_sections')
            .select('section_id')
            .eq('educator_id', userId);

        if (!educatorSections || educatorSections.length === 0) {
            // Fallback: try to find by name match in sections
            return NextResponse.json({ sectionNames: [], role: 'educator' });
        }

        const sectionIds = educatorSections.map(es => es.section_id);
        const { data: sections } = await supabase
            .from('sections')
            .select('name')
            .in('id', sectionIds);

        return NextResponse.json({
            sectionNames: sections?.map(s => s.name) || [],
            role: 'educator'
        });

    } catch (error) {
        console.error('Errore GET /api/educator-sections:', error);
        return NextResponse.json({ sectionNames: [], role: 'educator' });
    }
}
