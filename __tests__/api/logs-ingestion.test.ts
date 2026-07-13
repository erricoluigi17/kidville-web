import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/logs/route';
import { resetRateLimit } from '@/lib/security/rate-limit';
import type { RigaLog } from '@/lib/logging/app-log';

/**
 * `POST /api/logs` — la porta OSTILE: l'unica route che accetta di scrivere in `app_log` su
 * richiesta di chiunque, e per giunta senza autenticazione (gli errori sulla pagina di login
 * sono il caso d'uso principale).
 *
 * COSA SI VERIFICA QUI. Non che la riga arrivi al DB — quello è il mestiere di
 * `__tests__/lib/logging-app-log.test.ts`, che il sink lo esercita davvero. Qui si guarda
 * l'unica cosa che questa route decide: COSA passa e COSA no, con quale forma arriva al sink, e
 * IN QUANTE CHIAMATE. Il sink è quindi una spia, e ci si asserisce sopra.
 *
 * NB: la spia non registra le righe di `withRoute`. Sotto vitest `logger.ts` è SILENZIOSO
 * (guardia valutata al caricamento del modulo), quindi `persisti()` esce subito e non chiama
 * il sink: ciò che la spia vede sono ESATTAMENTE gli eventi ingeriti, nient'altro.
 */

/**
 * La spia è su `appLogBatch`, che è ciò che la route chiama davvero: le righe partono TUTTE
 * INSIEME, in un round-trip solo. `appLog` resta mockata (nessun altro la chiama da qui) e a sua
 * volta passa dal batch, così le due strade finiscono nella stessa spia.
 */
const appLogBatch = vi.fn<(righe: RigaLog[]) => Promise<void>>(async () => {});

vi.mock('@/lib/logging/app-log', () => ({
    appLog: (riga: RigaLog) => appLogBatch([riga]),
    appLogBatch: (righe: RigaLog[]) => appLogBatch(righe),
}));

const UUID = '11111111-2222-3333-4444-555555555555';

function post(
    body: unknown,
    opzioni: { headers?: Record<string, string>; url?: string } = {},
): Request {
    const corpo = typeof body === 'string' ? body : JSON.stringify(body);
    return new Request(opzioni.url ?? 'http://localhost/api/logs', {
        method: 'POST',
        body: corpo,
        headers: { 'content-type': 'application/json', ...opzioni.headers },
    });
}

/** Un evento del client, valido: si parte sempre da qui e si rompe un campo alla volta. */
function evento(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { livello: 'error', evento: 'js', messaggio: 'boom', ...extra };
}

/** Tutte le righe arrivate al sink, nell'ordine in cui la route le ha ingerite. */
function righe(): RigaLog[] {
    return appLogBatch.mock.calls.flatMap((c) => c[0]);
}

/** La riga `n`-esima fra quelle arrivate al sink. */
function riga(n = 0): RigaLog {
    return righe()[n];
}

