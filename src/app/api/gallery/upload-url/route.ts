import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { rateLimit } from '@/lib/security/rate-limit';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { eVideoLegacy, rifiutoLegacyVideo } from '@/lib/media/blocco-legacy-video';
import { BUCKET_GALLERIA, MIME_GALLERIA, TETTO_GALLERIA_BYTE, estensioneDaMime, mimeBase } from '@/lib/gallery/limiti';
import { percorsoUploadProprio } from '@/lib/gallery/pubblicazione-foto';

// =============================================================================
// GALLERIA · URL FIRMATO — il file va dal telefono allo Storage, senza passare di qui.
//
// ─── IL DIFETTO, MISURATO IN PRODUZIONE ──────────────────────────────────────
// `app_log` del 2026-09-07: `POST /api/gallery/upload → 413`, SEI volte in un giorno,
// tutte da `/teacher/gallery`. L'unico video passato quel giorno pesava 4.484.198 byte
// — dodici kilobyte sotto il tetto di ~4,5 MB che Vercel impone al corpo di una
// funzione — e il tentativo di quaranta secondi dopo ha preso 413.
//
// Il bucket era innocente (50 MB, `video/mp4` e `video/webm` ammessi): la strozzatura
// stava fra un client che prometteva 50 MB e una piattaforma che ne accetta 4,5, e
// nessuno dei due lo sapeva. Il 413 lo scrive l'infrastruttura PRIMA che la funzione
// parta, con un corpo `text/plain`: nei log del server non restava niente, e
// all'insegnante usciva «Errore durante il caricamento del file».
//
// Il repo aveva imparato questo guasto il 31/07 (`@/lib/upload/limite-piattaforma`) e
// l'aveva applicato a otto percorsi di upload — lasciando fuori proprio l'unico che
// carica video. Qui si adotta lo schema già in esercizio per Protocolli e Cassa: il
// client chiede una firma, poi fa `PUT` del file direttamente sullo Storage. Il tetto
// torna a essere quello vero del bucket, 50 MB.
//
// ─── ORA DI QUI PASSANO SOLO LE FOTO ─────────────────────────────────────────
// Il difetto di partenza erano i video, e dal 2026-10-02 i video di qui non passano
// più: ogni `video/*` riceve un 409 `VIDEO_APP_DA_AGGIORNARE` (decisione in
// `@/lib/media/blocco-legacy-video`, senza interruttori) e va caricato dalla pipeline
// nuova, `POST /api/video-uploads`. Un file firmato qui resterebbe in archivio senza
// che nessuno lo converta né lo pubblichi.
//
// I TIPI VIDEO RESTANO NELLO `z.enum`, ed è voluto: un client vecchio che manda
// `video/mp4` deve ricevere il 409 che gli dice di aggiornarsi, non un 400 «formato non
// ammesso» che lo manderebbe a riprovare per sempre — il difetto del 2026-09-08 rifatto
// al contrario. Per lo stesso motivo non c'è più lo sniff del codec sui primi 64 KB
// (`testa_b64`): fermava un HEVC prima che partisse la `PUT`, e ora non c'è nessuna
// `PUT` di video da proteggere. Un `testa_b64` mandato da un client vecchio è un campo
// in più, che lo schema scarta in silenzio.
//
// ⚠️ `/api/gallery/upload` RESTA VIVA: è la porta delle shell native col bundle in
// cache, che continueranno a mandare multipart per settimane, e il lock
// `bucket-storage-dichiarati` legge da quel file la configurazione del bucket. Rifiuta
// i video con lo stesso 409, dallo stesso modulo.
// =============================================================================

