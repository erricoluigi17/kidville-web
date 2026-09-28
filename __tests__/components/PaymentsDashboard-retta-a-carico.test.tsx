import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

/**
 * «Paga il fratello …» al posto di «Non generata» (spec 2026-09-28, D1–D13).
 * ⚠️ `t` STABILE, come in `PaymentsDashboard-multisede.test.tsx`: `load` dipende da `t`.
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
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns?: string) => {
        const chiave = ns ?? '';
        const gia = perNamespace.get(chiave);
        if (gia) return gia;
        const t = (key: string, valori?: Record<string, unknown>) =>
            valori === undefined ? resolve(ns, key) : String(new IntlMessageFormat(resolve(ns, key), 'it').format(valori));
        const stabile = Object.assign(t, { rich: (k: string) => resolve(ns, k), markup: (k: string) => resolve(ns, k), raw: (k: string) => resolve(ns, k), has: () => true });
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
const SEDE_UNICA = { sedi: [{ id: 's1', nome: 'Kidville Uno' }], effettive: ['s1'], selezionate: [] as string[], sedeCorrente: 's1' as string | null, reFetchKey: 's1' };
const sediCtx = vi.hoisted(() => ({ valore: null as unknown }));
vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => sediCtx.valore,
}));
const logSpia = vi.hoisted(() => ({ chiamate: [] as { livello: string; messaggio: string; campi?: Record<string, unknown> }[] }));
vi.mock('@/lib/logging/client', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/client')>()),
    logClient: (e: { livello: string; messaggio: string; campi?: Record<string, unknown> }) => { logSpia.chiamate.push(e); },
}));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

const GIORNO_FISSO = '2026-10-10T10:00:00';
const CATEGORIE = { success: true, data: [
    { id: 'c-retta', nome: 'Retta', slug: 'retta', scuola_id: null },
    { id: 'c-mensa', nome: 'Mensa', slug: 'mensa', scuola_id: null },
] };

type Bimbo = { id: string; nome: string; cognome: string; section_id: string; classe_sezione: string };
const B = (id: string, nome: string, cognome: string, classe: string): Bimbo =>
    ({ id, nome, cognome, section_id: `sez-${classe}`, classe_sezione: classe });

const MARIO = B('a-mario', 'Mario', 'Rossi', 'Sez. C');   // paga per Luca e Teo
const LUCA = B('a-luca', 'Luca', 'Rossi', 'Sez. A');
const ANNA = B('a-anna', 'Anna', 'Bianchi', 'Sez. B');    // paga per Sara (pagato)
const SARA = B('a-sara', 'Sara', 'Bianchi', 'Sez. A');
const PINO = B('a-pino', 'Pino', 'Verdi', 'Sez. D');      // sesso assente, scaduto
const ELIO = B('a-elio', 'Elio', 'Verdi', 'Sez. A');
const NINO = B('a-nino', 'Nino', 'Neri', 'Sez. E');       // nessuna retta a ottobre
const DORA = B('a-dora', 'Dora', 'Neri', 'Sez. A');
const TEO = B('a-teo', 'Teo', 'Rossi', 'Sez. A');         // a carico di Mario MA con retta propria (D9)
const PIA = B('a-pia', 'Pia', 'Gialli', 'Sez. A');        // nessun legame, nessuna retta
const RITA = B('a-rita', 'Rita', 'Blu', 'Sez. A');        // pagante non più iscritto
const UGO = B('a-ugo', 'Ugo', 'Viola', 'Sez. A');         // pagante in un'altra sede
const IVO = B('a-ivo', 'Ivo', 'Grigi', 'Sez. A');         // pagante in una sede NON leggibile (C3)
const EVA = B('a-eva', 'Eva', 'Grigi', 'Sez. A');         // idem, ma con una retta propria (C3 + D9)

const STUDENTS = [MARIO, LUCA, ANNA, SARA, PINO, ELIO, NINO, DORA, TEO, PIA, RITA, UGO, IVO, EVA]
    .map((b) => ({ ...b, scuola_id: 's1', stato: 'iscritto' }));

function retta(id: string, b: Bimbo, extra: Record<string, unknown>) {
    return {
        id, alunno_id: b.id, descrizione: 'Retta Ottobre', importo: 250, importo_pagato: 0, stato: 'da_pagare',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-20', categoria_id: 'c-retta',
        periodo_competenza: '2026-10-01', coda_stato: null, scuola_id: 's1', scuola_nome: 'Kidville Uno',
        alunni: { nome: b.nome, cognome: b.cognome, section_id: b.section_id, classe_sezione: b.classe_sezione, sospeso: false },
        ...extra,
    };
}
const PAGAMENTI = {
    success: true,
    data: [
        retta('p-mario', MARIO, {}),
        retta('p-anna', ANNA, { stato: 'pagato', importo_pagato: 250 }),
        retta('p-pino', PINO, { stato: 'scaduto', scadenza: '2026-10-05' }),
        retta('p-teo', TEO, { importo: 100 }),
        retta('p-eva', EVA, { importo: 90 }),
    ],
};

const pag = (b: Bimbo, sesso: 'M' | 'F' | null, extra: Record<string, unknown> = {}) =>
    ({ id: b.id, nome: b.nome, cognome: b.cognome, sesso, classe_sezione: b.classe_sezione, iscritto: true, scuola_id: 's1', ...extra });
const LEGAMI = {
    success: true,
    data: [
        { alunno_id: LUCA.id, scuola_id: 's1', pagante: pag(MARIO, 'M') },
        { alunno_id: SARA.id, scuola_id: 's1', pagante: pag(ANNA, 'F') },
        { alunno_id: ELIO.id, scuola_id: 's1', pagante: pag(PINO, null) },
        { alunno_id: DORA.id, scuola_id: 's1', pagante: pag(NINO, 'M') },
        { alunno_id: TEO.id, scuola_id: 's1', pagante: pag(MARIO, 'M') },
        { alunno_id: RITA.id, scuola_id: 's1', pagante: { id: 'a-ex', nome: 'Ex', cognome: 'Blu', sesso: 'M', classe_sezione: 'Sez. F', iscritto: false, scuola_id: 's1' } },
        { alunno_id: UGO.id, scuola_id: 's1', pagante: { id: 'a-lontano', nome: 'Leo', cognome: 'Viola', sesso: 'M', classe_sezione: 'Sez. G', iscritto: true, scuola_id: 's2' } },
    ],
    // C3: il pagante di Ivo ed Eva sta in una sede che l'utente non legge — di lui non arriva niente.
    a_carico_non_visibili: [IVO.id, EVA.id],
};

let fetchFinta: ReturnType<typeof vi.fn>;
function stub(opzioni: { legamiStatus?: number; legami?: unknown; pagamenti?: unknown } = {}) {
    fetchFinta = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/rette-a-carico')) {
            const s = opzioni.legamiStatus ?? 200;
            return { ok: s === 200, status: s, json: async () => (s === 200 ? (opzioni.legami ?? LEGAMI) : { error: 'guasto', codice: 'LETTURA_FALLITA' }) };
        }
        const body = u.startsWith('/api/pagamenti?') ? (opzioni.pagamenti ?? PAGAMENTI)
            : u.startsWith('/api/admin/students') ? STUDENTS
                : u.includes('/settings/categorie') ? CATEGORIE
                    : u.includes('/settings/aruba') ? { success: true, data: { abilitato: true } }
                        : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchFinta);
}

/**
 * La riga della TABELLA di quel bambino (la card mobile è un `div` senza ruolo). Si guarda
 * la PRIMA cella, non tutta la riga: la riga di Elio contiene anche «Pino Verdi» (nel badge
 * «A carico di Pino Verdi»), e cercare «Pino Verdi» ovunque troverebbe il sosia.
 */
