import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

/**
 * ─── IL CRUSCOTTO PAGAMENTI E LA CODA FATTURE (consegna 2b, D5 · D12, 2026-09-24) ─────
 *
 * Due difetti, uno per gruppo di casi:
 *
 *   D5  — «Invia fattura» sta DENTRO `FatturaButton` (T8), e sparisce su una riga con una voce
 *         attiva solo se il cruscotto gli passa `codaStato`. Senza, il pulsante resta lì e la
 *         segreteria riaccoda una fattura già in coda.
 *   D12 — dopo un accodamento il chip «In coda» deve comparire subito. Con esito `nuova` lo
 *         stato è noto per costruzione e basta la riga (zero richieste: `load()` sono due GET,
 *         tutti i pagamenti della sede e gli iscritti); con `gia` si rilegge.
 *
 * ⚠️ `FatturaButton` È FINTO E REGISTRA LE PROPS: il difetto è *una prop non passata*, e uno
 * stub che rendesse un segnaposto sarebbe verde con e senza la correzione. Il suo bottone
 * chiama `onEmessa` con l'esito scelto dal caso (`spia.esito`).
 *
 * ⚠️ IL CHIP SI CERCA DENTRO LA `row`: in jsdom tabella e card mobile sono montate insieme
 * (`hidden lg:block` / `lg:hidden` sono solo classi) e montano entrambe `FatturaChip`. Cercato
 * nel documento, il chip della card farebbe verde un aggiornamento che la tabella non vede.
 * (Qui le due leggono lo stesso `pagamenti`, ma la regola resta quella del file gemello
 * `importi-euro-italiani.test.tsx`, da cui viene l'impianto.)
 */

/**
 * ⚠️ UN MOCK DI next-intl LOCALE, E L'UNICA DIFFERENZA DAL GLOBALE È CHE `t` È STABILE.
 *
 * Quello di `test/setup.ts` crea una `t` NUOVA a ogni resa. `load` del cruscotto è un
 * `useCallback` che dipende da `t` (`PaymentsDashboard.tsx`, `[userId, scuolaId, t]`), e il
 * `useEffect` che lo lancia dipende da `load`: con una `t` nuova a ogni resa ogni `setPagamenti`
 * rilancia le due GET, in un giro che non finisce. Misurato su questo file prima di questo mock:
 * al primo controllo le GET dell'elenco erano già 2 e 3, senza nessun clic. Contarle — ed è
 * proprio ciò che distingue `nuova` da `gia` (D12) — non avrebbe voluto dire niente.
 * In produzione `useTranslations` di next-intl restituisce la stessa funzione finché lingua,
 * cataloghi e namespace non cambiano: questo mock fa lo stesso, con una cache per namespace.
 * Per il resto è il globale: tutti i cataloghi italiani, chiavi piatte e puntate, e la
 * formattazione ICU solo quando arrivano dei valori (come `RiconciliazioneLottoFatture.test.tsx`).
 */
vi.mock('next-intl', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const cartella = join(process.cwd(), 'messages/it');
    const cataloghi: Record<string, unknown> = {};
    for (const file of readdirSync(cartella)) {
        if (!file.endsWith('.json')) continue;
        cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
    }
    const foglia = (ns: string | undefined, chiave: string): string | undefined => {
        const base = ns ? cataloghi[ns] : cataloghi;
        if (!base || typeof base !== 'object') return undefined;
        const piatta = (base as Record<string, unknown>)[chiave];
        if (typeof piatta === 'string') return piatta;
        let corrente: unknown = base;
        for (const pezzo of chiave.split('.')) {
            if (!corrente || typeof corrente !== 'object') return undefined;
            corrente = (corrente as Record<string, unknown>)[pezzo];
        }
        return typeof corrente === 'string' ? corrente : undefined;
    };
    const resolve = (ns: string | undefined, key: string): string =>
        foglia(ns, key) ?? (ns ? `${ns}.${key}` : key);
    const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
        try {
            return String(new IntlMessageFormat(messaggio, 'it').format(valori));
        } catch {
            return messaggio;
        }
    };
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns?: string) => {
        const chiaveCache = ns ?? '';
        const gia = perNamespace.get(chiaveCache);
        if (gia) return gia;
        const t = (key: string, valori?: Record<string, unknown>) =>
            valori === undefined ? resolve(ns, key) : formatta(resolve(ns, key), valori);
        const stabile = Object.assign(t, {
            rich: (key: string) => resolve(ns, key),
            markup: (key: string) => resolve(ns, key),
            raw: (key: string) => resolve(ns, key),
            has: () => true,
        });
        perNamespace.set(chiaveCache, stabile);
        return stabile;
    };
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