const postBodySchema = z.object({
    // La stessa lista del bucket. Un mime fuori elenco qui è un 400: firmare un
    // caricamento che lo Storage poi rifiuta sposta solo il guasto più in là.
    // I tipi video ci restano di proposito: un client vecchio deve ricevere il 409 del
    // blocco (più sotto), non un 400 che non gli dice cosa fare.
    //
    // ⚠️ IL `preprocess` NON È COSMESI, è il difetto del 2026-09-08. `z.enum` confronta
    // per UGUAGLIANZA, e il client non manda `video/mp4`: manda `video/mp4;codecs=avc1`,
    // perché è ciò che `MediaRecorder` scrive nel file convertito. Risultato: 33 caricamenti
    // respinti in un giorno, 8 insegnanti, 3 sedi, e nel bucket nessun video nuovo mentre le
    // foto continuavano a passare di qui (`processImageWithWatermark` consegna un
    // `image/jpeg` pulito). Le due porte gemelle normalizzavano già — `gallery/upload:32`,
    // `news/upload:55` — questa era l'unica che non lo faceva.
    //
    // È la RETE, non il rimedio: l'header `content-type` della `PUT` lo scrive il client e
    // questa route non lo tocca, quindi un bundle vecchio in cache si salva solo con la
    // normalizzazione in `@/lib/gallery/carica-media`. Vale comunque, perché una porta non
    // deve pretendere che il chiamante sia aggiornato.
    //
    // `preprocess` e non un controllo a mano: il narrowing di `z.enum` sopravvive, e
    // soprattutto `parseBody` deposita il corpo GREZZO nel contesto PRIMA di validare —
    // quindi in `app_log` si continua a leggere ciò che il client ha spedito davvero, che
    // è esattamente come questo guasto è stato diagnosticato.
    mime: z.preprocess(
        (v) => (typeof v === 'string' ? mimeBase(v) : v),
        z.enum(MIME_GALLERIA, { error: 'Formato non ammesso' }),
    ),
    size: z.coerce.number().int().min(1).max(TETTO_GALLERIA_BYTE, 'File troppo grande'),
    resume_path: z.string().min(1).max(300).optional(),
    // NESSUN `nome`, ed è una deviazione deliberata dai due modelli (Protocolli e
    // Cassa lo accettano). Un file di galleria si chiama `IMG_bambina-rossi.mov`: è
    // anagrafica di un minore, e finirebbe nella chiave dell'oggetto — quindi in
    // `app_log` ogni volta che qualcosa logga un percorso. L'estensione si deriva dal
    // mime VALIDATO, che è l'unica cosa che serviva davvero da quel nome.
});

