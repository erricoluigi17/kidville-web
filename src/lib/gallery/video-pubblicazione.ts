// =============================================================================
// LA METÀ «STORAGE» DELLA PUBBLICAZIONE DI UN VIDEO IN GALLERIA (V08, e PR 2 video).
//
// ─── PERCHÉ ESISTE UN MODULO A PARTE ─────────────────────────────────────────
//
// La pubblicazione ha due cancelli, e non si scambiano fra loro:
//
//  · quello APPLICATIVO — ruolo, sede, consenso fotografico, tag nel perimetro —
//    che vive in TypeScript: alla scelta dei bambini nei cancelli condivisi
//    (`./cancelli-destinatari`, gli stessi di `POST /api/gallery`) e, alla
//    pubblicazione, nelle riverifiche di `pubblicaVideoGalleria` (chi è uscito dalla
//    sede si toglie, chi ha perso la liberatoria resta e parte un avviso). Nessuna
//    riga di quella logica sta in SQL: due verità invecchiano separatamente, ed è un
//    difetto che questo repository ha già pagato (una copia del gate nell'handler
//    proteggeva la POST e lasciava scoperta la PATCH);
//  · quello TRANSAZIONALE — un solo vincitore, revisione corrente, job pronti,
//    scope immutato — che sta dentro `video_galleria_pubblica` (la riga e
//    `video_intent_finalize` nella STESSA transazione) e si può conoscere solo sotto
//    lock.
//
// Lo Storage non sta né nell'uno né nell'altro: **non entra nella transazione**.
// Il file si copia PRIMA della RPC, perché una riga di galleria deve nominare un
// oggetto che esiste già (altrimenti una famiglia apre un riquadro rotto). Questo
// modulo è la copia — e, dal 2026-10-02, il suo percorso è DETERMINISTICO.
//
// ─── IL PERCORSO È DETERMINISTICO, E PERCHÉ ──────────────────────────────────
//
// `uploads/<owner>/v-<intento>.mp4`, non più un nome casuale. La pubblicazione gira sul
// server, da sola, e un processo può morire in qualunque punto: dopo la copia e prima
// della RPC, per esempio. Col nome casuale il tentativo successivo copiava un secondo
// file e il primo restava in `gallery` senza nessuna riga che lo nominasse (invisibile
// all'oblio e alla retention, che partono dalla riga). Col nome fisso il secondo
// tentativo trova la copia già lì: se ha la stessa dimensione vale come riuscita e si
// prosegue con la RPC, che è idempotente. Se ha una dimensione diversa è un errore, e
// si grida: un file qualunque sotto il nome di un video di un minore non si adotta.
//
// ⚠️ La forma è quella che la RPC verifica (`FILE_URL_NON_VALIDO`): un solo segmento
// `[A-Za-z0-9_-]+` più l'estensione, dentro la cartella dell'autore. È la stessa che
// `percorsoUploadProprio` impone in TypeScript, e un test le confronta.
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
 *
 * `info` serve solo al 409 «esiste già»: per sapere quanto pesa l'oggetto che occupa il
 * percorso (e, se la dimensione attesa manca, quanto pesa la sorgente).
 */
type ClientCopia = {
    storage: {
        from: (bucket: string) => {
            copy: (
                da: string,
                a: string,
                opzioni?: { destinationBucket?: string },
            ) => Promise<{ data: unknown; error: unknown }>
            info: (path: string) => Promise<{ data: { size?: number } | null; error: unknown }>
        }
    }
}

