import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * IL TIPO DI FILE DICHIARATO DAL CLIENT È UN'AFFERMAZIONE DEL CLIENT (W7 · collaudo 2026-07-31).
 *
 * MISURATO SUL VERO, dal tester sicurezza:
 *  · `task_allegati` era **l'unico bucket con `allowed_mime_types = null`**: un finto `.html`
 *    caricato con `type: text/html` è stato memorizzato con quel mimetype. Oggi lo Storage lo
 *    SERVE `text/plain` + `nosniff`, quindi nessuna XSS — ma la difesa è del provider, non
 *    nostra, e il giorno in cui cambia non ce lo viene a dire nessuno.
 *  · `avvisi/upload` non aveva il gate applicativo che `news/upload` ha ricevuto lo stesso
 *    giorno: un `.txt` usciva come **`500 {"error":"mime type text/plain is not supported"}`**
 *    — il testo grezzo del provider, in faccia a una segretaria, dove serviva un **415**.
 *
 * QUESTO FILE INCHIODA IL COMPORTAMENTO, non lo status soltanto:
 *  1. il file NON deve arrivare allo Storage (asserzione sulla MUTAZIONE: `uploadPath` resta
 *     `null`) — un 415 dopo il caricamento non sarebbe un gate, sarebbe un commento;
 *  2. il corpo porta un **codice** traducibile, non la prosa del provider;
 *  3. accanto resta una riga di log `warn` con mime e dimensione, e **mai il nome del file**:
 *     «certificato-<cognome>.pdf» dice chi è il bambino;
 *  4. ogni rifiuto ha il suo CONTROLLO POSITIVO (lo stesso upload con un tipo ammesso passa e
 *     arriva davvero allo Storage), altrimenti una route che fallisse sempre sarebbe verde qui.
 */

const SEDE = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Il limite dei due bucket in produzione, misurato il 2026-08-01: 10 MB esatti. */
const LIMITE_BYTE = 10485760;

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    uploadPath: null as string | null,
    uploadContentType: null as string | null,
    uploadErrore: null as unknown,
    rispostaFirma: null as unknown,
}));

vi.mock('@/lib/auth/require-staff', () => ({
    requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}));
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
}));

const storage = {
    from: () => ({
        upload: async (path: string, _corpo: unknown, opzioni?: { contentType?: string }) => {
            h.uploadPath = path;
            h.uploadContentType = opzioni?.contentType ?? null;
            return { error: h.uploadErrore };
        },
        createSignedUrl: async () => h.rispostaFirma,
    }),
};

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({ storage }),
}));

import { POST as AVVISI_UPLOAD } from '@/app/api/avvisi/upload/route';
import { POST as TASKS_UPLOAD } from '@/app/api/tasks/upload/route';

/** Request multipart minimale: le due route leggono solo `formData().get('file')`. */
const uploadReq = (file: File): Request =>
    ({
        headers: new Headers(),
        url: 'http://test/api/upload',
        formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
    }) as unknown as Request;

const fileFinto = (nome: string, tipo: string, byte = 5): File => {
    const f = new File([new Uint8Array(Math.min(byte, 64)) as unknown as BlobPart], nome, { type: tipo });
    // La dimensione si falsifica invece di allocare 10 MB: al gate serve `size`, non il contenuto.
    if (byte > 64) Object.defineProperty(f, 'size', { value: byte });
    return f;
};

const eventiStorage = (livello: string) =>
    h.logEvento.mock.calls.filter((c) => c[0] === 'storage' && c[1] === livello);

beforeEach(() => {
    vi.clearAllMocks();
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } });
    h.uploadPath = null;
    h.uploadContentType = null;
    h.uploadErrore = null;
    h.rispostaFirma = { data: { signedUrl: 'https://x/object/sign/b/k?token=T' }, error: null };
});

