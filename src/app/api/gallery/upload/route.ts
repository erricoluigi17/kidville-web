import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData, parseMultipart } from '@/lib/validation/http';
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { eVideoLegacy, rifiutoLegacyVideo } from '@/lib/media/blocco-legacy-video';
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

        // ── IL PERCORSO VECCHIO DEI VIDEO È CHIUSO, e si chiude qui ───────────────
        // Questa è LA porta delle shell native col bundle in cache: il telefono
        // comprimeva il filmato da sé e lo spediva come un file qualunque. Con la
        // pipeline nuova viva quel file non lo convertirebbe nessuno — resterebbe in
        // archivio come un video che la maestra crede caricato e che nessun genitore
        // vedrà mai. Il rifiuto arriva PRIMA di `arrayBuffer()`: non ha senso tirarsi
        // in memoria quaranta megabyte per poi buttarli.
        //
        // OGNI `video/*`, senza condizioni e senza guardare i byte: un H.264 e un HEVC
        // ricevono lo stesso 409, perché i video passano solo da `POST /api/video-uploads`
        // (decisione e motivi in `src/lib/media/blocco-legacy-video.ts`, che non ha
        // interruttori). Le immagini non passano di qui: `eVideoLegacy` guarda il mime.
        if (eVideoLegacy(contentType)) {
            return rifiutoLegacyVideo('galleria', 'gallery/upload:POST', contentType, file.size);
        }

        const fileBuffer = await file.arrayBuffer();

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
                // `@/lib/gallery/storage`).
                //
                // ⚠️ QUESTO BLOCCO È UNA RETE DI SICUREZZA, NON CONFIGURAZIONE.
                // La configurazione del bucket si dichiara in migrazione
                // (`20260901…_bucket_gallery_privato_50mb.sql`) e la verifica il lock
                // `__tests__/architecture/bucket-storage-dichiarati.test.ts`. Qui NON
                // si riscrive a ogni foto: si guarda, e si scrive solo se c'è da
                // riparare.
                //
                // IL DIFETTO CHE HA PORTATO A QUESTA FORMA, misurato il 2026-09-01.
                // Fino a quel giorno questo blocco spediva `public: false` insieme a
                // `fileSizeLimit: 209715200` (200 MB), sopra il TETTO GLOBALE di upload
                // del progetto (50 MB, e deve restare tale). Supabase valuta quel campo
                // PRIMA di applicare qualunque altro e rifiuta l'INTERA chiamata con
                // 400 `EntityTooLarge`: nessun campo veniva scritto, `public` compreso.
                // Risultato: la richiusura automatica non è mai avvenuta — nemmeno una
                // volta dal 26/05/2026 — e ogni caricamento riuscito lasciava due righe
                // `error` nei log (62 il 01/09, su 31 foto tutte salvate).
                // La lezione, cablata nel test «la richiusura NON può essere vetata da
                // un altro campo»: si spedisce SOLO ciò che si sta riparando.
                const info = buckets?.find(b => b.name === BUCKET_GALLERIA);
                if (!info) {
                    // Ambiente nuovo (o DB non migrato): il bucket nasce qui, già chiuso.
                    // Il limite dichiarato sta SOTTO il tetto globale, altrimenti anche
                    // la creazione verrebbe respinta e il bucket non esisterebbe affatto.
                    const esitoCreazione = await supabase.storage.createBucket(BUCKET_GALLERIA, {
                        public: false,
                        // SOLO formati che si aprono sia su Android sia su iOS (decisione
                        // del 2026-09-01). In galleria finiscono foto e video dei bambini:
                        // un formato che si vede da una parte sola è metà dei genitori
                        // davanti a un riquadro nero.
                        //  · niente QuickTime (.mov) né Matroska (.mkv): Android non li
                        //    riproduce. Da questa porta i video non entrano più (409 qui
                        //    sopra) e quelli che il server pubblica escono dalla pipeline
                        //    sempre in mp4 H.264: l'elenco resta comunque l'ultima rete,
                        //    che vale anche per chi scrive con la chiave di servizio;
                        //  · niente `image/gif`: il client ridisegna OGNI immagine su
                        //    canvas e la riesporta in JPEG, quindi una GIF al bucket non
                        //    arriva. Elencarla descriveva una cosa che non accade;
                        //  · niente `image/jpg`: non è un tipo MIME, nessun browser lo manda.
                        allowedMimeTypes: [
                            'image/jpeg', 'image/png', 'image/webp',
                            'video/mp4', 'video/webm'
                        ],
                        // IL TETTO DEL BUCKET, che dal 2026-09-18 NON è più il tetto
                        // di ciò che passa da questa porta. Sono due numeri diversi e
                        // dicono due cose diverse:
                        //  · 2.000.000.000 è quanto l'OGGETTO può pesare, ed esiste
                        //    per il video convertito che la pubblicazione lato server
                        //    copia dentro con la chiave di servizio — mai un browser;
                        //  · i 50 MiB di `TETTO_GALLERIA_BYTE` restano il tetto di ciò
                        //    che il BROWSER spedisce da sé (le foto), e vivono nello
                        //    `z.max()` di `gallery/upload-url` e nel confronto di
                        //    `caricaMediaGalleria`.
                        // Questo numero deve coincidere con quello della migrazione
                        // `20260918104500_bucket_gallery_tetto_video.sql`: è la ricetta
                        // con cui il bucket NASCEREBBE in un ambiente nuovo, e se
                        // dicesse meno quell'ambiente partirebbe quaranta volte più
                        // stretto della produzione — con la pipeline video morta dentro
                        // e nessuno a dirlo. Lo verifica `bucket-storage-dichiarati`.
                        fileSizeLimit: 2000000000
                    });
                    logEvento('storage', esitoCreazione.error ? 'error' : 'info', {
                        operazione: 'gallery/upload:POST',
                        esito: esitoCreazione.error ? 'bucket-non-creato' : 'bucket-creato',
                        bucket: BUCKET_GALLERIA,
                    }, esitoCreazione.error ?? undefined);
                } else if (info.public === true) {
                    // Trovarlo APERTO è un incidente, non una nota: finché è rimasto
                    // così, ogni foto di bambino era scaricabile da chiunque avesse
                    // l'indirizzo. Si logga PRIMA di richiuderlo, altrimenti la
                    // riparazione cancellerebbe la traccia del guasto.
                    logEvento('storage', 'error', {
                        operazione: 'gallery/upload:POST',
                        esito: 'bucket-pubblico',
                        bucket: BUCKET_GALLERIA,
                    });
                    // SOLO `public`. Niente `fileSizeLimit`, niente `allowedMimeTypes`:
                    // il primo farebbe rifiutare la chiamata (vedi sopra), il secondo
                    // applicherebbe di soppiatto una divergenza che è una decisione di
                    // prodotto aperta e non presa (il lock la descrive per esteso).
                    // `updateBucket` NON lancia: ritorna `{ error }`, e il fallimento di
                    // una richiusura è esattamente ciò che non possiamo non sapere.
                    const esitoChiusura = await supabase.storage.updateBucket(BUCKET_GALLERIA, {
                        public: false,
                    });
                    logEvento('storage', esitoChiusura.error ? 'error' : 'warn', {
                        operazione: 'gallery/upload:POST',
                        esito: esitoChiusura.error ? 'bucket-non-richiuso' : 'bucket-richiuso',
                        bucket: BUCKET_GALLERIA,
                    }, esitoChiusura.error ?? undefined);
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
