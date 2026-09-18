/**
 * I LIMITI DEL BUCKET `gallery` — numeri e basta, senza nessun import.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ È UN FILE A SÉ, e non sta in `./storage.ts` insieme al resto della galleria.
 * Questi tre valori li leggono in due mondi diversi: le route (server) e il caricatore
 * che gira nel BROWSER. `storage.ts` importa `@/lib/logging/logger`, che a sua volta
 * tira `@/lib/supabase/server-client`: mettendoli lì, il bundle del client si portava
 * dentro il client service-role del server.
 *
 * Non è teoria: la build l'ha detto, in chiaro, elencando la catena
 *   server-client → app-log → logger → gallery/storage → gallery/carica-media
 * sotto «Client Component Browser». Un modulo senza import non può trascinarsi dietro
 * niente, ed è l'unica garanzia che regge anche fra sei mesi.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Il bucket dei media di galleria (foto e video dei bambini). Privato. */
export const BUCKET_GALLERIA = 'gallery'

/**
 * I FORMATI AMMESSI nel bucket.
 *
 * Li leggono in tre: la migrazione (che è la verità), la route multipart storica e la
 * porta che firma i caricamenti diretti. Solo formati che si aprono sia su Android sia
 * su iOS: in galleria finiscono foto e video dei bambini, e un formato che si vede da
 * una parte sola è metà dei genitori davanti a un riquadro nero.
 *
 * Il lock `bucket-storage-dichiarati` confronta tutte e tre le fonti: una lista più
 * larga qui firmerebbe caricamenti che lo Storage poi rifiuta — dopo che il file è
 * stato spedito per intero, su rete mobile.
 */
export const MIME_GALLERIA = [
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm',
] as const

/**
 * QUANTO IL BROWSER PUÒ SPEDIRE DA SÉ: 50 MiB.
 *
 * ⚠️ FINO AL 2026-09-17 QUI C'ERA SCRITTO CHE QUESTO NUMERO È IL TETTO GLOBALE DEL
 * PROGETTO. Non lo è più, ed è la parte che va letta invece di saltata: il 16
 * settembre il tetto globale è salito a 2.000.000.000 per far entrare gli originali
 * video, e questo è rimasto dov'era — per scelta, non per dimenticanza. I due numeri
 * erano uguali per coincidenza, e da quel giorno dicono cose diverse.
 *
 * Che cosa dice OGGI, in una riga: è il `.max()` con cui `gallery/upload-url` firma
 * un caricamento diretto, ed è il `MAX_SIZE` che il client applica prima ancora di
 * partire. Cioè il tetto della porta rivolta al BROWSER, l'unica che un telefono
 * possa usare.
 *
 * Non si alza «già che ci siamo»: il suo valore sta nell'essere piccolo. È ciò che
 * impedisce a un telefono di riversare un gigabyte dentro il bucket delle foto dei
 * bambini senza che nessuno l'abbia convertito, verificato o guardato — e il lock
 * `bucket-storage-dichiarati` lo pretende STRETTAMENTE sotto il tetto del bucket,
 * proprio perché quel giorno arrivi in revisione e non di soppiatto.
 *
 * Resta comunque vero, e vale per tutti e tre i numeri di questo file: Supabase
 * applica `min(limite del bucket, tetto globale)`, e una `createBucket`/
 * `updateBucket` che dichiarasse più del globale verrebbe respinta INTERA con
 * `EntityTooLarge`, senza applicare nemmeno `public` — è il difetto misurato il
 * 2026-09-01, per cui la richiusura automatica del bucket non è mai avvenuta.
 */
export const TETTO_GALLERIA_BYTE = 52_428_800

