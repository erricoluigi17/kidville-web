import { logClient, nomeErrore, type CampoValore } from '@/lib/logging/client';

/**
 * IL RIDIMENSIONAMENTO E IL WATERMARK DELLE FOTO DI GALLERIA — e le quattro reti che
 * impediscono a una tela degenere di diventare un file pubblicato.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * IL GUASTO, MISURATO IN PRODUZIONE (letto il 2026-09-11, non dedotto)
 *
 *   SELECT count(*), count(DISTINCT metadata->>'eTag') FROM storage.objects
 *   WHERE bucket_id = 'gallery' AND (metadata->>'size')::bigint = 775;
 *   → 3 righe, 1 SOLO eTag: "6ffc8975fca58e4ec3d9ba87b3f0f672"
 *
 * Tre immagini di ESATTAMENTE 775 byte fra il 09/09 e il 10/09, due insegnanti diverse,
 * tutte a Giugliano, pubblicate e viste dalle famiglie. Un md5 solo per tre file dice che
 * non sono tre foto sfortunate: è lo STESSO file, prodotto tre volte. E `6ffc8975…` è
 * l'md5 che la riproduzione in laboratorio ottiene da una tela 1x1.
 *
 * ⚠️ LA PRIMA DIAGNOSI ERA SBAGLIATA, e va scritto perché è la parte che insegna: si era
 * detto «canvas nero a 1920». Un JPEG uniformemente nero a 1920x1440 costa 20-35 KB, e
 * 775 byte non poteva essere quello. La frontiera misurata dice che la tela è MINUSCOLA,
 * non nera:
 *
 *     lato 1-16 → 771 byte      lato 17-32 → 775 byte      lato 33+ → 779 byte
 *
 * 1x1, 8x8 e 16x16 danno tutti lo stesso file. La versione precedente di questa funzione
 * leggeva `img.width`/`img.height` e non li guardava MAI: una dimensione degenere diventava
 * `canvas.width = 1`, e da lì un `File` risolto, caricato e pubblicato. Nessun log, nessun
 * errore, nessun test rosso.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────
 * LE QUATTRO RETI, NELL'ORDINE IN CUI CORRONO. La prima è la CAUSA RADICE; le altre tre
 * sono difesa in profondità, cioè servono il giorno in cui la prima non basta più.
 *
 *  1. LE DIMENSIONI SI GUARDANO, su ENTRAMBE le coppie — sorgente e destinazione — in un
 *     solo controllo. Un lato sotto `LATO_MINIMO_PX` è un RIFIUTO, non un motivo per
 *     proseguire. (Perché anche la destinazione: `8000x64` supera la soglia in ingresso e la
 *     sfonda in uscita — 1920x15 — perché il ridimensionamento schiaccia il lato corto.
 *     Perché UN solo controllo e non due: vedi lì, la prova di mutazione dice che il secondo
 *     copriva interamente il primo.)
 *  2. LA TELA NON È VUOTA, verificato su nove punti sparsi PRIMA di disegnare il
 *     watermark. L'ordine è la sostanza: verificando dopo si dichiarerebbe buona una tela
 *     su cui l'unica cosa disegnata è il nostro logo.
 *  3. IL PAVIMENTO SUI BYTE: un JPEG minuscolo a fronte di un ingresso grande è un guasto,
 *     non una compressione fortunata.
 *  4. IL RIGETTO È UN `Error` VERO. `img.onerror` passa un `Event`, e
 *     `nomeErrore(Event)` restituisce `'errore'`: in `app_log` le righe
 *     `gallery-pubblicazione-fallita: errore` SONO questi fallimenti, e l'insegnante
 *     leggeva il messaggio generico perché in pagina `err instanceof Error` era falso.
 *     Da qui esce sempre un `ImageProcessingError`, con un `motivo` enum-like e un
 *     messaggio che si può mostrare.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────
 * E NIENTE DI TUTTO QUESTO TORNA PIÙ L'ORIGINALE IN SILENZIO. Il ripiego muto era il
 * secondo difetto, gemello del primo: `8000x2` calcolava un'altezza di destinazione ZERO,
 * `toBlob` su una tela di area nulla consegnava `null`, e il `resolve(file)` in fondo
 * spediva l'originale non elaborato — senza watermark, a piena risoluzione e senza una
 * riga di log. Resta UN solo ripiego che torna l'originale, `getContext('2d') === null`,
 * e lo dichiara (vedi lì il perché).
 *
 * ⚠️ HEIC NON C'ENTRA, e non va aggiunta gestione: in quattordici giorni di file d'origine
 * non c'è UN `.heic`. La WebView consegna già JPEG.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ I NOMI DEI CAMPI DI LOG NON SONO LIBERI, e la prima stesura di questo file l'ha
 * imparato a spese proprie. La redazione dei `campi` è SERVER-SIDE (`/api/logs` fa
 * `redact(c.campi)`) e a LISTA BIANCA: sotto un nome che non è in `CHIAVI_IN_CHIARO` una
 * stringa esce `[redatto:str/N]`. Misurato eseguendo il `redact` vero, non dedotto:
 *
 *     { motivo:'dimensioni-degeneri', strada:'bitmap', fase:'img_onerror' }
 *     → { motivo:'[redatto:str/19]', strada:'[redatto:str/6]', fase:'[redatto:str/11]' }
 *
 * Tre nomi scelti perché descrittivi, tre colonne piene di niente. Peggio: `motivo` è dentro
 * `RADICI_TESTO_LIBERO`, quindi sotto quel nome non uscirebbe in chiaro MAI. Una colonna di
 * `[redatto:str/6]` SEMBRA una misura ed è un silenzio — è il difetto già pagato con
 * `piattaforma`, che per un mese ha scritto `web` su ogni riga.
 *
 * La diagnosi viaggia quindi sotto i nomi che la lista bianca ammette GIÀ, e sono quelli che
 * il repo usa da sempre per questa cosa — la coppia `operazione` + `esito` di
 * `notifiche/triggers.ts` e `notifiche/destinatari.ts`, più `canale`:
 *
 *     esito      ← il MOTIVO del rifiuto (ed è anche dentro il messaggio, per la deduplica)
 *     canale     ← la strada della decodifica: `bitmap` o `img`
 *     operazione ← la fase in cui si è rotto: `img_onerror`, `object_url`
 *
 * NON si allarga `CHIAVI_IN_CHIARO`: quella lista governa anche un canale ANONIMO — `redact`
 * gira sul body grezzo di `/api/logs`, e una chiave in più è una chiave il cui valore, da
 * chiunque sappia fare una POST, finisce in chiaro in tabella per trenta giorni.
 * ══════════════════════════════════════════════════════════════════════════════════════
 */

