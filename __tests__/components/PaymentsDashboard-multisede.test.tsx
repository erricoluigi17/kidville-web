import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

/**
 * ─── LO SCADENZARIO CON PIÙ SEDI ACCORPATE (P2a, 2026-09-26) ─────────────────────────────
 *
 * Decisioni del titolare, una per gruppo di casi:
 *   1. `scuolaId` null = più sedi: nelle GET `scuola_id` si OMETTE, mai «undefined»/«null».
 *   2. KPI: il totale più la ripartizione per sede.
 *   3. Colonna Sede nelle tabelle quando le sedi sono più d'una.
 *   4. Badge Aruba: la configurazione si chiede PER OGNI sede, e si dice quali non sono
 *      configurate (e quali non si sono potute verificare, loggandolo).
 *   5. «Genera mancanti» e «Nuovo acquisto» con più sedi CHIEDONO la sede.
 *   6. Filtro classi: vale per KPI, agenda, tabelle ed export (`section_ids`).
 *
 * ⚠️ `t` STABILE (vedi `PaymentsDashboard-coda.test.tsx`): `load` dipende da `t`, e con una
 * `t` nuova a ogni resa le GET ripartono in un giro senza fine — contarle non vorrebbe dire
 * niente, e qui si contano (una per sede).
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

vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => 'admin',
}));

/** Le sedi del contesto: `effettive` è ciò che il cockpit mostra. Mutabile per caso. */
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

/** Il log del client: gli errori del badge Aruba DEVONO passare di qui. */
const logSpia = vi.hoisted(() => ({ chiamate: [] as { livello: string; messaggio: string; campi?: Record<string, unknown> }[] }));
vi.mock('@/lib/logging/client', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/client')>()),
    logClient: (e: { livello: string; messaggio: string; campi?: Record<string, unknown> }) => { logSpia.chiamate.push(e); },
}));

/** Il modale dell'acquisto è FINTO e registra le props: il difetto sarebbe la sede non passata. */
const quickSpia = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/features/admin/pagamenti/QuickAcquistoModal', () => ({
    QuickAcquistoModal: (props: Record<string, unknown>) => {
        quickSpia.props.push(props);
        return <div data-testid="quick-finto" />;
    },
}));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

/** Ottobre: le rette di ottobre sono nella vista che si apre, e gli scaduti nell'agenda. */
const GIORNO_FISSO = '2026-10-10T10:00:00';

const CATEGORIE = {
    success: true,
    data: [
        { id: 'c-retta', nome: 'Retta', slug: 'retta', scuola_id: null },
        { id: 'c-gita', nome: 'Gita', slug: 'gita', scuola_id: null },
    ],
};

type Riga = Record<string, unknown>;
function voce(
    id: string, alunno: { id: string; nome: string; cognome: string; section_id: string; classe_sezione: string },
    sede: { id: string; nome: string }, extra: Riga,
): Riga {
    return {
        id, alunno_id: alunno.id, descrizione: 'Retta Ottobre', importo: 100, importo_pagato: 0, stato: 'da_pagare',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-05', categoria_id: 'c-retta',
        periodo_competenza: '2026-10-01', coda_stato: null, scuola_id: sede.id, scuola_nome: sede.nome,
        alunni: { nome: alunno.nome, cognome: alunno.cognome, section_id: alunno.section_id, classe_sezione: alunno.classe_sezione, sospeso: false },
        ...extra,
    };
}

// Due classi OMONIME («Girasoli») in due sedi: devono restare due classi distinte.
const MARIO = { id: 'a1', nome: 'Mario', cognome: 'Rossi', section_id: 'sez-a-gir', classe_sezione: 'Girasoli' };
const ADA = { id: 'a2', nome: 'Ada', cognome: 'Bianchi', section_id: 'sez-g-gir', classe_sezione: 'Girasoli' };
const LUCA = { id: 'a3', nome: 'Luca', cognome: 'Verdi', section_id: 'sez-g-tul', classe_sezione: 'Tulipani' };
const PIA = { id: 'a4', nome: 'Pia', cognome: 'Neri', section_id: 'sez-g-tul', classe_sezione: 'Tulipani' };

