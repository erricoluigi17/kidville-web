import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { scegliAnno, scegliCategorie, scegliMesi } from '../helpers/scelta-contabilita';

/**
 * ─── I KPI DELLA CONTABILITÀ SOMMANO LA SELEZIONE (T9, 2026-10-07) ───────────────────────
 *
 * Decisioni del titolare, una per gruppo di casi:
 *   1. All'apertura: categoria Retta, mese corrente → le card sommano le sole rette del mese.
 *   2. Più categorie / più mesi → elenco per voce con la colonna «Categoria»; KPI = quelle voci.
 *   3. I KPI NON seguono la ricerca né il filtro «Morosi».
 *   4. L'agenda resta su TUTTE le voci (a parte il filtro classi).
 *   5. La riga `kpi-selezione` dice cosa si sta sommando.
 *   6. «Genera mancanti» solo con un mese di retta (set–giu).
 *   7. L'occhio «Nascondi cifre»: card, tabella per sede e agenda; persiste; solo Direzione.
 *   8. «Nuovo acquisto» solo con UNA categoria diversa dalla retta.
 *
 * Dati finti (nessuna PII). `t` STABILE come in `PaymentsDashboard-multisede.test.tsx`: `load`
 * dipende da `t`, e con una `t` nuova a ogni resa le GET ripartirebbero all'infinito.
 */
vi.mock('next-intl', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const cartella = join(process.cwd(), 'messages/it');
    const cataloghi: Record<string, Record<string, unknown>> = {};
    for (const file of readdirSync(cartella)) {
        if (!file.endsWith('.json')) continue;
        cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
    }
    const resolve = (ns: string | undefined, key: string): string => {
        const v = ns ? cataloghi[ns]?.[key] : undefined;
        return typeof v === 'string' ? v : ns ? `${ns}.${key}` : key;
    };
    const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
        try {
            return String(new IntlMessageFormat(messaggio, 'it').format(valori));
        } catch {
            return messaggio;
        }
    };
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns?: string) => {
        const chiave = ns ?? '';
        const gia = perNamespace.get(chiave);
        if (gia) return gia;
        const t = (key: string, valori?: Record<string, unknown>) =>
            valori === undefined ? resolve(ns, key) : formatta(resolve(ns, key), valori);
        const stabile = Object.assign(t, {
            rich: (key: string) => resolve(ns, key),
            markup: (key: string) => resolve(ns, key),
            raw: (key: string) => resolve(ns, key),
            has: () => true,
        });
        perNamespace.set(chiave, stabile);
        return stabile;
    };
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

/** Il ruolo è una variabile: la Segreteria non deve avere né KPI né occhio. */
const identita = vi.hoisted(() => ({ ruolo: 'admin' }));
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => identita.ruolo,
}));

const SEDI = [
    { id: 'sede-a', nome: 'Kidville Aversa' },
    { id: 'sede-g', nome: 'Kidville Giugliano' },
];
const sediCtx = vi.hoisted(() => ({
    valore: {
        sedi: [] as { id: string; nome: string }[],
        effettive: [] as string[],
        selezionate: [] as string[],
        sedeCorrente: null as string | null,
        reFetchKey: '',
    },
}));
vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => sediCtx.valore,
}));

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

const OTTOBRE = '2026-10-10T10:00:00';

const CATEGORIE = {
    success: true,
    data: [
        { id: 'c-retta', nome: 'Retta', slug: 'retta', scuola_id: null },
        { id: 'c-gita', nome: 'Gita', slug: 'gita', scuola_id: null },
        { id: 'c-mensa', nome: 'Mensa', slug: 'mensa', scuola_id: null },
    ],
};

const UNO = { id: 'a1', nome: 'Prova', cognome: 'Uno' };
const DUE = { id: 'a2', nome: 'Prova', cognome: 'Due' };
const TRE = { id: 'a3', nome: 'Prova', cognome: 'Tre' };

type Riga = Record<string, unknown>;
function voce(id: string, alunno: typeof UNO, sede: { id: string; nome: string }, extra: Riga): Riga {
    return {
        id, alunno_id: alunno.id, descrizione: id, importo: 100, importo_pagato: 0, stato: 'da_pagare',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-20', categoria_id: 'c-retta',
        periodo_competenza: null, coda_stato: null, scuola_id: sede.id, scuola_nome: sede.nome,
        alunni: { nome: alunno.nome, cognome: alunno.cognome, section_id: 'sez-1', classe_sezione: 'Girasoli', sospeso: false },
        ...extra,
    };
}

