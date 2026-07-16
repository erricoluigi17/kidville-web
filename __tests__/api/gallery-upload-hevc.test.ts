import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { MESSAGGIO_VIDEO_NON_CONVERTIBILE } from '@/lib/media/codec-sniff';

// P10 — difesa in profondità server-side sull'upload della galleria.
// Il client converte HEVC/.mov PRIMA di caricare; ma un client vecchio (o una POST
// diretta) potrebbe spedire comunque un video non riproducibile da Chrome/Android.
// Lo STESSO sniff del client, sui primi 64KB, lo RIFIUTA con 415 + messaggio azionabile.
// Il log porta mime + size + motivo, MAI il nome del file (può contenere PII di minori).

const PUBLIC_URL = 'https://cdn.example/uploads/ed1/x.mp4';

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    logEvento: vi.fn(),
    uploadCalls: 0,
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }));
// Si spia SOLO logEvento (il resto del logger resta reale e silenzioso sotto VITEST).
// Gli eventi di dominio dell'upload hanno gruppo 'gallery'; quelli di `withRoute` 'route'.
vi.mock('@/lib/logging/logger', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/logger')>()),
    logEvento: h.logEvento,
}));
vi.mock('@/lib/supabase/server-client', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => ({
        storage: {
            listBuckets: async () => ({ data: [{ name: 'gallery' }], error: null }),
            createBucket: async () => ({ error: null }),
            updateBucket: async () => ({ error: null }),
            from: () => ({
                upload: async () => {
                    h.uploadCalls++;
                    return { error: null };
                },
                getPublicUrl: () => ({ data: { publicUrl: PUBLIC_URL } }),
            }),
        },
    }),
}));

import { POST } from '@/app/api/gallery/upload/route';

/** Scrive una stringa ASCII in un Uint8Array (fourcc/brand ISO-BMFF sono ASCII a 4 byte). */
function ascii(s: string): Uint8Array {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
}

function fileVideo(bytes: Uint8Array, type: string, name: string): File {
    return new File([bytes as unknown as BlobPart], name, { type });
}

/** Request minimale: la route usa solo `formData().get('file')` (+ header/url difensivi). */
function req(file: File): Request {
    return {
        headers: new Headers(),
        url: 'http://localhost/api/gallery/upload',
        formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
    } as unknown as Request;
}

// Solo gli eventi di DOMINIO dell'upload (via il rumore di 'route' di withRoute).
const eventiGallery = () => h.logEvento.mock.calls.filter((c) => c[0] === 'gallery');

beforeEach(() => {
    vi.clearAllMocks();
    h.uploadCalls = 0;
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } });
});

describe('POST /api/gallery/upload — HEVC rifiutato con 415', () => {
    // Nome file con "PII" fittizia: deve NON comparire da nessuna parte nel log.
    const NOME_FILE = 'video-di-mario-rossi-al-parco.mp4';

    it('fourcc hvc1 (mime video/mp4) → 415 con messaggio azionabile', async () => {
        const file = fileVideo(ascii('\x00\x00\x00\x20ftyphvc1\x00\x00mdat'), 'video/mp4', NOME_FILE);
        const res = await POST(req(file));
        expect(res.status).toBe(415);
        const j = await res.json();
        expect(j.error).toBe(MESSAGGIO_VIDEO_NON_CONVERTIBILE);
        // Rifiutato PRIMA di toccare lo storage: nessun upload.
        expect(h.uploadCalls).toBe(0);
    });

    it('logga mime + size + motivo, MAI il nome del file', async () => {
        const file = fileVideo(ascii('\x00\x00\x00\x20ftyphvc1\x00\x00mdat'), 'video/mp4', NOME_FILE);
        await POST(req(file));

        const ev = eventiGallery();
        expect(ev).toHaveLength(1);
        expect(ev[0][1]).toBe('warn');
        expect(ev[0][2]).toMatchObject({
            operazione: 'gallery/upload:POST',
            esito: 'video-non-riproducibile',
            mime: 'video/mp4',
            size: file.size,
            motivo: 'codec-hevc-hvc1',
        });
        // Privacy: nessun frammento del nome file (né la chiave) nel payload del log.
        const payload = JSON.stringify(ev[0][2]);
        expect(payload).not.toContain('mario');
        expect(payload).not.toContain('rossi');
        expect(payload).not.toContain(NOME_FILE);
        const chiavi = Object.keys(ev[0][2] as object);
        expect(chiavi).not.toContain('name');
        expect(chiavi).not.toContain('nome');
        expect(chiavi).not.toContain('file');
    });

    it('container QuickTime dichiarato dal MIME (.mov) → 415', async () => {
        const mov = fileVideo(ascii('\x00\x00\x00\x14ftypqt  \x00\x00mdat'), 'video/quicktime', 'clip.mov');
        const res = await POST(req(mov));
        expect(res.status).toBe(415);
        expect(h.uploadCalls).toBe(0);
    });
});

describe('POST /api/gallery/upload — mp4 H.264 prosegue', () => {
    it('fourcc avc1 (mime video/mp4) → 200 con fileUrl, nessun 415, upload effettuato', async () => {
        const file = fileVideo(ascii('\x00\x00\x00\x20ftypavc1\x00\x00mdat'), 'video/mp4', 'clip.mp4');
        const res = await POST(req(file));
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.fileUrl).toBe(PUBLIC_URL);
        // Nessun evento di rifiuto video-non-riproducibile.
        expect(eventiGallery()).toHaveLength(0);
        expect(h.uploadCalls).toBe(1);
    });
});

describe('POST /api/gallery/upload — gate di ruolo preservato', () => {
    it('403 se il gate docente nega (niente sniff, niente upload)', async () => {
        h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
        const file = fileVideo(ascii('ftyphvc1'), 'video/mp4', 'clip.mp4');
        const res = await POST(req(file));
        expect(res.status).toBe(403);
        expect(h.uploadCalls).toBe(0);
    });
});