const identita = vi.hoisted(() => ({ ruolo: 'admin' }));
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => identita.ruolo,
}));

const spia = vi.hoisted(() => ({
    props: [] as Record<string, unknown>[],
    esito: undefined as { accodata: 'nuova' | 'gia' } | undefined,
}));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: (props: Record<string, unknown>) => {
        spia.props.push(props);
        return (
            <button type="button"
                onClick={() => (props.onEmessa as ((e?: unknown) => void) | undefined)?.(spia.esito)}>
                Accoda finto
            </button>
        );
    },
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

const CATEGORIE = { success: true, data: [{ id: 'c1', nome: 'Retta', slug: 'retta' }] };
const ARUBA = { success: true, data: { abilitato: true } };

const STUDENTS = [
    { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: 'a2', nome: 'Ada', cognome: 'Bianchi', classe_sezione: 'Girasoli', stato: 'iscritto' },
];

/** Il giorno in cui gira il file: ottobre, come le due rette, così la vista rette le mostra. */
const GIORNO_FISSO = '2026-10-01T10:00:00';

/** Saldato e non fatturato («Da fatturare»), di ottobre come `GIORNO_FISSO`. */
function saldato(id: string, alunno: (typeof STUDENTS)[number], coda_stato: string | null) {
    return {
        id, alunno_id: alunno.id, descrizione: 'Retta Ottobre', importo: 150, importo_pagato: 150, stato: 'pagato',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-05', categoria_id: 'c1',
        periodo_competenza: '2026-10-01', coda_stato, alunni: { nome: alunno.nome, cognome: alunno.cognome },
    };
}

/** Due rette di ottobre saldate: una senza voce (`p-libera`), una in errore (`p-errore`). */
const PAGAMENTI = {
    success: true,
    data: [saldato('p-libera', STUDENTS[0], null), saldato('p-errore', STUDENTS[1], 'errore')],
};

/** Il dettaglio che il drawer chiede da sé (`GET /api/pagamenti/<id>`). */
const DETTAGLIO = { success: true, data: { incassi: [], rate: [], quote: [] } };

let fetchFinta: ReturnType<typeof vi.fn>;

/** Quante volte il cruscotto ha chiesto l'elenco dei pagamenti (metà di `load()`). */
function getElenco(): number {
    return fetchFinta.mock.calls.filter(([url]) => String(url).startsWith('/api/pagamenti?')).length;
}

/** La riga della TABELLA che contiene il testo: la card mobile è un `div` senza ruolo. */
function rigaTabella(testo: string): HTMLElement {
    const riga = screen.getAllByRole('row').find((r) => r.textContent?.includes(testo));
    if (!riga) throw new Error(`nessuna riga di tabella contiene «${testo}»`);
    return riga;
}

/** Le props dell'ULTIMA resa del pulsante di un pagamento. */
function propsDi(pagamentoId: string): Record<string, unknown> {
    const tutte = spia.props.filter((p) => p.pagamentoId === pagamentoId);
    const ultima = tutte.at(-1);
    if (!ultima) throw new Error(`FatturaButton di ${pagamentoId} mai reso`);
    return ultima;
}