/**
 * Selezione di default (Retta · ottobre): Incassato 100 · Da incassare 200 · Scaduto 200 · Da fatturare 100.
 * Fuori selezione: la retta di novembre (150), la gita di ottobre (40), la mensa di novembre (60) e
 * la mensa di settembre (25, scaduta: finisce nell'agenda ma non nei KPI).
 */
function pagamenti(sede: { id: string; nome: string }) {
    return {
        success: true,
        data: [
            voce('Retta ott Uno', UNO, sede, { importo: 100, importo_pagato: 100, stato: 'pagato', scadenza: '2026-10-05', periodo_competenza: '2026-10-01' }),
            voce('Retta ott Due', DUE, sede, { importo: 200, stato: 'scaduto', scadenza: '2026-10-05', periodo_competenza: '2026-10-01' }),
            voce('Retta nov Uno', UNO, sede, { importo: 150, scadenza: '2026-11-05', periodo_competenza: '2026-11-01' }),
            voce('Gita ott Uno', UNO, sede, { importo: 40, categoria_id: 'c-gita', scadenza: '2026-10-20' }),
            voce('Mensa nov Due', DUE, sede, { importo: 60, categoria_id: 'c-mensa', scadenza: '2026-11-10' }),
            voce('Mensa set Uno', UNO, sede, { importo: 25, categoria_id: 'c-mensa', stato: 'scaduto', scadenza: '2026-09-12' }),
        ],
    };
}

const STUDENTS = [UNO, DUE, TRE].map((a) => ({ ...a, classe_sezione: 'Girasoli', section_id: 'sez-1', scuola_id: 's1', stato: 'iscritto' }));

function stub(corpo: unknown, students: unknown = STUDENTS) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        const body =
            u.startsWith('/api/pagamenti?') ? corpo
                : u.startsWith('/api/pagamenti/rette-a-carico') ? { success: true, data: [], a_carico_non_visibili: [] }
                    : u.startsWith('/api/admin/students') ? students
                        : u.includes('/settings/categorie') ? CATEGORIE
                            : u.includes('/settings/aruba') ? { success: true, data: { abilitato: true } }
                                : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    }));
}

function unaSede() {
    sediCtx.valore = { sedi: [{ id: 's1', nome: 'Kidville Uno' }], effettive: ['s1'], selezionate: [], sedeCorrente: 's1', reFetchKey: 's1' };
}
function dueSedi() {
    sediCtx.valore = { sedi: SEDI, effettive: ['sede-a', 'sede-g'], selezionate: [], sedeCorrente: null, reFetchKey: 'sede-a,sede-g' };
}

function rigaTabella(testo: string): HTMLElement {
    const riga = screen.getAllByRole('row').find((r) => r.textContent?.includes(testo));
    if (!riga) throw new Error(`nessuna riga di tabella contiene «${testo}»`);
    return riga;
}
const righeConTesto = (testo: string) => screen.queryAllByRole('row').filter((r) => r.textContent?.includes(testo));

function cardKpi(etichetta: string): HTMLElement {
    const card = within(screen.getByTestId('kpi-contabilita')).getByText(etichetta).closest('.rounded-card');
    if (!card) throw new Error(`card KPI «${etichetta}» non trovata`);
    return card as HTMLElement;
}
/** Le quattro card KPI portano, nell'ordine, questi importi (formato italiano). */
function aspettaCard(incassato: string, daIncassare: string, scaduto: string, daFatturare: string) {
    expect(cardKpi('Incassato')).toHaveTextContent(incassato);
    expect(cardKpi('Da incassare')).toHaveTextContent(daIncassare);
    expect(cardKpi('Scaduto (morosità)')).toHaveTextContent(scaduto);
    expect(cardKpi('Da fatturare')).toHaveTextContent(daFatturare);
}

/** La vista per alunno è pronta quando la sua riga c'è (le GET sono arrivate). */
async function attendiVistaAlunno() {
    await waitFor(() => expect(rigaTabella('Prova Uno')).toBeInTheDocument());
}