/** Il lato massimo dell'immagine pubblicata. Il rapporto d'aspetto si conserva. */
export const MAX_DIM_IMMAGINE = 1920;

/**
 * Il lato minimo ammesso, in pixel — SORGENTE e DESTINAZIONE.
 *
 * 64 e non 17: la frontiera misurata dice che fino a 32 px il file è indistinguibile da
 * quello di 1x1, e una foto scattata da un telefono non ha mai un lato di 64 px. Il numero
 * sta comodamente fra i due — abbastanza alto per prendere ogni tela degenere, abbastanza
 * basso per non rifiutare niente che una fotocamera possa produrre.
 */
export const LATO_MINIMO_PX = 64;

/**
 * Il pavimento sui byte del JPEG prodotto, e la taglia d'ingresso oltre la quale si applica.
 *
 * ⚠️ LE DUE CONDIZIONI VANNO IN `&&`, e la seconda non è prudenza eccessiva: un'immagine
 * davvero piccola (una miniatura legittima da 2 KB) può comprimersi sotto i 4 KB senza che
 * niente sia andato storto. Col solo pavimento la si rifiuterebbe, e il rimedio sarebbe
 * peggiore del guasto. Quello che è impossibile è un JPEG da 800 byte generato da un
 * ingresso da 3 MB: lì i byte che mancano sono l'immagine.
 */
export const PAVIMENTO_BYTE_USCITA = 4096;
export const INGRESSO_NON_MINIATURA_BYTE = 32_768;

