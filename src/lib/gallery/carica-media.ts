/**
 * CARICA UN MEDIA DI GALLERIA — firma, poi `PUT` diretto allo Storage.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE, e non è una rifinitura. `app_log` del 2026-09-07:
 * `POST /api/gallery/upload → 413`, SEI volte in un giorno, tutte da `/teacher/gallery`.
 * L'unico video passato quel giorno pesava 4.484.198 byte — dodici kilobyte sotto il
 * tetto di ~4,5 MB che Vercel impone al corpo di una funzione — e il tentativo di
 * quaranta secondi dopo ha preso 413. Il bucket accetta 50 MB: la strozzatura stava fra
 * un client che li prometteva e una piattaforma che ne ammette 4,5.
 *
 * I CINQUE RAMI sono quelli già imparati in `@/lib/upload/carica-file` (testata del
 * 31/07/2026). Si RIUSANO qui invece di riscriverli, con una sola deroga dichiarata:
 *
 *  1. la taglia si controlla PRIMA di spedire — ma contro i 50 MB dello Storage, non
 *     contro il tetto di piattaforma: quello questa strada lo aggira per costruzione;
 *  2. `res.ok` si guarda PRIMA di `res.json()`. Il corpo di un 413 è `text/plain`: il
 *     parse LANCIA `SyntaxError`, e chi caricava leggeva «Errore durante il caricamento»
 *     — l'invito a rifare l'unica cosa che non poteva funzionare;
 *  3. il `path` torna dal corpo, e una risposta senza `path` è un ERRORE col suo
 *     messaggio: `res.ok` è vero, il caricamento «riesce», e la foto non compare;
 *  4. l'errore non perde lo STATO HTTP: `403` (sessione scaduta) e «rete assente» non
 *     sono lo stesso guasto, e `stato: null` dice «nessuna risposta», non «zero»;
 *  5. ⚠️ NESSUN TETTO DI TEMPO SULLA `PUT`, ed è la deroga. `TETTO_UPLOAD_MS` è 30 s,
 *     il massimo che il repo ammette, e un video da 40 MB su rete mobile ci mette di
 *     più: il tetto interromperebbe un caricamento CHE STA FUNZIONANDO. Il precedente
 *     esiste ed è dichiarato — `src/lib/native/scarica.ts` in `FETCH_SENZA_TETTO` — e
 *     questo è il suo gemello in salita. Il compenso è obbligatorio: ogni FALLIMENTO
 *     produce una riga con lo stato e un messaggio distinto per ramo, e il successo
 *     lascia due tracce SERVER (`gallery/upload-url:POST` + `gallery:POST`) — sicché
 *     una `PUT` appesa per sempre si riconosce come una firma senza il record che la
 *     segue. Senza tetto e senza quelle tracce si torna alla rotellina infinita.
 *
 * ⚠️ NON si usa `supabase.storage.uploadToSignedUrl()` dal browser: passerebbe dal fetch
 * strumentato, che sull'area `storage` impone 20 s — un tetto ancora più stretto di
 * quello che stiamo evitando. Si fa `fetch(signedUrl, { method: 'PUT' })`, la forma già
 * in esercizio in `admin/protocolli` e `CassaMovimentoModal`.
 *
 * ⚠️ IL CORPO DELLA `PUT` NON SI LEGGE MAI. Lo Storage risponde in XML e nomina il
 * bucket e i suoi vincoli: non è una frase da mostrare a un'insegnante (S31).
 *
 * ⚠️ MAI IL NOME DEL FILE NEI LOG. `IMG_bambina-rossi.mov` resterebbe trenta giorni in
 * `app_log`, interrogabile in SQL. Passano solo mime, dimensione e stato.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { logClient, nomeErrore } from '@/lib/logging/client';
import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti';

export type EsitoCarica =
    | { ok: true; path: string }
    | { ok: false; motivo: 'troppo-grande' | 'formato'; stato: number | null }
    | { ok: false; motivo: 'firma' | 'trasferimento' | 'rete'; stato: number | null };

/** La rotta che rende `messaggio` distinguibile in SQL: un ramo, un messaggio. */
function segnala(messaggio: string, stato: number | null, livello: 'warn' | 'error' = 'error') {
    // La chiave di dedup di `logClient` è `evento|messaggio|stato`: un solo
    // `gallery-upload-fallito` per tutti i rami li collasserebbe in una riga sola,
    // rendendo invisibile proprio la differenza fra «troppo grande», «firma non
    // emessa» e «lo Storage ha rifiutato». Fino al 2026-09-07 era così, e in tabella
    // ogni riga aveva `contesto` vuoto e nessuno stato.
    logClient({ livello, evento: 'fetch', messaggio, route: '/teacher/gallery', stato: stato ?? undefined });
}

