import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * S31 — IL MESSAGGIO DEL FORNITORE NON ARRIVA IN FACCIA ALLA SEGRETERIA.
 *
 * Il gate MIME (`src/lib/allegati/mime.ts`, ondata 4) chiude i casi PREVISTI: tipo non
 * ammesso → 415, file troppo grande → 413, e nessuno dei due tocca lo Storage. Ma la via
 * dell'errore imprevisto era rimasta aperta: quando `storage.upload()` fallisce per un
 * motivo qualunque — il bucket che stringe la sua lista dei tipi, una quota, un guasto —
 * le due route rigiravano al client `{ error: error.message }` con status 500, cioè il
 * TESTO GREZZO del provider. In collaudo (2026-07-31) quel testo era
 * «mime type text/plain is not supported»: nomina un vincolo interno, è in inglese dentro
 * un'interfaccia che può essere italiana, e a chi lavora in segreteria non dice cosa fare.
 *
 * Le due metà della correzione, e questo file le pretende ENTRAMBE:
 *  · verso il CLIENT esce un messaggio comprensibile con un CODICE traducibile;
 *  · verso il LOG il corpo dell'errore del provider resta INTERO (AGENTS §3): senza,
 *    l'unico posto in cui si può capire perché un upload fallisce sarebbe vuoto — è
 *    esattamente il guasto delle email di credenziali, dove si registrava «403» e non
 *    «403 the domain is not verified».
 *
 * Le asserzioni negative («non contiene il testo del provider») hanno tutte il loro
 * CONTROLLO POSITIVO: che il testo ci sia nel log, e che un upload riuscito continui a
 * rispondere 200. Senza, una route che rispondesse sempre 500 vuoto sarebbe verde qui.
 */

const SEDE = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Il messaggio esatto misurato in collaudo, quello che NON deve uscire. */
const MESSAGGIO_PROVIDER = 'mime type text/plain is not supported';

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    uploadPath: null as string | null,
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
        upload: async (path: string) => {
            h.uploadPath = path;
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

const uploadReq = (file: File): Request =>
    ({
        headers: new Headers(),
        url: 'http://test/api/upload',
        formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
    }) as unknown as Request;

/** Un allegato AMMESSO: il gate MIME lo lascia passare, così si arriva allo Storage. */
const pdf = (): File => new File([new Uint8Array(4) as unknown as BlobPart], 'circolare.pdf', { type: 'application/pdf' });

beforeEach(() => {
    vi.clearAllMocks();
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } });
    h.uploadPath = null;
    h.uploadErrore = null;
    h.rispostaFirma = { data: { signedUrl: 'https://x/object/sign/b/k?token=T' }, error: null };
});

describe.each([
    ['POST /api/avvisi/upload', AVVISI_UPLOAD, 'avvisi/upload:POST'] as const,
    ['POST /api/tasks/upload', TASKS_UPLOAD, 'tasks/upload:POST'] as const,
])('%s · lo Storage fallisce', (_nome, ROUTE, operazione) => {
    it('il testo grezzo del provider NON torna al client', async () => {
        h.uploadErrore = { message: MESSAGGIO_PROVIDER, statusCode: '415' };

        const res = await ROUTE(uploadReq(pdf()));
        const corpo = JSON.stringify(await res.json());

        expect(res.status).toBe(500);
        expect(corpo, 'Il messaggio del fornitore è arrivato al client.').not.toContain('mime type');
        expect(corpo).not.toContain('is not supported');
    });

    it('il corpo porta un CODICE traducibile e una frase comprensibile', async () => {
        h.uploadErrore = { message: MESSAGGIO_PROVIDER, statusCode: '415' };

        const res = await ROUTE(uploadReq(pdf()));
        const corpo = (await res.json()) as { error?: string; codice?: string };

        expect(corpo.codice).toBe('ALLEGATO_NON_CARICATO');
        expect(typeof corpo.error).toBe('string');
        expect(corpo.error!.length).toBeGreaterThan(10);
    });

    it('CONTROLLO POSITIVO · il messaggio del provider resta INTERO nel log', async () => {
        h.uploadErrore = { message: MESSAGGIO_PROVIDER, statusCode: '415' };

        await ROUTE(uploadReq(pdf()));

        expect(h.logErrore).toHaveBeenCalled();
        const scritto = JSON.stringify(h.logErrore.mock.calls);
        expect(
            scritto,
            'Il perché del guasto deve restare da qualche parte: qui è l’unico posto in cui può esistere.',
        ).toContain(MESSAGGIO_PROVIDER);
        expect(scritto).toContain(operazione);
    });

    it('anche il guasto imprevisto (eccezione) risponde con un codice, non con «Internal Server Error» nudo', async () => {
        // `formData()` che lancia: è il ramo `catch` in fondo alla route.
        const rotta = {
            headers: new Headers(),
            url: 'http://test/api/upload',
            formData: async () => { throw new Error('boom di trasporto'); },
        } as unknown as Request;

        const res = await ROUTE(rotta);
        const corpo = (await res.json()) as { error?: string; codice?: string };

        expect(res.status).toBe(500);
        expect(corpo.codice).toBe('ALLEGATO_NON_CARICATO');
        // E il guasto vero resta nel log, col suo messaggio. Si guarda l'ARGOMENTO, non la
        // sua serializzazione: `JSON.stringify(new Error('x'))` è `{}` — le proprietà di
        // `Error` non sono enumerabili — e un'asserzione su quella stringa sarebbe rossa
        // anche con il log giusto.
        expect(h.logErrore).toHaveBeenCalled();
        const passato = h.logErrore.mock.calls[0][1] as Error;
        expect(passato).toBeInstanceOf(Error);
        expect(passato.message).toBe('boom di trasporto');
    });

    it('CONTROLLO POSITIVO · quando lo Storage NON fallisce si risponde 200 e non si logga nessun errore', async () => {
        const res = await ROUTE(uploadReq(pdf()));

        expect(res.status).toBe(200);
        expect(h.uploadPath).not.toBeNull();
        expect(h.logErrore).not.toHaveBeenCalled();
    });
});
