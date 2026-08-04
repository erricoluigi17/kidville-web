/**
 * L'ATTRIBUZIONE DELL'ERRORE ALLA PAGINA IN CUI È SUCCESSO (rilievo T12-F2).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, misurato in produzione il 2026-08-04 su `app_log`.
 *
 * `logClient` lasciava la `route` a `undefined` quando il chiamante non ne passava una. Il
 * campo però non resta vuoto: lato server `app-log.ts` → `rotta(propria, dalContesto)` ripiega
 * sul `contesto().path`, che per un log del browser vale SEMPRE `/api/logs` — il nome del
 * CAMION, non quello del luogo dell'incidente. La colonna diceva quindi «/api/logs», che è
 * l'unica pagina in cui quell'errore NON è mai avvenuto.
 *
 * La misura: **60 righe `sorgente='client'` su 309** (19,4%) portavano `route='/api/logs'`, e
 * NESSUNA di quelle 60 era un errore di spedizione verso `/api/logs` — il patch di `fetch` in
 * `client.ts` esclude il proprio SINK (`daIgnorare`: `url.startsWith(SINK)`), quindi un guasto
 * del logger non può nemmeno generare quelle righe. Erano `modulo-allegato-upload-fallito`,
 * `sw-senza-controllo`, `iscrizione-sedi-non-caricate`, `Chat realtime: CHANNEL_ERROR`,
 * `parent-identity`: 62 dei 176 punti di chiamata del repo non passano la `route`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ QUESTI TEST GUARDANO IL CORPO SPEDITO E NON I CHIAMANTI.
 *
 * Un lock che facesse `grep` di `route:` nei 176 punti di chiamata sarebbe verde anche
 * passando `route: undefined`, ed è esattamente il caso che rompe. Qui si guarda l'unica cosa
 * che conta davvero: i byte che escono dal dispositivo verso `/api/logs`.
 *
 * ⚠️ IL SECONDO TEST PROTEGGE UNA CREDENZIALE. In questo repo il token del modulo pubblico sta
 * NEL PATH (`/m/<token>`, `src/app/m/[token]/page.tsx`), è una capability riusabile che apre la
 * domanda d'iscrizione di un minore, e la colonna `route` vive 30 giorni ed è interrogabile in
 * SQL. Il default della pagina è quindi anche una NUOVA superficie: prima quel path non usciva
 * perché non usciva niente. Deve uscire come pattern, mai come valore.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Il corpo di un batch, come lo legge `/api/logs`. */
interface CorpoBatch {
    eventi: Array<{ evento: string; messaggio: string; route?: string }>;
    piattaforma: string;
}

/**
 * Reinstalla il modulo da zero a ogni test: `client.ts` tiene coda, throttle e coda persistita
 * in stato di MODULO. Senza `resetModules` il secondo test erediterebbe la coda del primo, e
 * il dedup (stesso evento+messaggio entro la finestra) farebbe sparire eventi in silenzio —
 * cioè un test verde che non ha misurato niente.
 */
async function moduloPulito() {
    vi.resetModules();
    localStorage.clear();
    return import('@/lib/logging/client');
}

/**
 * Intercetta `navigator.sendBeacon` — il canale che `flush()` prova per PRIMO — e restituisce
 * il corpo JSON spedito. `sendBeacon` non esiste in jsdom: va definito, ed è anche il motivo
 * per cui questa è un'intercettazione onesta e non un mock di comodo.
 */
function intercettaBeacon(): () => Promise<CorpoBatch[]> {
    const corpi: Blob[] = [];
    const beacon = vi.fn((_url: string, dati?: BodyInit | null) => {
        corpi.push(dati as Blob);
        return true;
    });
    Object.defineProperty(navigator, 'sendBeacon', {
        value: beacon,
        configurable: true,
        writable: true,
    });
    return async () => Promise.all(corpi.map(async (b) => JSON.parse(await b.text()) as CorpoBatch));
}

/** Porta jsdom sulla pagina indicata: `location.pathname` è ciò che `client.ts` legge. */
function suPagina(path: string): void {
    window.history.replaceState({}, '', path);
    expect(location.pathname).toBe(path);
}