/** Aversa: Mario ha pagato 100. Giugliano: Ada scaduta 200, Luca da pagare 300. Pia senza retta. */
const PAGAMENTI_DUE_SEDI = {
    success: true,
    data: [
        voce('p-mario', MARIO, SEDI[0], { importo: 100, importo_pagato: 100, stato: 'pagato' }),
        voce('p-ada', ADA, SEDI[1], { importo: 200, stato: 'scaduto' }),
        voce('p-luca', LUCA, SEDI[1], { importo: 300, scadenza: '2026-10-20' }),
        voce('p-gita-luca', LUCA, SEDI[1], { importo: 40, categoria_id: 'c-gita', descrizione: 'Gita al museo', periodo_competenza: null }),
        voce('p-gita-mario', MARIO, SEDI[0], { importo: 30, categoria_id: 'c-gita', descrizione: 'Gita allo zoo', periodo_competenza: null }),
    ],
};

const STUDENTS_DUE_SEDI = [
    { ...MARIO, scuola_id: 'sede-a', stato: 'iscritto' },
    { ...ADA, scuola_id: 'sede-g', stato: 'iscritto' },
    { ...LUCA, scuola_id: 'sede-g', stato: 'iscritto' },
    { ...PIA, scuola_id: 'sede-g', stato: 'iscritto' },
    // Un secondo bambino di Aversa senza retta: Aversa ne ha 1 mancante, Giugliano 1 (Pia).
    { id: 'a5', nome: 'Teo', cognome: 'Gialli', section_id: 'sez-a-gir', classe_sezione: 'Girasoli', scuola_id: 'sede-a', stato: 'iscritto' },
];

let fetchFinta: ReturnType<typeof vi.fn>;
/** `status: -1` = la fetch LANCIA (rete giù); `jsonLancia` = corpo illeggibile (SyntaxError). */
let arubaPerSede: Record<string, () => { ok: boolean; status?: number; body: unknown; jsonLancia?: boolean }>;

/** Varianti per caso: categorie diverse, GET degli alunni rifiutata dal server. */
interface OpzioniStub { categorie?: unknown; studentsStatus?: number }

function stub(pagamenti: unknown, students: unknown, opzioni: OpzioniStub = {}) {
    fetchFinta = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/settings/aruba')) {
            const sede = new URL(u, 'http://x').searchParams.get('scuola_id') ?? '';
            const r = arubaPerSede[sede]?.() ?? { ok: true, body: { success: true, data: { abilitato: true } } };
            if (r.status === -1) throw new TypeError('Failed to fetch');
            return {
                ok: r.ok, status: r.status ?? 200,
                json: async () => {
                    if (r.jsonLancia) throw new SyntaxError('Unexpected token < in JSON');
                    return r.body;
                },
            };
        }
        const statusStudents = opzioni.studentsStatus ?? 200;
        if (u.startsWith('/api/admin/students') && statusStudents !== 200) {
            return { ok: false, status: statusStudents, json: async () => ({ error: 'Errore interno' }) };
        }
        const body =
            u.startsWith('/api/pagamenti/genera-rette') && init?.method === 'POST' ? { success: true, data: { generate: 1 } }
                : u.startsWith('/api/pagamenti?') ? pagamenti
                    : u.startsWith('/api/admin/students') ? students
                        : u.includes('/settings/categorie') ? (opzioni.categorie ?? CATEGORIE)
                            : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchFinta);
}

function urlChiamati(): string[] {
    return fetchFinta.mock.calls.map(([u]) => String(u));
}

function dueSedi() {
    sediCtx.valore = { sedi: SEDI, effettive: ['sede-a', 'sede-g'], selezionate: [], sedeCorrente: null, reFetchKey: 'sede-a,sede-g' };
}
function unaSede() {
    sediCtx.valore = { sedi: [{ id: 's1', nome: 'Kidville Uno' }], effettive: ['s1'], selezionate: [], sedeCorrente: 's1', reFetchKey: 's1' };
}

/** La riga della TABELLA (la card mobile è un `div` senza ruolo). */
function rigaTabella(testo: string): HTMLElement {
    const riga = screen.getAllByRole('row').find((r) => r.textContent?.includes(testo));
    if (!riga) throw new Error(`nessuna riga di tabella contiene «${testo}»`);
    return riga;
}

