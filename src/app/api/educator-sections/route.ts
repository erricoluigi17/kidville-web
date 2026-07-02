import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';

// Educator section mapping - in production this would come from a DB table
// For now we derive it from the alunni table using the educator's uploaded media
// or fall back to a known mapping based on which alunni have section_id assigned
async function getEducatorSectionNames(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    userId: string
): Promise<string[]> {
    // Method 0 (canonico): legame docente↔sezione in utenti_sezioni → sections.name.
    const { data: legamiSez } = await supabase
        .from('utenti_sezioni')
        .select('sections(name)')
        .eq('utente_id', userId);
    const canonicalNames = [...new Set(
        (legamiSez ?? []).flatMap((r: { sections: { name?: string }[] | { name?: string } | null }) => {
            const s = r.sections;
            if (!s) return [];
            return (Array.isArray(s) ? s : [s]).map(x => x.name);
        }).filter(Boolean) as string[]
    )];
    if (canonicalNames.length > 0) return canonicalNames;

    // Method 1: Check if the educator has any media uploads with tagged students
    // → derive their section from those students' classe_sezione
    const { data: myMedia } = await supabase
        .from('galleria_media_v2')
        .select('tag_students')
        .eq('uploaded_by', userId)
        .not('tag_students', 'is', null);

    const myTaggedIds = (myMedia ?? [])
        .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
        .filter(Boolean);

    if (myTaggedIds.length > 0) {
        const { data: students } = await supabase
            .from('alunni')
            .select('classe_sezione')
            .in('id', myTaggedIds);

        const classNames = [...new Set(
            (students ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
        )];

        if (classNames.length > 0) {
            return classNames;
        }
    }

    // Method 2: Check diary entries from this educator (eventi_diario)
    const { data: diaryEvents } = await supabase
        .from('eventi_diario')
        .select('sezione')
        .eq('teacher_id', userId)
        .limit(10);

    if (diaryEvents && diaryEvents.length > 0) {
        const sectionNames = [...new Set(
            diaryEvents.map((e: { sezione: string }) => e.sezione).filter(Boolean)
        )];
        if (sectionNames.length > 0) return sectionNames;
    }

    // Method 3: Use email to determine section (Anna → Girasoli, Chiara → Tulipani)
    const { data: utente } = await supabase
        .from('utenti')
        .select('email')
        .eq('id', userId)
        .maybeSingle();

    // Known educator mappings
    const emailToSection: Record<string, string> = {
        'maestra.anna@kidville.it': 'Girasoli',
        'maestra.chiara@kidville.it': 'Tulipani',
    };

    if (utente?.email && emailToSection[utente.email]) {
        return [emailToSection[utente.email]];
    }

    return [];
}

// GET /api/educator-sections[?userId=xxx]
// Returns the section names that the authenticated educator is assigned to.
// `?userId=` (sezioni di un ALTRO utente) è onorato solo per admin/coordinator;
// per tutti gli altri l'identità è quella della sessione.
export async function GET(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const { searchParams } = new URL(request.url);
        const requestedId = searchParams.get('userId');
        const canQueryOthers = auth.user.role === 'admin' || auth.user.role === 'coordinator';
        const userId = canQueryOthers && requestedId ? requestedId : auth.user.id;

        const supabase = await createAdminClient();

        // Get role from utenti
        const { data: utente } = await supabase
            .from('utenti')
            .select('ruolo, role')
            .eq('id', userId)
            .maybeSingle();

        const rawRole = utente?.ruolo || '';

        // Normalize role
        let normalizedRole = 'educator';
        if (rawRole === 'admin') normalizedRole = 'admin';
        else if (rawRole === 'coordinator' || rawRole === 'coordinatore') normalizedRole = 'coordinator';
        else if (['maestra', 'insegnante', 'educator'].includes(rawRole)) normalizedRole = 'educator';

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

        // Educators: derive their sections dynamically
        const sectionNames = await getEducatorSectionNames(supabase, userId);

        return NextResponse.json({
            sectionNames,
            role: 'educator'
        });

    } catch (error) {
        console.error('Errore GET /api/educator-sections:', error);
        return NextResponse.json({ sectionNames: [], role: 'educator' });
    }
}