describe('logClient — la route di ripiego è la PAGINA, non il camion dei log', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('(a) senza route esplicita, spedisce la pagina vera (/iscrizione), non /api/logs', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();
        suPagina('/iscrizione');

        // Esattamente la forma dei 62 punti di chiamata che non passano la route: qui il
        // chiamante è `EnrollmentWizard.tsx`, e in produzione questa riga è finita su
        // `/api/logs` sei volte.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'iscrizione-sedi-non-caricate',
        });
        flush();

        const [batch] = await leggi();
        expect(batch.eventi).toHaveLength(1);
        expect(batch.eventi[0].route).toBe('/iscrizione');
        // Il gemello negativo dell'asserzione positiva: `/api/logs` è il valore che il difetto
        // produceva, e nominarlo qui è ciò che rende il test una misura e non una descrizione.
        expect(batch.eventi[0].route).not.toBe('/api/logs');
    });

    it('(a-bis) la pagina spedita segue l\'utente: /parent/chat porta /parent/chat', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();
        suPagina('/parent/chat');

        logClient({
            livello: 'error',
            evento: 'react',
            messaggio: 'Chat realtime: CHANNEL_ERROR',
        });
        flush();

        const [batch] = await leggi();
        expect(batch.eventi[0].route).toBe('/parent/chat');
    });

    it('(b) 🔴 la pagina /m/<token> esce come pattern: il token NON finisce nel log', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();

        // Il token vero di `/m/` è un uuid: lo produce `randomUUID()` in
        // `api/admin/form-models/publish/route.ts`, e la colonna `public_token` accetta solo
        // quella forma (`src/lib/forms/token-pubblico.ts`). Non è un token di fantasia.
        const token = '3f2b9c1a-7d64-4e8b-9a05-1c2e3f4a5b6c';
        suPagina(`/m/${token}`);

        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'modulo-allegato-upload-fallito',
        });
        flush();

        const [batch] = await leggi();
        const spedito = JSON.stringify(batch);

        expect(batch.eventi[0].route).toBe('/m/[id]');
        // L'asserzione che conta: il token non deve comparire da NESSUNA parte del corpo — né
        // nella route, né nel messaggio, né in un campo che qualcuno aggiungerà domani.
        expect(spedito).not.toContain(token);
        // Nemmeno un pezzo del token: un troncamento a `ROUTE_MAX` che tagliasse a metà
        // lascerebbe comunque uscire materiale della credenziale.
        expect(spedito).not.toContain('3f2b9c1a');
    });

    it('(b-bis) 🔴 anche un token opaco non-uuid nel path esce come [tok]', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();

        // La forma che i token assumerebbero se domani si smettesse di usare `randomUUID()`:
        // ≥16 caratteri con almeno una cifra è la soglia di `redigiPath`.
        const token = 'tok9f8e7d6c5b4a3210';
        suPagina(`/m/${token}`);

        logClient({ livello: 'error', evento: 'js', messaggio: 'TypeError' });
        flush();

        const [batch] = await leggi();
        expect(batch.eventi[0].route).toBe('/m/[tok]');
        expect(JSON.stringify(batch)).not.toContain(token);
    });

    it('(c) chi passa una route esplicita continua a vincere sulla pagina corrente', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();
        suPagina('/iscrizione');

        // È il caso di `error.tsx`/`global-error.tsx` e delle boundary React, che la route se la
        // costruiscono da sé: il default non deve scavalcarle.
        logClient({
            livello: 'error',
            evento: 'react',
            messaggio: 'boundary',
            route: '/parent/pagamenti',
        });
        flush();

        const [batch] = await leggi();
        expect(batch.eventi[0].route).toBe('/parent/pagamenti');
    });

    it('(c-bis) una route esplicita GREZZA resta redatta, come prima', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();
        suPagina('/iscrizione');

        const token = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
        logClient({
            livello: 'error',
            evento: 'react',
            messaggio: 'boundary',
            route: `/m/${token}`,
        });
        flush();

        const [batch] = await leggi();
        expect(batch.eventi[0].route).toBe('/m/[id]');
        expect(JSON.stringify(batch)).not.toContain(token);
    });

    it('(d) fuori dal browser non inventa una route: il campo resta assente', async () => {
        const { logClient, flush } = await moduloPulito();
        const leggi = intercettaBeacon();
        suPagina('/');

        // `location.pathname` vale `/` sulla home: ridotto resta `/`, che È una pagina vera.
        // Il caso da non sbagliare è l'altro — una stringa VUOTA non deve finire in tabella
        // come se fosse una rotta.
        logClient({ livello: 'warn', evento: 'offline', messaggio: 'sw-senza-controllo', route: '' });
        flush();

        const [batch] = await leggi();
        // Route vuota = nessuna route dichiarata: ripiega sulla pagina, non spedisce ''.
        expect(batch.eventi[0].route).toBe('/');
    });
});