/** La card KPI con quell'etichetta, cercata DENTRO il blocco dei KPI («Da fatturare» è anche un badge di riga). */
function cardKpi(etichetta: string): HTMLElement {
    const card = within(screen.getByTestId('kpi-contabilita')).getByText(etichetta).closest('.rounded-card');
    if (!card) throw new Error(`card KPI «${etichetta}» non trovata`);
    return card as HTMLElement;
}

async function attendiCaricamento(testo = 'Ada Bianchi') {
    await waitFor(() => expect(rigaTabella(testo)).toBeInTheDocument());
}

beforeEach(() => {
    logSpia.chiamate.length = 0;
    quickSpia.props.length = 0;
    arubaPerSede = {};
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(GIORNO_FISSO));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('P2a · 1 — con più sedi nessun `scuola_id` nelle GET', () => {
    it('scuolaId null: pagamenti, alunni, categorie ed export senza `scuola_id`, e mai «undefined»/«null»', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();

        const get = urlChiamati().filter((u) => !u.includes('/settings/aruba'));
        // Presenza prima: le tre GET sono partite davvero.
        expect(get.some((u) => u.startsWith('/api/pagamenti?'))).toBe(true);
        expect(get.some((u) => u.startsWith('/api/admin/students?'))).toBe(true);
        expect(get.some((u) => u.includes('/settings/categorie'))).toBe(true);
        for (const u of get) {
            expect(u).not.toContain('scuola_id');
            expect(u).not.toMatch(/undefined|null/);
        }
        const href = screen.getByRole('link', { name: 'Esporta XLSX' }).getAttribute('href') ?? '';
        expect(href).toContain('tipo=scadenzario');
        expect(href).not.toContain('scuola_id');
        expect(href).not.toMatch(/undefined|null/);
    });

    it('scuolaId dichiarato: la GET dei pagamenti e l\'export portano quella sede (come prima)', async () => {
        unaSede();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiCaricamento();
        expect(urlChiamati().find((u) => u.startsWith('/api/pagamenti?'))).toContain('scuola_id=s1');
        expect(urlChiamati().find((u) => u.startsWith('/api/admin/students?'))).toContain('scuola_id=s1');
        expect(screen.getByRole('link', { name: 'Esporta XLSX' })).toHaveAttribute(
            'href', '/api/pagamenti/export?tipo=scadenzario&userId=u1&scuola_id=s1');
    });
});

describe('P2a · 2 — KPI: totale e ripartizione per sede', () => {
    it('con due sedi ogni sede ha i suoi importi, e le card il totale', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        const blocco = await screen.findByTestId('kpi-per-sede');
        const aversa = within(blocco).getByRole('row', { name: /Kidville Aversa/ });
        const giugliano = within(blocco).getByRole('row', { name: /Kidville Giugliano/ });
        // Aversa: incassati 100 (retta) ; da incassare 30 (gita).
        expect(within(aversa).getAllByRole('cell').map((c) => c.textContent)).toEqual(['€ 100,00', '€ 30,00', '€ 0,00', '€ 100,00']);
        // Giugliano: niente incassato; da incassare 200+300+40; scaduto 200.
        expect(within(giugliano).getAllByRole('cell').map((c) => c.textContent)).toEqual(['€ 0,00', '€ 540,00', '€ 200,00', '€ 0,00']);
        // Il totale nelle card resta la somma delle sedi.
        expect(within(screen.getByTestId('kpi-contabilita')).getByText('€ 570,00')).toBeInTheDocument();
    });

    it('con una sede sola la ripartizione non c\'è (le card sì)', async () => {
        unaSede();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(within(screen.getByTestId('kpi-contabilita')).getByText('€ 570,00')).toBeInTheDocument());
        expect(screen.queryByTestId('kpi-per-sede')).toBeNull();
    });
});

