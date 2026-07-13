import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

/**
 * `externalFetch` — il corpo dell'errore del provider non si butta più via.
 *
 * È il test del guasto che dà il nome all'intero progetto: per mesi nessuna email di
 * credenziali è arrivata a un genitore perché Resend rispondeva `403` e il codice registrava
 * soltanto il numero — mentre il corpo diceva «the kidville.it domain is not verified».
 * Nessun test era rosso. Questi lo sono, se qualcuno rimette il numero al posto del corpo.
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (guardia valutata al caricamento del
 * modulo) e `.env.local` punta al DB di PRODUZIONE: una suite che scrive log in produzione è
 * un incidente, non un test. Perciò `carica()` ricarica il grafo con `VITEST=''` e `app-log`
 * MOCKATO — si vede la riga vera (console + riga persistita) senza toccare nessun database.
 * È lo stesso schema di `logging-logger.test.ts` e `logging-app-log.test.ts`.
 */

type Riga = Record<string, unknown>;

let appLog: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

/**
 * Ricarica il modulo con la guardia SILENZIOSO spenta. Tutto (external, logger, native-push,
 * send) va preso dallo STESSO registry appena ricaricato: un import statico punterebbe a
 * un'altra istanza del logger, e il mock di `app-log` non vedrebbe niente.
 */
async function carica() {
    appLog = vi.fn(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    const external = await import('@/lib/logging/external');
    const push = await import('@/lib/push/native-push');
    const email = await import('@/lib/email/send');
    return { ...external, ...push, ...email };
}

/** La riga PERSISTITA (quella che finirà in `app_log`, cioè l'unica che leggeremo in SQL). */
async function rigaPersistita(n = 0): Promise<Riga> {
    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(n));
    return appLog.mock.calls[n][0] as Riga;
}

/**
 * L'ULTIMA riga persistita, dopo averne attese almeno `attese`.
 *
 * Serve a FCM: un invio che deve rinnovare il token OAuth produce DUE righe (prima
 * `oauth-token`, poi `messages:send`), perché ora anche la chiamata OAuth è osservata — era
 * il ramo che diceva soltanto «OAuth token FCM fallito: 400». In produzione il token è in
 * cache per un'ora, quindi la riga OAuth è una all'ora, non una per push.
 */
async function ultimaRiga(attese = 1): Promise<Riga> {
    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(attese));
    return appLog.mock.calls[appLog.mock.calls.length - 1][0] as Riga;
}

/** Tutto ciò che è finito su console. */
function scritto(): string {
    return [...log.mock.calls, ...err.mock.calls]
        .flat()
        .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
        .join('\n');
}

function rispondi(corpo: string, stato: number): typeof fetch {
    return vi.fn(async () => new Response(corpo, { status: stato })) as unknown as typeof fetch;
}

