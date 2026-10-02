/**
 * Utility per l'elaborazione dei file multimediali lato client (ridimensionamento e watermark delle foto).
 *
 * BARILE, e dal 2026-10-02 SOLO DELLE IMMAGINI. L'elaborazione vive in `./immagini`
 * (`processImageWithWatermark`, `ImageProcessingError`): qui la si riesporta perché la pagina di
 * galleria e la coda offline importano da `@/lib/media/processing`, e nessun chiamante cambia.
 *
 * I VIDEO NON PASSANO PIÙ DAL BROWSER. Fino a quel giorno il barile esportava anche la conversione
 * dei video con `MediaRecorder`, la convalida del formato e un tipo d'errore suo: il telefono
 * ridisegnava il video su una tela e lo ri-registrava prima di caricarlo. Ora un video si carica
 * com'è, dalla pipeline `src/lib/media/video/**`, e lo converte il server.
 */

export { processImageWithWatermark, ImageProcessingError, type MotivoImmagineNonElaborabile } from './immagini';