describe('P2a · 3 — la sede nelle righe', () => {
    it('con due sedi la tabella rette ha la colonna Sede e il badge della sede del bambino', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Sede');
        expect(within(rigaTabella('Ada Bianchi')).getByTestId('sede-badge')).toHaveTextContent('Kidville Giugliano');
        expect(within(rigaTabella('Mario Rossi')).getByTestId('sede-badge')).toHaveTextContent('Kidville Aversa');
    });

    it('vista per categoria e agenda: il badge viene dalla riga (`scuola_nome`)', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c-gita' } });
        await waitFor(() => expect(within(rigaTabella('Gita al museo')).getByTestId('sede-badge')).toHaveTextContent('Kidville Giugliano'));
        expect(within(rigaTabella('Gita allo zoo')).getByTestId('sede-badge')).toHaveTextContent('Kidville Aversa');

        // Agenda: il bucket «Scaduti» apre la lista, con la sede sulla riga.
        fireEvent.click(screen.getByRole('button', { name: /Scaduti fino a 30gg/ }));
        await waitFor(() => expect(within(rigaTabella('Ada Bianchi')).getByTestId('sede-badge')).toHaveTextContent('Kidville Giugliano'));
    });

    it('con una sede sola nessuna colonna Sede', async () => {
        unaSede();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await attendiCaricamento();
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Alunno');
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Sede');
        expect(within(rigaTabella('Ada Bianchi')).queryByTestId('sede-badge')).toBeNull();
    });
});

describe('P2a · 4 — badge Aruba per sede', () => {
    it('una GET per sede; dice quale sede non è configurata e quale non si è potuta verificare, e lo logga', async () => {
        dueSedi();
        sediCtx.valore = {
            ...sediCtx.valore,
            sedi: [...SEDI, { id: 'sede-c', nome: 'Kidville Cesa' }],
            effettive: ['sede-a', 'sede-g', 'sede-c'],
            reFetchKey: 'sede-a,sede-g,sede-c',
        };
        arubaPerSede = {
            'sede-a': () => ({ ok: true, body: { success: true, data: { abilitato: true } } }),
            'sede-g': () => ({ ok: true, body: { success: true, data: { abilitato: false } } }),
            'sede-c': () => ({ ok: false, status: 500, body: { error: 'Internal Server Error' } }),
        };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);

        const nonAttiva = await screen.findByTestId('aruba-non-attiva');
        expect(nonAttiva).toHaveTextContent('Kidville Giugliano');
        expect(nonAttiva).not.toHaveTextContent('Kidville Aversa');
        expect(nonAttiva).not.toHaveTextContent('Kidville Cesa');
        const nonVerificata = screen.getByTestId('aruba-non-verificata');
        expect(nonVerificata).toHaveTextContent('Kidville Cesa');
        expect(nonVerificata).not.toHaveTextContent('Kidville Giugliano');

        const aruba = urlChiamati().filter((u) => u.includes('/settings/aruba'));
        expect(aruba.map((u) => new URL(u, 'http://x').searchParams.get('scuola_id')).sort()).toEqual(['sede-a', 'sede-c', 'sede-g']);
        expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio.startsWith('aruba-config-non-letta'))).toBe(true);
    });

    it('una fetch che lancia (rete giù) si logga e la sede risulta da verificare', async () => {
        unaSede();
        arubaPerSede = { s1: () => ({ ok: false, status: -1, body: null }) };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        expect(await screen.findByTestId('aruba-non-verificata')).toHaveTextContent('Non siamo riusciti a verificare');
        expect(logSpia.chiamate.some((c) => c.messaggio.includes('TypeError'))).toBe(true);
    });

    it('una sede non attiva su due: la frase è al SINGOLARE («questa sede»)', async () => {
        dueSedi();
        arubaPerSede = { 'sede-g': () => ({ ok: true, body: { success: true, data: { abilitato: false } } }) };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        const nonAttiva = await screen.findByTestId('aruba-non-attiva');
        expect(nonAttiva).toHaveTextContent('non attiva per Kidville Giugliano: le fatture di questa sede non vengono trasmesse.');
        expect(nonAttiva).not.toHaveTextContent('queste sedi');
    });

    it('due sedi non attive su due: la frase è al PLURALE («queste sedi»)', async () => {
        dueSedi();
        arubaPerSede = {
            'sede-a': () => ({ ok: true, body: { success: true, data: { abilitato: false } } }),
            'sede-g': () => ({ ok: true, body: { success: true, data: { abilitato: false } } }),
        };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        expect(await screen.findByTestId('aruba-non-attiva')).toHaveTextContent(
            'non attiva per Kidville Aversa e Kidville Giugliano: le fatture di queste sedi non vengono trasmesse.');
    });

    it('corpo illeggibile: la causa (SyntaxError) finisce nel log, e la sede risulta da verificare', async () => {
        unaSede();
        arubaPerSede = { s1: () => ({ ok: true, body: null, jsonLancia: true }) };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        expect(await screen.findByTestId('aruba-non-verificata')).toBeInTheDocument();
        expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio === 'aruba-config-corpo-illeggibile: SyntaxError')).toBe(true);
    });

    it('con una sede sola non configurata resta il testo di sempre', async () => {
        unaSede();
        arubaPerSede = { s1: () => ({ ok: true, body: { success: true, data: { abilitato: false } } }) };
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        expect(await screen.findByTestId('aruba-non-attiva')).toHaveTextContent('Fatturazione elettronica Aruba/SDI non attiva: le fatture non vengono trasmesse.');
    });
});

