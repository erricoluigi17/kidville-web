import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function POST(request: Request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        const userId = formData.get('userId') as string | null;

        if (!file) {
            return NextResponse.json({ error: 'Nessun file fornito' }, { status: 400 });
        }

        if (!userId) {
            return NextResponse.json({ error: 'userId è obbligatorio' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // Assicurati che il bucket "gallery" esista e abbia il limite a 200MB
        try {
            const { data: buckets, error: listError } = await supabase.storage.listBuckets();
            if (!listError) {
                const exists = buckets?.some(b => b.name === 'gallery');
                if (!exists) {
                    await supabase.storage.createBucket('gallery', {
                        public: true,
                        allowedMimeTypes: [
                            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                            'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'
                        ],
                        fileSizeLimit: 209715200 // 200MB
                    });
                } else {
                    await supabase.storage.updateBucket('gallery', {
                        public: true,
                        allowedMimeTypes: [
                            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                            'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'
                        ],
                        fileSizeLimit: 209715200 // 200MB
                    });
                }
            }
        } catch (bucketErr) {
            console.error('Errore durante la verifica/creazione/aggiornamento del bucket:', bucketErr);
        }
        
        // Genera nome file unico
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;
        const filePath = `uploads/${userId}/${uniqueFileName}`;

        const fileBuffer = await file.arrayBuffer();
        const { data, error } = await supabase.storage
            .from('gallery')
            .upload(filePath, Buffer.from(fileBuffer), {
                contentType: file.type,
                upsert: true
            });

        if (error) {
            console.error('Errore caricamento storage:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Ottieni URL pubblico
        const { data: publicUrlData } = supabase.storage
            .from('gallery')
            .getPublicUrl(filePath);

        return NextResponse.json({ fileUrl: publicUrlData.publicUrl });
    } catch (error) {
        console.error('Errore API gallery upload:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
