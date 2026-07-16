import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff';

const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export const POST = withRoute('gallery/upload:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const formData = await request.formData();
        const f = parseData(postFormSchema, { file: formData.get('file') });
        if ('response' in f) return f.response;
        const { file } = f.data;
        // Il path è namespaced sull'utente del gate, non su un campo client.
        const userId = auth.user.id;

        // Il tipo del File elaborato può portare un suffisso codec (es.
        // `video/webm;codecs=vp9`): si normalizza al solo tipo base.
        const contentType = (file.type || 'application/octet-stream').split(';')[0].trim();
        const fileBuffer = await file.arrayBuffer();

        // DIFESA IN PROFONDITÀ. Il client converte HEVC/.mov prima di caricare; ma un client
        // vecchio (o una POST diretta) potrebbe spedire comunque un video non riproducibile da
        // Chrome/Android. Lo stesso sniff del client, sui primi 64KB, lo RIFIUTA con 415.
        if (contentType.startsWith('video/')) {
            const testa = new Uint8Array(fileBuffer.slice(0, 65536));
            const analisi = analizzaContenutoVideo(testa, contentType);
            if (analisi.daConvertire) {
                // MAI il nome del file nei log: può contenere PII. Solo mime, size e motivo.
                logEvento('gallery', 'warn', {
                    operazione: 'gallery/upload:POST',
                    esito: 'video-non-riproducibile',
                    mime: contentType,
                    size: file.size,
                    motivo: analisi.motivo,
                });
                return NextResponse.json({ error: MESSAGGIO_VIDEO_NON_CONVERTIBILE }, { status: 415 });
            }
        }

        const supabase = await createAdminClient();

        // Assicurati che il bucket "gallery" esista e abbia il limite a 200MB
        try {
            const { data: buckets, error: listError } = await supabase.storage.listBuckets();
            if (listError) {
                // IL RAMO REALISTICO, ed era MUTO: `listBuckets` non lancia — ritorna
                // `{ error }` — quindi il catch qui sotto non scattava e questa guardia saltava
                // in silenzio l'intero blocco che ASSICURA il bucket. Il log stava nel posto
                // sbagliato: sull'eccezione che non arriva, invece che sull'errore che arriva.
                //
                // `warn` e non `error`: il blocco è idempotente e in esercizio il bucket esiste
                // già, quindi non aver potuto verificarlo quasi sempre non toglie nulla e
                // l'upload sotto riesce lo stesso (il risultato è salvo). Se invece il bucket
                // manca davvero, è l'upload a fallire — con il suo `error` e il suo 500.
                logEvento('storage', 'warn', {
                    operazione: 'gallery/upload:POST',
                    esito: 'bucket-non-verificato',
                    bucket: 'gallery',
                }, listError);
            } else {
                const exists = buckets?.some(b => b.name === 'gallery');
                if (!exists) {
                    await supabase.storage.createBucket('gallery', {
                        public: true,
                        allowedMimeTypes: [
                            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                            // niente QuickTime (.mov) né Matroska (.mkv): HEVC/.mov si convertono
                            // (o si rifiutano con 415), il bucket accetta solo formati riproducibili.
                            'video/mp4', 'video/webm'
                        ],
                        fileSizeLimit: 209715200 // 200MB
                    });
                } else {
                    await supabase.storage.updateBucket('gallery', {
                        public: true,
                        allowedMimeTypes: [
                            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                            // niente QuickTime (.mov) né Matroska (.mkv): HEVC/.mov si convertono
                            // (o si rifiutano con 415), il bucket accetta solo formati riproducibili.
                            'video/mp4', 'video/webm'
                        ],
                        fileSizeLimit: 209715200 // 200MB
                    });
                }
            }
        } catch (bucketErr) {
            // Resta a coprire il guasto di TRASPORTO (il fetch che esplode prima di arrivare
            // allo Storage). Stesso livello e stessa ragione della guardia qui sopra: il blocco
            // è idempotente, il risultato dell'upload è salvo.
            logEvento('storage', 'warn', {
                operazione: 'gallery/upload:POST',
                esito: 'bucket-non-verificato',
                bucket: 'gallery',
            }, bucketErr);
        }
        
        // Genera nome file unico
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;
        const filePath = `uploads/${userId}/${uniqueFileName}`;

        const { error } = await supabase.storage
            .from('gallery')
            .upload(filePath, Buffer.from(fileBuffer), {
                contentType,
                upsert: true
            });

        if (error) {
            logErrore({ operazione: 'gallery/upload:POST', stato: 500, evento: 'storage' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Ottieni URL pubblico
        const { data: publicUrlData } = supabase.storage
            .from('gallery')
            .getPublicUrl(filePath);

        return NextResponse.json({ fileUrl: publicUrlData.publicUrl });
    } catch (error) {
        logErrore({ operazione: 'gallery/upload:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