describe('P2a · 5 — «Genera mancanti» e «Nuovo acquisto» chiedono la sede', () => {
    function postGenera() {
        return fetchFinta.mock.calls.filter(([u, i]) => String(u).startsWith('/api/pagamenti/genera-rette') && (i as RequestInit | undefined)?.method === 'POST');
    }

    it('due sedi: il bottone resta spento finché non si sceglie; poi genera SOLO per quella sede', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        const bottone = await screen.findByRole('button', { name: 'Genera mancanti' });
        expect(bottone).toBeDisabled();
        const scelta = screen.getByLabelText('Sede su cui generare');
        // Le opzioni contano i mancanti DI QUELLA sede.
        expect(within(scelta).getByRole('option', { name: 'Kidville Aversa (1 alunno)' })).toBeInTheDocument();
        expect(within(scelta).getByRole('option', { name: 'Kidville Giugliano (1 alunno)' })).toBeInTheDocument();
        // La frase del riquadro (cercata DENTRO la CTA): prima della scelta il totale delle
        // sedi — Teo di Aversa + Pia di Giugliano.
        const frase = () => within(screen.getByTestId('cta-genera-mancanti')).getByTestId('cta-genera-mancanti-frase');
        expect(frase().textContent).toMatch(/^2 alunni senza retta generata per /);

        fireEvent.change(scelta, { target: { value: 'sede-g' } });
        // Dopo la scelta: solo i mancanti di Giugliano (Pia). Il plurale si accorda al numero
        // (ICU `dashMsAlunniSenzaRetta`): «1 alunno», non «1 alunni».
        expect(frase().textContent).toMatch(/^1 alunno senza retta generata per /);
        expect(bottone).not.toBeDisabled();
        fireEvent.click(bottone);
        await waitFor(() => expect(postGenera()).toHaveLength(1));
        expect(JSON.parse(String((postGenera()[0][1] as RequestInit).body))).toEqual({ periodo: '2026-10', scuola_id: 'sede-g' });
    });

    it('una sede: nessuna domanda, si genera sulla sede dichiarata', async () => {
        unaSede();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        const bottone = await screen.findByRole('button', { name: 'Genera mancanti' });
        expect(screen.queryByLabelText('Sede su cui generare')).toBeNull();
        fireEvent.click(bottone);
        await waitFor(() => expect(postGenera()).toHaveLength(1));
        expect(JSON.parse(String((postGenera()[0][1] as RequestInit).body))).toEqual({ periodo: '2026-10', scuola_id: 's1' });
    });

    it('acquisto con due sedi: prima la sede, poi solo i bambini di quella sede, e il modale riceve la sede', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c-gita' } });
        const sede = await screen.findByLabelText('Sede dell’acquisto');
        const alunno = screen.getByDisplayValue('Scegli prima la sede…');
        expect(alunno).toBeDisabled();
        expect(screen.getByRole('button', { name: /Nuovo acquisto/ })).toBeDisabled();

        fireEvent.change(sede, { target: { value: 'sede-a' } });
        const opzioni = within(alunno).getAllByRole('option').map((o) => o.textContent);
        expect(opzioni).toContain('Mario Rossi · Girasoli');
        expect(opzioni).not.toContain('Ada Bianchi · Girasoli');
        fireEvent.change(alunno, { target: { value: 'a1' } });
        fireEvent.click(screen.getByRole('button', { name: /Nuovo acquisto/ }));

        await screen.findByTestId('quick-finto');
        const ultime = quickSpia.props.at(-1)!;
        expect(ultime.scuolaId).toBe('sede-a');
        expect((ultime.alunno as { id: string }).id).toBe('a1');
    });

    it('acquisto con due sedi e categoria DI SEDE (Aversa): nessuna domanda, ma solo i bambini di Aversa', async () => {
        // Il server ricava la sede dall'ALUNNO e non guarda la categoria: un bambino di
        // Giugliano con la «Gita» di Aversa sarebbe una voce di Giugliano con la categoria
        // sbagliata, mentre il modale direbbe «Sede: Kidville Aversa».
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI, {
            categorie: { success: true, data: [...CATEGORIE.data, { id: 'c-gita-a', nome: 'Gita', slug: 'gita-aversa', scuola_id: 'sede-a' }] },
        });
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c-gita-a' } });
        const alunno = await screen.findByDisplayValue('Seleziona alunno…');
        expect(screen.queryByLabelText('Sede dell’acquisto')).toBeNull();
        const opzioni = within(alunno).getAllByRole('option').map((o) => o.textContent);
        // Presenza prima: i due bambini di Aversa.
        expect(opzioni).toEqual(['Seleziona alunno…', 'Mario Rossi · Girasoli', 'Teo Gialli · Girasoli']);
        expect(opzioni).not.toContain('Ada Bianchi · Girasoli');

        fireEvent.change(alunno, { target: { value: 'a5' } });
        fireEvent.click(screen.getByRole('button', { name: /Nuovo acquisto/ }));
        await screen.findByTestId('quick-finto');
        const ultime = quickSpia.props.at(-1)!;
        expect(ultime.scuolaId).toBe('sede-a');
        expect((ultime.alunno as { id: string }).id).toBe('a5');
    });

    it('acquisto con una sede: nessun selettore di sede e il modale riceve la sede dichiarata', async () => {
        unaSede();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c-gita' } });
        const alunno = await screen.findByDisplayValue('Seleziona alunno…');
        expect(screen.queryByLabelText('Sede dell’acquisto')).toBeNull();
        fireEvent.change(alunno, { target: { value: 'a2' } });
        fireEvent.click(screen.getByRole('button', { name: /Nuovo acquisto/ }));
        await screen.findByTestId('quick-finto');
        expect(quickSpia.props.at(-1)!.scuolaId).toBe('s1');
    });
});

