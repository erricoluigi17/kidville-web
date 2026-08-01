import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { BUCKET_TASK_ALLEGATI, TTL_FIRMA_ALLEGATI_S } from '@/lib/allegati/storage';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza; il contenuto non è materia di zod.
const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export const POST = withRoute('tasks/upload:POST', async (request: Request) => {
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
            .from(BUCKET_TASK_ALLEGATI)
            .upload(uniqueFileName, Buffer.from(fileBuffer), {
                contentType: file.type,
                upsert: true
            });

        if (error) {
            logErrore({ operazione: 'tasks/upload:POST', stato: 500, evento: 'storage' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Il caricamento riuscito lascia una riga, e la riga arriva in tabella (evento
        // `storage` in `EVENTI_PERSISTITI` dal 2026-08-01). Stessa ragione del gemello
        // `avvisi/upload`: col bucket ora privato, senza un successo persistito «nessun log di
        // upload» non distingue «nessuno ha caricato» da «gli upload non partono più».
        //
        // Solo metadati, mai il nome del file: `bucket` e `mime` sono in lista bianca, `byte`
        // è un numero. Il nome no — «relazione-<cognome>.pdf» è un dato personale.
        logEvento('storage', 'info', {
            operazione: 'tasks/upload:POST',
            esito: 'allegato-caricato',
            bucket: BUCKET_TASK_ALLEGATI,
            mime: file.type,
            byte: file.size,
        });

        // Link firmato per l'ANTEPRIMA immediata: il bucket è privato dal
        // 2026-07-31 e un indirizzo pubblico (`/object/public/…`) risponde 400.
        const { data: firmato, error: errFirma } = await supabase.storage
            .from(BUCKET_TASK_ALLEGATI)
            .createSignedUrl(uniqueFileName, TTL_FIRMA_ALLEGATI_S);
        if (errFirma) {
            // Il file È salvato: il caricamento non si butta via per un'anteprima.
            // Il perché del guasto sta nel corpo dell'errore del provider.
            logEvento('storage', 'error', {
                operazione: 'tasks/upload:POST',
                esito: 'anteprima-non-firmata',
                bucket: BUCKET_TASK_ALLEGATI,
            }, errFirma);
        }

        // `path`/`url` portano il PERCORSO: è quello che va archiviato nel payload
        // dell'incarico — un indirizzo firmato sarebbe morto alla prima riapertura.
        //
        // `fileUrl` porta invece il link FIRMATO, e non è un'incoerenza: è la
        // chiave che i componenti degli incarichi usano per MOSTRARE l'allegato
        // (`att.fileUrl || att.url` in `TaskCard` e `StudentDetailPanel`). Col
        // percorso lì dentro, l'allegato appena caricato apparirebbe rotto fino al
        // salvataggio. Quando il client rimanda l'oggetto, la scrittura riporta a
        // percorso TUTTE le chiavi d'indirizzo (`normalizzaAllegatiTask`): in
        // tabella non entra mai un token che scade.
        return NextResponse.json({
            path: uniqueFileName,
            url: uniqueFileName,
            fileUrl: firmato?.signedUrl ?? uniqueFileName,
            previewUrl: firmato?.signedUrl ?? null,
            name: file.name,
            size: file.size,
            type: file.type
        });
    } catch (error) {
        logErrore({ operazione: 'tasks/upload:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