/**
 * Le frazioni del lato su cui si campiona la tela: 3x3 = nove punti sparsi, non una riga.
 *
 * Nove `getImageData` da un pixel costano microsecondi, e nove punti sparsi su tutta la
 * superficie è ciò che distingue «vuota» da «uniforme in un angolo». Un solo campione
 * diverso dagli altri basta a dichiararla piena: il confronto è per UGUAGLIANZA ESATTA dei
 * quattro canali, quindi su una foto vera — dove il rumore JPEG è sempre presente — la
 * probabilità di nove campioni identici è trascurabile.
 */
const FRAZIONI_CAMPIONE = [1 / 6, 1 / 2, 5 / 6];

/** La qualità JPEG dell'esportazione. Invariata: 0,85 era e resta. */
const QUALITA_JPEG = 0.85;

/** Il watermark occupa il 70% della larghezza, centrato in basso. Invariato. */
const WATERMARK_FRAZIONE_LARGHEZZA = 0.7;
const WATERMARK_MARGINE_BASSO = 0.05;

/**
 * Perché una foto NON è stata pubblicata, in forma di CODICE.
 *
 * Enum-like e senza PII, come `puntoDiFallimento` di `VideoConversionError`. Viaggia in DUE
 * posti, e servono entrambi: dentro il `messaggio` (la deduplica di `logClient` ha per chiave
 * `evento|messaggio|stato`, quindi motivi diversi in un messaggio unico collasserebbero in
 * una riga sola) e nei `campi` sotto il nome `esito` — perché `GROUP BY
 * contesto->'campi'->>'esito'` non legge il messaggio. Il nome `motivo` NON si può usare: è
 * in `RADICI_TESTO_LIBERO`, e lì un valore non esce in chiaro mai (vedi la testata).
 */
export type MotivoImmagineNonElaborabile =
    | 'immagine-non-decodificata'
    | 'dimensioni-degeneri'
    | 'tela-vuota'
    | 'byte-implausibili'
    | 'codifica-jpeg-fallita';

/**
 * I messaggi mostrati all'insegnante — ITALIANI e senza il nome del file.
 *
 * Italiano cablato per la stessa ragione dell'`error` di `validateVideoFile`: questa
 * libreria non ha un locale. Il `motivo` accanto serve a chi ce l'ha (la pagina) per
 * tradurre, e il codice è dentro la frase perché in una segnalazione via WhatsApp è
 * l'unica parola che ci riporta qui.
 *
 * ⚠️ NESSUN NOME DI FILE, nemmeno a schermo, e non è pignoleria: la pagina fa
 * `alert(err.message)` e il testo resta lì. Il nome del file che dice quale foto è quella
 * ce l'ha già l'insegnante davanti, nella lista dei caricamenti.
 */
const MESSAGGIO_UMANO: Record<MotivoImmagineNonElaborabile, string> = {
    'immagine-non-decodificata':
        'Questa foto non si è potuta aprire sul dispositivo (immagine-non-decodificata). Non è stata pubblicata: riprova, oppure riscattala.',
    'dimensioni-degeneri':
        'Questa foto è arrivata con dimensioni non valide (dimensioni-degeneri). Non è stata pubblicata: riselezionala dalla galleria, oppure riscattala.',
    'tela-vuota':
        'La foto elaborata è risultata vuota (tela-vuota). Non è stata pubblicata: riprova, e se succede di nuovo chiudi e riapri l\'app.',
    'byte-implausibili':
        'La foto elaborata è troppo piccola per contenere un\'immagine (byte-implausibili). Non è stata pubblicata: riprova.',
    'codifica-jpeg-fallita':
        'Il dispositivo non ha potuto convertire la foto in JPEG (codifica-jpeg-fallita). Non è stata pubblicata: riprova.',
};

/**
 * L'errore con cui l'elaborazione di un'immagine si rifiuta di consegnare un file.
 *
 * ⚠️ ESISTE PERCHÉ `nomeErrore` FUNZIONI. `img.onerror` passa un `Event`, e per un
 * non-`Error` `nomeErrore` restituisce `'errore'`: le righe
 * `gallery-pubblicazione-fallita: errore` di `app_log` sono esattamente questo caso, e si
 * confondevano con qualunque altra cosa. Un `name` proprio le separa in tabella, e
 * `instanceof Error` vero è ciò che fa arrivare il messaggio all'insegnante invece del
 * testo generico.
 */