function riga(nome: string): HTMLElement {
    const r = screen.getAllByRole('row').find((x) => x.querySelector('td')?.textContent?.startsWith(nome));
    if (!r) throw new Error(`nessuna riga è di «${nome}»`);
    return r;
}
/** C'è una riga, di chiunque, che contiene quel testo? (per le ASSENZE: più largo è, più vale). */
const qualcheRigaContiene = (testo: string) => screen.getAllByRole('row').some((r) => r.textContent?.includes(testo));
async function apri() {
    render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(riga('Luca Rossi')).toBeInTheDocument());
}

beforeEach(() => {
    // Una sede sola, salvo i test che ne dichiarano due (K8a): si rimette a ogni test.
    sediCtx.valore = SEDE_UNICA;
    logSpia.chiamate.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(GIORNO_FISSO));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('D1–D5 — il badge al posto di «Non generata»', () => {
    it('fratello: testo, classe, stato del fratello e tono neutro (da pagare)', async () => {
        stub(); await apri();
        const b = await within(riga('Luca Rossi')).findByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga il fratello Mario Rossi (Sez. C) · Da pagare');
        expect(b).toHaveClass('bg-kidville-neutral-soft');
        expect(within(riga('Luca Rossi')).queryByText('Non generata')).toBeNull();
    });
    it('sorella, retta pagata: verde', async () => {
        stub(); await apri();
        const b = within(riga('Sara Bianchi')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga la sorella Anna Bianchi (Sez. B) · Pagato');
        expect(b).toHaveClass('bg-kidville-success-soft');
    });
    it('sesso assente: «A carico di»; retta scaduta: rosso', async () => {
        stub(); await apri();
        const b = within(riga('Elio Verdi')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('A carico di Pino Verdi (Sez. D) · Scaduto');
        expect(b).toHaveClass('bg-kidville-error-soft');
    });
    it('D4 — il fratello non ha la retta del mese: «· Non generata», neutro', async () => {
        stub(); await apri();
        const b = within(riga('Dora Neri')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga il fratello Nino Neri (Sez. E) · Non generata');
        expect(b).toHaveClass('bg-kidville-neutral-soft');
    });
    it('il bambino senza legame resta «Non generata»', async () => {
        stub(); await apri();
        expect(within(riga('Pia Gialli')).getByText('Non generata')).toBeInTheDocument();
        expect(within(riga('Pia Gialli')).queryByTestId('retta-a-carico')).toBeNull();
    });
    it('anche nella card mobile (D13)', async () => {
        stub(); await apri();
        const testi = screen.getAllByTestId('retta-a-carico').map((e) => e.textContent);
        expect(testi.filter((x) => x === 'Paga il fratello Mario Rossi (Sez. C) · Da pagare')).toHaveLength(2);
    });
});

describe('D8 — nessuna azione di incasso sulla riga a carico', () => {
    it('niente Incassa, niente dettaglio, niente modifica', async () => {
        stub(); await apri();
        const r = riga('Luca Rossi');
        expect(within(r).queryByRole('button', { name: 'Incassa' })).toBeNull();
        expect(within(r).queryByTitle('Dettagli')).toBeNull();
        expect(within(r).queryByTitle('Modifica')).toBeNull();
    });
});

describe('D9 — retta generata a un bambino a carico', () => {
    it('la retta normale resta, più l’avviso arancio (tabella e card)', async () => {
        stub(); await apri();
        const r = riga('Teo Rossi');
        expect(within(r).getByRole('button', { name: 'Incassa' })).toBeInTheDocument();
        const avviso = within(r).getByTestId('retta-a-carico-verifica');
        expect(avviso).toHaveTextContent('A carico del fratello Mario Rossi (Sez. C): retta da verificare');
        expect(avviso).toHaveClass('bg-kidville-warn-soft');
        expect(screen.getAllByTestId('retta-a-carico-verifica')).toHaveLength(2);
    });
});

describe('D12 — pagante anomalo', () => {
    it('non iscritto: badge + avviso rosso', async () => {
        stub(); await apri();
        const r = riga('Rita Blu');
        expect(within(r).getByTestId('retta-a-carico')).toHaveTextContent('Paga il fratello Ex Blu (Sez. F) · Non generata');
        // C6: «non risulta iscritto», non «non è più iscritto» — un pagante SOSPESO è ancora
        // iscritto (`src/lib/alunni/stato.ts`), e dirgli «non più» era falso.
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga non risulta iscritto: retta da rivedere');
    });
    it('in un’altra sede non caricata: niente stato inventato, avviso rosso', async () => {
        stub(); await apri();
        const r = riga('Ugo Viola');
        expect(within(r).getByTestId('retta-a-carico')).toHaveTextContent(/^Paga il fratello Leo Viola \(Sez\. G\)$/);
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga è in un’altra sede: retta da rivedere');
    });
    // K8a (seconda revisione 2026-09-28): la vista a PIÙ sedi. Il pagante sta in un'altra sede,
    // ma quella sede è fra le caricate: allora il suo stato SI conosce e si mostra, col suo
    // colore — e l'avviso rosso resta, perché la retta è comunque da rivedere.
    it('K8a — in un’altra sede CARICATA (vista a più sedi): lo stato del fratello, col suo tono, E l’avviso rosso', async () => {
        sediCtx.valore = {
            sedi: [{ id: 's1', nome: 'Kidville Uno' }, { id: 's2', nome: 'Kidville Due' }],
            effettive: ['s1', 's2'], selezionate: [], sedeCorrente: null, reFetchKey: 's1,s2',
        };
        const LEO = B('a-lontano', 'Leo', 'Viola', 'Sez. G');
        stub({ pagamenti: { ...PAGAMENTI, data: [...PAGAMENTI.data, retta('p-leo', LEO, { stato: 'parziale', importo_pagato: 100, scuola_id: 's2', scuola_nome: 'Kidville Due' })] } });
        render(<PaymentsDashboard userId="u1" scuolaId={null} />);
        await waitFor(() => expect(riga('Ugo Viola')).toBeInTheDocument());
        const r = riga('Ugo Viola');
        const b = within(r).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga il fratello Leo Viola (Sez. G) · Parziale');
        expect(b).toHaveClass('bg-kidville-warn-soft');
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga è in un’altra sede: retta da rivedere');
        // Senza scuola_id: con più sedi la GET dei legami non restringe.
        const u = fetchFinta.mock.calls.map(([x]) => String(x)).find((x) => x.startsWith('/api/pagamenti/rette-a-carico'));
        expect(u).toBe('/api/pagamenti/rette-a-carico?userId=u1');
    });
    // K8b: D9 e D12 insieme — il bambino ha una retta PROPRIA e chi paga è anomalo.
    it('K8b — retta propria (D9) e pagante non iscritto: l’avviso arancio «da verificare» E quello rosso', async () => {
        const data = LEGAMI.data.map((l) => (l.alunno_id === TEO.id ? { ...l, pagante: { ...l.pagante, iscritto: false } } : l));
        stub({ legami: { ...LEGAMI, data } }); await apri();
        const r = riga('Teo Rossi');
        expect(within(r).getByRole('button', { name: 'Incassa' })).toBeInTheDocument();
        const verifica = within(r).getByTestId('retta-a-carico-verifica');
        expect(verifica).toHaveTextContent('A carico del fratello Mario Rossi (Sez. C): retta da verificare');
        expect(verifica).toHaveClass('bg-kidville-warn-soft');
        const anomalia = within(r).getByTestId('retta-a-carico-anomalia');
        expect(anomalia).toHaveTextContent('Chi paga non risulta iscritto: retta da rivedere');
        expect(anomalia).toHaveClass('bg-kidville-error-soft');
        // Il badge del pagante NON c'è: la riga ha la sua retta.
        expect(within(r).queryByTestId('retta-a-carico')).toBeNull();
    });
});

describe('D6 — «Genera mancanti» non conta i bambini a carico', () => {
    // Ivo (pagante non leggibile, C3) NON è fra i mancanti: la generazione lo salta comunque.
    it('restano solo Pia e Nino', async () => {
        stub(); await apri();
        expect(await screen.findByTestId('cta-genera-mancanti-frase')).toHaveTextContent('2 alunni senza retta generata');
    });
});

describe('D10 — filtro Morosi', () => {
    it('compare il bambino il cui pagante è moroso; sparisce quello del pagante in regola', async () => {
        stub(); await apri();
        fireEvent.click(screen.getByRole('button', { name: /Morosi/ }));
        await waitFor(() => expect(riga('Elio Verdi')).toBeInTheDocument());
        expect(riga('Pino Verdi')).toBeInTheDocument();
        expect(qualcheRigaContiene('Luca Rossi')).toBe(false);
        expect(qualcheRigaContiene('Sara Bianchi')).toBe(false);
    });
});

describe('D11 — ricerca per nome del pagante', () => {
    it('«Anna» trova anche Sara', async () => {
        stub(); await apri();
        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: 'Anna' } });
        await waitFor(() => expect(qualcheRigaContiene('Luca Rossi')).toBe(false));
        expect(riga('Sara Bianchi')).toBeInTheDocument();
        expect(riga('Anna Bianchi')).toBeInTheDocument();
    });
});

/**
 * C1 (revisione 2026-09-28) — i badge LUNGHI vanno a capo. Misurati col font vero: «Paga il
 * fratello Mario Rossi (Sez. C) · Non generata» 355 px, l'avviso D9 428 px, contro ~251 px di
 * card a 360 px di schermo: col `whitespace-nowrap` del Badge il nome veniva schiacciato e la
 * pagina scorreva in orizzontale. jsdom non misura: qui si guarda che la regola che VINCE sia
 * `whitespace-normal` — cioè che sia l'UNICA regola di white-space dell'elemento — e che nella
 * card il badge stia SOTTO il nome e non accanto.
 */
const regoleWhitespace = (el: Element) =>
    [...el.classList].filter((c) => /^!?whitespace-/.test(c) || /^whitespace-.*!$/.test(c));
const TESTID_BADGE_A_CARICO = ['retta-a-carico', 'retta-a-carico-verifica', 'retta-a-carico-anomalia', 'retta-a-carico-non-visibile'];

describe('C1 — i badge lunghi vanno a capo', () => {
    it('ogni badge delle rette a carico (tabella e card) ha whitespace-normal come UNICA regola', async () => {
        stub(); await apri();
        for (const id of TESTID_BADGE_A_CARICO) {
            const badge = screen.getAllByTestId(id);
            expect(badge.length, id).toBeGreaterThan(0);
            for (const b of badge) expect(regoleWhitespace(b), id).toEqual(['whitespace-normal']);
        }
    });
    it('il badge di stato di una riga normale resta su una riga (default invariato)', async () => {
        stub(); await apri();
        const pagato = within(riga('Anna Bianchi')).getByText('Pagato');
        expect(regoleWhitespace(pagato)).toEqual(['whitespace-nowrap']);
    });
    it('card mobile senza retta propria: il badge sta SOTTO il nome, non accanto', async () => {
        stub(); await apri();
        const card = screen.getAllByTestId('card-retta-a-carico').find((c) => c.textContent?.startsWith('Luca Rossi'));
        expect(card).toBeDefined();
        // La card non è più una riga flex «nome | badge»: i suoi figli si impilano.
        expect(card).not.toHaveClass('flex');
        expect(card).not.toHaveClass('justify-between');
        const nome = within(card!).getByText('Luca Rossi');
        const badge = within(card!).getByTestId('retta-a-carico');
        const contenitore = within(card!).getByTestId('card-retta-a-carico-badge');
        expect(contenitore.parentElement).toBe(card);
        expect(contenitore).toContainElement(badge);
        expect(nome.compareDocumentPosition(contenitore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(nome.contains(contenitore)).toBe(false);
    });
    it('anche la card del pagante non leggibile (C3) mette il badge sotto il nome', async () => {
        stub(); await apri();
        const card = screen.getAllByTestId('card-retta-a-carico').find((c) => c.textContent?.startsWith('Ivo Grigi'));
        expect(card).toBeDefined();
        expect(within(card!).getByTestId('card-retta-a-carico-badge')).toContainElement(within(card!).getByTestId('retta-a-carico-non-visibile'));
    });
    // K2 (seconda revisione 2026-09-28): fra 1024 e 1279 px, con `aCapo`, l'algoritmo della
    // tabella stringeva la colonna Stato fino alla parola più lunga — misurato a 1024 px un
    // badge di 109×132 px, otto righe, righe della tabella alte 155–198 px. Nella TABELLA ogni
    // badge delle rette a carico ha una larghezza minima; nella CARD mobile no (a 360 px il
    // badge ha la sua riga intera, ed è giusto com'è).
    it('K2 — nella tabella ogni badge a carico ha la larghezza minima; nelle card nessuno', async () => {
        stub(); await apri();
        const tabella = screen.getAllByRole('table').find((t) => t.textContent?.includes('Luca Rossi'))!;
        let inTabella = 0;
        for (const id of TESTID_BADGE_A_CARICO) {
            for (const b of screen.getAllByTestId(id)) {
                if (tabella.contains(b)) { inTabella++; expect(b, id).toHaveClass('min-w-[10rem]'); }
                else expect(b, id).not.toHaveClass('min-w-[10rem]');
            }
        }
        // Luca, Sara, Elio, Dora, Rita, Ugo (badge) + Teo (verifica) + Rita, Ugo, Ivo×2, Eva×2 (anomalia/non visibile)
        expect(inTabella).toBe(13);
        // …e nelle card, per costruzione, i badge ci sono: l'assenza sopra non è vuota.
        const card = screen.getAllByTestId('card-retta-a-carico').find((c) => c.textContent?.startsWith('Luca Rossi'))!;
        expect(within(card).getByTestId('retta-a-carico')).not.toHaveClass('min-w-[10rem]');
        // Il badge di stato di una riga normale resta com'è.
        expect(within(riga('Anna Bianchi')).getByText('Pagato')).not.toHaveClass('min-w-[10rem]');
    });
    it('la card «Non generata» senza legame resta com’era', async () => {
        stub(); await apri();
        expect(screen.getAllByTestId('card-retta-a-carico').some((c) => c.textContent?.startsWith('Pia Gialli'))).toBe(false);
    });
});

describe('C3 — pagante in una sede che l’utente non legge', () => {
    it('badge neutro «di un’altra sede» + avviso rosso; niente «Non generata», niente Incassa (tabella e card)', async () => {
        stub(); await apri();
        const r = riga('Ivo Grigi');
        const b = within(r).getByTestId('retta-a-carico-non-visibile');
        expect(b).toHaveTextContent('A carico di un fratello di un’altra sede');
        expect(b).toHaveClass('bg-kidville-neutral-soft');
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga è in un’altra sede: retta da rivedere');
        expect(within(r).queryByText('Non generata')).toBeNull();
        expect(within(r).queryByRole('button', { name: 'Incassa' })).toBeNull();
        expect(within(r).queryByTestId('retta-a-carico')).toBeNull();
        // Tabella + card mobile, per Ivo ed Eva.
        expect(screen.getAllByTestId('retta-a-carico-non-visibile')).toHaveLength(4);
    });
    it('con una retta propria (D9): la retta resta, più il badge e l’avviso', async () => {
        stub(); await apri();
        const r = riga('Eva Grigi');
        expect(within(r).getByRole('button', { name: 'Incassa' })).toBeInTheDocument();
        expect(within(r).getByTestId('retta-a-carico-non-visibile')).toBeInTheDocument();
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga è in un’altra sede: retta da rivedere');
    });
    // Q4 (quarta revisione 2026-09-29): questo test fissava «campo assente = risposta di prima del
    // 28/09 = nessuno». Ma la route nasce in questo branch e il campo l'ha sempre avuto: una
    // risposta senza è una forma inattesa, come `a_carico_non_visibili` non array (R10) o `data`
    // non array. Banner, e niente dati parziali: né i badge dei legami di quella risposta, né i
    // non visibili spacciati per «Non generata» e mancanti.
    for (const [caso, valore] of [['assente', undefined], ['null', null]] as const) {
        it(`Q4 — campo ${caso}: banner, e nessun badge di quella risposta`, async () => {
            const corpo: Record<string, unknown> = { ...LEGAMI };
            if (valore === undefined) delete corpo.a_carico_non_visibili;
            else corpo.a_carico_non_visibili = valore;
            stub({ legami: corpo }); await apri();
            expect(await screen.findByTestId('errore-legami')).toBeInTheDocument();
            expect(within(riga('Luca Rossi')).getByText('Non generata')).toBeInTheDocument();
            expect(screen.queryByTestId('retta-a-carico')).toBeNull();
            expect(screen.queryByTestId('retta-a-carico-non-visibile')).toBeNull();
            expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio === 'scadenzario-legami-forma-inattesa')).toBe(true);
        });
    }
    it('un valore che non è una stringa nel campo si scarta e si conta nel log', async () => {
        stub({ legami: { ...LEGAMI, a_carico_non_visibili: [IVO.id, 7] } }); await apri();
        expect(within(riga('Ivo Grigi')).getByTestId('retta-a-carico-non-visibile')).toBeInTheDocument();
        const log = logSpia.chiamate.filter((c) => c.messaggio === 'scadenzario-legami-voci-scartate');
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ livello: 'error', campi: { n: 1 } });
    });
});

