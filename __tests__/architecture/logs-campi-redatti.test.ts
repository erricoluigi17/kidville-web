import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { POST } from '@/app/api/logs/route';
import { resetRateLimit } from '@/lib/security/rate-limit';
import type { RigaLog, Identita } from '@/lib/logging/app-log';
import type { EventoClient } from '@/lib/logging/client';

/**
 * I DATI STRUTTURATI DEI LOG DEL CLIENT — `contesto.campi`, la colonna che era sempre `{}`.
 *
 * ─── IL FATTO, MISURATO IN PRODUZIONE ───────────────────────────────────────
 *
 * OGNI riga `sorgente='client'` di `app_log` ha `contesto = {}`: 3.626 eventi al giorno, e sotto
 * quel vuoto 301 `fotocamera-errore` su iOS che dicono CHE è andata male e non dicono PERCHÉ.
 * Non era distrazione di chi scriveva i chiamanti: `EventoClient` non aveva un campo in cui
 * mettere niente, e lo schema di `/api/logs` non l'avrebbe accettato.
 *
 * ─── COSA SORVEGLIA QUESTO FILE, in ordine di importanza ─────────────────────
 *
 *  1. LA REDAZIONE C'È, e non è del client. Il browser manda forma e cap; la lista bianca è
 *     server-side, la stessa di ogni altra riga del sistema (`redact`). Qui si verifica che il
 *     canale NUOVO non sia una scorciatoia attorno a quella vecchia difesa — che è esattamente il
 *     modo in cui il canale di testo libero verso `app_log` si era aperto due volte (rilievi M11
 *     e M15 di `redact.ts`).
 *  2. UN CAMPO ROTTO NON PORTA VIA I SUOI VICINI. La disciplina della route — «un elemento rotto
 *     non affonda il batch» — deve valere un livello più in basso: si perde il campo, non
 *     l'evento, e mai il batch.
 *  3. `campi` NON ENTRA NELL'IMPRONTA. Contiene contatori (`ms`, i byte, i fotogrammi) che
 *     cambiano a OGNI occorrenza: nella chiave di deduplica spegnerebbero la deduplica, cioè la
 *     sola difesa contro la tempesta del client (decine di migliaia di righe identiche in un'ora).
 *     Lo stesso vale, un passo prima, per l'anti-tempesta del BROWSER.
 *  4. I DUE LATI DEL CANALE DICONO GLI STESSI TRE NUMERI. `CAMPI_MAX`, `CAMPO_TESTO_MAX` e
 *     `CHIAVE_CAMPO` vivono in DUE file (`client.ts` non può importare da `redact.ts`, e per
 *     REGOLA 1 importa solo `./path`). Finché a tenerli uguali c'era solo un commento, allargare
 *     il cap del client lasciava 109 test verdi: vedi la sezione 6, dov'è misurato.
 *
 * PERCHÉ STA IN `architecture/` E NON IN `api/`: due delle quattro reti non guardano una risposta
 * HTTP, guardano un INVARIANTE fra tre moduli che non si importano fra loro — `client.ts`,
 * `/api/logs`, `app-log.ts`. La terza legge il SORGENTE di `app-log.ts`, che è il collo di
 * bottiglia di ogni log del progetto e non è di questa modifica: l'unico modo di accorgersi che
 * un domani qualcuno ci ha infilato il contesto dentro è guardare lì. La quarta legge il sorgente
 * dei due lati del canale, che è il solo posto in cui una divergenza è visibile.
 */

/**
 * La spia è su `appLogBatch`, come in `__tests__/api/logs-ingestion.test.ts`: è ciò che la route
 * chiama davvero, e il punto di osservazione resta la riga che arriva al sink.
 */
const appLogBatch = vi.fn<(righe: RigaLog[]) => Promise<void>>(async () => {});

vi.mock('@/lib/logging/app-log', () => ({
    appLog: (riga: RigaLog) => appLogBatch([riga]),
    appLogBatch: (righe: RigaLog[]) => appLogBatch(righe),
}));

const APP_LOG = path.join(process.cwd(), 'src/lib/logging/app-log.ts');

