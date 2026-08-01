import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { BUCKET_AVVISI_ALLEGATI, TTL_FIRMA_ALLEGATI_S } from '@/lib/allegati/storage';

const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export const POST = withRoute('avvisi/upload:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const formData = await request.formData();
        const f = parseData(postFormSchema, { file: formData.get('file') });
        if ('response' in f) return f.response;
        const { file } = f.data;

        const supabase = await createAdminClient();

        // Genera nome file unico
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;

        const fileBuffer = await file.arrayBuffer();
        const { error } = await supabase.storage
            .from(BUCKET_AVVISI_ALLEGATI)
            .upload(uniqueFileName, Buffer.from(fileBuffer), {
                contentType: file.type,
                upsert: true
            });

        if (error) {
            logErrore({ operazione: 'avvisi/upload:POST', stato: 500, evento: 'storage' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // IL CARICAMENTO RIUSCITO LASCIA UNA RIGA, E LA RIGA ARRIVA IN TABELLA.
        //
        // Da quando il bucket è privato (2026-07-31) «l'allegato non si apre» è un guasto nuovo:
        // un TTL scaduto, una firma che fallisce, un percorso salvato male. Con i soli errori,
        // «nessun log di upload» non distingue «nessuno ha caricato niente» da «gli upload non
        // partono più» — la stessa ambiguità che ha tenuto invisibile per mesi il guasto delle
        // email di credenziali (AGENTS.md, regola 5).
        //
        // Si emette QUI e non dopo la firma: il successo è che il file è nel bucket. Se
        // l'anteprima poi non si firma, accanto compare la riga `error` — e le due insieme
        // raccontano il fatto giusto («c'è, ma non si vede»).
        //
        // Solo metadati. Il NOME del file non si logga: un allegato può chiamarsi
        // «certificato-<cognome>.pdf», e sarebbe un dato personale di un minore in un canale
        // che si legge tutti i giorni. `bucket` e `mime` sono in lista bianca, `byte` è un
        // numero: la riga resta leggibile anche in `app_log`.
        logEvento('storage', 'info', {
            operazione: 'avvisi/upload:POST',
            esito: 'allegato-caricato',
            bucket: BUCKET_AVVISI_ALLEGATI,
            mime: file.type,
            byte: file.size,
        });

        // Link firmato per l'ANTEPRIMA immediata: il bucket è privato dal
        // 2026-07-31, quindi un indirizzo pubblico (`/object/public/…`) ora
        // risponde 400 — un allegato "caricato" che non si apre.
        const { data: firmato, error: errFirma } = await supabase.storage
            .from(BUCKET_AVVISI_ALLEGATI)
            .createSignedUrl(uniqueFileName, TTL_FIRMA_ALLEGATI_S);
        if (errFirma) {
            // Il file È salvato: non si butta via un caricamento per un'anteprima.
            // Ma il guasto va detto, COL CORPO dell'errore del provider (AGENTS §3):
            // senza, resterebbe solo un riquadro vuoto senza spiegazione.
            logEvento('storage', 'error', {
                operazione: 'avvisi/upload:POST',
                esito: 'anteprima-non-firmata',
                bucket: BUCKET_AVVISI_ALLEGATI,
            }, errFirma);
        }

        // `path` è ciò che va ARCHIVIATO in `avvisi.attachment_url`: un indirizzo
        // firmato, fra dieci minuti, non aprirebbe più niente.
        //
        // `fileUrl` resta col nome di prima per i client già in circolazione (il
        // modulo di pubblicazione legge quel campo e lo rigira come allegato): ora
        // contiene il PERCORSO, così anche loro salvano il dato giusto.
        return NextResponse.json({
            path: uniqueFileName,
            fileUrl: uniqueFileName,
            previewUrl: firmato?.signedUrl ?? null,
        });
    } catch (error) {
        logErrore({ operazione: 'avvisi/upload:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
