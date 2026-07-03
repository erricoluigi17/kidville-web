/**
 * Utility per l'elaborazione dei file multimediali lato client (ridimensionamento, watermark e validazioni).
 */

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
                console.warn('Impossibile caricare il watermark, esporto solo immagine ridimensionata.');
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

/**
 * Convalida la dimensione e il formato dei file video.
 * Limite: 50MB (52.428.800 byte)
 * Formati consentiti: mp4, quicktime (mov), webm
 */
export function validateVideoFile(file: File): { valid: boolean; error?: string } {
    if (!file.type.startsWith('video/')) {
        return { valid: true };
    }

    const ALLOWED_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (!ALLOWED_MIME.includes(file.type)) {
        return {
            valid: false,
            error: `Formato video non supportato (${file.type}). Sono supportati solo file .mp4, .mov e .webm.`
        };
    }

    const MAX_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_SIZE) {
        return {
            valid: false,
            error: `Il file video supera il limite massimo di 50MB. (Dimensione attuale: ${(file.size / (1024 * 1024)).toFixed(1)}MB)`
        };
    }

    return { valid: true };
}

/**
 * Applica il watermark del logo al video e lo comprime se necessario per rientrare nei limiti di peso.
 * Utilizza l'API MediaRecorder, Canvas e Web Audio API per unire video e traccia audio nativamente.
 */
export function processVideoWithWatermark(
    file: File, 
    watermarkUrl: string = '/watermark.png',
    maxSizeBytes: number = 50 * 1024 * 1024
): Promise<File> {
    return new Promise((resolve) => {
        if (typeof window === 'undefined' || !window.MediaRecorder) {
            return resolve(file); // Fallback se non supportato
        }

        // Carica prima il watermark
        const wm = new Image();
        wm.src = watermarkUrl;
        
        wm.onload = () => {
            startProcessing(false);
        };
        
        wm.onerror = () => {
            console.warn("Impossibile caricare il logo per il video, procedo solo con la compressione.");
            startProcessing(true); // Esegui solo compressione senza watermark
        };

        function startProcessing(noWatermark: boolean) {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            video.muted = true; // Muto per non riprodurre audio nello speaker del client in background
            video.playsInline = true;

            video.onloadedmetadata = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(video.src);
                    return resolve(file);
                }

                // Cappa le dimensioni massime a 720p per bilanciare qualità e velocità di elaborazione client-side
                let width = video.videoWidth;
                let height = video.videoHeight;
                const MAX_DIM = 720;

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

                // Calcola il bitrate ideale
                const duration = video.duration || 10;
                let bitrate = 2000000; // Bitrate di default alto (2.0 Mbps) per preservare qualità su video già leggeri
                
                if (file.size > maxSizeBytes) {
                    // Se il file supera il limite, calcoliamo il bitrate target
                    const targetSizeBits = maxSizeBytes * 0.85 * 8;
                    bitrate = Math.floor(targetSizeBits / duration);
                }
                bitrate = Math.max(600000, Math.min(2500000, bitrate)); // Cappa tra 600kbps e 2.5mbps

                // Estrai la traccia audio dal video originale mediante Web Audio API
                let audioTrack: MediaStreamTrack | null = null;
                let audioCtx: AudioContext | null = null;
                try {
                    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                    if (AudioContextClass) {
                        audioCtx = new AudioContextClass();
                        const source = audioCtx.createMediaElementSource(video);
                        const dest = audioCtx.createMediaStreamDestination();
                        source.connect(dest);
                        audioTrack = dest.stream.getAudioTracks()[0] || null;
                    }
                } catch (audioErr) {
                    console.warn("Impossibile catturare la traccia audio del video:", audioErr);
                }

                // Cattura lo stream video del canvas a 25 fps
                let stream: MediaStream;
                try {
                    const capturableCanvas = canvas as HTMLCanvasElement & { mozCaptureStream?: (fps?: number) => MediaStream };
                    stream = capturableCanvas.captureStream ? capturableCanvas.captureStream(25) : capturableCanvas.mozCaptureStream!(25);
                    if (audioTrack) {
                        stream.addTrack(audioTrack); // Unisci la traccia audio originale
                    }
                } catch {
                    URL.revokeObjectURL(video.src);
                    if (audioCtx) audioCtx.close().catch(() => {});
                    return resolve(file);
                }

                // Trova il tipo mime supportato dal browser per la registrazione
                let mimeType = 'video/webm;codecs=vp9';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'video/webm;codecs=vp8';
                }
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'video/webm';
                }
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'video/mp4';
                }

                let mediaRecorder: MediaRecorder;
                try {
                    mediaRecorder = new MediaRecorder(stream, {
                        mimeType,
                        videoBitsPerSecond: bitrate
                    });
                } catch {
                    try {
                        mediaRecorder = new MediaRecorder(stream);
                    } catch {
                        URL.revokeObjectURL(video.src);
                        if (audioCtx) audioCtx.close().catch(() => {});
                        return resolve(file);
                    }
                }

                const chunks: Blob[] = [];
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        chunks.push(e.data);
                    }
                };

                mediaRecorder.onstop = () => {
                    URL.revokeObjectURL(video.src);
                    if (audioCtx) {
                        audioCtx.close().catch(() => {});
                    }
                    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
                    const ext = mimeType.includes('mp4') ? '.mp4' : '.webm';
                    const processedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + "_watermarked" + ext, {
                        type: blob.type,
                        lastModified: Date.now()
                    });
                    resolve(processedFile);
                };

                // Avvia la riproduzione del video e il registratore
                video.play().catch(() => {
                    URL.revokeObjectURL(video.src);
                    if (audioCtx) audioCtx.close().catch(() => {});
                    resolve(file);
                });
                mediaRecorder.start();

                const drawFrame = () => {
                    if (video.paused || video.ended) {
                        if (mediaRecorder.state === 'recording') {
                            mediaRecorder.stop();
                        }
                        return;
                    }

                    // 1. Disegna il frame video corrente nel canvas
                    ctx.drawImage(video, 0, 0, width, height);

                    // 2. Disegna sopra il watermark
                    if (!noWatermark) {
                        // Watermark proporzionato al 70% della larghezza del video
                        const wmWidth = width * 0.70;
                        const wmHeight = (wm.height * wmWidth) / wm.width;
                        const x = (width - wmWidth) / 2;
                        const y = height - wmHeight - (height * 0.05);

                        ctx.globalAlpha = 1.0;
                        ctx.drawImage(wm, x, y, wmWidth, wmHeight);
                    }

                    requestAnimationFrame(drawFrame);
                };

                video.onplay = () => {
                    requestAnimationFrame(drawFrame);
                };

                video.onerror = () => {
                    if (mediaRecorder.state === 'recording') {
                        mediaRecorder.stop();
                    } else {
                        URL.revokeObjectURL(video.src);
                        if (audioCtx) audioCtx.close().catch(() => {});
                        resolve(file);
                    }
                };
            };

            video.onerror = () => {
                URL.revokeObjectURL(video.src);
                resolve(file);
            };
        }
    });
}
