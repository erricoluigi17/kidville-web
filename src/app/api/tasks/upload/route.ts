import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function POST(request: Request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'Nessun file fornito' }, { status: 400 });
        }

        const supabase = await createAdminClient();
        
        // Generate a unique file name
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;

        const fileBuffer = await file.arrayBuffer();
        const { data, error } = await supabase.storage
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