describe('P2a · 5b — la modifica di una voce offre solo le categorie della SUA sede', () => {
    it('due sedi: la retta di Luca (Giugliano) offre le globali e la «Gita» di Giugliano, non quella di Aversa', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI, {
            categorie: {
                success: true,
                data: [
                    ...CATEGORIE.data,
                    { id: 'c-gita-a', nome: 'Gita', slug: 'gita-aversa', scuola_id: 'sede-a' },
                    { id: 'c-gita-g', nome: 'Gita', slug: 'gita-giugliano', scuola_id: 'sede-g' },
                ],
            },
        });
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento('Luca Verdi');
        fireEvent.click(within(rigaTabella('Luca Verdi')).getByRole('button', { name: 'Modifica' }));

        const select = await screen.findByLabelText('Categoria');
        const valori = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
        // Presenza prima: le globali e quella della sede della voce.
        expect(valori).toEqual(expect.arrayContaining(['c-retta', 'c-gita', 'c-gita-g']));
        expect(valori).not.toContain('c-gita-a');
        // E con più sedi la categoria di sede porta il nome della sede: niente due «Gita» identiche.
        expect(within(select).getByRole('option', { name: 'Gita — Kidville Giugliano' })).toBeInTheDocument();
    });
});

describe('P2a · 7 — la GET degli alunni rifiutata non diventa «nessun alunno»', () => {
    it('students 500: log `scadenzario-alunni-rifiutato`, messaggio a schermo, e niente «Nessun alunno attivo trovato.»', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI, { studentsStatus: 500 });
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        // Presenza prima: il messaggio d'errore.
        expect(await screen.findByTestId('errore-alunni')).toHaveTextContent('Impossibile caricare gli alunni');
        expect(screen.queryByText('Nessun alunno attivo trovato.')).toBeNull();
        const log = logSpia.chiamate.find((c) => c.messaggio === 'scadenzario-alunni-rifiutato');
        expect(log).toBeDefined();
        expect(log!.livello).toBe('error');
        expect((log as unknown as { stato?: number }).stato).toBe(500);
    });

    it('students 200: nessun messaggio d\'errore degli alunni (il ramo non scatta sempre)', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();
        expect(screen.queryByTestId('errore-alunni')).toBeNull();
        expect(logSpia.chiamate.some((c) => c.messaggio.startsWith('scadenzario-alunni'))).toBe(false);
    });
});

