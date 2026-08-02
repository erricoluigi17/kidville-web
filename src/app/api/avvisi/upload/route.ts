import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseData, parseMultipart } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { BUCKET_AVVISI_ALLEGATI, TTL_FIRMA_ALLEGATI_S } from '@/lib/allegati/storage';
import { verificaAllegato } from '@/lib/allegati/mime';
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte';
import { firmaRimozioneAllegato } from '@/lib/allegati/sigillo';

const postFormSchema = z.object({
    file: z.instanceof(File, { error: 'Nessun file fornito' }),
});

export const POST = withRoute('avvisi/upload:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        // Content-Type sbagliato = errore del CLIENT: 400, non 500 (collaudo 2026-08-02, F2).
        // `request.formData()` LANCIA, e finiva nel `catch` qui sotto: una richiesta
        // malformata lasciava una riga `error` in `app_log`, cioè rumore nel canale in cui
        // si cercano i guasti veri.
        const formData = await parseMultipart(request);
        if ('response' in formData) return formData.response;
        const f = parseData(postFormSchema, { file: formData.data.get('file') });
        if ('response' in f) return f.response;
        const { file } = f.data;

        // IL TIPO DICHIARATO DAL CLIENT NON È UNA PROVA (collaudo 2026-07-31, W7).
        // Il gate sta QUI, prima dello Storage: senza, un `.txt` arrivava fino al bucket e
        // tornava indietro come `500 {"error":"mime type text/plain is not supported"}` — il
        // testo grezzo del provider, dove serviva un 415 comprensibile. È lo stesso gate di
        // `news/upload:POST`, in un modulo solo: due liste di tipi ammessi divergono.
        const gate = verificaAllegato(file, {
            operazione: 'avvisi/upload:POST',
            bucket: BUCKET_AVVISI_ALLEGATI,
        });
        if (!gate.ok) return gate.risposta;

        const supabase = await createAdminClient();

        // Genera nome file unico
        const fileExtension = file.name.split('.').pop() || '';
        const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${fileExtension}`;

        const fileBuffer = await file.arrayBuffer();
        const { error } = await supabase.storage
            .from(BUCKET_AVVISI_ALLEGATI)
            .upload(uniqueFileName, Buffer.from(fileBuffer), {
                // Il tipo NORMALIZZATO (`image/jpeg`, non `image/jpeg; charset=binary`): con
                // il suffisso dei parametri il bucket rifiuterebbe la stringa intera.
                contentType: gate.contentType,
                upsert: true
            });

        if (error) {
            // Il messaggio del fornitore resta QUI e non esce (S31): fino al 2026-08-01 la
            // riga sotto era `{ error: error.message }`, e in segreteria arrivava
            // «mime type text/plain is not supported». Al client un codice traducibile, al
            // log il corpo intero — che è l'unico posto in cui quel testo può esistere.
            logErrore({ operazione: 'avvisi/upload:POST', stato: 500, evento: 'storage' }, error);
            return rispostaAllegatoNonCaricato();
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
            mime: gate.contentType,
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
        // `sigillo` è la PROVA, per la rimozione, che questo file l'ha caricato QUESTO
        // utente adesso (S35): senza, `avvisi/upload/rimuovi` sarebbe il modo di cancellare
        // l'allegato dell'avviso di un altro, il cui percorso si legge dal link firmato che
        // la bacheca restituisce. `null` quando manca il segreto: in quel caso la rimozione
        // non si offre, invece di offrirla con una firma che non protegge niente.
        return NextResponse.json({
            path: uniqueFileName,
            fileUrl: uniqueFileName,
            previewUrl: firmato?.signedUrl ?? null,
            sigillo: firmaRimozioneAllegato({
                bucket: BUCKET_AVVISI_ALLEGATI,
                percorso: uniqueFileName,
                utenteId: auth.user.id,
            }),
        });
    } catch (error) {
        // `withRoute` non vede le eccezioni CATTURATE: il log lo fa questo ramo, di suo.
        // La risposta è la stessa del guasto dello Storage — dal punto di vista di chi
        // carica è lo stesso fatto («il file non è stato caricato»), e «Internal Server
        // Error» non è una frase che si mostra a una segretaria.
        logErrore({ operazione: 'avvisi/upload:POST', stato: 500 }, error);
        return rispostaAllegatoNonCaricato();
    }
});
