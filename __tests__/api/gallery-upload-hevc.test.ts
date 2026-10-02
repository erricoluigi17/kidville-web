import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import itShared from '../../messages/it/shared.json';

// P10 (2026-07) — difesa in profondità server-side sull'upload della galleria.
//
// Un tempo questa porta guardava i primi 64KB di ogni video (lo sniff del codec) e rifiutava con
// 415 un HEVC o un `.mov`, perché il client «convertiva prima di caricare» e un client vecchio
// poteva sfuggire. Dal 2026-10-02 il percorso vecchio dei video è CHIUSO: ogni `video/*` riceve un
// 409 `VIDEO_APP_DA_AGGIORNARE`, qualunque sia il codec, e nessun byte raggiunge lo Storage
// (`@/lib/media/blocco-legacy-video`, senza interruttori: lo misura
// `__tests__/architecture/blocco-legacy-video.test.ts`). Il test gemello su tutte e tre le porte è
// `__tests__/api/video-legacy-blocco.test.ts`; qui resta la porta multipart delle shell native, con
// i casi che un tempo erano il suo mestiere: l'HEVC e il QuickTime non prendono più il 415 — prendono
// lo STESSO 409 di un H.264 — e la foto continua a passare.
// Il log porta mime + size + codice, MAI il nome del file (può contenere PII di minori).

// Il bucket `gallery` è PRIVATO dal 2026-07-31: l'upload non risponde più con
// un indirizzo pubblico ma con il PERCORSO nel bucket (da salvare) e un link
// firmato per l'anteprima. `getPublicUrl` qui esplode di proposito: se il
// codice tornasse a chiamarlo, questo test lo direbbe.
const SIGNED_URL = 'https://firmato.test/uploads/ed1/x.jpg?token=abc';

/** La frase che la maestra legge davvero (catalogo condiviso): dice di aggiornare l'app. */
const FRASE_AGGIORNA = (itShared as Record<string, string>).erroreVideoAppDaAggiornare;

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    logEvento: vi.fn(),
    uploadCalls: 0,
    uploadPath: null as string | null,
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
                upload: async (path: string) => {
                    h.uploadCalls++;
                    h.uploadPath = path;
                    return { error: null };
                },
                getPublicUrl: () => {
                    throw new Error('bucket privato: getPublicUrl non deve essere usato');
                },
                createSignedUrl: async () => ({ data: { signedUrl: SIGNED_URL }, error: null }),
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

function fileDi(bytes: Uint8Array, type: string, name: string): File {
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
const eventiGallery = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria');

beforeEach(() => {
    vi.clearAllMocks();
    h.uploadCalls = 0;
    h.uploadPath = null;
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } });
});

describe('POST /api/gallery/upload — ogni video riceve il 409, HEVC compreso', () => {
    // Nome file con "PII" fittizia: deve NON comparire da nessuna parte nel log.
    const NOME_FILE = 'video-di-mario-rossi-al-parco.mp4';

    it('fourcc hvc1 (mime video/mp4) → 409 con la frase di aggiornamento, NON più 415', async () => {
        const file = fileDi(ascii('\x00\x00\x00\x20ftyphvc1\x00\x00mdat'), 'video/mp4', NOME_FILE);
        const res = await POST(req(file));
        expect(res.status).toBe(409);
        const j = await res.json();
        expect(j.codice).toBe('VIDEO_APP_DA_AGGIORNARE');
        expect(j.error).toBe(FRASE_AGGIORNA);
        // Rifiutato PRIMA di toccare lo storage: nessun upload.
        expect(h.uploadCalls).toBe(0);
    });

    it('un H.264 (fourcc avc1) riceve lo STESSO 409: il blocco non guarda il codec', async () => {
        // Un tempo questo era il caso «mp4 H.264 prosegue» → 200. Ora un video buono e uno
        // cattivo ricevono la stessa risposta, perché nessuno dei due lo convertirebbe.
        const hevc = await POST(req(fileDi(ascii('\x00\x00\x00\x20ftyphvc1\x00\x00mdat'), 'video/mp4', 'a.mp4')));
        const avc = await POST(req(fileDi(ascii('\x00\x00\x00\x20ftypavc1\x00\x00mdat'), 'video/mp4', 'b.mp4')));
        expect(avc.status).toBe(409);
        expect(await avc.json()).toEqual(await hevc.json());
        expect(h.uploadCalls).toBe(0);
    });

    it('container QuickTime dichiarato dal MIME (.mov) → 409 «aggiorna l\'app», non «formato non ammesso»', async () => {
        const mov = fileDi(ascii('\x00\x00\x00\x14ftypqt  \x00\x00mdat'), 'video/quicktime', 'clip.mov');
        const res = await POST(req(mov));
        expect(res.status).toBe(409);
        expect((await res.json()).codice).toBe('VIDEO_APP_DA_AGGIORNARE');
        expect(h.uploadCalls).toBe(0);
    });

    it('un file che non è nemmeno un video ma dichiara `video/mp4` → lo stesso 409 (si guarda il tipo, non i byte)', async () => {
        const res = await POST(req(fileDi(ascii('questo-non-e-un-video'), 'video/mp4', 'x.mp4')));
        expect(res.status).toBe(409);
        expect(h.uploadCalls).toBe(0);
    });

    it('logga mime + size + codice, MAI il nome del file', async () => {
        const file = fileDi(ascii('\x00\x00\x00\x20ftyphvc1\x00\x00mdat'), 'video/mp4', NOME_FILE);
        await POST(req(file));

        const ev = eventiGallery();
        expect(ev).toHaveLength(1);
        expect(ev[0][1]).toBe('warn');
        expect(ev[0][2]).toMatchObject({
            operazione: 'gallery/upload:POST',
            esito: 'legacy-video-bloccato',
            mime: 'video/mp4',
            size: file.size,
            error_code: 'CLIENT_UPDATE_REQUIRED',
        });
        // Lo sniff non c'è più: nessun evento «video-non-riproducibile», nessun `motivo` di codec.
        expect(JSON.stringify(ev[0][2])).not.toContain('video-non-riproducibile');
        expect(Object.keys(ev[0][2] as object)).not.toContain('motivo');
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
});

describe('POST /api/gallery/upload — la foto prosegue', () => {
    it('image/jpeg → 200 con percorso + anteprima firmata, nessun 409, upload effettuato', async () => {
        const file = fileDi(ascii('\xff\xd8\xff\xe0jpeg'), 'image/jpeg', 'foto.jpg');
        const res = await POST(req(file));
        expect(res.status).toBe(200);
        const j = await res.json();
        // Quello che il client rimanda alla POST /api/gallery è il PERCORSO.
        expect(j.path).toBe(h.uploadPath);
        expect(j.fileUrl).toBe(h.uploadPath);
        expect(j.previewUrl).toBe(SIGNED_URL);
        // Nessun evento di blocco: il blocco è sui video, non sulla porta.
        expect(eventiGallery()).toHaveLength(0);
        expect(h.uploadCalls).toBe(1);
    });
});

describe('POST /api/gallery/upload — gate di ruolo preservato', () => {
    it('403 se il gate docente nega (niente blocco, niente upload)', async () => {
        h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
        const file = fileDi(ascii('ftyphvc1'), 'video/mp4', 'clip.mp4');
        const res = await POST(req(file));
        expect(res.status).toBe(403);
        expect(h.uploadCalls).toBe(0);
        // Senza un docente la porta non rivela nemmeno cosa risponde ai video.
        expect(eventiGallery()).toHaveLength(0);
    });
});
