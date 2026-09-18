// =============================================================================
// LA METÀ «STORAGE» DELLA PUBBLICAZIONE DI UN VIDEO IN GALLERIA (V08).
//
// ─── PERCHÉ ESISTE UN MODULO A PARTE ─────────────────────────────────────────
//
// La pubblicazione ha due cancelli, e non si scambiano fra loro:
//
//  · quello APPLICATIVO — ruolo, sede, consenso fotografico, tag nel perimetro —
//    che vive in TypeScript dentro l'handler di `POST /api/gallery`, riusando i
//    presidi che la Galleria ha già (`requireDocente`, `resolveScuolaScrittura`,
//    `assertTagStudentsInScope`, `alunniSenzaConsenso`). Nessuna riga di quella
//    logica sta in SQL: due verità invecchiano separatamente, ed è un difetto che
//    questo repository ha già pagato (una copia del gate nell'handler proteggeva
//    la POST e lasciava scoperta la PATCH);
//  · quello TRANSAZIONALE — un solo vincitore, revisione corrente, job pronti,
//    scope immutato — che sta dentro `video_intent_finalize` e si può conoscere
//    solo sotto lock.
//
// Lo Storage non sta né nell'uno né nell'altro: **non entra nella transazione**.
// Il file si copia PRIMA della RPC, perché una riga di galleria deve nominare un
// oggetto che esiste già (altrimenti una famiglia apre un riquadro rotto); e se
// la RPC poi rifiuta, la copia va tolta. Questo modulo è quella coppia.
//
// ─── È LO SCHEMA DI `promuoviMediaBozza`, CON UNA DIFFERENZA MISURATA ─────────
//
// Per le News il media si SPOSTA da `news_bozze` a `news`, e l'annullamento lo
// sposta indietro. Qui si COPIA, e l'annullamento RIMUOVE. La ragione non è di
// gusto: `video_jobs.output_bucket`/`output_path` continuano a nominare l'uscita
// dentro il bucket di lavorazione — è la riga su cui si basano l'idempotenza del
// finalize, la riconciliazione e la retention. Spostare quel file renderebbe
// quella riga una promessa su un oggetto che non esiste più, e un secondo
// tentativo di pubblicazione non troverebbe niente da copiare.
//
// ─── E LA RIMOZIONE PASSA DA `rimuoviEVerifica`, MAI DA UN `remove()` MUTO ────
//
// `remove()` non fallisce sui percorsi che non esistono e restituisce solo quelli
// che ha davvero tolto: guardare il solo `error` fa passare «zero file rimossi su
// uno» per un successo. `rimuoviEVerifica` verifica lo STATO — «uscito adesso»,
// «non c'era più», «c'è ancora», «non si sa» — ed è l'unica forma che sa dire la
// differenza. Qui serve tutta: un file di un minore rimasto in `gallery` senza
// nessuna riga che lo nomini è invisibile all'oblio (che parte dalla riga), alla
// retention (idem) e alla revoca del consenso, cioè resta archiviato per sempre e
// nessun percorso del prodotto lo può più raggiungere. Quello si GRIDA.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { logErrore, logEvento } from '@/lib/logging/logger'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'

import { BUCKET_GALLERIA, TETTO_VIDEO_GALLERIA_BYTE } from './limiti'

/**
 * Il minimo del client Supabase che serve alla copia: il vero `SupabaseClient` lo
 * soddisfa, e un test può passarne uno finto senza montare mezzo SDK. È la stessa
 * scelta di `firmaMediaGalleria` in `./storage.ts`.
 */
type ClientCopia = {
    storage: {
        from: (bucket: string) => {
            copy: (
                da: string,
                a: string,
                opzioni?: { destinationBucket?: string },
            ) => Promise<{ data: unknown; error: unknown }>
        }
    }
}

export type EsitoCopiaVideo =
    | { ok: true; percorso: string }
    /**
     * `OUTPUT_TOO_LARGE` è un codice della pipeline (`CODICI_ESITO_VIDEO`), non
     * un nome inventato qui: mappa già su un 422 e su una frase tradotta.
     * `COPIA_NON_RIUSCITA` invece non è un esito del video ma del trasporto, e
     * l'handler lo traduce nella risposta che la Galleria usa da sempre quando un
     * file non entra (`rispostaAllegatoNonCaricato`, 500).
     */
    | { ok: false; codice: 'OUTPUT_TOO_LARGE' | 'COPIA_NON_RIUSCITA' }