export const POST = withRoute('gallery/upload-url:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { mime, size, resume_path } = b.data;

        // ── IL PERCORSO VECCHIO DEI VIDEO È CHIUSO, e si chiude qui ────────────────
        // Di qui passavano il browser dell'insegnante e la coda offline Dexie
        // (`syncPendingGalleryMedia` → `caricaMediaGalleria`): il filmato era già stato
        // compresso dal client e questa route si limitava a firmare la `PUT`. Con la
        // pipeline nuova viva, un file firmato così resterebbe in archivio senza che
        // nessuno lo converta. Il rifiuto arriva PRIMA della firma — firmare e poi
        // pentirsi vorrebbe dire lasciare una `PUT` autorizzata in mano al client — e
        // PRIMA del contatore, perché un rifiuto non deve consumare una delle 30 firme
        // di una persona. Sta anche prima del controllo di `resume_path`: la ripresa è
        // solo per le foto, ma a un video con un `resume_path` di troppo va detto lo
        // stesso «aggiorna l'app», non un 400 sul percorso.
        //
        // OGNI `video/*`, senza condizioni e senza guardare i byte (nessuna testa del
        // file, nessuno sniff): un H.264 e un HEVC ricevono lo stesso 409. L'unica
        // decisione e i suoi motivi stanno in `@/lib/media/blocco-legacy-video`, che non
        // ha interruttori. Le immagini non passano di qui: `eVideoLegacy` guarda il mime.
        // Un `video/quicktime` non arriva a questo punto: non è nello `z.enum` e prende
        // il 400 di sempre.
        if (eVideoLegacy(mime)) {
            return rifiutoLegacyVideo('galleria', 'gallery/upload-url:POST', mime, size);
        }

        if (resume_path && (!mime.startsWith('image/') || !percorsoUploadProprio(resume_path, auth.user.id))) {
            logEvento('galleria', 'warn', { operazione: 'gallery/upload-url:POST', esito: 'ripresa-percorso-invalido' });
            return NextResponse.json({ error: 'Percorso del caricamento non valido.', codice: 'ALLEGATO_NON_VALIDO' }, { status: 400 });
        }

        const supabase = await createAdminClient();
        if (resume_path) {
            // La PUT può aver fatto commit anche se il telefono non ha ricevuto la
            // risposta. Il prefisso è già verificato contro l'identità del gate.
            const { data: oggetto, error: errInfo } = await supabase.storage.from(BUCKET_GALLERIA).info(resume_path);
            const assente = String((errInfo as { statusCode?: string; status?: number } | null)?.statusCode ?? errInfo?.status) === '404';
            if (errInfo && !assente) {
                logErrore({ operazione: 'gallery/upload-url:POST', stato: 500, evento: 'storage' }, errInfo);
                return NextResponse.json({ error: 'Verifica del caricamento non riuscita. Riprova.', codice: 'ALLEGATO_NON_CARICATO' }, { status: 500 });
            }
            if (oggetto) {
                if (oggetto.size !== size || mimeBase(oggetto.contentType ?? '') !== mime) {
                    logEvento('galleria', 'warn', { operazione: 'gallery/upload-url:POST', esito: 'ripresa-metadata-diversi' });
                    return NextResponse.json({ error: 'Il percorso contiene un file diverso.', codice: 'CARICAMENTO_IN_CONFLITTO' }, { status: 409 });
                }
                logEvento('galleria', 'info', { operazione: 'gallery/upload-url:POST', esito: 'caricamento-recuperato', size, mime });
                return NextResponse.json({ path: resume_path, uploaded: true });
            }
            if (!assente) {
                logErrore({ operazione: 'gallery/upload-url:POST', stato: 500, evento: 'storage' }, new Error('Metadata oggetto mancanti'));
                return NextResponse.json({ error: 'Verifica del caricamento non riuscita. Riprova.', codice: 'ALLEGATO_NON_CARICATO' }, { status: 500 });
            }
        }

        // Ogni persona ha 30 firme: il Wi-Fi della scuola non condivide la quota.
        const rl = await rateLimit(`galleria-upload:${auth.user.id}`, {
            limit: 30,
            windowMs: 10 * 60 * 1000,
        });
        if (!rl.ok) {
            logEvento('galleria', 'warn', { operazione: 'gallery/upload-url:POST', esito: 'limite-firme', stato: 429 });
            return NextResponse.json(
                { error: 'Troppi caricamenti. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
                { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
            );
        }

        // Il percorso è intestato all'utente DEL GATE, mai a un campo del client: è la
        // stessa scelta di `gallery/upload`, e la ragione è che quel segmento è l'unica
        // cosa che separa i file di una maestra da quelli di un'altra.
        const path = resume_path ?? `uploads/${auth.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${estensioneDaMime(mime)}`;

        const { data, error } = await supabase.storage.from(BUCKET_GALLERIA).createSignedUploadUrl(path);
        if (error || !data?.signedUrl || !data.token) {
            // Il corpo dell'errore del fornitore resta nel LOG e non torna al client
            // (S31): «bucket not found» non è una frase da mostrare a un'insegnante, e
            // porta fuori il nome del bucket e dei suoi vincoli.
            logErrore({ operazione: 'gallery/upload-url:POST', stato: 500, evento: 'storage' }, error ?? new Error('URL mancante'));
            return NextResponse.json(
                { error: 'Caricamento non riuscito. Riprova.', codice: 'ALLEGATO_NON_CARICATO' },
                { status: 500 },
            );
        }

        logEvento('galleria', 'info', { operazione: 'gallery/upload-url:POST', esito: 'firma-emessa', size, mime, ripresa: Boolean(resume_path) });
        return NextResponse.json({ path, token: data.token, signedUrl: data.signedUrl });
    } catch (error) {
        logErrore({ operazione: 'gallery/upload-url:POST', stato: 500 }, error);
        // Anche il ramo catch-all porta un codice: «Internal Server Error» non è una
        // frase, è l'assenza di una frase, e a schermo diventa un errore che non dice
        // né cosa è successo né se valga la pena riprovare.
        return NextResponse.json(
            { error: 'Caricamento non riuscito. Riprova.', codice: 'ALLEGATO_NON_CARICATO' },
            { status: 500 },
        );
    }
});
