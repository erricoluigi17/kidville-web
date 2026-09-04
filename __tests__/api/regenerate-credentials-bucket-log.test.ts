import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il bucket delle credenziali non fallisce più in silenzio — e non si crea più a
 * ogni rigenerazione.
 *
 * ─── AGGIORNATO IL 2026-09-04, E LA STORIA QUI SOTTO RESTA PERCHÉ SPIEGA COME ──
 *
 * Il difetto raccontato più giù era vero e la sua correzione ha retto. Quello che
 * non reggeva era la RICHIESTA: creare, a ogni singola rigenerazione, un bucket
 * che esiste dal primo giorno. Misurato in produzione il 2026-09-04:
 * **32 righe `error` in un giorno** con `BucketAlreadyExists`, `stato_http 400`.
 *
 * Non arrivavano da questa route — che già classificava bene, `info` per
 * «esiste» — ma da `supabase-fetch.ts`, dove un 4xx sullo Storage è `error` per
 * invariante dichiarata: *«un 4xx qui è una richiesta sbagliata scritta da noi»*.
 * E aveva ragione: la richiesta sbagliata era chiederlo.
 *
 * Non si allenta l'invariante (varrebbe per tutto lo Storage): si toglie la
 * richiesta. Un canale d'allarme pieno di allarmi falsi è un canale spento, ed è
 * la prima cosa che AGENTS.md dice del rumore.
 *
 * Il fatto che questo file misura è quindi cambiato: non più «come si classifica
 * l'errore di `createBucket`», ma **che `createBucket` non venga più chiamata**,
 * e che il caso che il probe voleva prevenire — bucket assente — venga osservato
 * dove si manifesta davvero, cioè sull'upload.
 *
 * ─── LA STORIA, che spiega perché il `.catch(() => {})` era sbagliato ─────────
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

const h = vi.hoisted(() => {
    const stato = {
        requireStaff: vi.fn(),
        sendEmail: vi.fn(),
        logScrittura: vi.fn(),
        ensureIdentity: vi.fn(),
        logEvento: vi.fn(),
        /** Cosa risponde `createBucket`. `null` = creato senza errori. */
        erroreCreateBucket: null as { message: string } | null,
        /** Quante volte la route ha chiesto di creare il bucket: deve restare 0. */
        createBucketChiamato: 0,
        /** Cosa risponde l'upload del PDF. `null` = caricato. */
        erroreUpload: null as { message: string } | null,
        uploadChiamato: 0,
        /**
         * IL FINTO CLIENT, in una definizione sola, montata su DUE moduli.
         *
         * La route prende il client dal factory strumentato (`@/lib/supabase/server-client`):
         * fingere il solo `@supabase/supabase-js` non intercettava più niente, e il test
         * diventava rosso per il motivo sbagliato — un client VERO contro un database che qui
         * non esiste (e che, prima di `test.env` in `vitest.config.ts`, era la PRODUZIONE).
         */
        creaFinto: () => ({
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
                createBucket: async () => {
                    stato.createBucketChiamato += 1;
                    return { data: null, error: stato.erroreCreateBucket };
                },
                from: () => ({
                    upload: async () => {
                        stato.uploadChiamato += 1;
                        return stato.erroreUpload
                            ? { data: null, error: stato.erroreUpload }
                            : { data: { path: 'x.pdf' }, error: null };
                    },
                }),
            },
        }),
    };
    return stato;
});

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

// Il factory STRUMENTATO: è da qui che la route prende il client (`createAdminClient`).
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => h.creaFinto(),
    createClient: async () => h.creaFinto(),
}));
// E il pacchetto grezzo, che la route non usa più: finto lo stesso, così un ritorno indietro
// non arriva alla rete.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.creaFinto() }));

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
        h.createBucketChiamato = 0;
        h.erroreUpload = null;
        h.uploadChiamato = 0;
    });

    it('NON crea più il bucket a ogni rigenerazione: era la richiesta a essere sbagliata', async () => {
        // 32 righe `error` in un giorno solo, tutte «BucketAlreadyExists», tutte
        // per una domanda la cui risposta era nota dal primo giorno.
        const res = await POST(req());
        expect(res.status).toBe(200);
        expect(h.createBucketChiamato, 'il bucket esiste: non si chiede').toBe(0);
        expect(righeStorage(), 'e non si lascia rumore').toEqual([]);
        // CONTROLLO POSITIVO: togliere la creazione non deve aver rotto il PDF.
        expect(h.uploadChiamato).toBe(1);
    });

    it('bucket davvero assente: l’allarme scatta dove il guasto si manifesta, cioè sull’upload', async () => {
        // È il caso che il probe voleva prevenire. Prevenirlo costava 32 falsi
        // allarmi al giorno; osservarlo costa una riga, e solo quando succede.
        h.erroreUpload = { message: 'Bucket not found' };

        const res = await POST(req());
        // La password è già cambiata: la richiesta non fallisce per un PDF.
        expect(res.status).toBe(200);

        const righe = righeStorage();
        expect(righe).toHaveLength(1);
        expect(righe[0][1]).toBe('error');
        expect(righe[0][2]).toMatchObject({ bucket: 'credenziali', esito: 'bucket-credenziali-assente' });
        // Il CORPO dell'errore non si butta via: è l'unica cosa che dice *perché*.
        expect(righe[0][3]).toEqual({ message: 'Bucket not found' });
    });

    it('un errore di upload che NON è «bucket assente» resta un errore di upload', async () => {
        // Non si etichetta come «bucket mancante» qualunque cosa vada storta: una
        // diagnosi sbagliata manda a cercare nel posto sbagliato.
        h.erroreUpload = { message: 'payload too large' };

        const res = await POST(req());
        expect(res.status).toBe(200);
        const righe = righeStorage();
        expect(righe).toHaveLength(1);
        expect(righe[0][2]).toMatchObject({ esito: 'pdf-credenziali-non-caricato' });
    });
});
