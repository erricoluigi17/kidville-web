import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData, parseMultipart } from '@/lib/validation/http';
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff';
import { BUCKET_GALLERIA, TTL_FIRMA_GALLERIA_S } from '@/lib/gallery/storage';

const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export const POST = withRoute('gallery/upload:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        // Content-Type sbagliato = errore del CLIENT: 400, non 500 (collaudo 2026-08-02, F2).
        const formData = await parseMultipart(request);
        if ('response' in formData) return formData.response;
        const f = parseData(postFormSchema, { file: formData.data.get('file') });
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
                logEvento('galleria', 'warn', {
                    operazione: 'gallery/upload:POST',
                    esito: 'video-non-riproducibile',
                    mime: contentType,
                    size: file.size,
                    motivo: analisi.motivo,
                });
                // `codice` accanto alla prosa: quel testo nasce in una libreria condivisa
                // client+server, dove il locale non esiste, ed è quindi italiano. Il codice
                // lo fa tradurre a chi la lingua ce l'ha (`src/lib/ui/esito-fetch.ts`).
                return NextResponse.json(
                    { error: MESSAGGIO_VIDEO_NON_CONVERTIBILE, codice: 'VIDEO_NON_CONVERTIBILE' },
                    { status: 415 }
                );
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
                // Bucket PRIVATO (2026-07-31). Era `public: true`, e ogni foto di
                // un bambino era leggibile da CHIUNQUE avesse (o indovinasse)
                // l'indirizzo del file: senza login, senza scadenza, fuori dal
                // gate di ruolo, dall'isolamento per sede e dalla regola «foto
                // privata», che vivevano tutti sul database e mai sul file.
                // Da qui in poi si serve un link firmato a tempo (vedi
                // `@/lib/gallery/storage`), e questo blocco deve RIMETTERE il
                // bucket privato a ogni upload: se una mano lo riaprisse dalla
                // console, il primo caricamento lo richiuderebbe.
                const opzioniBucket = {
                    public: false,
                    allowedMimeTypes: [
                        'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                        // niente QuickTime (.mov) né Matroska (.mkv): HEVC/.mov si convertono
                        // (o si rifiutano con 415), il bucket accetta solo formati riproducibili.
                        'video/mp4', 'video/webm'
                    ],
                    fileSizeLimit: 209715200 // 200MB
                };
                const info = buckets?.find(b => b.name === BUCKET_GALLERIA);
                // Trovarlo APERTO è un incidente, non una nota: finché è rimasto
                // così, ogni foto di bambino era scaricabile da chiunque avesse
                // l'indirizzo. Si logga PRIMA di richiuderlo, altrimenti la
                // riparazione cancellerebbe la traccia del guasto.
                if (info?.public === true) {
                    logEvento('storage', 'error', {
                        operazione: 'gallery/upload:POST',
                        esito: 'bucket-pubblico',
                        bucket: BUCKET_GALLERIA,
                    });
                }
                // ⚠️ Anche queste NON lanciano: ritornano `{ error }`. Senza
                // guardare il valore di ritorno, «il bucket lo rimettiamo
                // privato a ogni upload» sarebbe una promessa non verificata —
                // e il fallimento della richiusura è esattamente ciò che non
                // possiamo permetterci di non sapere.
                const esitoBucket = info
                    ? await supabase.storage.updateBucket(BUCKET_GALLERIA, opzioniBucket)
                    : await supabase.storage.createBucket(BUCKET_GALLERIA, opzioniBucket);
                if (esitoBucket.error) {
                    logEvento('storage', 'error', {
                        operazione: 'gallery/upload:POST',
                        esito: 'bucket-non-riconfigurato',
                        bucket: BUCKET_GALLERIA,
                    }, esitoBucket.error);
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
            .from(BUCKET_GALLERIA)
            .upload(filePath, Buffer.from(fileBuffer), {
                contentType,
                upsert: true
            });

        if (error) {
            logErrore({ operazione: 'gallery/upload:POST', stato: 500, evento: 'storage' }, error);
            // Il corpo dell'errore del fornitore resta nel LOG e non torna al client (S31,
            // AGENTS §3): «mime type … is not supported» non è una frase da mostrare a
            // un'insegnante, e porta fuori il nome del bucket e dei suoi vincoli.
            return rispostaAllegatoNonCaricato();
        }

        // Link firmato per l'ANTEPRIMA immediata: il bucket è privato, quindi
        // `getPublicUrl` produrrebbe un indirizzo che risponde 400.
        const { data: firmato, error: errFirma } = await supabase.storage
            .from(BUCKET_GALLERIA)
            .createSignedUrl(filePath, TTL_FIRMA_GALLERIA_S);
        if (errFirma) {
            // Il file È salvato: non si butta via un caricamento (foto di una
            // giornata che non torna) per un'anteprima. Ma il guasto va detto,
            // COL CORPO dell'errore del provider: senza, resterebbe solo
            // un'anteprima vuota senza spiegazione.
            logEvento('storage', 'error', {
                operazione: 'gallery/upload:POST',
                esito: 'anteprima-non-firmata',
                bucket: BUCKET_GALLERIA,
            }, errFirma);
        }

        // `path` è ciò che il client deve RIMANDARE a POST /api/gallery: in
        // tabella si archivia il percorso, non un indirizzo firmato che fra
        // dieci minuti non apre più niente.
        //
        // `fileUrl` resta per i client vecchi (e per i telefoni con il bundle in
        // cache), che leggono quel nome e lo rigirano come `file_url`: ora
        // contiene il PERCORSO, così anche loro salvano il dato giusto.
        return NextResponse.json({
            path: filePath,
            fileUrl: filePath,
            previewUrl: firmato?.signedUrl ?? null,
        });
    } catch (error) {
        logErrore({ operazione: 'gallery/upload:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