export async function caricaMediaGalleria(file: File, mime: string): Promise<EsitoCarica> {
    // ── 1. la taglia, PRIMA di spedire ──────────────────────────────────────
    if (file.size > TETTO_GALLERIA_BYTE) {
        segnala(`gallery-upload-troppo-grande: ${file.size} byte, limite ${TETTO_GALLERIA_BYTE}`, null, 'warn');
        return { ok: false, motivo: 'troppo-grande', stato: null };
    }

    // ── 2. la firma, con i primi 64 KB per lo sniff del codec ───────────────
    // Il server rifiuta un HEVC PRIMA che il file parta: su rete mobile è la
    // differenza fra scoprirlo subito e scoprirlo dopo quaranta megabyte.
    let testa_b64: string | undefined;
    if (mime.startsWith('video/')) {
        try {
            const testa = await file.slice(0, 65536).arrayBuffer();
            let bin = '';
            const bytes = new Uint8Array(testa);
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            testa_b64 = btoa(bin);
        } catch {
            // Header illeggibile: si lascia decidere al server, che è fail-closed.
            // Non è un ramo muto — il 415 che seguirà ha il suo messaggio.
            testa_b64 = undefined;
        }
    }

    let firma: Response;
    try {
        firma = await fetch('/api/gallery/upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mime, size: file.size, testa_b64 }),
        });
    } catch (err) {
        segnala(`gallery-firma-non-emessa: ${nomeErrore(err)}`, null);
        return { ok: false, motivo: 'rete', stato: null };
    }

    if (!firma.ok) {
        // `res.ok` PRIMA di `res.json()`, sempre: su un 413 il corpo è `text/plain` e
        // il parse lancia, seppellendo l'unica informazione utile.
        const formato = firma.status === 415;
        segnala(
            formato ? 'gallery-video-non-convertibile' : 'gallery-firma-non-emessa',
            firma.status,
            formato ? 'warn' : 'error',
        );
        return { ok: false, motivo: formato ? 'formato' : 'firma', stato: firma.status };
    }

    const corpo = (await firma.json().catch(() => null)) as { path?: string; signedUrl?: string } | null;
    if (!corpo?.path || !corpo.signedUrl) {
        // Ramo 3: `res.ok` è vero e il caricamento «riesce», ma senza indirizzo non
        // c'è niente da caricare. Messaggio suo, o in tabella sarebbe indistinguibile.
        segnala('gallery-firma-senza-path', firma.status);
        return { ok: false, motivo: 'firma', stato: firma.status };
    }

    // ── 3. il file, diritto allo Storage. Senza tetto di tempo (vedi testata) ──
    let put: Response;
    try {
        put = await fetch(corpo.signedUrl, {
            method: 'PUT',
            headers: { 'content-type': mime, 'x-upsert': 'false' },
            body: file,
        });
    } catch (err) {
        segnala(`gallery-put-fallito: ${nomeErrore(err)}`, null);
        return { ok: false, motivo: 'rete', stato: null };
    }

    if (!put.ok) {
        // Il corpo NON si legge: è XML dello Storage e nomina il bucket (S31).
        segnala('gallery-put-fallito', put.status);
        return { ok: false, motivo: 'trasferimento', stato: put.status };
    }

    // IL SUCCESSO NON SI LOGGA DA QUI, e non è una dimenticanza: `logClient` ammette
    // solo `warn` ed `error` — un `info` per ogni foto sarebbe la tabella di rumore che
    // quella scelta esiste per evitare. Il compenso alla deroga sul tetto di tempo è
    // comunque VERO e si legge in SQL, perché ogni caricamento lascia due tracce SERVER:
    // `gallery/upload-url:POST` quando la firma parte, e `gallery:POST` quando il record
    // nasce. Una `PUT` appesa per sempre è esattamente una firma SENZA il record che la
    // segue — visibile come differenza fra i due conteggi, che è ciò che serve sapere.
    return { ok: true, path: corpo.path };
}

/**
 * L'esito in una frase per chi carica.
 *
 * Le stringhe non entrano MAI nella funzione qui sopra: quella restituisce un esito, e
 * chi rende ha il suo `useTranslations` e il suo tono. È la stessa separazione che
 * `@/lib/upload/carica-file` dichiara nella propria testata.
 *
 * `formato` non ha una frase sua: il testo di `MESSAGGIO_VIDEO_NON_CONVERTIBILE` è già
 * nel catalogo (`galleryAlertVideoNonConvertibile`) e spiega cosa fare sull'iPhone —
 * scriverne una seconda le farebbe divergere al primo ritocco.
 */
export function messaggioCaricamento(
    esito: Extract<EsitoCarica, { ok: false }>,
    t: (chiave: string) => string,
): string {
    switch (esito.motivo) {
        case 'troppo-grande': return t('galleryErrTroppoGrande');
        case 'formato': return t('galleryAlertVideoNonConvertibile');
        case 'rete': return t('galleryErrRete');
        case 'trasferimento': return t('galleryErrTrasferimento');
        case 'firma': return t('galleryErrFirma');
    }
}