/**
 * Il nome dell'oggetto dentro `gallery`.
 *
 * ⚠️ NON deriva in nessun modo dal file di partenza. Un video di galleria si
 * chiama `IMG_bambina-rossi.mov`: è anagrafica di un minore, e finirebbe nella
 * chiave dell'oggetto — quindi in `app_log` ogni volta che qualcosa logga un
 * percorso. Stessa regola e stessa forma di `gallery/upload-url`, dove il nome si
 * costruisce e l'estensione si ricava dal tipo validato.
 *
 * L'estensione è `mp4` e non è una deduzione: il profilo di codifica della
 * pipeline produce **sempre** un MP4 H.264/AAC faststart
 * (`buildVideoEncodeArgs`), e `verifyVideoOutput` rifiuta l'uscita che non lo
 * fosse prima ancora che il job arrivi a `ready`. Un container diverso non
 * entrerebbe comunque: `allowed_mime_types` del bucket elenca cinque tipi.
 */
function percorsoInGalleria(ownerId: string): string {
    return `uploads/${ownerId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.mp4`
}

/**
 * Copia l'uscita convertita dentro `gallery` e restituisce il percorso da
 * scrivere in `galleria_media_v2.file_url`.
 *
 * Il chiamante deve aver già attraversato TUTTI i cancelli applicativi: qui non
 * si valuta nessun permesso, e in particolare non si guarda il consenso
 * fotografico — che va verificato PRIMA, perché è l'unico ordine in cui un
 * consenso revocato non lascia un file dentro il bucket.
 */
export async function copiaVideoInGalleria(
    supabase: ClientCopia,
    opzioni: {
        /** `video_jobs.output_bucket`: il dato, non un nome indovinato. */
        bucketSorgente: string
        percorsoSorgente: string
        /** `video_jobs.output_size`, quando c'è: `null` non autorizza, fa solo saltare il confronto. */
        byte: number | null
        ownerId: string
        operazione: string
    },
): Promise<EsitoCopiaVideo> {
    const { bucketSorgente, percorsoSorgente, byte, ownerId, operazione } = opzioni

    // IL TETTO SI GUARDA PRIMA DI SPEDIRE, non dopo. Lo Storage rifiuterebbe
    // comunque — il bucket ha il suo `file_size_limit` — ma lo farebbe alla fine
    // del trasferimento, e il rifiuto arriverebbe come un 4xx opaco invece che
    // come il codice che dice esattamente cosa non va.
    if (typeof byte === 'number' && byte > TETTO_VIDEO_GALLERIA_BYTE) {
        logEvento('galleria', 'warn', {
            operazione,
            esito: 'video-oltre-il-tetto',
            bucket: BUCKET_GALLERIA,
            byte,
            limite: TETTO_VIDEO_GALLERIA_BYTE,
        })
        return { ok: false, codice: 'OUTPUT_TOO_LARGE' }
    }

    const percorso = percorsoInGalleria(ownerId)

    let esito: { error: unknown }
    try {
        esito = await supabase.storage
            .from(bucketSorgente)
            .copy(percorsoSorgente, percorso, { destinationBucket: BUCKET_GALLERIA })
    } catch (e) {
        // Guasto di TRASPORTO: `copy()` non ritorna, lancia. Stesso trattamento e
        // soprattutto stessa VISIBILITÀ dell'errore restituito — un `catch` muto
        // qui sarebbe il guasto invisibile che questo modulo esiste per impedire.
        logErrore({ operazione, evento: 'storage', stato: 503 }, e)
        return { ok: false, codice: 'COPIA_NON_RIUSCITA' }
    }

    if (esito.error) {
        // Il corpo dell'errore del fornitore non si butta MAI via: «413» non dice
        // niente, «413 Payload too large» dice tutto (AGENTS §3). Resta nel log e
        // non torna al client, che riceve solo il codice.
        logErrore({ operazione, evento: 'storage', stato: 503 }, esito.error)
        return { ok: false, codice: 'COPIA_NON_RIUSCITA' }
    }

    // Evento critico ⇒ si logga anche il SUCCESSO: senza, «nessun log» non
    // distinguerebbe «copiato» da «non è mai partita nessuna copia». Solo
    // conteggi, nomi di bucket e uuid: il percorso porta con sé chi ha caricato.
    logEvento('galleria', 'info', {
        operazione,
        esito: 'video-copiato-in-galleria',
        bucket: BUCKET_GALLERIA,
        byte: byte ?? null,
    })
    return { ok: true, percorso }
}