export class ImageProcessingError extends Error {
    readonly motivo: MotivoImmagineNonElaborabile;
    constructor(motivo: MotivoImmagineNonElaborabile) {
        super(MESSAGGIO_UMANO[motivo]);
        this.name = 'ImageProcessingError';
        this.motivo = motivo;
    }
}

/**
 * La strada seguita dalla decodifica: finisce nel log, così un guasto del solo ripiego si vede.
 *
 * Si chiama `canale` e non `strada` perché è il nome del CAMPO DI LOG, e `strada` non è in
 * `CHIAVI_IN_CHIARO`: uscirebbe `[redatto:str/6]`. Il nome interno segue quello del campo di
 * proposito — così il valore che si legge nel codice è il valore che si legge in tabella, e
 * nessuno può rinominarne uno solo dei due.
 */
type CanaleDecodifica = 'bitmap' | 'img';

interface Decodificata {
    canale: CanaleDecodifica;
    larghezza: number;
    altezza: number;
    sorgente: CanvasImageSource;
    chiudi: () => void;
}

/** Il solo container del mime, senza i parametri: è un campo di log, non un gate. */
function tipoBase(tipo: string): string {
    return tipo.split(';')[0].trim().toLowerCase().slice(0, 64);
}

/**
 * Logga il rifiuto e restituisce l'errore da lanciare — le due cose insieme, sempre.
 *
 * Separarle è il modo noto di produrre un rifiuto muto: un `throw` nuovo scritto sei mesi
 * dopo si dimentica il log, e il guasto torna invisibile com'era.
 */
function rifiuta(
    motivo: MotivoImmagineNonElaborabile,
    campi: Record<string, CampoValore>,
): ImageProcessingError {
    // Il motivo sta nel MESSAGGIO e non solo nei campi: la deduplica di `logClient` ha per
    // chiave `evento|messaggio|stato`, quindi motivi diversi in un messaggio unico
    // collasserebbero in una riga sola — è il difetto già pagato su
    // `gallery-pubblicazione-fallita`.
    //
    // ⚠️ `esito` E NON `motivo`: `motivo` è in `RADICI_TESTO_LIBERO` e in tabella uscirebbe
    // `[redatto:str/19]`. `esito` è in `CHIAVI_IN_CHIARO` ed è il nome con cui questo repo
    // scrive già gli slug di fallimento (`notifiche/destinatari.ts`, `notifiche/triggers.ts`).
    const conEsito: Record<string, CampoValore> = { esito: motivo, ...campi };
    logClient({
        livello: 'error',
        evento: 'js',
        messaggio: `immagine-rifiutata: ${motivo}`,
        campi: conEsito,
    });
    return new ImageProcessingError(motivo);
}

/** `true` solo per un numero finito almeno pari alla soglia: prende anche `NaN` e `Infinity`. */
function latoAmmesso(lato: number): boolean {
    return Number.isFinite(lato) && lato >= LATO_MINIMO_PX;
}

/**
 * `-1` al posto di `NaN`/`Infinity`, perché la misura ARRIVI.
 *
 * `campiRidotti` scarta i numeri non finiti — giustamente: in JSON diventerebbero `null`, e
 * «null» non è una misura. Ma proprio una dimensione `NaN` è il dato più interessante di un
 * rifiuto per dimensioni, e scartato si trasformerebbe in un `campi_scartati: 1`. `-1` è un
 * lato impossibile, quindi non si confonde con una misura vera.
 */
function numeroLoggabile(n: number): number {
    return Number.isFinite(n) ? n : -1;
}

/** Le dimensioni di destinazione, col rapporto d'aspetto conservato. */
function misuraDestinazione(larghezza: number, altezza: number): [number, number] {
    if (larghezza <= MAX_DIM_IMMAGINE && altezza <= MAX_DIM_IMMAGINE) return [larghezza, altezza];
    if (larghezza > altezza) {
        return [MAX_DIM_IMMAGINE, Math.round((altezza * MAX_DIM_IMMAGINE) / larghezza)];
    }
    return [Math.round((larghezza * MAX_DIM_IMMAGINE) / altezza), MAX_DIM_IMMAGINE];
}

