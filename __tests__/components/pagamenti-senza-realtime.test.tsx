import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

/**
 * I PAGAMENTI DEL GENITORE SENZA REALTIME (S4-A, 12/10/2026).
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 * IL FATTO, misurato. Tre componenti dell'area genitore ascoltavano `postgres_changes` su
 * TABELLE INTERE: `SospensioneBanner` (pagamenti, incassi e `alunni`), `PagamentiSummary`
 * (pagamenti, incassi) e `StoricoPagamenti` (pagamenti, incassi). Non è un filtro per famiglia:
 * il canale riceve OGNI modifica della tabella e il database deve valutare la RLS una volta per
 * ogni modifica e per ogni ascoltatore. La segreteria che genera le rette del mese scrive
 * centinaia di righe in un colpo, e ogni riga moltiplica per il numero di famiglie collegate —
 * e ogni modifica ricevuta faceva ANCHE un refetch.
 *
 * ⚠️ E UNO DEI CANALI NON POTEVA FUNZIONARE. `alunni` NON è nella pubblicazione
 * `supabase_realtime` (verificato in produzione il 12/10 su `pg_publication_tables`): quel
 * terzo `.on('postgres_changes', …, { table: 'alunni' })` non ha mai consegnato niente a
 * nessuno. Un abbonamento che non può scattare non si vede: non fallisce, non avvisa, e chi
 * leggeva il codice concludeva che la revoca della sospensione arrivasse da sola.
 *
 * AL SUO POSTO un orologio lento, fermo quando nessuno guarda, che riparte al ritorno in primo
 * piano (`usePollingVisibile`). Lo stato dei pagamenti cambia quando la segreteria registra un
 * incasso: poche volte al giorno, non poche volte al minuto.
 * ═════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Il client Supabase del browser: se qualcuno riapre un canale, queste spie lo dicono.
 *
 * ⚠️ NON è un mock piatto che passa per forza: `canale` conta le sottoscrizioni, e il giorno in
 * cui un `.channel(...)` tornasse in uno di questi tre componenti il conto passa da 0 a 1 e le
 * prove diventano rosse. Finché l'import non c'è, le spie restano a zero — che è il fatto da
 * dimostrare.
 */
const supa = vi.hoisted(() => ({ clienti: 0, canali: 0 }));

vi.mock('@/lib/supabase/browser-client', () => {
    const channel = {
        on() { return channel; },
        subscribe() { return channel; },
    };
    return {
        getSupabase: () => {
            supa.clienti += 1;
            return {
                channel: () => { supa.canali += 1; return channel; },
                removeChannel: () => {},
            };
        },
    };
});

// Web: nessun bridge Capacitor dentro `osservaVisibilita`.
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

/**
 * `next-intl` CON UNA `t` STABILE, e qui non è un dettaglio: è la condizione perché questo
 * file possa contare le richieste.
 *
 * Il mock globale (`test/setup.ts`) costruisce una `t` NUOVA a ogni chiamata di
 * `useTranslations`. In `StoricoPagamenti` `load` è un `useCallback(..., [userId, t])` e il
 * suo `useEffect(() => { load() }, [load])` rifà quindi la GET a OGNI render: un ciclo
 * infinito che rende ogni conteggio privo di senso (e che manda in timeout qualunque
 * `await act(async …)`, perché la coda non diventa mai quieta — misurato e già scritto in
 * `__tests__/components/StoricoPagamenti-fattura-scarico.test.tsx`).
 *
 * ⚠️ È un artefatto del FINTO, non un difetto del prodotto: in `use-intl` la `t` nasce da
 * `const translate = useMemo(() => createBaseTranslator({…}), […])`, quindi in produzione
 * la sua identità regge fra i render e l'effetto parte una volta. Tenere la `t` stabile qui
 * è l'unico modo di misurare il ritmo vero invece del ritmo del mock.
 *
 * Le chiavi si risolvono nel proprio nome perché in questo file NESSUNA asserzione legge un
 * testo: si contano URL. Chi aggiungesse qui una prova sui testi italiani deve invece
 * leggere i cataloghi, come fa il mock globale.
 */
