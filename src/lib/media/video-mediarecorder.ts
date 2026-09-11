import { logClient } from '@/lib/logging/client';
import { VideoConversionError } from './processing';

/**
 * Applica il watermark del logo al video e lo comprime se necessario per rientrare nei limiti di peso.
 * Utilizza l'API MediaRecorder, Canvas e Web Audio API per unire video e traccia audio nativamente.
 *
 * `opzioni.obbligatoria`: quando true, ogni fallback silenzioso all'originale diventa un
 * `reject(VideoConversionError)`. Serve ai video HEVC/.mov, che NON sono riproducibili da
 * Chrome/Android: consegnare l'originale sarebbe consegnare un video rotto in bacheca. Senza
 * l'opzione il comportamento LEGACY resta identico (fallback all'originale = `resolve(file)`).
 */
export function processVideoWithWatermark(
    file: File,
    watermarkUrl: string = '/watermark.png',
    maxSizeBytes: number = 50 * 1024 * 1024,
    opzioni?: { obbligatoria?: boolean }
): Promise<File> {
    return new Promise<File>((resolve, reject) => {
        // Punto di fallimento: se la conversione è OBBLIGATORIA si rigetta (il video non è
        // riproducibile, l'originale non va consegnato); altrimenti si torna all'originale.
        const fallisci = (punto: string) => {
            if (opzioni?.obbligatoria) reject(new VideoConversionError(punto));
            else resolve(file);
        };

        if (typeof window === 'undefined' || !window.MediaRecorder) {
            return fallisci('mediarecorder-non-supportato');
        }

        // Carica prima il watermark
        const wm = new Image();
        wm.src = watermarkUrl;
        
        wm.onload = () => {
            startProcessing(false);
        };
        
        wm.onerror = () => {
            logClient({ livello: 'warn', evento: 'js', messaggio: 'watermark-video-non-caricato' });
            startProcessing(true); // Esegui solo compressione senza watermark
        };

        function startProcessing(noWatermark: boolean) {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            // NON si silenzia l'elemento con la proprietà `muted`: farlo svuoterebbe anche la
            // traccia catturata via `createMediaElementSource` → i video convertiti uscirebbero
            // SENZA audio (era esattamente questo il bug). L'audio non arriva agli speaker perché
            // il grafo Web Audio (sotto) instrada l'elemento nella registrazione e NON in
            // `audioCtx.destination` (niente eco).
            video.playsInline = true;

            video.onloadedmetadata = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(video.src);
                    return fallisci('canvas-2d-non-disponibile');
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
                } catch {
                    logClient({ livello: 'warn', evento: 'js', messaggio: 'traccia-audio-non-catturata' });
                    // Cattura Web Audio fallita: qui NON c'è alcuna traccia da preservare, quindi
                    // silenziare l'elemento è sicuro. Si azzera il VOLUME (non la proprietà
                    // `muted`, coerentemente con la scelta qui sopra) così l'elemento non suona
                    // dagli speaker durante la conversione. Ramo di ripiego raro: nel percorso
                    // normale la cattura riesce e questo non serve.
                    video.volume = 0;
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
                    return fallisci('capture-stream-fallito');
                }

                // Tipo mime supportato per la registrazione. Si ANTEPONE `video/mp4;codecs=avc1`
                // (H.264, riproducibile ovunque: Chrome ≥126, Safari), con fallback su webm come
                // prima. Così il file convertito è compatibile col maggior numero di dispositivi.
                const candidatiMime = [
                    'video/mp4;codecs=avc1',
                    'video/webm;codecs=vp9',
                    'video/webm;codecs=vp8',
                    'video/webm',
                    'video/mp4',
                ];
                const mimeType = candidatiMime.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';

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
                        return fallisci('mediarecorder-init-fallito');
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
                    fallisci('play-fallito');
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
                        // Già registrato qualcosa: si chiude e `onstop` risolve col convertito.
                        mediaRecorder.stop();
                    } else {
                        URL.revokeObjectURL(video.src);
                        if (audioCtx) audioCtx.close().catch(() => {});
                        fallisci('video-errore-durante-conversione');
                    }
                };
            };

            // Metadati illeggibili: è QUI che casca un HEVC/.mov su Chrome/Android — il decoder
            // non lo apre e `onloadedmetadata` non scatta mai. Con conversione obbligatoria è il
            // punto in cui si rigetta (niente originale non riproducibile in bacheca).
            video.onerror = () => {
                URL.revokeObjectURL(video.src);
                fallisci('video-metadati-illeggibili');
            };
        }
    });
}