beforeEach(() => {
    resetRateLimit();
    appLogBatch.mockClear();
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. IL PERCORSO BUONO.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ingestione', () => {
    it('accetta un batch valido da un utente ANONIMO (è il caso d\'uso: la pagina di login)', async () => {
        const res = await POST(post({ eventi: [evento()] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 1, scartati: 0 });
        expect(righe()).toHaveLength(1);
    });

    it('la riga arriva al sink marcata `client`, con piattaforma, rotta e stato', async () => {
        const res = await POST(post({
            piattaforma: 'ios',
            eventi: [evento({
                evento: 'fetch',
                messaggio: 'GET /api/alunni → 500',
                route: '/parent/attendance',
                stato: 500,
            })],
        }));
        expect(res.status).toBe(200);

        const r = riga();
        expect(r.sorgente).toBe('client');
        expect(r.piattaforma).toBe('ios');
        expect(r.livello).toBe('error');
        expect(r.messaggio).toBe('GET /api/alunni → 500');
        expect(r.statoHttp).toBe(500);
        // La rotta della PAGINA: è l'unica cosa che il client sa e il server no (qui
        // `contesto().path` varrebbe `/api/logs` — il camion, non il luogo dell'incidente).
        expect(r.route).toBe('/parent/attendance');
    });

    it('l\'evento è PREFISSATO: un client non può impersonare un evento del server', async () => {
        // Senza il prefisso, `evento: 'cron'` scriverebbe righe che la query di sorveglianza
        // dei cron (`where evento = 'cron'`) conterebbe come battiti veri: un client ostile
        // potrebbe far sembrare VIVO un job morto. È il tipo di bug che si scopre tardi.
        await POST(post({ eventi: [evento({ evento: 'cron' })] }));
        expect(riga().evento).toBe('client:cron');
        expect(riga().evento).not.toBe('cron');
    });

    it('il digest di Next finisce in `codice` (l\'unico filo che lega l\'errore al suo stack server)', async () => {
        await POST(post({ eventi: [evento({ evento: 'react', digest: '1274618402' })] }));
        expect(riga().codice).toBe('1274618402');
    });

    it('ingerisce l\'intero batch, in ordine', async () => {
        const eventi = [evento({ messaggio: 'uno' }), evento({ messaggio: 'due' })];
        const res = await POST(post({ eventi }));
        expect(await res.json()).toEqual({ ok: true, ricevuti: 2, scartati: 0 });
        expect(righe()).toHaveLength(2);
        expect(riga(0).messaggio).toBe('uno');
        expect(riga(1).messaggio).toBe('due');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1-bis. UN ELEMENTO ROTTO NON AFFONDA IL BATCH.
 *
 * Il difetto era questo: la validazione girava sull'ARRAY (`z.array(eventoSchema)`), quindi un
 * solo elemento fuori forma faceva tornare 400 e i fino a 19 log VERI accanto a lui erano persi
 * PER SEMPRE — `flush()` aveva già svuotato la coda e cancellato `localStorage`, e `sendBeacon`
 * non riporta l'esito. Non è un caso di laboratorio: `Promise.reject(new Error())` produce un
 * `messaggio: ''`, che `z.string().min(1)` rifiuta.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('un evento invalido non porta con sé quelli buoni', () => {
    it('scarta il singolo evento rotto e INGERISCE gli altri', async () => {
        const res = await POST(post({
            eventi: [
                evento({ messaggio: 'prima' }),
                evento({ messaggio: '' }), // il caso reale: `Promise.reject(new Error())`
                evento({ messaggio: 'dopo' }),
            ],
        }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 2, scartati: 1 });
        // I due log veri sono arrivati: è tutto il punto del fix.
        expect(righe()).toHaveLength(2);
        expect(riga(0).messaggio).toBe('prima');
        expect(riga(1).messaggio).toBe('dopo');
    });

    it('un batch di soli eventi rotti non lancia e non ingerisce nulla', async () => {
        const res = await POST(post({ eventi: [evento({ livello: 'info' }), { boh: 1 }] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 0, scartati: 2 });
        expect(righe()).toHaveLength(0);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IL CLIENT NON È FIDATO. Nessun campo di correlazione arriva dal body.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il body non detta le chiavi di correlazione', () => {
    it('un `sorgente: server` nel body NON passa: la sorgente è cablata', async () => {
        // Altrimenti un client potrebbe travestire i propri errori da errori del SERVER, e la
        // colonna `sorgente` — quella con cui si separa «si è rotta l'app» da «si è rotto il
        // backend» — direbbe il falso.
        await POST(post({ eventi: [evento({ sorgente: 'server' })] }));
        expect(riga().sorgente).toBe('client');
    });

    it('un `utenteId`/`requestId` nel body viene semplicemente IGNORATO (zod non li conosce)', async () => {
        const spia = { utenteId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', requestId: 'falso' };
        await POST(post({ eventi: [evento(spia)] }));
        const r = riga() as unknown as Record<string, unknown>;
        expect(r.utenteId).toBeUndefined();
        expect(r.requestId).toBeUndefined();
        // I campi di correlazione li legge `appLog` dal CONTESTO, e questa è l'invariante.
    });

    it('l\'identità si prende SERVER-SIDE (?userId=), e solo se è un uuid', async () => {
        // `sendBeacon` non può mandare header: il canale reale è il query param, che è la
        // seconda metà di `getRequestUserId`. Qui si verifica solo che la route non esploda e
        // accetti la richiesta: la colonna `utente_id` la riempie `appLog` leggendo il contesto.
        const res = await POST(post({ eventi: [evento()] }, {
            url: `http://localhost/api/logs?userId=${UUID}`,
        }));
        expect(res.status).toBe(200);

        const spazzatura = await POST(post({ eventi: [evento()] }, {
            url: 'http://localhost/api/logs?userId=%3Cscript%3E',
        }));
        expect(spazzatura.status).toBe(200); // un id malformato costa il campo, non il log
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LE DIFESE. Ognuna ferma ciò che la precedente lascia passare.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('difese', () => {
    /*
     * LE DIFESE DI BATCH (400/413) sono rimaste solo dove il batch NON È LEGGIBILE: troppi byte,
     * JSON malformato, troppi elementi. Lì non c'è nessun log buono da salvare, e rifiutare
     * tutto è l'unica risposta possibile.
     *
     * Le difese sul CONTENUTO del singolo evento (livello, nome, stato) NON rifiutano più il
     * batch: scartano l'evento. Quei tre test qui sotto asserivano `400` + `appLog` mai
     * chiamato — cioè asserivano ESATTAMENTE il difetto (un elemento rotto che si porta via i
     * vicini). Ora asseriscono che l'evento non entra IN TABELLA, che è la difesa vera: quella
     * regge identica, ed è l'unica che contava.
     */
    it('rifiuta un batch oltre il massimo (20): è l\'involucro a essere fuori forma', async () => {
        const eventi = Array.from({ length: 21 }, () => evento());
        const res = await POST(post({ eventi }));
        expect(res.status).toBe(400);
        expect(righe()).toHaveLength(0);
    });

    it('scarta un livello non ammesso: un client non può riempire la tabella di `info`', async () => {
        const res = await POST(post({ eventi: [evento({ livello: 'info' })] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 0, scartati: 1 });
        // La difesa che conta: l'`info` NON è arrivato in tabella.
        expect(righe()).toHaveLength(0);
    });

    it('rifiuta un payload troppo grande dal content-length, PRIMA di parsarlo', async () => {
        const res = await POST(post({ eventi: [evento()] }, {
            headers: { 'content-length': '100000' },
        }));
        expect(res.status).toBe(413);
        expect(righe()).toHaveLength(0);
    });

    it('...e anche quando il content-length MENTE o manca (il cap vero è sulla stringa letta)', async () => {
        // Un `content-length` dichiarato non è una misura: è un'affermazione dell'attaccante.
        // Se fosse l'unico cappello, un body da 4 MB con l'header omesso arriverebbe intero a
        // `JSON.parse` — che è precisamente la spesa che si voleva evitare.
        const gigante = JSON.stringify({
            eventi: [evento({ messaggio: 'x'.repeat(70_000) })],
        });
        const res = await POST(post(gigante));
        expect(res.status).toBe(413);
        expect(righe()).toHaveLength(0);
    });

    it('rifiuta un JSON malformato senza lanciare', async () => {
        const res = await POST(post('{ questo non è json'));
        expect(res.status).toBe(400);
        expect(righe()).toHaveLength(0);
    });

    it('scarta un evento con un nome fuori forma (spazi, a capo: righe di log FALSE)', async () => {
        // In un formato a righe un `\n` dentro un valore non è un carattere strano: è una riga
        // di log inventata da chi fa la richiesta. Non entra — ma ora si porta via solo sé stesso.
        const res = await POST(post({
            eventi: [evento({ evento: 'js\nKV_OK rid=vittima' }), evento({ messaggio: 'sano' })],
        }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 1, scartati: 1 });
        expect(righe()).toHaveLength(1);
        expect(riga().messaggio).toBe('sano');
    });

    it('scarta uno `stato` fuori scala (traboccherebbe la colonna int)', async () => {
        const res = await POST(post({ eventi: [evento({ stato: 10 ** 12 })] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 0, scartati: 1 });
        expect(righe()).toHaveLength(0);
    });

    it('applica il rate-limit per ip, con Retry-After', async () => {
        const chiamata = () => POST(post(
            { eventi: [evento()] },
            { headers: { 'x-forwarded-for': '1.2.3.4' } },
        ));
        for (let i = 0; i < 30; i++) {
            expect((await chiamata()).status).toBe(200);
        }
        const res = await chiamata();
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('il rate-limit di un ip non chiude la porta a un ALTRO ip', async () => {
        const da = (ip: string) => POST(post(
            { eventi: [evento()] },
            { headers: { 'x-forwarded-for': ip } },
        ));
        for (let i = 0; i < 31; i++) await da('1.2.3.4');
        expect((await da('5.6.7.8')).status).toBe(200);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. REDAZIONE. Il testo del client è testo del MONDO: qui è dove si sanifica.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('redazione del testo che arriva dal browser', () => {
    it('un\'email dentro il messaggio del client NON arriva in tabella', async () => {
        await POST(post({
            eventi: [evento({ messaggio: 'invio fallito per mario.rossi@example.com' })],
        }));
        expect(riga().messaggio).not.toContain('mario.rossi@example.com');
        expect(riga().messaggio).toContain('[email]');
    });

    it('...e nemmeno dentro lo STACK, il cui header È il messaggio', async () => {
        // L'header dello stack di V8 è una copia del messaggio: sanificare solo `messaggio`
        // sarebbe decorativo, e il dato uscirebbe dalla porta accanto.
        await POST(post({
            eventi: [evento({
                messaggio: 'boom',
                stack: 'Error: utente mario.rossi@example.com non trovato\n    at f (/src/a.ts:1:1)',
            })],
        }));
        const stack = String(riga().stack);
        expect(stack).not.toContain('mario.rossi@example.com');
        expect(stack).toContain('[email]');
        // I frame restano intatti: sono path e nomi di funzione, ed è l'unica cosa che serve.
        expect(stack).toContain('at f (/src/a.ts:1:1)');
    });

    it('un codice fiscale nel messaggio viene mascherato', async () => {
        await POST(post({ eventi: [evento({ messaggio: 'cf RSSMRA85T10A562S non valido' })] }));
        expect(riga().messaggio).not.toContain('RSSMRA85T10A562S');
        expect(riga().messaggio).toContain('[cf]');
    });

    it('la rotta della pagina arriva GREZZA al sink, che la riduce a pattern (`redigiPath`)', async () => {
        // La riduzione sta in `appLog` — un punto solo, non 239 chiamanti — e questo test
        // fissa il confine: la route passa la rotta, non la interpreta.
        await POST(post({
            eventi: [evento({ route: '/m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c' })],
        }));
        expect(riga().route).toBe('/m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c');
    });

    /*
     * IL TOKEN DEL MODULO PUBBLICO DENTRO IL `messaggio`. Era il buco: `messaggio` finisce in
     * `app_log.messaggio` (30 giorni, SQL), e nessuna difesa del server lo toccava —
     * `sanificaMessaggio` maschera email e codici fiscali, non i path; `redigiPath` il server lo
     * applicava alla sola colonna `route`. Il token di `/m/<token>` è una CREDENZIALE riusabile
     * che apre il modulo di preiscrizione di un minore.
     *
     * Il client ora riduce alla fonte, ma questa è la difesa in profondità che deve reggere da
     * sola: un'app installata da mesi (o modificata) continuerà a spedire path grezzi.
     */
    it('un token nel PATH dentro il messaggio non arriva in tabella (difesa in profondità)', async () => {
        await POST(post({
            eventi: [evento({
                messaggio: 'GET /m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c → 500',
            })],
        }));
        expect(riga().messaggio).not.toContain('8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c');
        // Ridotto a pattern, NON cancellato: la riga deve ancora dire quale rotta e quale stato.
        expect(riga().messaggio).toBe('GET /m/[id] → 500');
    });

    it('...anche il token opaco, e anche annegato in un URL intero', async () => {
        await POST(post({
            eventi: [evento({
                messaggio: 'Failed to fetch https://app.kidville.it/api/public/forms/tok_live_9f8e7d6c5b4a3210/submit',
            })],
        }));
        expect(riga().messaggio).not.toContain('tok_live_9f8e7d6c5b4a3210');
        expect(riga().messaggio).toContain('/api/public/forms/[tok]/submit');
    });

    it('...ma una data NON viene scambiata per un path (il messaggio resta leggibile)', async () => {
        // La riduzione è chirurgica: se mangiasse `12/03/2026` produrrebbe `12/[n]/[n]`, cioè
        // un messaggio mutilato in cambio di zero privacy. Un log illeggibile è un log perso.
        await POST(post({ eventi: [evento({ messaggio: 'iscrizione scaduta il 12/03/2026' })] }));
        expect(riga().messaggio).toBe('iscrizione scaduta il 12/03/2026');
    });

    /*
     * ⚠️ IL BUCO VERO, e stava nello STACK — non nel messaggio.
     *
     * Il messaggio lo riducevano già in due (il client alla fonte, questa route in profondità).
     * Lo stack NON lo riduceva NESSUNO: `logClient` fa solo `tronca`, e qui `descriviErrore` →
     * `preparaStack` sanificava l'header con `sanificaMessaggio`, che maschera email, codici
     * fiscali e vincoli Postgres — ma NON i path. E l'header dello stack di V8 È IL MESSAGGIO:
     * un `TypeError` di rete («Errore caricando https://app.kidville.it/m/<token>») portava il
     * token in `app_log.stack`, dove vive 30 giorni ed è interrogabile in SQL.
     */
    it('il token nel path dentro lo STACK non arriva in tabella', async () => {
        const TOKEN = 'tok_live_9f8e7d6c5b4a3210';
        const FRAME = '    at r (/_next/static/chunks/app/parent/layout-1a2b3c4d5e6f7a8b.js:1:2)';
        await POST(post({
            eventi: [evento({
                evento: 'fetch',
                messaggio: 'boom',
                stack: `Error: Errore caricando https://app.kidville.it/m/${TOKEN}\n${FRAME}`,
            })],
        }));

        const stack = String(riga().stack);
        expect(stack).not.toContain(TOKEN);
        expect(stack).toContain('/m/[tok]'); // ridotto a pattern, non cancellato
        // Il FRAME resta INTERO — e ha un segmento che l'euristica del token prenderebbe
        // volentieri (`layout-1a2b3c4d5e6f7a8b.js`). Ridurlo cancellerebbe la posizione
        // dell'errore, cioè l'unica cosa per cui uno stack esiste.
        expect(stack).toContain(FRAME.trim());
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. UN SOLO ROUND-TRIP. La route è ANONIMA: quanto costa al DB è una difesa.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il batch si scrive in una volta sola', () => {
    it('venti eventi → UNA chiamata al sink, con venti righe (erano 20 RPC sequenziali)', async () => {
        // 30 richieste al minuto per ip × 20 eventi = 600 round-trip al minuto al DB di
        // produzione, da un client solo, su una route senza gate. La RPC `app_log_registra`
        // accetta un array da sempre: il ciclo non doveva starci.
        const eventi = Array.from({ length: 20 }, (_, i) => evento({ messaggio: `errore ${i}` }));
        const res = await POST(post({ eventi }));

        expect(await res.json()).toEqual({ ok: true, ricevuti: 20, scartati: 0 });
        expect(appLogBatch).toHaveBeenCalledTimes(1);
        expect(appLogBatch.mock.calls[0][0]).toHaveLength(20);
        // L'ordine è quello del client: la prima riga è il primo evento.
        expect(riga(0).messaggio).toBe('errore 0');
        expect(riga(19).messaggio).toBe('errore 19');
    });

    it('gli eventi scartati non entrano nel batch (ma non lo affondano)', async () => {
        const res = await POST(post({
            eventi: [evento({ messaggio: 'buono' }), evento({ livello: 'info' })],
        }));

        expect(await res.json()).toEqual({ ok: true, ricevuti: 1, scartati: 1 });
        expect(appLogBatch).toHaveBeenCalledTimes(1);
        expect(appLogBatch.mock.calls[0][0]).toHaveLength(1);
        expect(riga().messaggio).toBe('buono');
    });

    it('un batch di soli eventi rotti non tocca affatto il sink', async () => {
        // Nessuna riga da scrivere: non si spende un round-trip per spedire un array vuoto.
        const res = await POST(post({ eventi: [{ boh: 1 }, evento({ livello: 'info' })] }));
        expect(await res.json()).toEqual({ ok: true, ricevuti: 0, scartati: 2 });
        expect(appLogBatch).not.toHaveBeenCalled();
    });
});
