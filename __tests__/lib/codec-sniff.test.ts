import { describe, it, expect } from 'vitest';
import { analizzaContenutoVideo, MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff';

// P10 — sniff del codec/container video sui primi 64KB dell'header (ISO-BMFF / EBML).
// La stessa funzione gira nel client (prima della conversione) e nel server (415):
// è l'unica fonte di verità per «questo video va convertito?». Qui la si esercita con
// buffer sintetici, senza DOM né dipendenze dal browser.

/** Scrive una stringa ASCII in un Uint8Array (i fourcc/brand sono ASCII a 4 byte). */
function ascii(s: string): Uint8Array {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
}

/** Header ISO-BMFF fittizio: `....ftyp<brand/fourcc>....` (i primi 4 byte sono la size). */
function ftyp(fourcc: string): Uint8Array {
    return ascii(`\x00\x00\x00\x20ftyp${fourcc}\x00\x00\x00\x00mdat`);
}

describe('analizzaContenutoVideo — QuickTime va convertito', () => {
    it('MIME video/quicktime → daConvertire (il .mov di iPhone)', () => {
        const r = analizzaContenutoVideo(ascii('qualunque-contenuto'), 'video/quicktime');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('container-quicktime-mime');
    });

    it('brand `qt  ` nel box ftyp (MIME generico) → daConvertire', () => {
        const r = analizzaContenutoVideo(ftyp('qt  '), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('container-quicktime-brand');
    });
});

describe('analizzaContenutoVideo — HEVC / Dolby Vision vanno convertiti', () => {
    it('fourcc hvc1 → daConvertire (motivo codec-hevc-hvc1)', () => {
        const r = analizzaContenutoVideo(ftyp('hvc1'), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('codec-hevc-hvc1');
    });

    it.each(['hev1', 'hvcC', 'dvh1', 'dvhe'])('fourcc %s → daConvertire', (cc) => {
        const r = analizzaContenutoVideo(ftyp(cc), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe(`codec-hevc-${cc}`);
    });

    it('HEVC ha la precedenza su H.264 se compaiono entrambi (mai un video rotto in bacheca)', () => {
        // Un mp4 malandato con sia avc1 sia hvc1 nell'header: si converte comunque.
        const r = analizzaContenutoVideo(ascii('ftypavc1....hvc1'), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('codec-hevc-hvc1');
    });
});

describe('analizzaContenutoVideo — formati già riproducibili passano', () => {
    it('fourcc avc1 (H.264) → passa (motivo codec-h264-avc1)', () => {
        const r = analizzaContenutoVideo(ftyp('avc1'), 'video/mp4');
        expect(r.daConvertire).toBe(false);
        expect(r.motivo).toBe('codec-h264-avc1');
    });

    it('fourcc avcC (H.264) → passa', () => {
        const r = analizzaContenutoVideo(ftyp('avcC'), 'video/mp4');
        expect(r.daConvertire).toBe(false);
        expect(r.motivo).toBe('codec-h264-avcC');
    });

    it('magic EBML (webm/mkv container) → passa', () => {
        const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
        const r = analizzaContenutoVideo(webm, '');
        expect(r.daConvertire).toBe(false);
        expect(r.motivo).toBe('webm');
    });

    it('MIME video/webm (header non EBML) → passa', () => {
        const r = analizzaContenutoVideo(ascii('nessun-magic'), 'video/webm');
        expect(r.daConvertire).toBe(false);
        expect(r.motivo).toBe('webm');
    });

    it('accetta anche un ArrayBuffer, non solo un Uint8Array', () => {
        const r = analizzaContenutoVideo(ftyp('avc1').buffer, 'video/mp4');
        expect(r.daConvertire).toBe(false);
        expect(r.motivo).toBe('codec-h264-avc1');
    });
});

describe('analizzaContenutoVideo — sul dubbio è CONSERVATIVO', () => {
    it('buffer troncato/senza prove + MIME generico → daConvertire (indeterminato)', () => {
        // Il box `moov` col fourcc può stare oltre i 64KB campionati: meglio una
        // conversione in più che un video non riproducibile in bacheca.
        const r = analizzaContenutoVideo(ascii('ftyp'), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('indeterminato-conservativo');
    });

    it('buffer VUOTO → daConvertire (conservativo)', () => {
        const r = analizzaContenutoVideo(new Uint8Array(0), 'video/mp4');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('indeterminato-conservativo');
    });

    it('MIME assente e header ignoto → daConvertire (conservativo)', () => {
        const r = analizzaContenutoVideo(ascii('xxxxxxxx'), '');
        expect(r.daConvertire).toBe(true);
        expect(r.motivo).toBe('indeterminato-conservativo');
    });
});

describe('MESSAGGIO_VIDEO_NON_CONVERTIBILE — azionabile e senza PII', () => {
    it('indica il percorso Impostazioni → Fotocamera → Formati → Più compatibile', () => {
        expect(MESSAGGIO_VIDEO_NON_CONVERTIBILE).toContain('Impostazioni');
        expect(MESSAGGIO_VIDEO_NON_CONVERTIBILE).toContain('Più compatibile');
        expect(MESSAGGIO_VIDEO_NON_CONVERTIBILE.toLowerCase()).toContain('.mp4');
    });
});