/**
 * QUANTO PUÒ PESARE UN VIDEO CONVERTITO: 2 GB.
 *
 * ⚠️ NON È «il tetto della galleria alzato»: è un SECONDO tetto, accanto a quello
 * qui sopra, e i due dicono cose diverse.
 *
 *  · `TETTO_GALLERIA_BYTE` (50 MiB) è quanto il BROWSER può spedire da sé. Lo usa
 *    `gallery/upload-url` come `.max()` quando firma un caricamento diretto, e lo
 *    applica il client prima ancora di partire. Resta dov'è, e non si alza «già
 *    che ci siamo»: è ciò che impedisce a un telefono di riversare un gigabyte
 *    nel bucket senza che nessuno l'abbia convertito, verificato o guardato.
 *  · `TETTO_VIDEO_GALLERIA_BYTE` (2 GB) è quanto può pesare l'USCITA della
 *    pipeline video — un MP4 H.264 già convertito, verificato e copiato dentro
 *    `gallery` dal finalizer con la chiave di servizio. Nessun browser lo spedisce.
 *
 * Il tetto del BUCKET, che è una terza cosa ancora, deve valere il più grande dei
 * due: lo dichiara la migrazione
 * `20260918…_bucket_gallery_tetto_video.sql` e lo verifica
 * `__tests__/architecture/bucket-storage-dichiarati.test.ts`, che dal 2026-09-18
 * porta tre asserzioni separate invece di un numero solo. Un lock che le confonde
 * smette di dire qualcosa di vero su entrambe.
 *
 * PERCHÉ PROPRIO 2.000.000.000, e non un numero scelto qui: è lo stesso tetto che
 * la pipeline si dà sull'INGRESSO (`MAX_VIDEO_INPUT_BYTES`,
 * `src/lib/media/video/limiti.ts`) e che il database impone all'uscita
 * (`video_jobs_output_chk`, `video_job_ready`). Se i due divergessero, un job
 * potrebbe arrivare a `ready` — 700 secondi di conversione già pagati — e poi
 * trovarsi respinto dallo Storage al momento della copia, che è il posto più caro
 * in cui scoprire un limite. Il lock lo confronta voce per voce.
 */
export const TETTO_VIDEO_GALLERIA_BYTE = 2_000_000_000

/**
 * IL SOLO CONTAINER, senza i parametri che il produttore ci ha appeso.
 *
 * `MediaRecorder` non consegna `video/mp4`: consegna `video/mp4;codecs=avc1`, e quel
 * tipo entra nel `File` convertito (`@/lib/media/processing`) e da lì, grezzo, in due
 * confronti che i parametri non li tollerano — il nostro `z.enum` e `allowed_mime_types`
 * del bucket. Il 2026-09-08 questo ha fermato TUTTI i video della galleria: 33 tentativi
 * respinti con 400, 8 insegnanti, 3 sedi, e nel bucket nessun video nuovo per un giorno
 * intero mentre le foto continuavano a passare dalla stessa porta.
 *
 * ⚠️ ERA LA SECONDA VOLTA (la prima è nel PRD al 2026-07-13, DL-051/052). Il repo la
 * lezione la conosceva e la applicava in tre punti — `api/gallery/upload`,
 * `api/news/upload`, `validateVideoFile` — ognuno con il suo `split` a mano. Da qui in
 * avanti, per la galleria, la regola ha un nome solo.
 *
 * Il `toLowerCase` non è un di più: `MIME_GALLERIA` è tutto minuscolo, quindi senza di
 * esso anche un `Video/MP4` — legittimo, i tipi MIME sono case-insensitive — prenderebbe
 * lo stesso 400.
 */
export function mimeBase(mime: string): string {
    return (mime || '').split(';')[0].trim().toLowerCase()
}

/**
 * L'estensione dal MIME VALIDATO, mai dal nome del file.
 *
 * Il nome di un file di galleria è `IMG_bambina-rossi.mov`: anagrafica di un minore,
 * che finirebbe nella chiave dell'oggetto e quindi in `app_log` ogni volta che
 * qualcosa logga un percorso. Del nome serviva solo l'estensione, e quella si ricava
 * dal tipo.
 */
export function estensioneDaMime(mime: string): string {
    switch (mime) {
        case 'image/jpeg': return 'jpg'
        case 'image/png': return 'png'
        case 'image/webp': return 'webp'
        case 'video/mp4': return 'mp4'
        case 'video/webm': return 'webm'
        default: return 'bin'
    }
}
