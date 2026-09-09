import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { rateLimit, clientIp } from '@/lib/security/rate-limit';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff';
import { BUCKET_GALLERIA, MIME_GALLERIA, TETTO_GALLERIA_BYTE, estensioneDaMime, mimeBase } from '@/lib/gallery/limiti';

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
// ─── COSA SI PERDE, DETTO SENZA ABBELLIRLO ───────────────────────────────────
// Il server non vede più tutti i byte, quindi lo sniff del codec — la terza rete contro
// un HEVC che su Android mostrerebbe a un genitore un riquadro nero — non può più
// girare sul file intero. Qui i primi 64 KB viaggiano nel corpo di QUESTA richiesta e
// lo sniff gira lo stesso, sul server, con la STESSA `analizzaContenutoVideo`: zero
// divergenze fra client e server, che è la ragione per cui quel modulo esiste. In più
// la maestra scopre il rifiuto prima di spedire quaranta megabyte su rete mobile.
//
// ⚠️ RESTA SCOPERTO un client che manda una testa pulita e poi PUTta un altro file.
// È un indebolimento vero rispetto a prima, non un pareggio: le sole reti rimaste sono
// la lista mime del bucket e i 50 MB. Il costo di un errore è un riquadro nero, non un
// dato esposto, ed è per questo che si accetta. La strada per chiuderlo, se un giorno
// in `gallery` comparirà un HEVC vero, è uno sniff a POSTERIORI dei byte archiviati,
// come audit notturno FUORI dal percorso critico — mai un secondo giro di rete su ogni
// caricamento.
//
// ⚠️ `/api/gallery/upload` RESTA VIVA E INVARIATA: è la porta delle shell native col
// bundle in cache, che continueranno a mandare multipart per settimane, e il lock
// `bucket-storage-dichiarati` legge da quel file la configurazione del bucket. Per quei
// client la terza rete è ancora intera — vedono tutti i byte.
// =============================================================================

const postBodySchema = z.object({
    // La stessa lista del bucket. Un mime fuori elenco qui è un 400: firmare un
    // caricamento che lo Storage poi rifiuta sposta solo il guasto più in là.
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
    // I primi 64 KB del file, in base64, per lo sniff del codec. Obbligatori per i
    // video (vedi il fail-closed più sotto), inutili per le immagini. 64 KB in base64
    // ≈ 87.400 caratteri: il corpo di questa richiesta resta due ordini di grandezza
    // sotto il tetto della piattaforma, che è il punto di tutto l'esercizio.
    testa_b64: z.string().max(120_000).optional(),
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

        // Chiave PROPRIA, non condivisa con protocolli e cassa: una raffica di firme
        // di galleria è un guasto diverso, e con due chiavi si legge separatamente.
        const rl = await rateLimit(`galleria-upload:${clientIp(request)}`, {
            limit: 30,
            windowMs: 10 * 60 * 1000,
        });
        if (!rl.ok) {
            return NextResponse.json(
                { error: 'Troppi caricamenti. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
                { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
            );
        }

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { mime, size, testa_b64 } = b.data;

        // ── LO SNIFF, che con l'upload diretto è l'ultima cosa che il server vede ──
        if (mime.startsWith('video/')) {
            // Fail-closed: senza la testa non si firma. È la stessa scelta del client,
            // che su un header illeggibile dichiara `daConvertire: true`.
            if (!testa_b64) {
                logEvento('galleria', 'warn', {
                    operazione: 'gallery/upload-url:POST',
                    esito: 'video-senza-testa',
                    mime,
                    size,
                });
                return NextResponse.json(
                    { error: MESSAGGIO_VIDEO_NON_CONVERTIBILE, codice: 'VIDEO_NON_CONVERTIBILE' },
                    { status: 415 },
                );
            }
            const testa = new Uint8Array(Buffer.from(testa_b64, 'base64'));
            const analisi = analizzaContenutoVideo(testa, mime);
            if (analisi.daConvertire) {
                // MAI il nome del file nei log: può contenere PII. Solo mime, size e motivo.
                logEvento('galleria', 'warn', {
                    operazione: 'gallery/upload-url:POST',
                    esito: 'video-non-riproducibile',
                    mime,
                    size,
                    motivo: analisi.motivo,
                });
                return NextResponse.json(
                    { error: MESSAGGIO_VIDEO_NON_CONVERTIBILE, codice: 'VIDEO_NON_CONVERTIBILE' },
                    { status: 415 },
                );
            }
        }

        // Il percorso è intestato all'utente DEL GATE, mai a un campo del client: è la
        // stessa scelta di `gallery/upload`, e la ragione è che quel segmento è l'unica
        // cosa che separa i file di una maestra da quelli di un'altra.
        const path = `uploads/${auth.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${estensioneDaMime(mime)}`;

        const supabase = await createAdminClient();
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