vi.mock('next-intl', () => {
    const memoria = new Map<string, ReturnType<typeof costruisci>>();
    const costruisci = (ns?: string) => {
        const t = (key: string) => (ns ? `${ns}.${key}` : key);
        return Object.assign(t, {
            rich: (key: string) => (ns ? `${ns}.${key}` : key),
            markup: (key: string) => (ns ? `${ns}.${key}` : key),
            raw: (key: string) => (ns ? `${ns}.${key}` : key),
            has: () => true,
        });
    };
    return {
        useTranslations: (ns?: string) => {
            const chiave = ns ?? '';
            const trovata = memoria.get(chiave);
            if (trovata) return trovata;
            const nuova = costruisci(ns);
            memoria.set(chiave, nuova);
            return nuova;
        },
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({
    logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
    impostaVersioneApp: () => {},
}));

import { SospensioneBanner } from '@/components/features/parent/SospensioneBanner';
import { PagamentiSummary } from '@/components/features/parent/pagamenti/PagamentiSummary';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';
import { RITMO_PAGAMENTI_MS } from '@/lib/pagamenti/ritmo';

const UTENTE = 'u-1';

/** Tre voci con fattura emessa: ognuna monta il suo `FatturaDocumenti`. */
const VOCI = [1, 2, 3].map((n) => ({
    id: `p${n}`,
    alunno_id: 'a1',
    scuola_id: 'sede-1',
    descrizione: `Retta ${n}`,
    importo: 100,
    importo_pagato: 0,
    sconto: 0,
    scadenza: '2026-09-10',
    stato: 'da_pagare',
    tipo: 'singolo',
    obbligatorio: true,
    fattura_stato: 'emessa',
    payment_categories: { nome: 'Rette', icona: '🧾' },
    alunni: { nome: 'Mara', cognome: 'Bianchi' },
}));

let rete: ReturnType<typeof vi.fn>;

function conta(frammento: string): number {
    return rete.mock.calls.filter(([u]) => String(u).includes(frammento)).length;
}

/** `/api/pagamenti` da solo, senza contare la rotta figlia `fattura/list`. */
function chiamateElenco(): number {
    return rete.mock.calls.filter(([u]) => {
        const url = String(u);
        return url.startsWith('/api/pagamenti?') || url.startsWith('/api/pagamenti/sospensione-stato');
    }).length;
}

function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (nascosta ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

async function avanza(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
}

/**
 * Lascia arrivare la catena `fetch → res.json() → setStato → render → effetto figlio`.
 *
 * ⚠️ Non si usa `waitFor`: con l'orologio finto la sua attesa non scorre, e un `waitFor`
 * che non può avverarsi paga il timeout intero invece di dire che cosa manca (20 s,
 * misurati su questo stesso file). Qui si svuotano i microtask a mano.
 *
 * I giri sono generosi di proposito: un turno in più non può nascondere niente, perché
 * tutte le asserzioni di questo file sono CONTEGGI di chiamate — più tempo si lascia, più
 * chiamate potrebbero comparire, quindi la prova diventa severa, non indulgente.
 */
async function assorbi() {
    await act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    supa.clienti = 0;
    supa.canali = 0;
    logClient.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    rete = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/fattura/list')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, data: [] }),
            };
        }
        if (u.startsWith('/api/pagamenti/sospensione-stato')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, data: { sospeso: false, totaleScaduto: 0 } }),
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: VOCI, sedi: [] }),
        };
    });
    vi.stubGlobal('fetch', rete);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('S4-A — nessun canale realtime sui pagamenti del genitore', () => {
    it('il RITMO non scende sotto i cinque minuti', () => {
        // Non è un numero di gusto: il 12/10, in due ore, `/rest/v1/pagamenti` ha preso 11.327
        // richieste e il p95 del database è salito da 25 ms a 350-470 ms su `/auth/v1/user`. Un
        // orologio che sostituisce il realtime e intanto aggiunge richieste non ha risolto
        // niente. ROSSO SE: qualcuno lo stringe «per farlo sembrare più reattivo».
        expect(RITMO_PAGAMENTI_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    });

    it.each([
        ['SospensioneBanner', () => <SospensioneBanner userId={UTENTE} />],
        ['PagamentiSummary', () => <PagamentiSummary userId={UTENTE} href="/parent/pagamenti" />],
        ['StoricoPagamenti', () => <StoricoPagamenti userId={UTENTE} />],
    ])('%s non apre nessun canale', async (_nome, albero) => {
        render(albero());
        await assorbi();

        expect(supa.canali, 'è tornato un `.channel(...)` su una tabella intera').toBe(0);
        expect(supa.clienti, 'il client del browser non serve più a questo componente').toBe(0);
    });

    it.each([
        ['SospensioneBanner', () => <SospensioneBanner userId={UTENTE} />],
        ['PagamentiSummary', () => <PagamentiSummary userId={UTENTE} href="/parent/pagamenti" />],
        ['StoricoPagamenti', () => <StoricoPagamenti userId={UTENTE} />],
    ])('%s ricarica al ritmo lento, e si ferma quando nessuno guarda', async (_nome, albero) => {
        render(albero());
        await assorbi();
        const primo = chiamateElenco();
        expect(primo, 'il primo caricamento non è partito').toBe(1);

        await avanza(RITMO_PAGAMENTI_MS);
        expect(chiamateElenco(), "l'orologio non ha fatto il suo giro").toBe(primo + 1);

        // Telefono in tasca: l'orologio si FERMA. È il difetto del 7 settembre.
        await act(async () => { visibilita(true); });
        await avanza(RITMO_PAGAMENTI_MS * 5);
        expect(chiamateElenco(), 'ha continuato a chiamare a pagina nascosta').toBe(primo + 1);

        // E il ritorno ricarica subito: chi riapre l'app deve trovare i dati freschi.
        await act(async () => { visibilita(false); });
        await assorbi();
        expect(chiamateElenco(), 'il ritorno in primo piano non ha ricaricato').toBe(primo + 2);
    });
});

describe('S4-A — la ricarica NON rifà le N chiamate a `fattura/list`', () => {
    it('un giro dell\'orologio non rimonta le righe', async () => {
        // ─────────────────────────────────────────────────────────────────────────────
        // È LA PARTE CHE POTEVA PEGGIORARE LE COSE. `FatturaDocumenti` interroga
        // `/api/pagamenti/fattura/list` UNA VOLTA PER RIGA, e quella rotta fa una `list` sul
        // bucket delle fatture: il 12/10, in due ore, 5.006 chiamate a
        // `storage/v1/object/list/fatture`. Se la ricarica periodica rimontasse le righe,
        // ogni giro dell'orologio costerebbe N chiamate in più invece di una.
        //
        // Ciò che lo impedisce: le chiavi di lista sono stabili (`key={p.id}` sulla card,
        // `key={g.categoria}` sulla sezione, e `raggruppaPerCategoria` è deterministica) e
        // l'effetto di `useFattureScaricabili` dipende solo da `[pagamentoId, userId]`.
        // ROSSO SE: una delle due cose cambia — una chiave sull'indice, un oggetto nuovo nelle
        // dipendenze dell'effetto, un `key` che include lo stato della voce.
        // ─────────────────────────────────────────────────────────────────────────────
        render(<StoricoPagamenti userId={UTENTE} />);
        await assorbi();
        expect(
            conta('/api/pagamenti/fattura/list'),
            'le righe non hanno chiesto il loro elenco fatture: la prova misurerebbe il nulla',
        ).toBe(VOCI.length);

        await avanza(RITMO_PAGAMENTI_MS);
        await assorbi();

        expect(chiamateElenco(), "l'orologio non ha ricaricato l'elenco").toBe(2);
        expect(
            conta('/api/pagamenti/fattura/list'),
            'la ricarica ha rimontato le righe: N chiamate a `fattura/list` per ogni giro',
        ).toBe(VOCI.length);
    });
});