/**
 * LA DECODIFICA — `createImageBitmap` per prima, `new Image()` come ripiego.
 *
 * PERCHÉ `createImageBitmap` E NON `new Image()`, su WKWebView in particolare: la decodifica
 * avviene FUORI dal thread principale (l'interfaccia non si blocca su una foto da 12
 * Mpixel), il ridimensionamento lo fa il DECODIFICATORE con `resizeQuality: 'high'` — che
 * ricampiona meglio di un `drawImage` a rapporti grandi — e la memoria si libera quando lo
 * decidiamo noi, con `close()`, invece che quando il GC passa su un `<img>`.
 *
 * ⚠️ COSA NON FA, detto perché il commento non dichiari una vittoria che non c'è: il picco
 * di memoria NON scende rispetto a prima. Le dimensioni si possono misurare solo dopo aver
 * decodificato, quindi la prima decodifica è a piena risoluzione come l'`<img>` di prima.
 * Quello che si guadagna è il thread, la qualità del ricampionamento e una liberazione
 * deterministica; il canvas era già alla taglia di destinazione anche prima.
 */
async function decodifica(file: File): Promise<Decodificata> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file);
            return {
                canale: 'bitmap',
                larghezza: bitmap.width,
                altezza: bitmap.height,
                sorgente: bitmap,
                chiudi: () => bitmap.close(),
            };
        } catch (err) {
            // NON è la fine: qualche motore rifiuta da qui un formato che l'`<img>` apre. Si
            // ripiega, e si dice perché — altrimenti un ripiego permanente sembrerebbe la
            // strada normale.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'immagine-createimagebitmap-fallita',
                campi: { error_code: nomeErrore(err), mime: tipoBase(file.type), byte_ingresso: file.size },
            });
        }
    } else {
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'immagine-createimagebitmap-assente',
            campi: { mime: tipoBase(file.type) },
        });
    }
    return decodificaConImg(file);
}

/** Il ripiego: `<img>` + object URL. Rigetta con un `ImageProcessingError`, MAI con un `Event`. */
function decodificaConImg(file: File): Promise<Decodificata> {
    return new Promise<Decodificata>((resolve, reject) => {
        let url: string;
        try {
            url = URL.createObjectURL(file);
        } catch (err) {
            reject(
                rifiuta('immagine-non-decodificata', {
                    error_code: nomeErrore(err),
                    // `operazione` e non `fase`: `fase` uscirebbe `[redatto:str/11]`.
                    operazione: 'object_url',
                    mime: tipoBase(file.type),
                }),
            );
            return;
        }

        const img = new Image();
        img.onload = () => {
            resolve({
                canale: 'img',
                // `naturalWidth` e non `width`: su un `<img>` non attaccato al documento
                // `width` può essere l'attributo, non la dimensione intrinseca.
                larghezza: img.naturalWidth || img.width,
                altezza: img.naturalHeight || img.height,
                sorgente: img,
                // L'URL si revoca DOPO il disegno, non qui: revocarlo in `onload` funzionava
                // per caso — l'immagine era già decodificata — e non è una proprietà su cui
                // valga la pena appoggiarsi.
                chiudi: () => URL.revokeObjectURL(url),
            });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            // ⚠️ QUI STAVA IL `reject(err)` CON L'`Event`. È la riga che rendeva
            // `gallery-pubblicazione-fallita: errore` indistinguibile da qualunque altra cosa.
            reject(
                rifiuta('immagine-non-decodificata', {
                    operazione: 'img_onerror',
                    mime: tipoBase(file.type),
                    byte_ingresso: file.size,
                }),
            );
        };
        img.src = url;
    });
}

/**
 * La seconda decodifica, quella che RIDIMENSIONA. Non lancia: se cede, si torna alla
 * sorgente a piena risoluzione e sarà `drawImage` a scalare (peggio, ma non è un guasto).
 */
