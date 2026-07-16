import { describe, it, expect, beforeEach } from 'vitest';
import {
    processVideoWithWatermark,
    validateVideoFile,
    VideoConversionError,
} from '@/lib/media/processing';

// P10 — conversione video OBBLIGATORIA per i .mov/HEVC.
// `processVideoWithWatermark(..., { obbligatoria: true })` NON deve più ricadere in
// silenzio sull'originale (che per un HEVC sarebbe un video rotto in bacheca): ogni
// anello che cede diventa un `reject(VideoConversionError)`. Senza l'opzione il
// comportamento LEGACY resta identico: fallback all'originale = `resolve(file)`.
//
// Sotto jsdom NON esiste `MediaRecorder`, quindi la catena cede al PRIMO anello
// (`mediarecorder-non-supportato`): è esattamente il ramo che distingue i due modi.

const MAX = 50 * 1024 * 1024;

function videoMp4(name = 'clip.mp4'): File {
    return new File([new Uint8Array([0, 1, 2, 3])], name, { type: 'video/mp4' });
}

beforeEach(() => {
    // Deterministico: assicura l'assenza di MediaRecorder (jsdom non lo implementa,
    // ma un eventuale polyfill di un altro modulo non deve sporcare questo test).
    delete (window as unknown as Record<string, unknown>).MediaRecorder;
});

describe('processVideoWithWatermark — conversione OBBLIGATORIA', () => {
    it('con { obbligatoria: true } RIGETTA con VideoConversionError (niente originale)', async () => {
        const file = videoMp4();
        await expect(
            processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true })
        ).rejects.toBeInstanceOf(VideoConversionError);
    });

    it('l\'errore riporta il punto di fallimento (primo anello: MediaRecorder assente)', async () => {
        const file = videoMp4();
        await expect(
            processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true })
        ).rejects.toMatchObject({
            name: 'VideoConversionError',
            puntoDiFallimento: 'mediarecorder-non-supportato',
        });
    });
});

describe('processVideoWithWatermark — comportamento LEGACY invariato senza opzione', () => {
    it('senza opzioni: fallback all\'originale = resolve(file)', async () => {
        const file = videoMp4();
        await expect(processVideoWithWatermark(file)).resolves.toBe(file);
    });

    it('con { obbligatoria: false }: fallback all\'originale = resolve(file)', async () => {
        const file = videoMp4();
        await expect(
            processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: false })
        ).resolves.toBe(file);
    });

    it('con opzioni vuote ({}): fallback all\'originale = resolve(file)', async () => {
        const file = videoMp4();
        await expect(
            processVideoWithWatermark(file, '/watermark.png', MAX, {})
        ).resolves.toBe(file);
    });
});

describe('validateVideoFile — allow-list mp4/webm, niente QuickTime', () => {
    it('un file NON video passa senza controlli', () => {
        const jpg = new File([new Uint8Array(4)], 'foto.jpg', { type: 'image/jpeg' });
        expect(validateVideoFile(jpg)).toEqual({ valid: true });
    });

    it('video/mp4 è ammesso', () => {
        expect(validateVideoFile(videoMp4()).valid).toBe(true);
    });

    it('video/webm è ammesso', () => {
        const webm = new File([new Uint8Array(4)], 'clip.webm', { type: 'video/webm' });
        expect(validateVideoFile(webm).valid).toBe(true);
    });

    it('il suffisso codec è tollerato (video/webm;codecs=vp9 → normalizzato)', () => {
        const webm = new File([new Uint8Array(4)], 'clip.webm', { type: 'video/webm;codecs=vp9' });
        expect(validateVideoFile(webm).valid).toBe(true);
    });

    it('video/quicktime NON è ammesso (il .mov va convertito prima)', () => {
        const mov = new File([new Uint8Array(4)], 'clip.mov', { type: 'video/quicktime' });
        const r = validateVideoFile(mov);
        expect(r.valid).toBe(false);
        // Messaggio azionabile: cita i formati validi e la conversione dei .mov/HEVC.
        expect(r.error).toContain('.mp4');
        expect(r.error?.toLowerCase()).toContain('.webm');
    });

    it('oltre 50MB è rifiutato con un messaggio che cita il limite', () => {
        const big = new File([new Uint8Array(8)], 'grosso.mp4', { type: 'video/mp4' });
        Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
        const r = validateVideoFile(big);
        expect(r.valid).toBe(false);
        expect(r.error).toContain('50MB');
    });
});

describe('VideoConversionError — forma diagnostica senza PII', () => {
    it('è un Error, ha name e puntoDiFallimento enum-like nel messaggio', () => {
        const e = new VideoConversionError('capture-stream-fallito');
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('VideoConversionError');
        expect(e.puntoDiFallimento).toBe('capture-stream-fallito');
        expect(e.message).toContain('capture-stream-fallito');
    });
});