describe.each([
    ['POST /api/avvisi/upload', AVVISI_UPLOAD, 'avvisi/upload:POST', 'avvisi_allegati'] as const,
    ['POST /api/tasks/upload', TASKS_UPLOAD, 'tasks/upload:POST', 'task_allegati'] as const,
])('%s · il tipo dichiarato dal client passa da un gate', (_nome, ROUTE, operazione, bucket) => {
    it('un `.txt` viene rifiutato con 415 e NON arriva mai nel bucket', async () => {
        const res = await ROUTE(uploadReq(fileFinto('note.txt', 'text/plain')));

        expect(res.status).toBe(415);
        // LA MUTAZIONE: il file non è stato caricato affatto. Senza questa, un 415
        // restituito dopo l'upload passerebbe lo stesso — e nel bucket ci sarebbe un `.txt`.
        expect(h.uploadPath, 'Il file non deve arrivare allo Storage.').toBeNull();
    });

    it('un finto `.html` (il file caricato davvero in collaudo) viene rifiutato', async () => {
        const res = await ROUTE(uploadReq(fileFinto('evil.html', 'text/html')));
        expect(res.status).toBe(415);
        expect(h.uploadPath).toBeNull();
    });

    it('il corpo del 415 porta un CODICE traducibile, non il testo grezzo del provider', async () => {
        const res = await ROUTE(uploadReq(fileFinto('note.txt', 'text/plain')));
        const corpo = (await res.json()) as { error?: string; codice?: string };

        expect(corpo.codice).toBe('ALLEGATO_TIPO_NON_AMMESSO');
        expect(typeof corpo.error).toBe('string');
        expect(
            corpo.error,
            'Il messaggio del provider («mime type text/plain is not supported») non è una ' +
                'risposta per chi lavora in segreteria.',
        ).not.toMatch(/is not supported|mime type/i);
    });

    it('rifiuto → riga `warn` con mime e dimensione, e MAI il nome del file', async () => {
        await ROUTE(uploadReq(fileFinto('certificato-medico-bruna.txt', 'text/plain')));

        const avvisi = eventiStorage('warn');
        expect(avvisi).toHaveLength(1);
        expect(avvisi[0][2]).toMatchObject({ operazione, esito: 'mime-non-ammesso', bucket, mime: 'text/plain' });
        // Un rifiuto non è un successo: la riga `info` non deve esserci.
        expect(eventiStorage('info')).toHaveLength(0);
        const scritto = JSON.stringify(h.logEvento.mock.calls);
        expect(scritto).not.toContain('certificato');
        expect(scritto).not.toContain('bruna');
    });

    it('CONTROLLO POSITIVO · un PDF passa il gate e arriva davvero nel bucket', async () => {
        const res = await ROUTE(uploadReq(fileFinto('circolare.pdf', 'application/pdf')));

        expect(res.status).toBe(200);
        expect(h.uploadPath, 'Il file ammesso deve essere caricato.').not.toBeNull();
        expect(h.uploadContentType).toBe('application/pdf');
        expect(eventiStorage('warn')).toHaveLength(0);
    });

    it('CONTROLLO POSITIVO · una foto JPEG passa (è il caso d’uso di tutti i giorni)', async () => {
        const res = await ROUTE(uploadReq(fileFinto('foto.jpg', 'image/jpeg')));
        expect(res.status).toBe(200);
        expect(h.uploadPath).not.toBeNull();
    });

    it('il suffisso codec non fa rifiutare un tipo ammesso (`image/jpeg;charset=…`)', async () => {
        const res = await ROUTE(uploadReq(fileFinto('foto.jpg', 'image/jpeg; charset=binary')));
        expect(res.status).toBe(200);
        // E allo Storage arriva il tipo NORMALIZZATO, non la stringa col suffisso.
        expect(h.uploadContentType).toBe('image/jpeg');
    });

    it('oltre il limite del bucket → 413 e nessun caricamento', async () => {
        const res = await ROUTE(uploadReq(fileFinto('grosso.pdf', 'application/pdf', LIMITE_BYTE + 1)));

        expect(res.status).toBe(413);
        expect(h.uploadPath, 'Un file oltre il limite non deve nemmeno partire.').toBeNull();
        const corpo = (await res.json()) as { codice?: string };
        expect(corpo.codice).toBe('ALLEGATO_TROPPO_GRANDE');

        const avvisi = eventiStorage('warn');
        expect(avvisi).toHaveLength(1);
        expect(avvisi[0][2]).toMatchObject({ operazione, esito: 'allegato-troppo-grande', bucket, byte: LIMITE_BYTE + 1 });
    });

    it('CONTROLLO POSITIVO · esattamente al limite si carica (il gate non è un off-by-one)', async () => {
        const res = await ROUTE(uploadReq(fileFinto('al-limite.pdf', 'application/pdf', LIMITE_BYTE)));
        expect(res.status).toBe(200);
        expect(h.uploadPath).not.toBeNull();
    });
});
