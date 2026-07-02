import { NextResponse } from 'next/server';
import { sealDangerous } from '@/lib/security/seal';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: Request) {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data, error } = await supabase.from('alunni').select(`
        id, cognome, nome,
        student_parents (
            parent_id,
            relation_type,
            parents (*)
        )
    `).eq('id', '553309b3-22db-4ddc-98fb-d1dbfdd841ba');
    return NextResponse.json({ data, error });
}