/**
 * Toglie da `gallery` le copie che una pubblicazione mancata ha lasciato lì.
 *
 * È la gemella di `riportaMediaInBozza` per le News, e ne condivide la ragione
 * d'essere: la copia avviene PRIMA della scrittura, e deve essere così — la riga
 * deve nominare un oggetto che esiste. Ma se poi la riga non si scrive (vincolo
 * violato, RPC che rifiuta perché nel frattempo l'intento è cambiato, database
 * irraggiungibile), quel file è già dentro il bucket delle foto dei bambini e
 * nessuna riga lo nomina.
 *
 * Si RIMUOVE invece di riportare indietro perché l'originale in lavorazione non è
 * mai stato toccato: la sorgente è ancora al suo posto, e un secondo tentativo
 * ricopia. Cancellare qui non perde niente.
 *
 * Se nemmeno la rimozione riesce, il file resta e si GRIDA: non c'è niente di
 * meglio da fare, ma è l'unico modo perché qualcuno possa ripulirlo.
 */
export async function annullaCopiaVideoInGalleria(
    supabase: SupabaseClient,
    percorsi: string[],
    operazione: string,
): Promise<{ rimossi: number; rimasti: number }> {
    const unici = [...new Set(percorsi.filter((p) => typeof p === 'string' && p.trim() !== ''))]
    if (unici.length === 0) return { rimossi: 0, rimasti: 0 }

    const esito = await rimuoviEVerifica(supabase, BUCKET_GALLERIA, unici, operazione)
    // «Non so se c'è ancora» vale «c'è»: è la regola di `rimuoviEVerifica`, e qui
    // conta più che altrove, perché l'alternativa è dichiarare ripulito un file di
    // un minore che potrebbe essere ancora lì.
    //
    // ⚠️ `erroreRimozione` VA GUARDATO A PARTE, e la prima stesura di questa riga
    // non lo faceva. Quando `remove()` risponde con un errore la funzione esce
    // subito con l'esito VUOTO: `ancoraPresenti` e `incerti` sono entrambi vuoti,
    // quindi `bloccanti()` vale `[]` — cioè «tutto a posto», su una chiamata in
    // cui **nessun file è uscito**. Con il solo `bloccanti()` questa funzione
    // scriveva la riga di successo su un file rimasto dentro `gallery`: il guasto
    // silenzioso che il modulo intero esiste per impedire, riaperto dalla porta di
    // servizio. Lo stesso confronto lo fanno già `permanenza-consenso.ts:756`,
    // `retention-galleria:532` e `anagrafica-personale/scansione:773`.
    const rimasti = esito.erroreRimozione ? unici.length : bloccanti(esito).length
    // `giaAssenti` NON è un guasto: l'esito voluto è già raggiunto (un tentativo
    // precedente l'aveva tolto, o la copia non era mai arrivata in fondo).
    const rimossi = esito.rimossi.length + esito.giaAssenti.length

    if (rimasti > 0) {
        logEvento('galleria', 'error', {
            operazione,
            esito: 'video-copia-rimasta-in-galleria',
            bucket: BUCKET_GALLERIA,
            n_file: rimasti,
            msg:
                `${operazione}: ${rimasti} file sono rimasti nel bucket gallery e nessuna riga ` +
                'li nomina — oblio, retention e revoca del consenso partono dalla riga e non ci arrivano',
        })
    } else {
        // Evento critico ⇒ anche il successo: «nessun log» non deve poter
        // significare insieme «annullato» e «l'annullamento non è mai partito».
        logEvento('galleria', 'info', {
            operazione,
            esito: 'video-copia-annullata',
            bucket: BUCKET_GALLERIA,
            n_file: rimossi,
        })
    }
    return { rimossi, rimasti }
}
