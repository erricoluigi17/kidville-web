import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST() {
    try {
        const tablesToClear = [
            'student_parents', 'legame_genitori_alunni', 'student_adults', 
            'delegates', 'delegati', 'student_documents', 'educator_sections',
            'eventi_diario', 'valutazioni', 'galleria_media', 'armadietto',
            'locker_inventory', 'locker_requests', 'locker_loads',
            'ticket_mensa', 'pagamenti', 'registro_modifiche', 'firme_documenti',
            'daily_routines', 'presenze', 'firme_docenti', 'registro_orario', 'note_disciplinari'
        ];

        for (const table of tablesToClear) {
            try {
                await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
                await supabase.from(table).delete().not('created_at', 'is', null);
            } catch (e) {}
        }

        await supabase.from('alunni').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('parents').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('adults').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        return NextResponse.json({ success: true, message: 'Wipe completed' });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
