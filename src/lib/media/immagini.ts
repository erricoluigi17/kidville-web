import { logClient } from '@/lib/logging/client';

/**
 * Ridimensiona un'immagine e applica il watermark con il logo della scuola.
 * Cappa la dimensione massima a 1920px (mantenendo il rapporto d'aspetto)
 * ed esporta in formato JPEG con qualità a 0.85 per preservare la qualità visiva.
 */
export function processImageWithWatermark(file: File, watermarkUrl: string = '/watermark.png'): Promise<File> {
    return new Promise((resolve, reject) => {
        // Se non è un'immagine, risolvi direttamente con il file originale
        if (!file.type.startsWith('image/')) {
            return resolve(file);
        }

        const img = new Image();
        img.src = URL.createObjectURL(file);
        
        img.onload = () => {
            URL.revokeObjectURL(img.src);

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return resolve(file); // Fallback se il contesto canvas non è disponibile
            }

            // Dimensioni massime consentite
            const MAX_DIM = 1920;
            let width = img.width;
            let height = img.height;

            if (width > MAX_DIM || height > MAX_DIM) {
                if (width > height) {
                    height = Math.round((height * MAX_DIM) / width);
                    width = MAX_DIM;
                } else {
                    width = Math.round((width * MAX_DIM) / height);
                    height = MAX_DIM;
                }
            }

            canvas.width = width;
            canvas.height = height;

            // Disegna l'immagine originale sul canvas
            ctx.drawImage(img, 0, 0, width, height);

            // Carica e applica il watermark
            const wm = new Image();
            wm.src = watermarkUrl;

            wm.onload = () => {
                // Imposta le dimensioni del watermark: 70% della larghezza dell'immagine (ingrandito al 70%)
                const wmWidth = width * 0.70;
                const wmHeight = (wm.height * wmWidth) / wm.width;

                // Calcola la posizione (al centro in basso con un margine del 5% dell'altezza)
                const x = (width - wmWidth) / 2;
                const y = height - wmHeight - (height * 0.05);

                // Disegna il watermark sul canvas completamente visibile (no trasparenza)
                ctx.globalAlpha = 1.0;
                ctx.drawImage(wm, x, y, wmWidth, wmHeight);

                // Converte in blob (JPEG, qualità 85%)
                canvas.toBlob((blob) => {
                    if (blob) {
                        const processedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(processedFile);
                    } else {
                        resolve(file); // Fallback all'originale in caso di errore
                    }
                }, 'image/jpeg', 0.85);
            };

            wm.onerror = () => {
                logClient({ livello: 'warn', evento: 'js', messaggio: 'watermark-immagine-non-caricato' });
                canvas.toBlob((blob) => {
                    if (blob) {
                        const processedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(processedFile);
                    } else {
                        resolve(file);
                    }
                }, 'image/jpeg', 0.85);
            };
        };

        img.onerror = (err) => {
            reject(err);
        };
    });
}