describe('PaymentsDashboard — la coda fatture sul pulsante e dopo un accodamento (consegna 2b)', () => {
    beforeEach(() => {
        identita.ruolo = 'admin';
        spia.props.length = 0;
        spia.esito = undefined;
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date(GIORNO_FISSO));
        fetchFinta = vi.fn(async (url: string) => {
            const u = String(url);
            const body =
                u.startsWith('/api/pagamenti?') ? PAGAMENTI
                    : u.startsWith('/api/pagamenti/') ? DETTAGLIO
                        : u.startsWith('/api/admin/students') ? STUDENTS
                            : u.includes('/settings/categorie') ? CATEGORIE
                                : u.includes('/settings/aruba') ? ARUBA
                                    : { success: true, data: [] };
            return { ok: true, json: async () => body };
        });
        vi.stubGlobal('fetch', fetchFinta);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('D5: al pulsante della riga in errore arriva `codaStato: "errore"`, a quella senza voce `null`', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Presenza prima: la riga in errore ha già il suo chip.
        await waitFor(() => expect(within(rigaTabella('Ada Bianchi')).getByTestId('coda-chip')).toHaveTextContent('Errore in coda'));
        expect(propsDi('p-errore').codaStato).toBe('errore');
        // `null`, non assente: `toHaveProperty` distingue la prop passata a null da quella dimenticata.
        expect(propsDi('p-libera')).toHaveProperty('codaStato', null);
        expect(typeof propsDi('p-libera').onEmessa).toBe('function');
    });

    it('D12 `nuova`: il chip «In coda» compare sulla riga, e l\'elenco NON si rilegge', async () => {
        spia.esito = { accodata: 'nuova' };
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(within(rigaTabella('Mario Rossi')).getByText('Da fatturare')).toBeInTheDocument());
        expect(getElenco()).toBe(1);
        // L'assenza prima del clic, su una riga che c'è.
        expect(within(rigaTabella('Mario Rossi')).queryByTestId('coda-chip')).toBeNull();

        fireEvent.click(within(rigaTabella('Mario Rossi')).getByRole('button', { name: 'Accoda finto' }));

        // Una PRESENZA: il chip nuovo, sulla riga giusta.
        expect(await within(rigaTabella('Mario Rossi')).findByTestId('coda-chip')).toHaveTextContent('In coda');
        // E al pulsante della riga arriva lo stato nuovo (D5 subito dopo D12).
        expect(propsDi('p-libera').codaStato).toBe('in_coda');
        // L'altra riga non si tocca.
        expect(within(rigaTabella('Ada Bianchi')).getByTestId('coda-chip')).toHaveTextContent('Errore in coda');
        expect(getElenco()).toBe(1);
    });

    it('D12 `gia`: si rilegge l\'elenco (lo stato può essere `in_invio` o `errore`)', async () => {
        spia.esito = { accodata: 'gia' };
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(within(rigaTabella('Mario Rossi')).getByText('Da fatturare')).toBeInTheDocument());
        expect(getElenco()).toBe(1);

        fireEvent.click(within(rigaTabella('Mario Rossi')).getByRole('button', { name: 'Accoda finto' }));

        await waitFor(() => expect(getElenco()).toBe(2));
    });

    it('D12 senza esito: si rilegge l\'elenco, come per `gia`', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(within(rigaTabella('Mario Rossi')).getByText('Da fatturare')).toBeInTheDocument());
        expect(getElenco()).toBe(1);

        fireEvent.click(within(rigaTabella('Mario Rossi')).getByRole('button', { name: 'Accoda finto' }));

        await waitFor(() => expect(getElenco()).toBe(2));
    });

    it('D12 dal drawer: un accodamento `nuova` fatto lì accende il chip sulla riga della tabella', async () => {
        spia.esito = { accodata: 'nuova' };
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(within(rigaTabella('Mario Rossi')).getByText('Da fatturare')).toBeInTheDocument());

        fireEvent.click(within(rigaTabella('Mario Rossi')).getByTitle('Dettagli'));
        const drawer = await screen.findByRole('dialog');
        fireEvent.click(within(drawer).getByRole('button', { name: 'Accoda finto' }));

        expect(await within(rigaTabella('Mario Rossi')).findByTestId('coda-chip')).toHaveTextContent('In coda');
        expect(getElenco()).toBe(1);
    });
});