beforeEach(() => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('KV_LOG_LEVEL', '');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. L'INVARIANTE: su !ok il corpo si legge, si logga e si propaga.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('externalFetch — il corpo dell\'errore è obbligatorio', () => {
    it('su !ok restituisce lo status E il corpo del provider', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"The kidville.it domain is not verified"}', 403);

        const r = await externalFetch('resend', 'https://api.resend.com/emails', { method: 'POST' });

        expect(r.ok).toBe(false);
        expect(r.stato).toBe(403);
        expect(r.corpo).toContain('domain is not verified');
        // Il corpo è stato consumato da noi: non si restituisce una Response svuotata.
        expect(r.res).toBeUndefined();
    });

    it('IL PUNTO DI TUTTO: il corpo finisce nella COLONNA `messaggio`, in chiaro, non in un campo redatto', async () => {
        // Un campo `corpo` dentro `campi` diventerebbe `[redatto:str/N]` in `app_log` (redact
        // è a lista bianca PER CHIAVE) — cioè illeggibile proprio nel canale che dura 30
        // giorni e si interroga in SQL. Passato come errore, `descriviErrore` lo normalizza.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"The kidville.it domain is not verified"}', 403);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(r.livello).toBe('error');
        expect(String(r.messaggio)).toContain('domain is not verified');
        expect(String(r.messaggio)).not.toContain('[redatto');
        // Interrogabile: `where codice = '403'` e `where stato_http = 403`.
        expect(r.codice).toBe('403');
        expect(r.statoHttp).toBe(403);
    });

    it('lo status DA SOLO non basta più: la riga su Vercel porta il motivo', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"domain is not verified"}', 403);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const righe = scritto();
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('provider=resend');
        expect(righe).toContain('code=403');
        expect(righe).toContain('domain is not verified'); // ← il bug del 2026, per iscritto
    });

    it('su ok NON tocca il corpo: lo stream si consuma una volta sola, e il json() è del chiamante', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"id":"x"}', 200);

        const r = await externalFetch('resend', 'https://api.resend.com/emails');

        expect(r.ok).toBe(true);
        expect(r.corpo).toBe('');
        expect(await r.res!.json()).toEqual({ id: 'x' });
    });

    it('su errore di rete NON lancia: ritorna un esito leggibile', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;

        const r = await externalFetch('fcm', 'https://fcm.googleapis.com/x');

        expect(r.ok).toBe(false);
        expect(r.stato).toBe(0);
        expect(r.corpo).toContain('ECONNREFUSED');
    });

    it('rete giù: `stato` NON finisce in colonna come 0 (uno zero non è uno status HTTP)', async () => {
        // `where stato_http >= 500` conta i guasti: uno 0 lì dentro sarebbe uno status che non
        // esiste. La riga c'è comunque, con il messaggio dell'eccezione.
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('fetch failed');
        }) as unknown as typeof fetch;

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(r.statoHttp).toBeUndefined();
        expect(String(r.messaggio)).toContain('fetch failed');
        expect(r.livello).toBe('error');
    });

    it('un corpo d\'errore VUOTO non produce una riga muta', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('', 502);

        const r = await externalFetch('aruba', 'https://ws.fatturazione.aruba.it/invio');

        expect(r.ok).toBe(false);
        expect(String((await rigaPersistita()).messaggio)).toContain('HTTP 502');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IL SUCCESSO SI LOGGA (AGENTS, regola 5).
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il battito di successo', () => {
    it('un evento CRITICO (email) persiste anche il successo: "nessun log" ≠ "tutto ok"', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"id":"x"}', 200);

        await externalFetch('resend', 'https://api.resend.com/emails', undefined, {
            evento: 'email',
            campi: { operazione: 'sendEmail' },
        });

        const r = await rigaPersistita();
        expect(r.livello).toBe('info');
        expect(r.evento).toBe('email');
        expect(r.statoHttp).toBe(200);
        // La colonna che un umano legge per prima non deve dire "200".
        expect(r.messaggio).toBe('sendEmail');
    });

    it('un evento NON critico non intasa la tabella con i successi (resta su Vercel)', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('sidi', 'https://sidi.pubblica.istruzione.it/x');

        await new Promise((r) => setTimeout(r, 5));
        expect(appLog).not.toHaveBeenCalled();
        expect(scritto()).toContain('KV_EVT'); // ma la riga su Vercel c'è
    });

    it('senza `operazione` il messaggio è il PATTERN del path, non il numero 200', async () => {
        // `testoEvento()` prende il primo fra msg/esito/operazione/stato: senza `operazione`,
        // la colonna che un umano legge per prima direbbe «200» su ogni riga.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('fcm', 'https://fcm.googleapis.com/v1/projects/kidville-1/messages:send',
            undefined, { evento: 'push' });

        expect((await rigaPersistita()).messaggio).toBe('/v1/projects/kidville-1/messages:send');
    });

    it('e il path passa comunque da `redigiPath`: un id nel path del provider non si logga', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('provider', 'https://x.it/v1/utenti/11111111-2222-3333-4444-555555555555/invia',
            undefined, { evento: 'email' });

        expect((await rigaPersistita()).messaggio).toBe('/v1/utenti/[id]/invia');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LA GRAVITÀ: un token disinstallato non è un guasto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('gravita', () => {
    it('declassa un !ok atteso a `info`: si conta, non allarma', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"error":{"status":"UNREGISTERED"}}', 404);

        await externalFetch('fcm', 'https://fcm.googleapis.com/x', undefined, {
            evento: 'push',
            gravita: () => 'info',
        });

        const r = await rigaPersistita();
        expect(r.livello).toBe('info');
        // Il corpo resta comunque leggibile: declassare non vuol dire buttare via.
        expect(String(r.messaggio)).toContain('UNREGISTERED');
        // E NIENTE Error nativo su console: non inquina `get_runtime_errors`.
        expect(err).not.toHaveBeenCalled();
    });

    it('un predicato che LANCIA non decide al posto nostro: resta `error`', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('boom', 500);

        await externalFetch('fcm', 'https://fcm.googleapis.com/x', undefined, {
            evento: 'push',
            gravita: () => {
                throw new Error('predicato ostile');
            },
        });

        expect((await rigaPersistita()).livello).toBe('error');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. PRIVACY E FAIL-OPEN.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('privacy e fail-open', () => {
    it('un\'email dentro il corpo del provider NON arriva in chiaro nei log', async () => {
        // `sanificaMessaggio` gira anche sul corpo del provider: il contratto di redazione non
        // si scavalca dal basso solo perché il testo arriva da fuori.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"mario.rossi@example.com is not a valid recipient"}', 422);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(JSON.stringify(r)).not.toContain('mario.rossi');
        expect(String(r.messaggio)).toContain('[email]');
        expect(scritto()).not.toContain('mario.rossi');
    });

    it('un corpo d\'errore GIGANTE non viene bufferizzato per intero né spedito al DB', async () => {
        const { externalFetch } = await carica();
        const PEZZO = 'x'.repeat(64_000);
        let emessi = 0;
        const flusso = new ReadableStream<Uint8Array>({
            pull(c) {
                // 6,4 MB se qualcuno leggesse tutto: il limite deve fermarsi ben prima.
                if (emessi++ >= 100) return c.close();
                c.enqueue(new TextEncoder().encode(PEZZO));
            },
        });
        globalThis.fetch = vi.fn(async () =>
            new Response(flusso, { status: 500 })) as unknown as typeof fetch;

        const r = await externalFetch('aruba', 'https://ws.fatturazione.aruba.it/invio');

        expect(r.ok).toBe(false);
        expect(r.corpo.length).toBeLessThanOrEqual(1_000);
        expect(emessi).toBeLessThan(10); // si è smesso di leggere, non si è letto tutto
    });

    it('non lancia MAI: nemmeno se `fetch` restituisce spazzatura', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => undefined) as unknown as typeof fetch;
        await expect(externalFetch('x', 'https://x.it')).resolves.toBeDefined();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. FCM — il corpo non si butta più via, e la semantica di `gone` non si tocca.
 * ════════════════════════════════════════════════════════════════════════════ */

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** OAuth 200 con l'access token, poi la risposta FCM che il test vuole. */
function fcmChe(risponde: { corpo: string; stato: number }): typeof fetch {
    return vi.fn(async (url: unknown) => {
        if (String(url).includes('oauth2')) {
            return new Response('{"access_token":"tok","expires_in":3600}', { status: 200 });
        }
        return new Response(risponde.corpo, { status: risponde.stato });
    }) as unknown as typeof fetch;
}

describe('native-push (FCM)', () => {
    beforeEach(() => {
        vi.stubEnv('FCM_PROJECT_ID', 'kidville');
        vi.stubEnv('FCM_CLIENT_EMAIL', 'svc@kidville.iam.gserviceaccount.com');
        vi.stubEnv('FCM_PRIVATE_KEY', privateKey);
    });

    it('404 → gone (la subscription va rimossa): semantica INVARIATA', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({ corpo: '{"error":{"status":"NOT_FOUND"}}', stato: 404 });

        const r = await sendNativePush('token-x', 'ios', { title: 'x' });

        expect(r).toEqual({ ok: false, gone: true });
    });

    it('400 + UNREGISTERED nel corpo → gone: semantica INVARIATA', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({
            corpo: '{"error":{"status":"UNREGISTERED","message":"token not registered"}}',
            stato: 400,
        });

        const r = await sendNativePush('token-x', 'android', { title: 'x' });

        expect(r).toEqual({ ok: false, gone: true });
    });

    it('400 con un ALTRO motivo NON è gone: il corpo è loggato E propagato (era `fcm_http_400`)', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({
            corpo: '{"error":{"message":"SenderId mismatch"}}',
            stato: 400,
        });

        const r = await sendNativePush('token-x', 'android', { title: 'x' });

        expect(r.gone).toBeUndefined();
        // Prima diceva soltanto `fcm_http_400`, che non dice NULLA.
        expect(r.error).toContain('SenderId mismatch');
        expect(String((await ultimaRiga(2)).messaggio)).toContain('SenderId mismatch');
    });

    it('il successo di una push finisce in tabella (push è un evento critico)', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({ corpo: '{"name":"projects/kidville/messages/1"}', stato: 200 });

        expect(await sendNativePush('token-x', 'ios', { title: 'x' })).toEqual({ ok: true });

        const r = await ultimaRiga(2); // [0] è il rinnovo del token OAuth, [1] l'invio
        expect(r.evento).toBe('push');
        expect(r.livello).toBe('info');
        expect(r.messaggio).toBe('messages:send');
    });

    it('l\'OAuth rifiutato non si riduce più a un numero: il corpo di Google è nel log', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = vi.fn(async () =>
            new Response('{"error":"invalid_grant","error_description":"Invalid JWT Signature"}', { status: 400 }),
        ) as unknown as typeof fetch;

        const r = await sendNativePush('token-x', 'ios', { title: 'x' });

        expect(r.ok).toBe(false);
        expect(String((await rigaPersistita()).messaggio)).toContain('Invalid JWT Signature');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. EMAIL — la scena del delitto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('email/send', () => {
    beforeEach(() => {
        vi.stubEnv('RESEND_API_KEY', 'chiave');
        vi.stubEnv('LOG_HASH_SALT', 'sale');
    });

    it('403 sandbox: il motivo del provider arriva NEL LOG e nell\'esito', async () => {
        const { sendEmailDetailed } = await carica();
        globalThis.fetch = rispondi(
            '{"statusCode":403,"message":"The kidville.it domain is not verified"}', 403);

        const r = await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' });

        expect(r.ok).toBe(false);
        expect(r.error).toContain('403');
        expect(r.error).toContain('domain is not verified');
        expect(String((await rigaPersistita()).messaggio)).toContain('domain is not verified');
    });

    it('l\'invio RIUSCITO lascia un battito in tabella, con il destinatario HASHATO', async () => {
        const { sendEmailDetailed } = await carica();
        globalThis.fetch = rispondi('{"id":"1"}', 200);

        expect(await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' }))
            .toEqual({ ok: true, error: null });

        const r = await rigaPersistita();
        expect(r.evento).toBe('email');
        expect(r.livello).toBe('info');
        expect(r.messaggio).toBe('sendEmail');
        // L'indirizzo non compare MAI: né in tabella né su Vercel.
        expect(JSON.stringify(r)).not.toContain('mamma@example.com');
        expect(scritto()).not.toContain('mamma@example.com');
    });

    it('RESEND_API_KEY assente = `error`, non `info`: zero email e zero sospetti è un incidente', async () => {
        vi.stubEnv('RESEND_API_KEY', '');
        const { sendEmailDetailed } = await carica();

        const r = await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' });

        expect(r.ok).toBe(false);
        const riga = await rigaPersistita();
        expect(riga.livello).toBe('error');
        expect(riga.evento).toBe('config');
        expect(String(riga.messaggio)).toContain('RESEND_API_KEY');
    });

    it('la PASSWORD TEMPORANEA non finisce più nei log (il vecchio console.log stampava il testo)', async () => {
        vi.stubEnv('RESEND_API_KEY', '');
        const { sendEmailDetailed, credentialsEmailBody } = await carica();
        const text = credentialsEmailBody('Maria', 'mamma@example.com', 'Segreta.2026!');

        await sendEmailDetailed({ to: 'mamma@example.com', subject: 'Credenziali', text });

        const tutto = scritto() + JSON.stringify(appLog.mock.calls);
        expect(tutto).not.toContain('Segreta.2026!');
        expect(tutto).not.toContain('Password temporanea');
        expect(tutto).not.toContain('mamma@example.com');
    });
});
