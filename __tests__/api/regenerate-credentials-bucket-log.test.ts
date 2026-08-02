import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il bucket delle credenziali non fallisce più in silenzio.
 *
 * PERCHÉ QUESTO TEST ESISTE. La riga era
 * `await admin.storage.createBucket('credenziali', { public: false }).catch(() => {})`
 * ed era sbagliata due volte. Primo: lo Storage NON lancia, ritorna `{ error }` — quel
 * `.catch` non ha mai intercettato niente, l'errore veniva scartato dal fatto stesso di non
 * guardarlo. Secondo: è il percorso delle EMAIL DI CREDENZIALI, cioè il difetto storico da
 * cui nasce l'intera regola 6 di AGENTS.md — per mesi nessuna credenziale arrivò a
 * destinazione perché il provider rispondeva 403 e il codice registrava solo il numero.
 *
 * Il test non guarda lo status della risposta: la route risponde 200 in tutti e due i casi,
 * ed è giusto così (la password è già stata cambiata, il PDF è un effetto collaterale). Guarda
 * la MUTAZIONE che conta davvero qui — la riga di log — e distingue i due esiti:
 *  · bucket già presente (il caso normale in tutti gli ambienti) → `info`, nessun allarme;
 *  · qualunque altro errore → `error`, con l'oggetto d'errore vero passato al logger.
 */

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    sendEmail: vi.fn(),
    logScrittura: vi.fn(),
    ensureIdentity: vi.fn(),
    logEvento: vi.fn(),
    /** Cosa risponde `createBucket`. `null` = creato senza errori. */
    erroreCreateBucket: null as { message: string } | null,
    uploadChiamato: 0,
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));
vi.mock('@/lib/auth/scope', () => ({
    assertParentInScope: vi.fn(async () => null),
    assertUtenteInScope: vi.fn(async () => null),
}));
vi.mock('@/lib/email/send', () => ({
    sendEmailDetailed: h.sendEmail,
    sendEmail: async () => true,
    credentialsEmailBody: () => 'body',
}));
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }));
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: vi.fn(async () => undefined) }));
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: vi.fn(async () => undefined) }));
vi.mock('@/lib/pdf/credentials-pdf', () => ({ buildCredentialsPdf: () => Buffer.from('%PDF-finto') }));
vi.mock('@/lib/auth/parent-identity', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/auth/parent-identity')>();
    return { ...actual, ensureParentIdentity: h.ensureIdentity };
});
// Solo `logEvento` è finto: `withRoute` resta quello vero, così il test attraversa
// davvero il wrapper come in produzione.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/logging/logger')>();
    return { ...actual, logEvento: h.logEvento };
});

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({
                        data: {
                            id: 'p1',
                            auth_user_id: 'auth-p',
                            emails: ['p@x.test'],
                            first_name: 'Nome',
                            last_name: 'Cognome',
                        },
                        error: null,
                    }),
                }),
            }),
        }),
        auth: { admin: { updateUserById: async () => ({ data: {}, error: null }) } },
        storage: {
            // La forma VERA di supabase-js: una promise che si risolve con `{ data, error }`,
            // non una che rifiuta. È il punto di tutto il test.
            createBucket: async () => ({ data: null, error: h.erroreCreateBucket }),
            from: () => ({
                upload: async () => {
                    h.uploadChiamato += 1;
                    return { data: { path: 'x.pdf' }, error: null };
                },
            }),
        },
    }),
}));

import { POST } from '@/app/api/admin/regenerate-credentials/route';

const UUID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

function req() {
    return new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ targetKind: 'parent', targetId: UUID }),
    });
}

/** Le chiamate a `logEvento` per l'evento `storage`. */
function righeStorage() {
    return h.logEvento.mock.calls.filter((c) => c[0] === 'storage');
}

describe('regenerate-credentials — il bucket delle credenziali non tace più', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
        h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'segreteria', scuola_id: 's1' } });
        h.sendEmail.mockResolvedValue({ ok: true, error: null });
        h.ensureIdentity.mockResolvedValue({
            ok: true, authUserId: 'auth-p', email: 'p@x.test',
            createdAuth: false, createdUtenti: false, boundNow: false, password: null,
        });
        h.erroreCreateBucket = null;
        h.uploadChiamato = 0;
    });

    it('bucket già presente: una riga `info`, nessun falso allarme — e il PDF si carica lo stesso', async () => {
        h.erroreCreateBucket = { message: 'The resource already exists' };

        const res = await POST(req());
        expect(res.status).toBe(200);

        const righe = righeStorage();
        expect(righe, 'il caso normale deve lasciare UNA riga, non zero e non due').toHaveLength(1);
        expect(righe[0][1]).toBe('info');
        expect(righe[0][2]).toMatchObject({ bucket: 'credenziali', esito: 'bucket-gia-presente' });
        // A `info` non si passa l'oggetto d'errore: non è un guasto, è l'esito atteso.
        expect(righe[0][3]).toBeUndefined();
        // CONTROLLO POSITIVO: il ramo «già presente» non deve interrompere niente.
        expect(h.uploadChiamato).toBe(1);
    });

    it('bucket non creato per un motivo VERO: riga `error` con l’errore del provider allegato', async () => {
        h.erroreCreateBucket = { message: 'new row violates row-level security policy' };

        const res = await POST(req());
        expect(res.status).toBe(200); // la password è già cambiata: la richiesta non fallisce

        const righe = righeStorage();
        expect(righe).toHaveLength(1);
        expect(righe[0][1]).toBe('error');
        expect(righe[0][2]).toMatchObject({ bucket: 'credenziali', esito: 'bucket-non-creato' });
        // Il CORPO dell'errore non si butta via: è l'unica cosa che dice *perché*.
        expect(righe[0][3]).toEqual({ message: 'new row violates row-level security policy' });
    });

    it('nessun errore: nessuna riga di rumore', async () => {
        h.erroreCreateBucket = null;

        const res = await POST(req());
        expect(res.status).toBe(200);
        expect(righeStorage(), 'il percorso felice non deve produrre righe `storage`').toEqual([]);
        expect(h.uploadChiamato).toBe(1);
    });
});