beforeEach(() => {
    identita.ruolo = 'admin';
    unaSede();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(OTTOBRE));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
});


describe('T9 · 1 — l\'apertura somma le sole rette del mese corrente', () => {
    it('Retta · ottobre: le card portano solo quelle voci (non la gita, non novembre)', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        await waitFor(() => expect(cardKpi('Incassato')).toHaveTextContent('€ 100,00'));
        // Sommando TUTTE le voci si avrebbe Da incassare 475 (200+150+40+60+25) e Scaduto 225:
        // qui contano solo le rette di ottobre.
        aspettaCard('€ 100,00', '€ 200,00', '€ 200,00', '€ 100,00');
    });
});

describe('T9 · 2 — più categorie e più mesi: elenco per voce con la colonna «Categoria»', () => {
    it('Retta+Mensa × ott+nov: le quattro voci, la colonna Categoria, i KPI di quelle voci', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        // Presenza prima: nella vista per alunno non c'è la colonna Categoria.
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Categoria');

        await scegliCategorie(['Retta', 'Mensa']);
        await scegliMesi(['Ott 2026', 'Nov 2026']);

        await waitFor(() => expect(rigaTabella('Mensa nov Due')).toBeInTheDocument());
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Categoria');
        for (const d of ['Retta ott Uno', 'Retta ott Due', 'Retta nov Uno', 'Mensa nov Due']) {
            expect(rigaTabella(d)).toBeInTheDocument();
        }
        // La categoria della voce, in una cella a sé.
        expect(within(rigaTabella('Mensa nov Due')).getByText('Mensa')).toBeInTheDocument();
        expect(within(rigaTabella('Retta ott Uno')).getByText('Retta')).toBeInTheDocument();
        // E nelle card mobile (in jsdom montate insieme alla tabella): una riga di categoria per voce.
        const cardCategoria = screen.getAllByTestId('card-categoria').map((c) => c.textContent);
        expect(cardCategoria).toHaveLength(4);
        expect(cardCategoria.filter((c) => c === 'Mensa')).toHaveLength(1);
        expect(cardCategoria.filter((c) => c === 'Retta')).toHaveLength(3);
        // Fuori selezione: la gita di ottobre e la mensa di settembre.
        expect(righeConTesto('Gita ott Uno')).toHaveLength(0);
        expect(righeConTesto('Mensa set Uno')).toHaveLength(0);
        // KPI: 100 incassati; da incassare 200+150+60; scaduto 200; da fatturare 100.
        aspettaCard('€ 100,00', '€ 410,00', '€ 200,00', '€ 100,00');
    });

    it('una sola categoria non retta: niente colonna Categoria (la dice già il filtro)', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        await scegliCategorie(['Gita']);
        await waitFor(() => expect(rigaTabella('Gita ott Uno')).toBeInTheDocument());
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Categoria');
        expect(screen.queryAllByTestId('card-categoria')).toHaveLength(0);
    });
});

describe('T9 · 3 — i KPI non seguono la ricerca né «Morosi»', () => {
    it('la ricerca restringe l\'elenco ma non le card; «Morosi» idem', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        aspettaCard('€ 100,00', '€ 200,00', '€ 200,00', '€ 100,00');

        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: 'Due' } });
        // La ricerca ha effetto davvero (presenza dell'una, assenza dell'altra)...
        await waitFor(() => expect(righeConTesto('Prova Uno')).toHaveLength(0));
        expect(rigaTabella('Prova Due')).toBeInTheDocument();
        // ...e le card restano quelle di prima.
        aspettaCard('€ 100,00', '€ 200,00', '€ 200,00', '€ 100,00');

        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: '' } });
        // Presenza prima: la ricerca svuotata riporta TUTTI (anche Prova Tre, senza retta).
        await waitFor(() => expect(rigaTabella('Prova Uno')).toBeInTheDocument());
        expect(rigaTabella('Prova Tre')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Morosi/ }));
        // Solo chi ha la retta scaduta (Prova Due) resta in elenco.
        await waitFor(() => expect(righeConTesto('Prova Uno')).toHaveLength(0));
        expect(righeConTesto('Prova Tre')).toHaveLength(0);
        expect(rigaTabella('Prova Due')).toBeInTheDocument();
        aspettaCard('€ 100,00', '€ 200,00', '€ 200,00', '€ 100,00');
    });

    it('anche nell\'elenco per voce (Retta+Mensa × ott+nov) le card restano ferme', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        await scegliCategorie(['Retta', 'Mensa']);
        await scegliMesi(['Ott 2026', 'Nov 2026']);
        await waitFor(() => expect(rigaTabella('Mensa nov Due')).toBeInTheDocument());
        aspettaCard('€ 100,00', '€ 410,00', '€ 200,00', '€ 100,00');

        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: 'Due' } });
        await waitFor(() => expect(righeConTesto('Retta nov Uno')).toHaveLength(0));
        expect(rigaTabella('Mensa nov Due')).toBeInTheDocument();
        aspettaCard('€ 100,00', '€ 410,00', '€ 200,00', '€ 100,00');

        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: '' } });
        await waitFor(() => expect(rigaTabella('Retta nov Uno')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /Morosi/ }));
        // Resta la sola voce scaduta («Retta ott Due»): l'elenco si è ristretto davvero...
        await waitFor(() => expect(righeConTesto('Mensa nov Due')).toHaveLength(0));
        expect(rigaTabella('Retta ott Due')).toBeInTheDocument();
        // ...e le card no.
        aspettaCard('€ 100,00', '€ 410,00', '€ 200,00', '€ 100,00');
    });
});

