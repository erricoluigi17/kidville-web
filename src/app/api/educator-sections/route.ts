import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

// Uuid opzionale da query string: stringa vuota trattata come assente
// (preserva il check truthy `requestedId ?` pre-esistente su `?userId=`).
const zUuidQueryOpzionale = z.preprocess(
    (v) => (v === '' ? undefined : v),
    zUuid.optional()
);

const getQuerySchema = z.object({
    userId: zUuidQueryOpzionale,
});

// Sezioni del docente: fonte canonica utenti_sezioni → sections.name (Method 0);
// in mancanza di legami restano due euristiche legacy (media taggati, eventi
// diario). Nessuna mappa hardcoded: senza riscontri → [].
async function getEducatorSectionNames(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    userId: string
): Promise<string[]> {
    // Method 0 (canonico): legame docente↔sezione in utenti_sezioni → sections.name.
    const canonicalNames = await nomiSezioniDiUtente(supabase, userId);
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

    // Nessun legame né derivazione: nessuna sezione (il chiamante degrada a vuoto).
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

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const requestedId = q.data.userId;
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
                .select('name, school_type')
                .order('name');
            // `sections[].school_type` è additivo: `sectionNames` resta invariato
            // per i consumer esistenti; il nuovo campo serve a /teacher/diary per
            // filtrare le sezioni primaria in base a diario_primaria_visibile.
            return NextResponse.json({
                sectionNames: sections?.map((s: { name: string }) => s.name) || [],
                sections: (sections ?? []).map((s: { name: string; school_type: string | null }) => ({ name: s.name, school_type: s.school_type })),
                role: normalizedRole
            });
        }

        // Educators: derive their sections dynamically
        const sectionNames = await getEducatorSectionNames(supabase, userId);

        // Arricchimento school_type per nome (i 4 metodi di derivazione producono
        // solo nomi): un'unica query risolve il grado di ogni sezione.
        let schoolTypeByName = new Map<string, string | null>();
        if (sectionNames.length > 0) {
            const { data: gradi } = await supabase
                .from('sections')
                .select('name, school_type')
                .in('name', sectionNames);
            schoolTypeByName = new Map((gradi ?? []).map((s: { name: string; school_type: string | null }) => [s.name, s.school_type]));
        }

        return NextResponse.json({
            sectionNames,
            sections: sectionNames.map((n) => ({ name: n, school_type: schoolTypeByName.get(n) ?? null })),
            role: 'educator'
        });

    } catch (error) {
        console.error('Errore GET /api/educator-sections:', error);
        return NextResponse.json({ sectionNames: [], role: 'educator' });
    }
}
