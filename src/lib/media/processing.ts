/**
 * Utility per l'elaborazione dei file multimediali lato client (ridimensionamento, watermark e validazioni).
 *
 * BARILE. Le due elaborazioni pesanti vivono in file separati, perché sono indipendenti e
 * vengono riscritte separatamente: `processImageWithWatermark` in `./immagini`,
 * `processVideoWithWatermark` in `./video-mediarecorder`. Qui restano la convalida
 * (`validateVideoFile`, `MotivoVideoNonValido`) e `VideoConversionError`. Gli import esistenti
 * (`@/lib/media/processing`) continuano a funzionare identici: nessun chiamante cambia.
 *
 * ⚠️ I DUE PERCORSI NON CONDIVIDONO PIÙ L'ERRORE, e la testata lo diceva ancora quando non era
 * già più vero. Da quando l'elaborazione delle immagini rifiuta una tela degenere invece di
 * pubblicarla, ognuno dei due ha il proprio tipo di rigetto — `VideoConversionError` (qui) e
 * `ImageProcessingError` (in `./immagini`). Il barile li riesporta ENTRAMBI: la pagina di
 * galleria deve poter distinguere «questa foto non si pubblica, e all'insegnante si dice
 * perché» da un guasto inatteso, e un chiamante che per farlo dovesse saltare il barile
 * renderebbe il barile una mezza verità.
 */

export { processImageWithWatermark, ImageProcessingError, type MotivoImmagineNonElaborabile } from './immagini';
export { processVideoWithWatermark } from './video-mediarecorder';

/**
 * Convalida la dimensione e il formato dei file video DOPO l'elaborazione.
 * Limite: 50MB (52.428.800 byte)
 * Formati consentiti: mp4, webm (il file elaborato è sempre uno dei due).
 *
 * Il container QuickTime (.mov) NON è più ammesso: il .mov di iPhone porta HEVC, che
 * Chrome/Android non riproducono, e va convertito PRIMA (vedi `analizzaContenutoVideo`). Il tipo si
 * normalizza al solo container (`video/webm;codecs=vp9` → `video/webm`), perché il file
 * prodotto da MediaRecorder porta il suffisso codec e altrimenti verrebbe scartato a torto.
 */
/**
 * Perché un video è stato rifiutato, in forma di CODICE.
 *
 * `error` accanto resta, ed è italiano: nasce in una libreria condivisa
 * client+server, dove il locale non esiste. Il codice serve a chi il locale ce
 * l'ha — la pagina — per mostrare la frase nella lingua dell'interfaccia invece
 * della prosa italiana (stesso rimedio dei `codice:` delle route, cfr.
 * `src/lib/ui/esito-fetch.ts`). Chi non lo legge non cambia comportamento.
 */
export type MotivoVideoNonValido = 'formato-non-supportato' | 'file-troppo-grande';

export function validateVideoFile(file: File): { valid: boolean; error?: string; codice?: MotivoVideoNonValido } {
    if (!file.type.startsWith('video/')) {
        return { valid: true };
    }

    const tipoBase = file.type.split(';')[0].trim().toLowerCase();
    const ALLOWED_MIME = ['video/mp4', 'video/webm'];
    if (!ALLOWED_MIME.includes(tipoBase)) {
        return {
            valid: false,
            codice: 'formato-non-supportato',
            error: `Formato video non supportato (${file.type}). Carica un file .mp4 (H.264) o .webm. I video .mov/HEVC (tipici di iPhone) vanno convertiti prima del caricamento.`
        };
    }

    const MAX_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_SIZE) {
        return {
            valid: false,
            codice: 'file-troppo-grande',
            error: `Il file video supera il limite massimo di 50MB. (Dimensione attuale: ${(file.size / (1024 * 1024)).toFixed(1)}MB)`
        };
    }

    return { valid: true };
}

/**
 * Errore di conversione video: la conversione OBBLIGATORIA (`opzioni.obbligatoria`) non è
 * riuscita. `puntoDiFallimento` è l'anello della catena che ha ceduto (enum-like, senza PII):
 * serve a diagnosticare in quale passaggio il dispositivo non ha potuto convertire.
 */
export class VideoConversionError extends Error {
    puntoDiFallimento: string;
    constructor(puntoDiFallimento: string) {
        super(`Conversione video non riuscita (${puntoDiFallimento}).`);
        this.name = 'VideoConversionError';
        this.puntoDiFallimento = puntoDiFallimento;
    }
}