describe('T9 · 4 — l\'agenda resta su TUTTE le voci', () => {
    it('il bucket «Scaduti fino a 30gg» elenca anche la mensa di settembre, fuori selezione', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        // Fuori dall'agenda la mensa di settembre non è né nelle righe né nei KPI.
        expect(righeConTesto('Mensa set Uno')).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: /Scaduti fino a 30gg/ }));
        await waitFor(() => expect(rigaTabella('Mensa set Uno')).toBeInTheDocument());
        expect(rigaTabella('Retta ott Due')).toBeInTheDocument();
    });
});

describe('T9 · 5 — la riga «Somma di:» dice cosa si somma', () => {
    it('di default «Somma di: Retta · ottobre 2026»; cambia con la selezione', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Retta · ottobre 2026'));

        await scegliCategorie(['Retta', 'Gita']);
        await scegliMesi(['Ott 2026', 'Nov 2026']);
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Retta, Gita · ott–nov 2026'));

        await scegliCategorie('tutte');
        await scegliMesi('tutto');
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Tutte le categorie · Tutto l’anno'));
    });

    it('prima che arrivino le categorie nessuna somma «di tutto»: le card restano «—»', async () => {
        // Le categorie non arrivano mai: la selezione resta «in attesa».
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const u = String(url);
            if (u.includes('/settings/categorie')) return new Promise(() => {});
            const body = u.startsWith('/api/pagamenti?') ? pagamenti({ id: 's1', nome: 'Kidville Uno' })
                : u.startsWith('/api/pagamenti/rette-a-carico') ? { success: true, data: [], a_carico_non_visibili: [] }
                    : u.startsWith('/api/admin/students') ? STUDENTS
                        : { success: true, data: { abilitato: true } };
            return { ok: true, status: 200, json: async () => body };
        }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Presenza: la schermata ha caricato i pagamenti (l'agenda è montata)...
        await screen.findByRole('button', { name: /Scaduti fino a 30gg/ });
        // ...ma le card dicono «—», non la somma di tutte le voci.
        expect(cardKpi('Incassato')).toHaveTextContent('—');
        expect(cardKpi('Incassato')).not.toHaveTextContent('€');
        expect(screen.getByTestId('kpi-selezione')).not.toHaveTextContent('Somma di');
    });
});