async function riscala(file: File, larghezza: number, altezza: number): Promise<Decodificata | null> {
    try {
        const bitmap = await createImageBitmap(file, {
            resizeWidth: larghezza,
            resizeHeight: altezza,
            resizeQuality: 'high',
        });
        return {
            canale: 'bitmap',
            larghezza: bitmap.width,
            altezza: bitmap.height,
            sorgente: bitmap,
            chiudi: () => bitmap.close(),
        };
    } catch (err) {
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'immagine-riscalatura-decodificatore-fallita',
            campi: { error_code: nomeErrore(err), larghezza, altezza },
        });
        return null;
    }
}

/**
 * LA TELA È VUOTA? `true` sì, `false` no, `null` non si è potuto sapere.
 *
 * Il terzo valore non è pigrizia: `getImageData` può lanciare (tela sporcata, motore che
 * nega la rilettura), e rifiutare in quel caso bloccherebbe OGNI caricamento su quel
 * dispositivo. La causa radice la chiude il controllo sulle dimensioni; questa è la rete
 * successiva, e una rete che sa degradare vale più di una che si porta dietro il prodotto.
 */
function telaVuota(ctx: CanvasRenderingContext2D, larghezza: number, altezza: number): boolean | null {
    try {
        let primo: string | null = null;
        for (const fy of FRAZIONI_CAMPIONE) {
            for (const fx of FRAZIONI_CAMPIONE) {
                const x = Math.min(larghezza - 1, Math.max(0, Math.floor(larghezza * fx)));
                const y = Math.min(altezza - 1, Math.max(0, Math.floor(altezza * fy)));
                const d = ctx.getImageData(x, y, 1, 1).data;
                const firma = `${d[0]},${d[1]},${d[2]},${d[3]}`;
                if (primo === null) primo = firma;
                else if (firma !== primo) return false;
            }
        }
        return true;
    } catch (err) {
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'immagine-verifica-tela-illeggibile',
            campi: { error_code: nomeErrore(err), larghezza, altezza },
        });
        return null;
    }
}

/** Disegna il watermark. Non lancia e non rigetta: un logo mancante non è una foto persa. */
function disegnaWatermark(
    ctx: CanvasRenderingContext2D,
    watermarkUrl: string,
    larghezza: number,
    altezza: number,
): Promise<void> {
    return new Promise<void>((resolve) => {
        const wm = new Image();
        wm.onload = () => {
            try {
                const wmLarghezza = larghezza * WATERMARK_FRAZIONE_LARGHEZZA;
                const wmSorgenteL = wm.naturalWidth || wm.width;
                const wmSorgenteA = wm.naturalHeight || wm.height;
                const wmAltezza = (wmSorgenteA * wmLarghezza) / wmSorgenteL;
                if (!Number.isFinite(wmAltezza) || wmAltezza <= 0) {
                    // Un logo con una dimensione a zero è la stessa classe di guasto che
                    // questo file esiste per prendere: si salta il watermark, non si divide
                    // per zero in silenzio.
                    logClient({
                        livello: 'warn',
                        evento: 'js',
                        messaggio: 'watermark-immagine-dimensioni-degeneri',
                        campi: { larghezza: wmSorgenteL, altezza: wmSorgenteA },
                    });
                    resolve();
                    return;
                }
                ctx.globalAlpha = 1.0;
                ctx.drawImage(
                    wm,
                    (larghezza - wmLarghezza) / 2,
                    altezza - wmAltezza - altezza * WATERMARK_MARGINE_BASSO,
                    wmLarghezza,
                    wmAltezza,
                );
            } catch (err) {
                logClient({
                    livello: 'warn',
                    evento: 'js',
                    messaggio: 'watermark-immagine-non-disegnato',
                    campi: { error_code: nomeErrore(err) },
                });
            }
            resolve();
        };
        wm.onerror = () => {
            // Messaggio INVARIATO dalla versione precedente: in `app_log` la continuità di
            // questa riga è ciò che permette di confrontare prima e dopo.
            logClient({ livello: 'warn', evento: 'js', messaggio: 'watermark-immagine-non-caricato' });
            resolve();
        };
        wm.src = watermarkUrl;
    });
}

/** `toBlob` in forma di promessa. `null` = codifica non riuscita (e il perché è loggato). */
function esportaJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
        try {
            canvas.toBlob((blob) => resolve(blob), 'image/jpeg', QUALITA_JPEG);
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'immagine-toblob-ha-lanciato',
                campi: { error_code: nomeErrore(err) },
            });
            resolve(null);
        }
    });
}