describe('P2a · 6 — filtro classi su KPI, tabelle ed export', () => {
    async function scegliClasse(nome: RegExp) {
        fireEvent.click(await screen.findByRole('button', { name: /^Classe / }));
        fireEvent.click(screen.getByRole('button', { name: nome }));
    }

    it('due sedi: le «Girasoli» omonime restano separate, e la scelta filtra tabella, KPI ed export', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();
        // Presenza prima: tutte e tre le righe e il totale pieno.
        expect(rigaTabella('Mario Rossi')).toBeInTheDocument();
        expect(rigaTabella('Luca Verdi')).toBeInTheDocument();

        await scegliClasse(/^Girasoli — Kidville Giugliano$/);

        await waitFor(() => expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Mario Rossi'))).toBe(false));
        expect(rigaTabella('Ada Bianchi')).toBeInTheDocument();
        expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Luca Verdi'))).toBe(false);
        // KPI: solo la retta scaduta di Ada (200), niente incassato (quello era di Mario).
        expect(cardKpi('Scaduto (morosità)')).toHaveTextContent('€ 200,00');
        expect(cardKpi('Incassato')).toHaveTextContent('€ 0,00');
        // Anche la ripartizione per sede segue il filtro: Aversa si svuota (i 100 incassati e la
        // gita erano di Mario), Giugliano resta con la sola retta scaduta di Ada (Luca è Tulipani).
        const perSede = within(screen.getByTestId('kpi-per-sede'));
        const celle = (sede: RegExp) => within(perSede.getByRole('row', { name: sede })).getAllByRole('cell').map((c) => c.textContent);
        expect(celle(/Kidville Aversa/)).toEqual(['€ 0,00', '€ 0,00', '€ 0,00', '€ 0,00']);
        expect(celle(/Kidville Giugliano/)).toEqual(['€ 0,00', '€ 200,00', '€ 200,00', '€ 0,00']);
        const href = screen.getByRole('link', { name: 'Esporta XLSX' }).getAttribute('href') ?? '';
        expect(new URL(href, 'http://x').searchParams.get('section_ids')).toBe('sez-g-gir');
    });

    it('senza scelta l\'export non porta `section_ids`; con due classi le porta entrambe', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();
        const link = () => new URL(screen.getByRole('link', { name: 'Esporta XLSX' }).getAttribute('href') ?? '', 'http://x');
        expect(link().searchParams.has('section_ids')).toBe(false);
        await scegliClasse(/^Girasoli — Kidville Aversa$/);
        fireEvent.click(screen.getByRole('button', { name: /^Tulipani — Kidville Giugliano$/ }));
        await waitFor(() => expect(link().searchParams.get('section_ids')).toBe('sez-a-gir,sez-g-tul'));
    });

    it('agenda: il bucket conta e mostra solo le voci delle classi scelte', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await attendiCaricamento();
        await scegliClasse(/^Tulipani — Kidville Giugliano$/);
        fireEvent.click(screen.getByRole('button', { name: /Scaduti fino a 30gg/ }));
        // Presenza: la gita di Luca (Tulipani) è scaduta il 05/10.
        await waitFor(() => expect(rigaTabella('Gita al museo')).toBeInTheDocument());
        // Assenza, dopo la presenza: la retta scaduta di Ada (Girasoli) resta fuori.
        expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Ada Bianchi'))).toBe(false);
    });

    it('vista per categoria: il filtro vale anche lì', async () => {
        dueSedi();
        stub(PAGAMENTI_DUE_SEDI, STUDENTS_DUE_SEDI);
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c-gita' } });
        await waitFor(() => expect(rigaTabella('Gita allo zoo')).toBeInTheDocument());
        await scegliClasse(/^Tulipani — Kidville Giugliano$/);
        await waitFor(() => expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Gita allo zoo'))).toBe(false));
        expect(rigaTabella('Gita al museo')).toBeInTheDocument();
    });
});
