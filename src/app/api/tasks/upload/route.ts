import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza; il contenuto non è materia di zod.
const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export async function POST(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const formData = await request.formData();
        const parsed = parseData(postFormSchema, { file: formData.get('file') });
        if ('response' in parsed) return parsed.response;
        const { file } = parsed.data;

        const supabase = await createAdminClient();

        // Generate a unique file name
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;

        const fileBuffer = await file.arrayBuffer();
        const { error } = await supabase.storage
            .from('task_allegati')
            .upload(uniqueFileName, Buffer.from(fileBuffer), {
                contentType: file.type,
                upsert: true
            });

        if (error) {
            console.error('Errore caricamento storage:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Get public URL
        const { data: publicUrlData } = supabase.storage
            .from('task_allegati')
            .getPublicUrl(uniqueFileName);

        return NextResponse.json({
            fileUrl: publicUrlData.publicUrl,
            name: file.name,
            size: file.size,
            type: file.type
        });
    } catch (error) {
        console.error('Errore API upload:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