describe('la GET dei legami', () => {
    it('parte con la sede dichiarata', async () => {
        stub(); await apri();
        const u = fetchFinta.mock.calls.map(([x]) => String(x)).find((x) => x.startsWith('/api/pagamenti/rette-a-carico'));
        expect(u).toBe('/api/pagamenti/rette-a-carico?userId=u1&scuola_id=s1');
    });
    it('guasto: banner d’errore, e i bambini tornano «Non generata» (mai un badge inventato)', async () => {
        stub({ legamiStatus: 500 }); await apri();
        expect(await screen.findByTestId('errore-legami')).toHaveTextContent('Impossibile sapere chi paga la retta per un fratello');
        expect(within(riga('Luca Rossi')).getByText('Non generata')).toBeInTheDocument();
        expect(screen.queryByTestId('retta-a-carico')).toBeNull();
        expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio.startsWith('scadenzario-legami'))).toBe(true);
    });
    // C8a (revisione 2026-09-28): la frase parla dei bambini «Non generata» della vista Rette.
    // Nelle viste Categoria e Agenda non corrisponde a niente sullo schermo: lì non si mostra.
    it('il banner sta solo nella vista Rette: sparisce in Categoria e in Agenda, e torna in Rette', async () => {
        stub({ legamiStatus: 500 }); await apri();
        expect(await screen.findByTestId('errore-legami')).toBeInTheDocument();
        // Categoria: si aspetta la PRESENZA di qualcosa che c'è SOLO nella vista Categoria — la
        // riga vuota «Nessun pagamento in questa categoria.» (qui la Mensa non ha voci) — poi si
        // guarda l'assenza del banner. (R11d, terza revisione 2026-09-29: il segnaposto della
        // ricerca che si aspettava prima c'è in ENTRAMBE le viste, e l'attesa vera era quella
        // su un'assenza, «Luca Rossi» sparito — che passa anche mentre la vista sta cambiando.)
        fireEvent.change(screen.getByDisplayValue('Retta'), { target: { value: 'c-mensa' } });
        expect(await screen.findByText('Nessun pagamento in questa categoria.')).toBeInTheDocument();
        expect(screen.queryByText('Luca Rossi')).toBeNull();
        expect(screen.queryByTestId('errore-legami')).toBeNull();
        // Di nuovo Rette: torna.
        fireEvent.change(screen.getByDisplayValue('Mensa'), { target: { value: 'c-retta' } });
        await waitFor(() => expect(riga('Luca Rossi')).toBeInTheDocument());
        expect(screen.getByTestId('errore-legami')).toBeInTheDocument();
        // Agenda (dalla vista Rette): un bucket qualunque.
        fireEvent.click(screen.getByRole('button', { name: /Prossimi 30gg/ }));
        await screen.findByRole('button', { name: /Chiudi/ });
        expect(screen.queryByTestId('errore-legami')).toBeNull();
    });
    // C4 (revisione 2026-09-28): una voce malformata si scarta — ma NON in silenzio.
    it('voci malformate: le buone restano, e un log error dice QUANTE (mai chi)', async () => {
        const malformata = { alunno_id: PIA.id, pagante: { id: 'a-x', nome: 'Zeno' } }; // manca il cognome
        stub({ legami: { ...LEGAMI, data: [...LEGAMI.data, malformata, 42] } }); await apri();
        expect(within(riga('Luca Rossi')).getByTestId('retta-a-carico')).toBeInTheDocument();
        const log = logSpia.chiamate.filter((c) => c.messaggio === 'scadenzario-legami-voci-scartate');
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ livello: 'error', campi: { n: 2 } });
        expect(JSON.stringify(log[0])).not.toContain('Zeno');
        // …e nessun banner: le voci buone ci sono, lo schermo non mente su di loro.
        expect(screen.queryByTestId('errore-legami')).toBeNull();
    });
    // K6 (seconda revisione 2026-09-28): la validazione guardava solo id, nome e cognome.
    it('K6 — una classe non stringa non fa cadere il cruscotto: la voce si scarta e si conta', async () => {
        const rotta = { alunno_id: PIA.id, scuola_id: 's1', pagante: { ...pag(MARIO, 'M'), classe_sezione: 42 } };
        stub({ legami: { ...LEGAMI, data: [...LEGAMI.data, rotta] } }); await apri();
        expect(within(riga('Luca Rossi')).getByTestId('retta-a-carico')).toBeInTheDocument();
        expect(within(riga('Pia Gialli')).getByText('Non generata')).toBeInTheDocument();
        const log = logSpia.chiamate.filter((c) => c.messaggio === 'scadenzario-legami-voci-scartate');
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ livello: 'error', campi: { n: 1 } });
    });
    it('K6 — `iscritto` assente non accende il falso avviso «non risulta iscritto»', async () => {
        const { iscritto: _tolto, ...senza } = pag(MARIO, 'M');
        void _tolto;
        stub({ legami: { ...LEGAMI, data: [...LEGAMI.data, { alunno_id: PIA.id, scuola_id: 's1', pagante: senza }] } }); await apri();
        expect(within(riga('Pia Gialli')).getByText('Non generata')).toBeInTheDocument();
        expect(within(riga('Pia Gialli')).queryByTestId('retta-a-carico-anomalia')).toBeNull();
        expect(logSpia.chiamate.filter((c) => c.messaggio === 'scadenzario-legami-voci-scartate')[0]).toMatchObject({ campi: { n: 1 } });
    });
    it('nessuna voce scartata: nessun log', async () => {
        stub(); await apri();
        expect(logSpia.chiamate.some((c) => c.messaggio === 'scadenzario-legami-voci-scartate')).toBe(false);
    });
    // R10 (terza revisione 2026-09-29): `a_carico_non_visibili` presente ma non un array finiva
    // solo in un log, e i legami di quella stessa risposta si mostravano come veri. È la stessa
    // forma inattesa dei legami: banner, e niente dati parziali. (Dalla quarta revisione, Q4,
    // anche il campo ASSENTE o `null`: vedi i due test «Q4 — campo …» qui sopra.)
    it('R10 — `a_carico_non_visibili` che non è un array: banner, e nessun badge di quella risposta', async () => {
        stub({ legami: { ...LEGAMI, a_carico_non_visibili: IVO.id } }); await apri();
        expect(await screen.findByTestId('errore-legami')).toBeInTheDocument();
        expect(within(riga('Luca Rossi')).getByText('Non generata')).toBeInTheDocument();
        expect(screen.queryByTestId('retta-a-carico')).toBeNull();
        expect(screen.queryByTestId('retta-a-carico-non-visibile')).toBeNull();
        expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio === 'scadenzario-legami-forma-inattesa')).toBe(true);
    });
});

