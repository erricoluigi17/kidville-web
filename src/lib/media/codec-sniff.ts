/**
 * Sniffing del codec/container di un file video dai primi byte dell'header
 * (ISO-BMFF `ftyp`/`moov` per mp4/mov, EBML per webm).
 *
 * CONDIVISO client e server, con ZERO dipendenze dal DOM o da API del browser: gira
 * identico nel `page.tsx` (prima della conversione) e nella route `/api/gallery/upload`
 * (difesa in profondità → 415). L'unica fonte di verità per «questo video va convertito?»
 * sta qui, così client e server non possono divergere.
 *
 * PERCHÉ SERVE. Da iPhone la fotocamera registra in HEVC dentro un container QuickTime
 * (.mov): Chrome e Android NON lo decodificano, e in bacheca il genitore vedrebbe un
 * riquadro nero o un video muto. Il container va riconosciuto PRIMA di caricarlo.
 *
 * LIMITE NOTO E ACCETTATO: è euristica sui primi 64KB. In un mp4 il box `moov` (che porta
 * il fourcc del codec) può stare in coda al file, oltre il campione: in quel caso il codec
 * non si vede e si cade nel ramo conservativo. Lato client questo significa "una conversione
 * in più" (mai un video rotto in bacheca); lato server è la seconda rete, non la prima.
 */

export interface EsitoAnalisiVideo {
    /** true = il file NON è riproducibile ovunque e va convertito (o rifiutato dal server). */
    daConvertire: boolean;
    /** Motivo diagnostico, enum-like e senza PII: sicuro da loggare. */
    motivo: string;
}

/**
 * fourcc dei codec HEVC / Dolby Vision. Se compaiono nell'header, il file non è
 * riproducibile da Chrome/Android e va convertito.
 */
const FOURCC_HEVC = ['hvc1', 'hev1', 'hvcC', 'dvh1', 'dvhe'];

/** fourcc H.264: prova POSITIVA che il file è già riproducibile ovunque. */
const FOURCC_H264 = ['avc1', 'avcC'];

/**
 * Messaggio azionabile mostrato quando un video non è convertibile/riproducibile.
 * Vive qui perché è l'UNICO modulo importabile sia dal client (alert nella pagina) sia
 * dal server (corpo del 415): un solo testo, nessuna copia da tenere allineata.
 */
export const MESSAGGIO_VIDEO_NON_CONVERTIBILE =
    'Questo video non può essere convertito su questo dispositivo. ' +
    'Su iPhone: Impostazioni → Fotocamera → Formati → "Più compatibile", poi registra di nuovo. ' +
    'In alternativa carica un file .mp4 (H.264) o .webm.';

function toBytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** Cerca una sequenza ASCII di 4 caratteri nell'header campionato. */
function contieneFourcc(bytes: Uint8Array, fourcc: string): boolean {
    const c0 = fourcc.charCodeAt(0);
    const c1 = fourcc.charCodeAt(1);
    const c2 = fourcc.charCodeAt(2);
    const c3 = fourcc.charCodeAt(3);
    const limite = bytes.length - 4;
    for (let i = 0; i <= limite; i++) {
        if (bytes[i] === c0 && bytes[i + 1] === c1 && bytes[i + 2] === c2 && bytes[i + 3] === c3) {
            return true;
        }
    }
    return false;
}

/** EBML magic (webm/mkv): 0x1A 0x45 0xDF 0xA3 in testa al file. */
function eWebm(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/**
 * Decide se un file video va convertito, analizzando i primi 64KB del suo header.
 *
 * `daConvertire=true` quando:
 *  - il container è QuickTime (MIME `video/quicktime`, o brand `qt  ` nel box `ftyp`);
 *  - compare un fourcc HEVC/Dolby Vision.
 * `daConvertire=false` (passa) per H.264 (`avc1`/`avcC`) e webm.
 * Sul DUBBIO (nessuna prova, header troncato) è CONSERVATIVO: `true`. Meglio una
 * conversione in più che un video non riproducibile in bacheca.
 */
export function analizzaContenutoVideo(buf: ArrayBuffer | Uint8Array, mime: string): EsitoAnalisiVideo {
    const tipo = (mime || '').split(';')[0].trim().toLowerCase();
    const bytes = toBytes(buf);

    // 1. QuickTime dichiarato dal MIME (il .mov di iPhone).
    if (tipo === 'video/quicktime') {
        return { daConvertire: true, motivo: 'container-quicktime-mime' };
    }

    // 2. HEVC / Dolby Vision dai fourcc: non riproducibile da Chrome/Android.
    for (const cc of FOURCC_HEVC) {
        if (contieneFourcc(bytes, cc)) {
            return { daConvertire: true, motivo: `codec-hevc-${cc}` };
        }
    }

    // 3. Container QuickTime dal brand `qt  ` nel box `ftyp` (MIME assente o generico).
    if (contieneFourcc(bytes, 'qt  ')) {
        return { daConvertire: true, motivo: 'container-quicktime-brand' };
    }

    // 4. WebM: riproducibile ovunque.
    if (eWebm(bytes) || tipo === 'video/webm') {
        return { daConvertire: false, motivo: 'webm' };
    }

    // 5. H.264: prova positiva di file già riproducibile.
    for (const cc of FOURCC_H264) {
        if (contieneFourcc(bytes, cc)) {
            return { daConvertire: false, motivo: `codec-h264-${cc}` };
        }
    }

    // 6. Nessuna prova: CONSERVATIVO (il `moov` può stare oltre i 64KB campionati).
    return { daConvertire: true, motivo: 'indeterminato-conservativo' };
}