/**
 * Ridimensiona un'immagine a `MAX_DIM_IMMAGINE` (rapporto d'aspetto conservato), applica il
 * watermark della scuola ed esporta un `image/jpeg` a qualità 0,85.
 *
 * RIGETTA con `ImageProcessingError` invece di consegnare un file quando l'elaborazione non
 * ha prodotto un'immagine: vedi la testata del file per le quattro reti e per il guasto di
 * produzione che le motiva.
 */
export async function processImageWithWatermark(
    file: File,
    watermarkUrl: string = '/watermark.png',
): Promise<File> {
    if (!file.type.startsWith('image/')) {
        // Torna intatto, ma non muto: un tipo vuoto (certi selettori Android) o inatteso
        // arriva allo Storage senza watermark e a piena risoluzione, e finora non lo sapeva
        // nessuno.
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'immagine-tipo-non-immagine',
            campi: { mime: tipoBase(file.type), byte_ingresso: file.size },
        });
        return file;
    }

    /**
     * Chiude una sorgente senza poter rompere l'elaborazione (regola 9: il logging è
     * fail-open, e la chiusura di una bitmap è osservabilità della memoria, non prodotto).
     */
    const chiudi = (fn: () => void) => {
        try {
            fn();
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'immagine-chiusura-sorgente-fallita',
                campi: { error_code: nomeErrore(err) },
            });
        }
    };

    const decodificata = await decodifica(file);

    /**
     * LA SOLA sorgente ancora viva — UNA variabile e non un elenco, ed è la correzione di un
     * difetto misurato: con un array a cui si accodava la ridotta, la bitmap a PIENA
     * RISOLUZIONE restava viva fino al `finally`, cioè attraverso il caricamento del watermark
     * e tutta la codifica JPEG — il momento di massima pressione di memoria su WKWebView. Su
     * una foto da 12 Mpixel sono ~48 MB tenuti in vita senza che serva a nessuno, accanto agli
     * ~11 MB della ridotta e agli ~11 della tela.
     *
     * Contraddiceva la promessa scritta nella testata di `decodifica` («la memoria si libera
     * quando lo decidiamo noi, con `close()`, invece che quando il GC passa su un `<img>`»):
     * si liberava a funzione finita, esattamente come prima. Una variabile sola rende la cosa
     * impossibile da sbagliare — sostituirla È chiuderla, e non esiste un ramo in cui una
     * sorgente venga chiusa due volte (che passerebbe dal `catch` qui sopra, loggando un
     * guasto che non c'è).
     */
    let daChiudere: () => void = decodificata.chiudi;

    try {
        const { canale, larghezza: sorgenteL, altezza: sorgenteA } = decodificata;

        const [destL, destA] = misuraDestinazione(sorgenteL, sorgenteA);

        // ── RETE 1: LE DIMENSIONI SI GUARDANO. È la correzione della causa radice: qui
        //    passavano 1x1, 8x8, 16x16 e 8000x2.
        //
        // ⚠️ UN SOLO CONTROLLO, SU ENTRAMBE LE COPPIE, e la prima stesura ne aveva DUE —
        // uno sulla sorgente e uno sulla destinazione. La prova di mutazione ha mostrato che
        // il secondo copriva interamente il primo, il che era prevedibile una volta detto:
        // `misuraDestinazione` non ingrandisce mai, quindi `min(dest) <= min(sorgente)` e un
        // lato degenere in ingresso è degenere anche in uscita. Il primo controllo non era
        // una rete in più: era un ramo che nessun ingresso poteva raggiungere da solo, e che
        // sembrava protezione. Due misure servono nel LOG (8000x64 diventa 1920x15, e sapere
        // quale delle due coppie è fuori norma dice se il guasto è del file o del nostro
        // ridimensionamento); una sola serve nel GATE.
        if (
            !latoAmmesso(sorgenteL) ||
            !latoAmmesso(sorgenteA) ||
            !latoAmmesso(destL) ||
            !latoAmmesso(destA)
        ) {
            throw rifiuta('dimensioni-degeneri', {
                larghezza: numeroLoggabile(sorgenteL),
                altezza: numeroLoggabile(sorgenteA),
                larghezza_uscita: numeroLoggabile(destL),
                altezza_uscita: numeroLoggabile(destA),
                byte_ingresso: file.size,
                mime: tipoBase(file.type),
                canale,
            });
        }

        // Il ridimensionamento al DECODIFICATORE quando la strada lo permette.
        let sorgente = decodificata.sorgente;
        if (canale === 'bitmap' && (destL !== sorgenteL || destA !== sorgenteA)) {
            const ridotta = await riscala(file, destL, destA);
            if (ridotta) {
                // ⚠️ SUBITO, non nel `finally`: da qui la piena risoluzione non serve più a
                // nessuno, e ciò che segue (watermark + codifica JPEG) è il picco di memoria.
                chiudi(daChiudere);
                daChiudere = ridotta.chiudi;
                sorgente = ridotta.sorgente;
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = destL;
        canvas.height = destA;
        // `willReadFrequently`: la RETE 2 rilegge nove pixel e `toBlob` rilegge tutta la
        // tela comunque. Su una tela che va sempre riletta il contesto software non è un
        // costo — è la richiesta esplicita di non fare un round-trip con la GPU.
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            // L'UNICO ripiego che torna l'originale, e non perché sia bello: senza un
            // contesto 2d non c'è niente da verificare, e rifiutare bloccherebbe ogni
            // caricamento su quel dispositivo. Almeno adesso si sa che è accaduto.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'immagine-canvas-2d-non-disponibile',
                campi: { larghezza: destL, altezza: destA, byte_ingresso: file.size, canale },
            });
            return file;
        }

        ctx.drawImage(sorgente, 0, 0, destL, destA);

        // ── RETE 2: la tela non è vuota — PRIMA del watermark. Verificarla dopo vorrebbe
        //    dire verificare il nostro logo.
        const vuota = telaVuota(ctx, destL, destA);
        if (vuota === true) {
            throw rifiuta('tela-vuota', {
                larghezza: destL,
                altezza: destA,
                byte_ingresso: file.size,
                mime: tipoBase(file.type),
                canale,
            });
        }

        await disegnaWatermark(ctx, watermarkUrl, destL, destA);

        const blob = await esportaJpeg(canvas);
        if (!blob) {
            throw rifiuta('codifica-jpeg-fallita', {
                larghezza: destL,
                altezza: destA,
                byte_ingresso: file.size,
                canale,
            });
        }

        // ── RETE 3: il pavimento sui byte.
        if (blob.size < PAVIMENTO_BYTE_USCITA && file.size >= INGRESSO_NON_MINIATURA_BYTE) {
            throw rifiuta('byte-implausibili', {
                byte_uscita: blob.size,
                byte_ingresso: file.size,
                larghezza: destL,
                altezza: destA,
                canale,
            });
        }

        // IL SUCCESSO SI LOGGA (regola 5 di AGENTS.md), e qui serve più che altrove: con i
        // soli errori, «nessuna foto vuota» non si distingue da «questa funzione non gira
        // più». `warn` perché è il livello più basso che il canale del client accetta — la
        // deduplica (`evento|messaggio|stato`, poi `(impronta, giorno)` in tabella) ne lascia
        // una riga, non una per foto.
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'immagine-elaborata',
            campi: {
                canale,
                larghezza: destL,
                altezza: destA,
                byte_ingresso: file.size,
                byte_uscita: blob.size,
                // `false` quando la tela NON si è potuta rileggere (`getImageData` ha
                // lanciato): si sa che la rete 2 non ha corso, invece di crederla passata.
                // `true` solo quando è stata riletta e trovata piena.
                //
                // ⚠️ NON c'è un terzo valore, e il commento di prima ne dichiarava uno:
                // `CampoValore` (`client.ts`) ammette `string | number | boolean`, quindi un
                // `null` su questo canale non è nemmeno esprimibile. Un campo che dichiara
                // «rete 2 passata» quando non è passata è peggio di un campo assente.
                tela_verificata: vuota === false,
            },
        });

        return new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', {
            type: 'image/jpeg',
            lastModified: Date.now(),
        });
    } finally {
        chiudi(daChiudere);
    }
}