/**
 * R7a (terza revisione 2026-09-29) — i legami che falliscono DOPO una lettura riuscita. Il ramo
 * del guasto svuota i legami e i non visibili, ma nessun test partiva con dei badge già a
 * schermo: togliendo lo svuotamento la suite restava verde, e un «Aggiorna» fallito avrebbe
 * lasciato i badge di prima spacciati per attuali, sotto un banner che dice il contrario.
 */
describe('R7a — la GET dei legami fallisce al secondo caricamento', () => {
    async function apriPoiGuasto() {
        const o: { legamiStatus?: number } = {};
        stub(o); await apri();
        // Controllo positivo: prima del guasto i badge ci sono.
        expect(within(riga('Luca Rossi')).getByTestId('retta-a-carico')).toBeInTheDocument();
        expect(within(riga('Ivo Grigi')).getByTestId('retta-a-carico-non-visibile')).toBeInTheDocument();
        o.legamiStatus = 500;
        fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
        expect(await screen.findByTestId('errore-legami')).toBeInTheDocument();
        await waitFor(() => expect(riga('Luca Rossi')).toBeInTheDocument());
    }
    it('i badge «Paga il fratello …» di prima NON restano: tornano «Non generata», col banner', async () => {
        await apriPoiGuasto();
        expect(within(riga('Luca Rossi')).getByText('Non generata')).toBeInTheDocument();
        expect(screen.queryByTestId('retta-a-carico')).toBeNull();
    });
    it('lo stesso per i non visibili: Ivo torna «Non generata», niente «di un’altra sede»', async () => {
        await apriPoiGuasto();
        expect(within(riga('Ivo Grigi')).getByText('Non generata')).toBeInTheDocument();
        expect(screen.queryByTestId('retta-a-carico-non-visibile')).toBeNull();
    });
});