function post(body: unknown): Request {
    return new Request('http://localhost/api/logs', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
}

/** Un evento del client valido: si parte da qui e si rompe un campo alla volta. */
function evento(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { livello: 'error', evento: 'js', messaggio: 'boom', ...extra };
}

function righe(): RigaLog[] {
    return appLogBatch.mock.calls.flatMap((c) => c[0]);
}

/** I `campi` come sono arrivati al sink: `contesto.campi`, la stessa chiave dei log del server. */
function campiDi(n = 0): Record<string, unknown> {
    const extra = righe()[n]?.contestoExtra;
    return (extra?.campi ?? {}) as Record<string, unknown>;
}

/** Manda un solo evento e restituisce l'esito della route. */
async function manda(e: Record<string, unknown>): Promise<{ ricevuti: number; scartati: number }> {
    const res = await POST(post({ eventi: [e] }));
    expect(res.status).toBe(200);
    return (await res.json()) as { ricevuti: number; scartati: number };
}

beforeEach(() => {
    resetRateLimit();
    appLogBatch.mockClear();
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. LA PORTA È APERTA — e i campi arrivano dove le query li cercano.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('i campi del client arrivano in tabella', () => {
    it('finiscono sotto `contesto.campi`, la STESSA chiave dei log del server', async () => {
        // `logger.ts → rigaEvento` scrive `contestoExtra: { campi: redact(campi) }`. Se il client
        // usasse un altro ramo, `contesto->'campi'->>'error_code'` sarebbe DUE query invece di
        // una — e nessuno se ne accorgerebbe: la riga esisterebbe, solo altrove.
        expect(await manda(evento({ campi: { error_code: 'NotAllowedError', ms: 1200 } })))
            .toEqual({ ok: true, ricevuti: 1, scartati: 0 });
        expect(campiDi()).toEqual({ error_code: 'NotAllowedError', ms: 1200 });
    });

    it('un evento SENZA campi non porta un contesto finto', async () => {
        // `contestoExtra: {}` scriverebbe `{"campi":{}}` in tabella: un ramo vuoto che sembra una
        // misura assente invece di un evento che non ne aveva.
        await manda(evento());
        expect(righe()[0].contestoExtra).toBeUndefined();
    });

    it('il PERCHÉ dei 301 `fotocamera-errore`: il nome della classe d\'errore esce leggibile', async () => {
        // È la ragione per cui il canale esiste. Se `error_code` uscisse `[redatto:str/16]` il
        // canale sarebbe il vuoto di prima con più righe di codice.
        await manda(evento({ evento: 'fotocamera-errore', campi: { error_code: 'NotAllowedError', tipo: 'video', ms: 4200 } }));
        expect(campiDi()).toEqual({ error_code: 'NotAllowedError', tipo: 'video', ms: 4200 });
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. LA REDAZIONE È DEL SERVER — il canale nuovo non scavalca la difesa vecchia.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('i campi passano dalla redazione', () => {
    it('un\'email non arriva in chiaro: la chiave la manda a hash', async () => {
        await manda(evento({ campi: { email: 'mario.rossi@example.com' } }));
        const v = campiDi().email;
        expect(typeof v).toBe('string');
        expect(v).not.toContain('mario.rossi@example.com');
        expect(v).not.toContain('@');
    });

    it('sotto una chiave in lista bianca il VALORE deve confermare: il testo libero resta fuori', async () => {
        // M11, un canale in più. `esito` è in lista bianca, ma la lista bianca apre sulla CHIAVE
        // e la forma dell'enumerato (niente spazi, ≤64) è ciò che chiude il testo libero. Se
        // questo test diventasse rosso, `/api/logs` sarebbe di nuovo un canale di prosa verso una
        // colonna che vive 30 giorni e si interroga in SQL.
        await manda(evento({ campi: { esito: 'il bambino ha la varicella' } }));
        expect(campiDi().esito).toBe('[redatto:str/26]');
    });

    it('un codice fiscale non passa nemmeno sotto una chiave in lista bianca', async () => {
        // `FORMA_CODICE_FISCALE`: sedici caratteri senza spazi sono un enumerato perfetto, e in
        // produzione una riga con `"sezione": "<CF>"` in chiaro c'era davvero.
        await manda(evento({ campi: { sezione: 'RSSMRA80A01H501U' } }));
        expect(campiDi().sezione).toBe('[redatto:str/16]');
    });

    it('una chiave che NON è in lista bianca non è un canale di testo: esce la lunghezza, non il dato', async () => {
        await manda(evento({ campi: { dettaglio: 'Mario Rossi' } }));
        expect(campiDi().dettaglio).toBe('[redatto:str/11]');
    });

    it('i numeri e i booleani restano leggibili: sono la diagnosi, e non nominano nessuno', async () => {
        await manda(evento({ campi: { ms: 1200, fotogrammi: 30, nativo: true, ripiego: false } }));
        expect(campiDi()).toEqual({ ms: 1200, fotogrammi: 30, nativo: true, ripiego: false });
    });

    it('`campi_scartati` arriva in tabella LEGGIBILE: un conteggio redatto non conta niente', async () => {
        // Il conteggio che il client appende quando butta un campo (`CAMPI_SCARTATI` in
        // `client.ts`) attraversa questa porta come tutto il resto. Non è in `CHIAVI_IN_CHIARO`:
        // passa perché è un NUMERO, e i numeri `redact` li lascia. Se un domani la lista bianca
        // cambiasse verso e i numeri iniziassero a essere mascherati, l'osservabilità dello scarto
        // diventerebbe `[redatto:num]` — cioè si saprebbe di aver perso qualcosa senza sapere
        // quanto, e questo test sarebbe rosso il giorno del cambio.
        await manda(evento({ campi: { campi_scartati: 3, ms: 1 } }));
        expect(campiDi()).toEqual({ campi_scartati: 3, ms: 1 });
    });

    it('un PATH sotto una chiave in lista bianca non porta via il token (difesa in profondità)', async () => {
        /*
         * IL BUCO, trovato con `redact.ts` alla mano e chiuso nella stessa modifica. Sotto una
         * chiave in lista bianca `FORMA_ENUMERATO` ammette lo slash iniziale — serve, perché
         * `instrumentation.ts` scrive lì i pattern di rotta — quindi `/m/<uuid>` è un enumerato
         * perfetto (39 caratteri, nessuno spazio) e uscirebbe IN CHIARO. In questo repo quel path
         * è una CREDENZIALE: apre il modulo di preiscrizione di un minore.
         *
         * Il client lo riduce già, ma gira su una macchina che non controlliamo: un'app installata
         * da mesi continuerà a spedire path grezzi. La riduzione si rifà qui, come per `messaggio`.
         */
        const token = '8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c';
        await manda(evento({ campi: { operazione: `/m/${token}` } }));
        expect(campiDi().operazione).toBe('/m/[id]');
        expect(JSON.stringify(righe())).not.toContain(token);
    });

    it('un uuid resta leggibile: è auto-descrittivo per forma, ed è la domanda «a chi è successo?»', async () => {
        const id = '11111111-2222-3333-4444-555555555555';
        await manda(evento({ campi: { alunno_id: id } }));
        expect(campiDi().alunno_id).toBe(id);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. UN CAMPO ROTTO NON PORTA VIA I SUOI VICINI.
 *
 * La forma «ovvia» — `z.record(z.string().regex(CHIAVE_CAMPO), campoValore)` — in zod 4 fa
 * fallire l'INTERO record appena una chiave è fuori forma (`invalid_key`), e con il record cade
 * l'evento: il messaggio e lo stack morirebbero per una chiave scritta male. Misurato, non dedotto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('una chiave fuori forma si scarta, e non porta via niente', () => {
    it('la chiave cattiva sparisce, le altre restano, l\'evento entra', async () => {
        expect(await manda(evento({ campi: { 'Chiave Cattiva': 1, ms: 7 } })))
            .toEqual({ ok: true, ricevuti: 1, scartati: 0 });
        expect(campiDi()).toEqual({ ms: 7 });
    });

    it('...e non fa cadere il BATCH: gli altri eventi arrivano tutti', async () => {
        const res = await POST(post({
            eventi: [
                evento({ messaggio: 'primo', campi: { 'chiave con spazi': 1 } }),
                evento({ messaggio: 'secondo', campi: { ms: 3 } }),
                evento({ messaggio: 'terzo' }),
            ],
        }));
        expect(await res.json()).toEqual({ ok: true, ricevuti: 3, scartati: 0 });
        expect(righe().map((r) => r.messaggio)).toEqual(['primo', 'secondo', 'terzo']);
        expect(righe()[0].contestoExtra).toBeUndefined();
        expect(campiDi(1)).toEqual({ ms: 3 });
    });

    it('`__proto__` non arriva in tabella, e non tocca nessun prototipo', async () => {
        /*
         * `JSON.parse('{"__proto__":…}')` crea una proprietà PROPRIA con quel nome (misurato: non
         * è un dettaglio teorico), quindi la chiave arriva davvero fin qui.
         *
         * ⚠️ CHI CI ARRIVA PRIMA, misurato e scritto perché nessuno creda che questo test provi
         * più di quello che prova: è ZOD. `z.record` ricopia i campi per assegnazione, e
         * `out['__proto__'] = …` su un oggetto normale finisce nel setter del prototipo invece che
         * fra le chiavi — dopo il parse `Object.keys` non lo vede più. `CHIAVE_CAMPO` (che
         * comincia per lettera minuscola) è la SECONDA rete, e serve il giorno in cui l'involucro
         * qui sopra cambiasse forma. Le due si coprono a vicenda, e questo test guarda l'esito:
         * in tabella quella chiave non c'è, e nessun prototipo è stato toccato.
         */
        const corpo = '{"eventi":[{"livello":"error","evento":"js","messaggio":"boom","campi":{"__proto__":"x","ms":1}}]}';
        const res = await POST(new Request('http://localhost/api/logs', {
            method: 'POST',
            body: corpo,
            headers: { 'content-type': 'application/json' },
        }));
        expect(await res.json()).toEqual({ ok: true, ricevuti: 1, scartati: 0 });
        expect(campiDi()).toEqual({ ms: 1 });
        expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('un valore troppo lungo si scarta: è il campo a perdersi, non l\'evento', async () => {
        await manda(evento({ campi: { error_code: 'a'.repeat(65), ms: 1 } }));
        expect(campiDi()).toEqual({ ms: 1 });
    });

    it('un valore che non è una misura (oggetto, array, null) si scarta', async () => {
        await manda(evento({ campi: { annidato: { a: 1 }, lista: [1, 2], vuoto: null, ms: 1 } }));
        expect(campiDi()).toEqual({ ms: 1 });
    });

    it('oltre il tetto di 12 chiavi si tiene il tetto, non si perde l\'evento', async () => {
        const campi: Record<string, number> = {};
        for (let i = 0; i < 20; i++) campi[`c${i}`] = i;
        expect(await manda(evento({ campi }))).toEqual({ ok: true, ricevuti: 1, scartati: 0 });
        expect(Object.keys(campiDi())).toHaveLength(12);
    });

    it('un `campi` che non è nemmeno un oggetto si perde da solo: l\'evento entra intero', async () => {
        for (const rotto of ['pippo', 42, [1, 2], null]) {
            appLogBatch.mockClear();
            expect(await manda(evento({ campi: rotto }))).toEqual({ ok: true, ricevuti: 1, scartati: 0 });
            expect(righe()[0].messaggio).toBe('boom');
            expect(righe()[0].contestoExtra).toBeUndefined();
        }
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. `campi` NON ENTRA NELL'IMPRONTA.
 *
 * Due occorrenze dello stesso guasto devono SOMMARSI in una riga (`occorrenze`), non
 * moltiplicarsi in due. I campi portano `ms` e contatori: nella chiave sarebbero una riga nuova
 * per occorrenza, cioè la deduplica spenta esattamente durante la tempesta che la motiva.
 * ════════════════════════════════════════════════════════════════════════════ */

/** L'identità di una riga: gli stessi campi che `aRiga` passa a `impronta`, e nient'altro. */
function identitaDi(r: RigaLog): Identita {
    return {
        sorgente: r.sorgente ?? 'server',
        livello: r.livello,
        evento: r.evento,
        route: r.route,
        codice: r.codice,
        statoHttp: r.statoHttp,
        messaggio: r.messaggio,
        stack: r.stack,
        bersaglio: r.bersaglio,
    };
}

describe('i campi non entrano nella chiave di deduplica', () => {
    it('due eventi identici con campi DIVERSI hanno la stessa impronta (deduplicano insieme)', async () => {
        // `impronta` vera: questo file mocka `app-log`, quindi il sink è una spia — ma la funzione
        // che calcola l'impronta la si vuole autentica.
        const { impronta } = await vi.importActual<typeof import('@/lib/logging/app-log')>(
            '@/lib/logging/app-log',
        );

        await POST(post({
            eventi: [
                evento({ campi: { ms: 1200, fotogrammi: 30 } }),
                evento({ campi: { ms: 45, fotogrammi: 12 } }),
            ],
        }));
        const [a, b] = righe();
        expect(campiDi(0)).not.toEqual(campiDi(1));

        // Le due righe differiscono SOLO per il contesto: è ciò che le fa collassare in una.
        expect({ ...a, contestoExtra: undefined }).toEqual({ ...b, contestoExtra: undefined });
        expect(impronta(identitaDi(a))).toBe(impronta(identitaDi(b)));

        // CONTROPROVA — un test mai visto fallire non è un test. Se i campi entrassero
        // nell'impronta (qui li si infila a mano nel solo posto che il chiamante può toccare, il
        // `bersaglio`), le due occorrenze si separerebbero: una riga per `ms`, cioè migliaia.
        expect(impronta({ ...identitaDi(a), bersaglio: JSON.stringify(campiDi(0)) }))
            .not.toBe(impronta({ ...identitaDi(b), bersaglio: JSON.stringify(campiDi(1)) }));
    });

    it('`aRiga` non passa il contesto a `impronta` — e la rete guarda il SORGENTE, non l\'esito', () => {
        // Un test sull'esito passerebbe anche se `impronta` ricevesse i campi e li ignorasse per
        // caso (una chiave assente in `Identita`). Qui si guarda la chiamata vera: chi un domani
        // volesse «distinguere per campi» dovrebbe scriverlo proprio lì dentro.
        const sorgente = fs.readFileSync(APP_LOG, 'utf8');
        const chiamata = /fingerprint:\s*impronta\(\{([\s\S]*?)\}\)/.exec(sorgente);
        expect(chiamata, 'la chiamata `fingerprint: impronta({…})` non è più in `app-log.ts`: '
            + 'questo lock non sta più guardando niente').not.toBeNull();
        expect(
            /contesto|campi/i.test(chiamata![1]),
            'L\'impronta ha ricevuto il contesto. I campi cambiano a ogni occorrenza (`ms`): '
            + 'dentro la chiave di deduplica, mille righe identiche tornano a essere mille righe.',
        ).toBe(false);
    });

    it('`Identita` non ha un campo per i campi: l\'impronta non li può ricevere per sbaglio', () => {
        const sorgente = fs.readFileSync(APP_LOG, 'utf8');
        const interfaccia = /export interface Identita \{([\s\S]*?)\n\}/.exec(sorgente);
        expect(interfaccia, 'l\'interfaccia `Identita` non c\'è più: il lock è cieco').not.toBeNull();
        expect(/contesto|campi/i.test(interfaccia![1])).toBe(false);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. IL LATO CLIENT — la porta serve a poco se dal dispositivo non esce niente.
 *
 * Punto di osservazione: la RETE. Si guarda ciò che lascia il browser, non le intenzioni del
 * modulo — stessa disciplina di `__tests__/lib/logging-client.test.ts`, da cui viene l'harness.
 * ════════════════════════════════════════════════════════════════════════════ */

type Client = typeof import('@/lib/logging/client');

/** Il token del modulo pubblico è un uuid in un SEGMENTO di path: è una credenziale. */
const TOKEN_UUID = '8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c';

describe('i campi lasciano il dispositivo, con forma e cap', () => {
    let rete: Mock;
    let fetchPrecedente: typeof fetch;

    async function carica(): Promise<Client> {
        vi.resetModules();
        const mod = await import('@/lib/logging/client');
        mod.installaLoggerClient();
        return mod;
    }

    /** Il batch spedito a `/api/logs` (in jsdom `sendBeacon` non esiste: si usa il fallback). */
    function batchSpedito(): { eventi: EventoClient[] } {
        const chiamata = rete.mock.calls.find(([u]) => String(u).startsWith('/api/logs'));
        if (!chiamata) throw new Error('nessun batch spedito a /api/logs');
        return JSON.parse(String((chiamata[1] as RequestInit).body));
    }

    beforeEach(() => {
        localStorage.clear();
        fetchPrecedente = window.fetch;
        rete = vi.fn();
        rete.mockResolvedValue(new Response(null, { status: 200 }));
        // PRIMA dell'installazione: è questo che il logger cattura come `fetchOriginale`.
        window.fetch = rete as unknown as typeof fetch;
    });

    afterEach(() => {
        window.fetch = fetchPrecedente;
    });

    it('un `logClient` con campi li spedisce', async () => {
        const { logClient, flush } = await carica();
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi: { error_code: 'TypeError', ms: 12 } });
        flush();
        expect(batchSpedito().eventi[0].campi).toEqual({ error_code: 'TypeError', ms: 12 });
    });

    it('la REGOLA 4 vale anche per i campi: nessun path grezzo esce dal dispositivo', async () => {
        const { logClient, flush } = await carica();
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi: { url: `/m/${TOKEN_UUID}` } });
        flush();
        expect(JSON.stringify(batchSpedito())).not.toContain(TOKEN_UUID);
        expect(batchSpedito().eventi[0].campi?.url).toBe('/m/[id]');
    });

    it('il testo si TRONCA al cap del server, le chiavi fuori forma si buttano', async () => {
        const { logClient, flush } = await carica();
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'boom',
            // @ts-expect-error — `Chiave Cattiva` NON deve compilare: è la rete di `CampiClient`,
            // e questa direttiva è il suo lock. Se qualcuno allargasse quel tipo, `tsc` direbbe
            // «Unused '@ts-expect-error' directive» e il gate diventerebbe rosso qui.
            campi: { error_code: 'a'.repeat(200), 'Chiave Cattiva': 1, rotto: Number.NaN },
        });
        flush();
        const campi = batchSpedito().eventi[0].campi!;
        expect(campi.error_code).toHaveLength(64);
        // `NaN` è un `number` a tutti gli effetti e il tipo non lo vede: in JSON diventerebbe
        // `null`, un buco con l'aspetto di una misura. Entrambi gli scarti sono CONTATI.
        expect(Object.keys(campi).sort()).toEqual(['campi_scartati', 'error_code']);
        expect(campi.campi_scartati).toBe(2);
    });

    it('l\'ANTI-TEMPESTA non si spegne: due eventi identici con campi diversi restano UNO', async () => {
        // Il gemello, sul client, del lock sull'impronta. La chiave del throttle non include i
        // campi: se li includesse, ogni occorrenza avrebbe una chiave nuova e `DEDUP_MS` non
        // fermerebbe più niente — cioè decine di migliaia di richieste nell'ora in cui la rete è
        // degradata, proprio mentre `/api/logs` serve.
        const { logClient, flush } = await carica();
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi: { ms: 1 } });
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi: { ms: 999 } });
        flush();
        const eventi = batchSpedito().eventi;
        expect(eventi).toHaveLength(1);
        expect(eventi[0].campi).toEqual({ ms: 1 });
    });

    it('una coda persistita scritta a mano non sfonda il batch: i campi ripassano dal cap', async () => {
        // Il `localStorage` è scrivibile da chiunque abbia la console aperta, e un 413 non è
        // ritentabile: venti eventi con campi giganti costerebbero l'INTERA coda.
        localStorage.setItem('kv_log_coda', JSON.stringify([
            { livello: 'error', evento: 'js', messaggio: 'salvato', campi: { error_code: 'b'.repeat(5_000), 'CHIAVE!': 1 } },
        ]));
        const { flush } = await carica();
        flush();
        const campi = batchSpedito().eventi[0].campi!;
        expect(campi.error_code).toHaveLength(64);
        expect(Object.keys(campi).sort()).toEqual(['campi_scartati', 'error_code']);
        expect(campi.campi_scartati).toBe(1);
    });

    /* ────────────────────────────────────────────────────────────────────────
     * LO SCARTO NON È MUTO NEMMENO SUL DISPOSITIVO.
     *
     * Il contatore che `/api/logs` tiene sui campi che scarta LUI è cieco per costruzione
     * all'errore più probabile: un nostro chiamante che scrive `errorCode` invece di
     * `error_code`. Quella chiave muore sul telefono e al server non arriva niente da contare.
     * Un canale nato per chiudere un silenzio non può aprirne un altro.
     * ──────────────────────────────────────────────────────────────────────── */

    it('la chiave in camelCase non muore in silenzio: parte il CONTEGGIO insieme all\'evento', async () => {
        // Misurato sul canale di prima: `campi: { errorCode: 'TypeError', ms: 1 }` spediva
        // `{"ms":1}` e nient'altro — nessuna riga, da nessuna parte, diceva che un campo era
        // stato perso.
        const { logClient, flush } = await carica();
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'boom',
            // @ts-expect-error — la rete di `CampiClient` prende il camelCase a COMPILAZIONE: è
            // il caso per cui esiste. La direttiva è anche il lock di quel tipo (vedi sopra).
            campi: { errorCode: 'TypeError', ms: 1 },
        });
        flush();
        expect(batchSpedito().eventi[0].campi).toEqual({ ms: 1, campi_scartati: 1 });
    });

    it('se si perde TUTTO, parte comunque il conteggio: un evento muto sarebbe il silenzio di prima', async () => {
        const { logClient, flush } = await carica();
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: 'boom',
            // @ts-expect-error — vedi sopra: il camelCase non compila.
            campi: { errorCode: 'TypeError' },
        });
        flush();
        expect(batchSpedito().eventi[0].campi).toEqual({ campi_scartati: 1 });
    });

    it('un evento SENZA campi non porta un conteggio finto', async () => {
        // Un `campi_scartati: 0` su ogni riga sarebbe rumore in dodici caselle contate.
        const { logClient, flush } = await carica();
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom' });
        flush();
        expect(batchSpedito().eventi[0].campi).toBeUndefined();
    });

    it('oltre il tetto il conteggio NON c\'è, ed è il residuo dichiarato (non una dimenticanza)', async () => {
        /*
         * IL SOLO CASO MUTO CHE RESTA, pinnato qui perché chi lo cambia sappia di cambiarlo.
         *
         * Il contatore occupa una casella, e con dodici campi passati la casella non c'è: il
         * conteggio si perde. Sfrattare l'ultimo campo buono per far posto al numero degli scarti
         * costerebbe una MISURA per raccontare un'aritmetica, e non è il verso giusto.
         *
         * È anche il caso meno grave, e la ragione è la visibilità: «ho scritto venti campi» si
         * vede nel diff, `errorCode` invece di `error_code` no. Il conteggio esiste per il secondo,
         * che è l'errore che passa la revisione. E un lettore che trova ESATTAMENTE dodici campi
         * ha comunque il suo indizio: dodici è il tetto.
         */
        const { logClient, flush } = await carica();
        const campi: Record<string, number> = {};
        for (let i = 0; i < 20; i++) campi[`c${i}`] = i;
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi });
        flush();
        const spediti = batchSpedito().eventi[0].campi!;
        expect(Object.keys(spediti)).toHaveLength(12);
        expect(spediti.campi_scartati).toBeUndefined();
    });

    it('con UN posto libero il conteggio c\'è: è il caso che il canale deve coprire', async () => {
        // Undici campi buoni e uno storto: la dodicesima casella è libera e il conteggio la
        // occupa. È la forma che ha in pratica un chiamante reale — pochi campi, uno sbagliato.
        const { logClient, flush } = await carica();
        const campi: Record<string, number> = { 'NON-VALIDA': 0 };
        for (let i = 0; i < 11; i++) campi[`c${i}`] = i;
        logClient({ livello: 'warn', evento: 'js', messaggio: 'boom', campi });
        flush();
        const spediti = batchSpedito().eventi[0].campi!;
        expect(Object.keys(spediti)).toHaveLength(12);
        expect(spediti.campi_scartati).toBe(1);
    });

    it('sul secondo giro gli scarti si SOMMANO, non si sovrascrivono (la coda è idempotente)', async () => {
        // `riparato` ripassa la coda riletta da `campiRidotti`: se il conteggio si azzerasse a
        // ogni giro, un evento sopravvissuto a un 429 direbbe di aver perso meno di quanto ha perso.
        localStorage.setItem('kv_log_coda', JSON.stringify([
            { livello: 'error', evento: 'js', messaggio: 'salvato', campi: { campi_scartati: 3, 'CHIAVE!': 1, ms: 2 } },
        ]));
        const { flush } = await carica();
        flush();
        expect(batchSpedito().eventi[0].campi).toEqual({ campi_scartati: 4, ms: 2 });
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. I DUE LATI DEL CANALE DICONO GLI STESSI TRE NUMERI.
 *
 * `CAMPI_MAX`, `CAMPO_TESTO_MAX` e `CHIAVE_CAMPO` sono DUPLICATI, in `src/lib/logging/client.ts`
 * e in `/api/logs`. Non per pigrizia: `client.ts` non può importare `redact.ts` (tira dentro
 * `node:crypto`) e la sua REGOLA 1 gli concede un solo import, `./path` — il giorno in cui un
 * modulo di quel file trascina Node, non è un bug a runtime, è `npm run build` che cade.
 *
 * I commenti dei due file dichiarano TRE VOLTE che i valori «devono restare gli stessi», e ne
 * nominano anche la conseguenza: «un cap più largo qui produrrebbe campi che il server SCARTA —
 * cioè dati che il client crede di aver spedito e che in tabella non esistono». Una
 * dichiarazione non è un lock.
 *
 * ─── MISURATO PRIMA DI SCRIVERE QUESTO BLOCCO ───────────────────────────────
 *
 * (a) `CAMPI_MAX` del client portato a 20, server lasciato a 12 → `vitest run` su questo file,
 *     `logging-client.test.ts` e `logs-ingestion.test.ts`: «109 passed (109)».
 * (b) `CHIAVE_CAMPO` del client cambiato in `/^[A-Za-z][A-Za-z0-9_]{0,31}$/`, server lasciato
 *     minuscolo → di nuovo «109 passed». Il client avrebbe spedito `errorCode` tutta la vita e il
 *     server l'avrebbe buttato senza che nessuno lo sapesse.
 *
 * In questo repo è un difetto già pagato, e `src/lib/logging/esito-elenco.ts` lo cita per nome:
 * «una regola valida per due strade che vive in due posti diverge alla prima modifica: è successo
 * su `gallery` (50 MB nel bucket, 200 MB nella route, per mesi)».
 *
 * SI LEGGE IL SORGENTE, non si importano le costanti: importarle le confronterebbe con sé stesse
 * (sono `const` non esportate proprio perché nessuno le condivida per sbaglio), e soprattutto non
 * si accorgerebbe di un TERZO valore scritto a mano dentro lo `z.string().max(…)` dello schema.
 * ════════════════════════════════════════════════════════════════════════════ */

const CLIENT = path.join(process.cwd(), 'src/lib/logging/client.ts');
const ROUTE = path.join(process.cwd(), 'src/app/api/logs/route.ts');

/** I tre vincoli che i due lati del canale devono dichiarare identici, alla lettera. */
const VINCOLI = ['CAMPI_MAX', 'CAMPO_TESTO_MAX', 'CHIAVE_CAMPO'] as const;

/**
 * Il valore LETTERALE di una `const` nel sorgente. Se la dichiarazione non c'è più — rinominata,
 * spostata, resa calcolata — il lock non passa in silenzio: fallisce dicendo che sta guardando il
 * nulla. È la lezione di `ritmo-email-un-posto-solo.test.ts`, e la stessa che vale per le due
 * reti su `app-log.ts` qui sopra.
 */
function dichiarazione(sorgente: string, file: string, nome: string): string {
    const m = new RegExp(`^const ${nome} = (.+);$`, 'm').exec(sorgente);
    expect(
        m,
        `\`const ${nome}\` non è più dichiarata così in ${file}: questo lock sta guardando il nulla, `
        + 'e i due lati del canale possono divergere senza che il gate diventi rosso.',
    ).not.toBeNull();
    return m![1];
}

describe('i tre vincoli dei campi sono identici sui due lati del canale', () => {
    const client = fs.readFileSync(CLIENT, 'utf8');
    const route = fs.readFileSync(ROUTE, 'utf8');

    it.each(VINCOLI)('`%s` dice lo stesso in `client.ts` e in `/api/logs`', (nome) => {
        expect(
            dichiarazione(client, 'src/lib/logging/client.ts', nome),
            `\`${nome}\` è DIVERSO fra \`src/lib/logging/client.ts\` e \`src/app/api/logs/route.ts\`. `
            + 'Un vincolo più largo sul client produce campi che il server scarta: dati che il client '
            + 'crede di aver spedito e che in tabella non esistono — cioè un log che non c\'è, senza '
            + 'niente di rosso da nessuna parte. Un vincolo più largo sul server è una porta aperta '
            + 'più di quanto il canale dichiari. Si cambiano TUTTI E DUE, o nessuno.',
        ).toBe(dichiarazione(route, 'src/app/api/logs/route.ts', nome));
    });

    it('prova di sanità: il lock legge davvero tre valori, non tre stringhe vuote', () => {
        // Senza questa, un `dichiarazione` che restituisse `''` da entrambi i lati renderebbe il
        // confronto qui sopra VERDE per sempre: il lock guarderebbe il nulla e direbbe che va bene.
        const [max, testo, chiave] = VINCOLI.map((n) => dichiarazione(client, 'client.ts', n));
        expect(Number(max)).toBe(12);
        expect(Number(testo)).toBe(64);

        // E la regex non è una stringa qualunque: ricostruita, deve accettare la chiave buona e
        // rifiutare quella storta. È ciò che prova che il lock sta confrontando IL vincolo.
        const corpo = /^\/(.+)\/$/.exec(chiave);
        expect(corpo, `\`CHIAVE_CAMPO\` non è più un letterale di regex: ${chiave}`).not.toBeNull();
        const re = new RegExp(corpo![1]);
        expect(re.test('error_code')).toBe(true);
        expect(re.test('errorCode')).toBe(false);
        expect(re.test('__proto__')).toBe(false);
        expect(re.test('a'.repeat(33))).toBe(false);
    });
});