describe('T9 · 5b — mai «in caricamento» per sempre se le categorie non arrivano', () => {
    /** Le categorie falliscono in modo diverso; il resto risponde. */
    function stubCategorieGuaste(guasto: () => Promise<unknown>) {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const u = String(url);
            if (u.includes('/settings/categorie')) return guasto();
            const body = u.startsWith('/api/pagamenti?') ? pagamenti({ id: 's1', nome: 'Kidville Uno' })
                : u.startsWith('/api/pagamenti/rette-a-carico') ? { success: true, data: [], a_carico_non_visibili: [] }
                    : u.startsWith('/api/admin/students') ? STUDENTS
                        : { success: true, data: { abilitato: true } };
            return { ok: true, status: 200, json: async () => body };
        }));
    }
    async function controlla() {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Tutte le categorie, il mese fissato: la selezione di ripiego, non «—» né «Caricamento…».
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Tutte le categorie · ottobre 2026'));
        // Con tutte le voci di ottobre: incassato 100 (retta pagata), da incassare 200+40.
        expect(cardKpi('Incassato')).toHaveTextContent('€ 100,00');
        expect(cardKpi('Da incassare')).toHaveTextContent('€ 240,00');
        expect(screen.queryByText('Caricamento…')).toBeNull();
    }

    it('GET categorie 500: «Tutte le categorie», card in euro, nessun caricamento infinito', async () => {
        stubCategorieGuaste(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Errore interno' }) }));
        await controlla();
    });

    it('fetch delle categorie che rifiuta (rete giù): lo stesso', async () => {
        stubCategorieGuaste(() => Promise.reject(new TypeError('Failed to fetch')));
        await controlla();
    });
});

describe('T9 · 5c — la scelta dell\'anno mantiene i mesi', () => {
    it('anno 2027 con ottobre scelto: la riga dice «ottobre 2027»', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Retta · ottobre 2026'));
        await screen.findByRole('button', { name: /^Mesi/ });
        scegliAnno(2027);
        await waitFor(() => expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('Somma di: Retta · ottobre 2027'));
    });
});

describe('T9 · 6 — «Genera mancanti» solo con un mese di retta', () => {
    it('a ottobre c\'è (Prova Tre senza retta)', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        expect(await screen.findByRole('button', { name: 'Genera mancanti' })).toBeInTheDocument();
    });

    function postGenera() {
        return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
            .filter(([u, i]) => String(u).startsWith('/api/pagamenti/genera-rette') && (i as RequestInit | undefined)?.method === 'POST');
    }

    it('con Retta + novembre la CTA genera il mese SCELTO (2026-11), sulla sede giusta', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await screen.findByRole('button', { name: 'Genera mancanti' });
        await scegliMesi(['Nov 2026']);
        // A novembre solo Prova Uno ha la retta: mancano Prova Due e Prova Tre, e la frase cita il mese.
        await waitFor(() => expect(screen.getByTestId('cta-genera-mancanti-frase').textContent).toMatch(/^2 alunni senza retta generata per Nov 2026/));
        fireEvent.click(screen.getByRole('button', { name: 'Genera mancanti' }));
        await waitFor(() => expect(postGenera()).toHaveLength(1));
        expect(JSON.parse(String((postGenera()[0][1] as RequestInit).body))).toEqual({ periodo: '2026-11', scuola_id: 's1' });
    });

    it('con un altro anno (2027) e ottobre: periodo 2027-10', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await screen.findByRole('button', { name: 'Genera mancanti' });
        scegliAnno(2027);
        await waitFor(() => expect(screen.getByTestId('cta-genera-mancanti-frase').textContent).toMatch(/^3 alunni senza retta generata per Ott 2027/));
        fireEvent.click(screen.getByRole('button', { name: 'Genera mancanti' }));
        await waitFor(() => expect(postGenera()).toHaveLength(1));
        expect(JSON.parse(String((postGenera()[0][1] as RequestInit).body))).toEqual({ periodo: '2027-10', scuola_id: 's1' });
    });

    it('a luglio la retta si vede come elenco per voce: niente «Non generata», niente CTA, stato vuoto', async () => {
        vi.setSystemTime(new Date('2026-07-10T10:00:00'));
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Presenza prima: l'elenco per voce di luglio non ha voci e lo dice.
        expect(await screen.findByText('Nessun pagamento per questa selezione.')).toBeInTheDocument();
        expect(screen.getByTestId('kpi-selezione')).toHaveTextContent('luglio 2026');
        // La vista per alunno (e il suo «Non generata» falso) non c'è, né la CTA che genererebbe rette estive.
        expect(screen.queryByText('Non generata')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Genera mancanti' })).toBeNull();
        expect(screen.queryByTestId('cta-genera-mancanti')).toBeNull();
    });
});