export type EsitoCopiaVideo =
    /**
     * `giaPresente` è vero quando il percorso era già occupato da una copia della STESSA
     * dimensione (un tentativo precedente è arrivato fin lì e poi è morto): la copia non
     * si è rifatta, ma il file c'è ed è quello giusto. Chi chiama prosegue come per una
     * copia nuova; il flag serve a loggarlo e a contarlo.
     */
    | { ok: true; percorso: string; giaPresente: boolean }
    /**
     * `OUTPUT_TOO_LARGE` è un codice della pipeline (`CODICI_ESITO_VIDEO`), non
     * un nome inventato qui: mappa già su un 422 e su una frase tradotta.
     * `COPIA_NON_RIUSCITA` invece non è un esito del video ma del trasporto (e vale anche
     * quando il file sul percorso non si riesce a verificare: «non so se c'è» non vale «c'è»).
     * `DESTINAZIONE_DIVERSA`: il percorso è occupato da un oggetto di dimensione DIVERSA da
     * quella attesa — un file qualunque sotto il nome di un video di un minore non si adotta.
     */
    | { ok: false; codice: 'OUTPUT_TOO_LARGE' | 'COPIA_NON_RIUSCITA' | 'DESTINAZIONE_DIVERSA' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Il nome dell'oggetto dentro `gallery`: `uploads/<owner>/v-<intento>.mp4`.
 *
 * ⚠️ NON deriva in nessun modo dal file di partenza. Un video di galleria si
 * chiama `IMG_bambina-rossi.mov`: è anagrafica di un minore, e finirebbe nella
 * chiave dell'oggetto — quindi in `app_log` ogni volta che qualcosa logga un
 * percorso. Stessa regola e stessa forma di `gallery/upload-url`, dove il nome si
 * costruisce e l'estensione si ricava dal tipo validato. Qui nemmeno un'ora o un
 * numero casuale: solo due uuid, scelti dal server.
 *
 * DETERMINISTICO: lo stesso intento dà sempre lo stesso percorso, ed è ciò che rende
 * ripetibile la copia (vedi la testata). Un intento = un solo video di galleria
 * (`SINGLE_JOB_CHANNEL`), quindi un percorso per intento non collide mai con un altro.
 *
 * L'estensione è `mp4` e non è una deduzione: il profilo di codifica della
 * pipeline produce **sempre** un MP4 H.264/AAC faststart
 * (`buildVideoEncodeArgs`), e `verifyVideoOutput` rifiuta l'uscita che non lo
 * fosse prima ancora che il job arrivi a `ready`. Un container diverso non
 * entrerebbe comunque: `allowed_mime_types` del bucket elenca cinque tipi.
 *
 * I due id DEVONO essere uuid: lo verifica `copiaVideoInGalleria` prima di usare il
 * percorso. Un `/` o un `..` in un id diventerebbe un percorso fuori dalla cartella
 * dell'autore.
 */
export function percorsoVideoInGalleria(ownerId: string, intentId: string): string {
    return `uploads/${ownerId}/v-${intentId}.mp4`
}

/**
 * `copy()` su un oggetto che c'è già: lo Storage risponde 409 («The resource already
 * exists»). Si riconosce dallo stato HTTP, dal codice di stato che il corpo ripete e,
 * per i trasporti che li perdono entrambi, dal messaggio.
 */
function destinazioneGiaPresente(errore: unknown): boolean {
    if (typeof errore !== 'object' || errore === null) return false
    const e = errore as { status?: unknown; statusCode?: unknown; message?: unknown }
    return (
        String(e.status) === '409' ||
        String(e.statusCode) === '409' ||
        (typeof e.message === 'string' && /already exists/i.test(e.message))
    )
}

/** Quanto pesa un oggetto, da `info()`. Un errore o una dimensione illeggibile NON valgono zero. */
async function dimensioneOggetto(
    supabase: ClientCopia,
    bucket: string,
    percorso: string,
): Promise<{ ok: true; byte: number } | { ok: false; errore: unknown }> {
    try {
        const { data, error } = await supabase.storage.from(bucket).info(percorso)
        if (error) return { ok: false, errore: error }
        const byte = typeof data?.size === 'number' ? data.size : NaN
        if (!Number.isFinite(byte)) return { ok: false, errore: new Error('dimensione dell’oggetto assente') }
        return { ok: true, byte }
    } catch (e) {
        // Guasto di TRASPORTO: `info()` non ritorna, lancia. Stessa visibilità dell'errore
        // restituito: lo vede chi chiama, che lo logga.
        return { ok: false, errore: e }
    }
}

/**
 * Copia l'uscita convertita dentro `gallery` e restituisce il percorso da
 * scrivere in `galleria_media_v2.file_url`.
 *
 * Il chiamante deve aver già attraversato TUTTI i cancelli applicativi: qui non
 * si valuta nessun permesso, e in particolare non si guarda il consenso
 * fotografico — che si guarda alla scelta dei bambini e di nuovo alla pubblicazione
 * (dove chi l'ha persa resta, e parte un avviso).
 *
 * ⚠️ LA RPC `video_galleria_pubblica` SI CHIAMA SOLO SE QUESTA FUNZIONE RISPONDE
 * `ok: true`. La RPC scrive `output_delete_after = now` sull'uscita in lavorazione
 * («la copia c'è, il file di lavoro si può togliere») senza poter verificare da SQL che la
 * copia esista: se si chiamasse dopo un fallimento, il file di lavoro sparirebbe senza
 * che in galleria ce ne sia uno. `ok: true` dopo un 409 (stessa dimensione) vale come
 * copia riuscita: il file c'è ed è quello giusto.
 */
export async function copiaVideoInGalleria(
    supabase: ClientCopia,
    opzioni: {
        /** `video_jobs.output_bucket`: il dato, non un nome indovinato. */
        bucketSorgente: string
        percorsoSorgente: string
        /**
         * `video_jobs.output_size`, quando c'è: `null` non autorizza il tetto (fa solo saltare il
         * confronto) e, se il percorso di destinazione è già occupato, si legge la dimensione
         * della sorgente dallo Storage.
         */
        byte: number | null
        ownerId: string
        /** L'intento che si pubblica: dà il nome al file (`v-<intento>.mp4`). */
        intentId: string
        operazione: string
    },
): Promise<EsitoCopiaVideo> {
    const { bucketSorgente, percorsoSorgente, byte, ownerId, intentId, operazione } = opzioni

    // I DUE ID SI VERIFICANO PRIMA DI COMPORRE UN PERCORSO. Vengono dal database e sono
    // uuid, ma un percorso nasce da una concatenazione, e un `/` o un `..` fuori posto
    // scriverebbe fuori dalla cartella dell'autore. Non si logga il valore: è, per
    // definizione, qualcosa che non è un uuid.
    if (!UUID_RE.test(ownerId) || !UUID_RE.test(intentId)) {
        logEvento('galleria', 'error', {
            operazione,
            esito: 'video-percorso-non-valido',
            bucket: BUCKET_GALLERIA,
        })
        return { ok: false, codice: 'COPIA_NON_RIUSCITA' }
    }

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

    const percorso = percorsoVideoInGalleria(ownerId, intentId)

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
        // IL PERCORSO È GIÀ OCCUPATO: un tentativo precedente è arrivato fin qui. È il caso
        // per cui il nome è deterministico, e vale come riuscita SOLO se l'oggetto ha la
        // dimensione giusta.
        if (destinazioneGiaPresente(esito.error)) {
            return verificaDestinazioneGiaPresente(supabase, {
                bucketSorgente,
                percorsoSorgente,
                byte,
                percorso,
                operazione,
            })
        }
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
    return { ok: true, percorso, giaPresente: false }
}

/**
 * Il 409: sul percorso deterministico c'è già un oggetto. Si adotta solo se pesa quanto
 * l'uscita che si voleva copiare.
 *
 * FAIL-CLOSED su tutto ciò che non si riesce a leggere: «non so quanto pesa» non vale
 * «pesa giusto». Il rifiuto è `COPIA_NON_RIUSCITA` (si ritenta col backoff dell'outbox),
 * non `DESTINAZIONE_DIVERSA`, che è riservato a una dimensione CONOSCIUTA e diversa.
 */
async function verificaDestinazioneGiaPresente(
    supabase: ClientCopia,
    opzioni: {
        bucketSorgente: string
        percorsoSorgente: string
        byte: number | null
        percorso: string
        operazione: string
    },
): Promise<EsitoCopiaVideo> {
    const { bucketSorgente, percorsoSorgente, byte, percorso, operazione } = opzioni

    const trovato = await dimensioneOggetto(supabase, BUCKET_GALLERIA, percorso)
    if (!trovato.ok) {
        logEvento('galleria', 'error', {
            operazione,
            esito: 'video-copia-verifica-non-riuscita',
            bucket: BUCKET_GALLERIA,
            lato: 'destinazione',
        }, trovato.errore)
        return { ok: false, codice: 'COPIA_NON_RIUSCITA' }
    }

    let attesi = byte
    if (attesi === null) {
        const sorgente = await dimensioneOggetto(supabase, bucketSorgente, percorsoSorgente)
        if (!sorgente.ok) {
            logEvento('galleria', 'error', {
                operazione,
                esito: 'video-copia-verifica-non-riuscita',
                bucket: bucketSorgente,
                lato: 'sorgente',
            }, sorgente.errore)
            return { ok: false, codice: 'COPIA_NON_RIUSCITA' }
        }
        attesi = sorgente.byte
    }

    if (trovato.byte !== attesi) {
        // Un file diverso sotto il nome di un video di un minore: si GRIDA, e non si adotta.
        // Solo numeri: il percorso porta con sé chi ha caricato.
        logEvento('galleria', 'error', {
            operazione,
            esito: 'video-copia-destinazione-diversa',
            bucket: BUCKET_GALLERIA,
            byte_attesi: attesi,
            byte_trovati: trovato.byte,
        })
        return { ok: false, codice: 'DESTINAZIONE_DIVERSA' }
    }

    logEvento('galleria', 'info', {
        operazione,
        esito: 'video-copia-gia-presente',
        bucket: BUCKET_GALLERIA,
        byte: trovato.byte,
    })
    return { ok: true, percorso, giaPresente: true }
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