describe('T9 · 6b — «Rateizza» non compare sulle rette nell\'elenco per voce', () => {
    it('la retta non pagata non ha «Dividi in acconti»; la gita non pagata sì', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        await scegliCategorie(['Retta', 'Gita']);
        await waitFor(() => expect(rigaTabella('Gita ott Uno')).toBeInTheDocument());
        // Presenza prima: la gita (altra categoria, non pagata) lo ha…
        expect(within(rigaTabella('Gita ott Uno')).getByTitle('Dividi in acconti')).toBeInTheDocument();
        // …la retta scaduta no: le rate non portano `periodo_competenza` e «Genera mancanti» la riemetterebbe.
        expect(within(rigaTabella('Retta ott Due')).queryByTitle('Dividi in acconti')).toBeNull();
    });
});

describe('T9 · 7 — l\'occhio «Nascondi cifre»', () => {
    it('card, tabella per sede e agenda diventano «••••» (nessun «€» nei KPI) e la scelta persiste', async () => {
        dueSedi();
        // Due sedi: ogni voce con la sua sede.
        const corpo = { success: true, data: [
            ...(pagamenti(SEDI[0]).data as Riga[]).map((v) => ({ ...v, id: `a-${v.id}` })),
            ...(pagamenti(SEDI[1]).data as Riga[]).map((v) => ({ ...v, id: `g-${v.id}`, descrizione: `g-${v.descrizione}` })),
        ] };
        stub(corpo, STUDENTS.map((s) => ({ ...s, scuola_id: 'sede-a' })));
        const { unmount } = render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        const blocco = await screen.findByTestId('kpi-per-sede');
        // Presenza prima: gli importi ci sono, in euro.
        expect(blocco).toHaveTextContent('€');
        expect(within(screen.getByTestId('kpi-contabilita')).getAllByText(/€/).length).toBeGreaterThan(0);
        const bucket = () => screen.getByRole('button', { name: /Scaduti fino a 30gg/ });
        expect(bucket()).toHaveTextContent('€');

        fireEvent.click(screen.getByRole('button', { name: 'Nascondi cifre' }));

        expect(screen.getByRole('button', { name: 'Nascondi cifre' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('kpi-contabilita').textContent).not.toContain('€');
        expect(screen.getByTestId('kpi-contabilita')).toHaveTextContent('••••');
        expect(screen.getByTestId('kpi-per-sede').textContent).not.toContain('€');
        expect(screen.getByTestId('kpi-per-sede')).toHaveTextContent('••••');
        expect(bucket().textContent).not.toContain('€');
        expect(bucket()).toHaveTextContent('••••');

        // Smontaggio e rimontaggio: la scelta è ricordata.
        unmount();
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await screen.findByTestId('kpi-per-sede');
        expect(screen.getByRole('button', { name: 'Nascondi cifre' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('kpi-contabilita').textContent).not.toContain('€');
    });

    it('alla Segreteria il bottone non c\'è', async () => {
        identita.ruolo = 'segreteria';
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        expect(screen.queryByRole('button', { name: 'Nascondi cifre' })).toBeNull();
        expect(screen.queryByTestId('kpi-contabilita')).toBeNull();
    });
});

describe('T9 · 8 — «Nuovo acquisto» solo con UNA categoria non retta', () => {
    it('la sola retta su DUE mesi è un elenco per voce, e non offre «Nuovo acquisto»', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        await scegliMesi(['Ott 2026', 'Nov 2026']);
        // Presenza: l'elenco per voce c'è (la voce di novembre non esiste nella vista per alunno di ottobre).
        await waitFor(() => expect(rigaTabella('Retta nov Uno')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Nuovo acquisto/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Genera mancanti' })).toBeNull();
    });

    it('non c\'è con la sola retta, c\'è con la sola gita, sparisce con gita+mensa', async () => {
        stub(pagamenti({ id: 's1', nome: 'Kidville Uno' }));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiVistaAlunno();
        expect(screen.queryByRole('button', { name: /Nuovo acquisto/ })).toBeNull();

        await scegliCategorie(['Gita']);
        expect(await screen.findByRole('button', { name: /Nuovo acquisto/ })).toBeInTheDocument();

        await scegliCategorie(['Gita', 'Mensa']);
        await waitFor(() => expect(screen.queryByRole('button', { name: /Nuovo acquisto/ })).toBeNull());
        // Presenza dopo: l'elenco c'è ancora (con la colonna Categoria), non si è svuotata la schermata.
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Categoria');
    });
});
