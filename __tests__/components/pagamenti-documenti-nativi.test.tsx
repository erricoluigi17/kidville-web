import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * ─── NAT3e — I DOCUMENTI DELLA CONTABILITÀ DALL'APP (ricevute, export, fiscale, cassa) ─────
 *
 * Prima erano `<a href="/api/…">` e un `window.open` dopo una fetch: nella WebView di Capacitor
 * non scaricano niente e non lanciano niente. Ora, SOLO nell'app, il tocco ferma la navigazione e
 * passa all'helper unico (`apriDocumento` / `scaricaDocumento`); sul web il clic segue l'`href`
 * come prima.
 *
 * ⚠️ L'HELPER È FINTO MA REGISTRA GLI ARGOMENTI, e i casi controllano QUALE funzione riceve QUALE
 * sorgente (la route con i suoi parametri, l'URL firmato del giustificativo), con quale nome e
 * tipo: un finto che si limitasse a «è stato chiamato» sarebbe verde anche scambiando `apri` con
 * `scarica`, o passando la route sbagliata. `fileConsegnato` resta quello vero: l'avviso dipende
 * dal verdetto, e il verdetto lo decide il modulo reale.
 *
 * ⚠️ `t` STABILE, come in `PaymentsDashboard-coda.test.tsx`: il `load` del cruscotto dipende da
 * `t`, e con la `t` nuova a ogni resa del mock globale le GET non finirebbero mai.
 */
vi.mock('next-intl', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const leggi = (ns: string): Record<string, unknown> =>
        JSON.parse(readFileSync(join(process.cwd(), 'messages/it', `${ns}.json`), 'utf8'));
    const cataloghi = new Map<string, Record<string, unknown>>();
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns = 'common') => {
        const gia = perNamespace.get(ns);
        if (gia) return gia;
        if (!cataloghi.has(ns)) {
            try { cataloghi.set(ns, leggi(ns)); } catch { cataloghi.set(ns, {}); }
        }
        const cat = cataloghi.get(ns) ?? {};
        const t = (key: string) => {
            const v = cat[key];
            return typeof v === 'string' ? v : `${ns}.${key}`;
        };
        const stabile = Object.assign(t, { rich: t, markup: t, raw: t, has: () => true });
        perNamespace.set(ns, stabile);
        return stabile;
    };
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

const nat = vi.hoisted(() => ({ nativo: false }));
vi.mock('@/lib/push/native-register', async (orig) => ({
    ...(await orig<typeof import('@/lib/push/native-register')>()),
    isNativeApp: () => nat.nativo,
}));

const helper = vi.hoisted(() => ({ apri: vi.fn(), scarica: vi.fn() }));
vi.mock('@/lib/native/scarica', async (orig) => ({
    ...(await orig<typeof import('@/lib/native/scarica')>()),
    apriDocumento: helper.apri,
    scaricaDocumento: helper.scarica,
}));

vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useAdminIdentity: () => ({ userId: 'u1', ruolo: 'admin', withUser: (h: string) => h }),
    useRuoloCockpit: () => 'admin',
}));

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));
vi.mock('@/components/features/admin/pagamenti/RevisioneFatturePanel', () => ({
    RevisioneFatturePanel: () => null,
}));

import { FiscalePanel } from '@/components/features/admin/pagamenti/FiscalePanel';
import { TransazioniPanel } from '@/components/features/admin/pagamenti/TransazioniPanel';
import { CassaPanel, nomeGiustificativo } from '@/components/features/admin/pagamenti/CassaPanel';
import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { daAvvisare, tipoAvviso, MIME_XLSX } from '@/components/features/admin/pagamenti/LinkDocumento';

/** «Aggiorna l'app»: SOLO col binario senza plugin (`binarioDaAggiornare`). */
const AVVISO_AGGIORNA = /Documento non disponibile sul telefono/;
/** «Riprova»: ogni altro fallimento (server, sessione, foglio che non si apre). */
const AVVISO_RIPROVA = /Il documento non è arrivato: riprova/;
const ANNO = new Date().getFullYear();

function jsonRes(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body } as Response;
}

/** Risposte per URL; la prima regola che corrisponde vince. */
function stubFetch(regole: [string, () => Response][]) {
    const fn = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        for (const [pezzo, risposta] of regole) if (u.includes(pezzo)) return risposta();
        return jsonRes({ success: true, data: [] });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

/**
 * Il clic segue l'`href`? Lo dice `defaultPrevented` letto sul `document`, DOPO il gestore di
 * React (che sta sulla radice). Poi si ferma la navigazione, che jsdom non implementa.
 */
let clicSeguito: boolean[] = [];
function spiaNavigazione(e: Event) {
    if ((e.target as HTMLElement | null)?.closest?.('a')) {
        clicSeguito.push(!e.defaultPrevented);
        e.preventDefault();
    }
}

beforeEach(() => {
    nat.nativo = false;
    helper.apri.mockReset().mockResolvedValue({ esito: 'nativo-anteprima' });
    helper.scarica.mockReset().mockResolvedValue({ esito: 'nativo-file' });
    clicSeguito = [];
    document.addEventListener('click', spiaNavigazione);
});
afterEach(() => {
    document.removeEventListener('click', spiaNavigazione);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/* ─── Fiscale: attestazione 730 (apri) ed export AdE (scarica) ───────────────────────────── */

function stubFiscale() {
    return stubFetch([
        ['/api/pagamenti/ricevute', () => jsonRes({ success: true, data: [], disponibile: false })],
        ['/api/admin/students', () => jsonRes({ success: true, data: [{ id: 'al-1', nome: 'Uno', cognome: 'Alunno', classe_sezione: '1A' }] })],
    ]);
}

describe('FiscalePanel — attestazione 730 ed export AdE', () => {
    it('nell\'app l\'attestazione si APRE con l\'helper, sulla route con alunno, anno e utente', async () => {
        nat.nativo = true;
        stubFiscale();
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        const link = await screen.findByRole('link', { name: /Scarica attestazione/ });
        fireEvent.click(link);

        expect(clicSeguito).toEqual([false]);
        expect(helper.scarica).not.toHaveBeenCalled();
        expect(helper.apri).toHaveBeenCalledTimes(1);
        expect(helper.apri).toHaveBeenCalledWith({
            sorgente: `/api/pagamenti/attestazione?alunno_id=al-1&anno=${ANNO}&userId=u1`,
            nomeFile: `attestazione-730-${ANNO}.pdf`,
            mime: 'application/pdf',
            etichetta: 'attestazione-730',
        });
    });

    it('nell\'app l\'export AdE si SCARICA (foglio «Salva su File»), come XLSX dell\'anno precedente', async () => {
        nat.nativo = true;
        stubFiscale();
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        await screen.findByRole('link', { name: /Scarica attestazione/ });
        fireEvent.click(screen.getByRole('link', { name: /Esporta comunicazione/ }));

        expect(clicSeguito).toEqual([false]);
        expect(helper.apri).not.toHaveBeenCalled();
        expect(helper.scarica).toHaveBeenCalledWith({
            sorgente: `/api/pagamenti/export?tipo=ade&anno=${ANNO - 1}&userId=u1&scuola_id=sc-1`,
            nomeFile: `comunicazione-ade-${ANNO - 1}.xlsx`,
            mime: MIME_XLSX,
            etichetta: 'export-ade',
        });
    });

    it('sul web NON cambia niente: il clic segue l\'href e l\'helper non parte', async () => {
        stubFiscale();
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        const att = await screen.findByRole('link', { name: /Scarica attestazione/ });
        const ade = screen.getByRole('link', { name: /Esporta comunicazione/ });
        expect(att.getAttribute('href')).toBe(`/api/pagamenti/attestazione?alunno_id=al-1&anno=${ANNO}&userId=u1`);
        expect(att.getAttribute('target')).toBeNull();
        expect(ade.getAttribute('href')).toBe(`/api/pagamenti/export?tipo=ade&anno=${ANNO - 1}&userId=u1&scuola_id=sc-1`);
        fireEvent.click(att);
        fireEvent.click(ade);
        expect(clicSeguito).toEqual([true, true]);
        expect(helper.apri).not.toHaveBeenCalled();
        expect(helper.scarica).not.toHaveBeenCalled();
    });

    it('binario da aggiornare → avviso «aggiorna l\'app» (e non «riprova»); file consegnato → nessun avviso', async () => {
        nat.nativo = true;
        stubFiscale();
        helper.apri.mockResolvedValueOnce({ esito: 'nativo-anteprima' });
        helper.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile', binarioDaAggiornare: true });
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        const att = await screen.findByRole('link', { name: /Scarica attestazione/ });

        fireEvent.click(att);
        await waitFor(() => expect(helper.apri).toHaveBeenCalledTimes(1));
        // Presenza di un'altra cosa prima dell'assenza: il comando AdE, che non ha ancora avvisi.
        expect(screen.getByRole('link', { name: /Esporta comunicazione/ })).toBeInTheDocument();
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
        expect(screen.queryByText(AVVISO_RIPROVA)).toBeNull();

        fireEvent.click(screen.getByRole('link', { name: /Esporta comunicazione/ }));
        expect(await screen.findByText(AVVISO_AGGIORNA)).toBeInTheDocument();
        expect(screen.getAllByText(AVVISO_AGGIORNA)).toHaveLength(1);
        expect(screen.queryByText(AVVISO_RIPROVA)).toBeNull();
    });

    it('errore del server con l\'app già aggiornata (http-500) → avviso «riprova», MAI «aggiorna l\'app»', async () => {
        nat.nativo = true;
        stubFiscale();
        helper.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' });
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click(await screen.findByRole('link', { name: /Scarica attestazione/ }));

        expect(await screen.findByText(AVVISO_RIPROVA)).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(AVVISO_RIPROVA);
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
    });

    it('un secondo tocco mentre il primo è in volo non parte', async () => {
        nat.nativo = true;
        stubFiscale();
        let chiudi: (v: unknown) => void = () => {};
        helper.scarica.mockReturnValueOnce(new Promise((r) => { chiudi = r; }));
        render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
        await screen.findByRole('link', { name: /Scarica attestazione/ });
        const ade = screen.getByRole('link', { name: /Esporta comunicazione/ });
        fireEvent.click(ade);
        fireEvent.click(ade);
        expect(helper.scarica).toHaveBeenCalledTimes(1);
        await act(async () => { chiudi({ esito: 'nativo-file' }); });
        fireEvent.click(ade);
        expect(helper.scarica).toHaveBeenCalledTimes(2);
    });
});

/* ─── Transazioni: ristampa della ricevuta dal registro ──────────────────────────────────── */

describe('TransazioniPanel — ricevuta della transazione', () => {
    const TX = {
        id: 'tx-1', pagante_parent_id: 'g-1', importo_totale: 120, metodo: 'bonifico',
        riferimento: 'CRO', data_valuta: '2026-09-01', note: null, annullata_il: null, creato_il: '2026-09-01T10:00:00Z',
    };
    function stubTransazioni() {
        return stubFetch([
            ['/api/pagamenti/transazioni', () => jsonRes({ success: true, data: [TX], disponibile: true })],
            ['/api/admin/parents', () => jsonRes([])],
        ]);
    }

    it('nell\'app la ricevuta si APRE con l\'helper, sulla route della transazione', async () => {
        nat.nativo = true;
        stubTransazioni();
        render(<TransazioniPanel userId="u1" scuolaId="s1" />);
        fireEvent.click(await screen.findByRole('link', { name: /Ricevuta/ }));

        expect(clicSeguito).toEqual([false]);
        expect(helper.scarica).not.toHaveBeenCalled();
        expect(helper.apri).toHaveBeenCalledWith({
            sorgente: '/api/pagamenti/transazioni/tx-1/ricevuta?userId=u1',
            nomeFile: 'ricevuta-famiglia.pdf',
            mime: 'application/pdf',
            etichetta: 'ricevuta-transazione',
        });
    });

    /**
     * Il passo di ESITO dopo il salvataggio. `precompila` salta allo step «importi» con la voce
     * già spuntata e il totale già scritto: basta premere «Registra incasso». La POST si distingue
     * dalla GET del registro (stessa URL) per `init.method`; il registro torna VUOTO, così l'unico
     * link «Ricevuta…» a schermo è quello dell'esito.
     */
    function stubEsito() {
        const post = vi.fn(() => jsonRes({ success: true, data: { transazione_id: 'tx-9' } }));
        vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const u = String(url);
            if (u.startsWith('/api/pagamenti/famiglia')) {
                return jsonRes({
                    success: true,
                    data: {
                        parent: { id: 'g-1', nome: 'X' }, figli: [],
                        voci: [{ id: 'p1', alunno_id: 'a1', importo: 120, importo_pagato: 0, residuo: 120 }],
                        credito: 0,
                    },
                });
            }
            if (u === '/api/pagamenti/transazioni' && init?.method === 'POST') return post();
            if (u.startsWith('/api/pagamenti/transazioni')) return jsonRes({ success: true, data: [], disponibile: true });
            if (u.startsWith('/api/admin/parents')) return jsonRes([]);
            return jsonRes({ success: true, data: [] });
        }));
        return post;
    }

    async function registraEArrivaAllEsito() {
        const post = stubEsito();
        render(<TransazioniPanel userId="u1" scuolaId="s1" precompila={{ parent: 'g-1', tot: 120 }} />);
        const registra = await screen.findByRole('button', { name: 'Registra incasso' });
        await waitFor(() => expect(registra).toBeEnabled());
        fireEvent.click(registra);
        const link = await screen.findByRole('link', { name: /Ricevuta famiglia/ });
        expect(post).toHaveBeenCalledTimes(1);
        return link;
    }

    it('nell\'app la ricevuta del passo di ESITO si APRE con l\'helper, sulla transazione appena salvata', async () => {
        nat.nativo = true;
        const link = await registraEArrivaAllEsito();
        fireEvent.click(link);

        expect(clicSeguito).toEqual([false]);
        expect(helper.scarica).not.toHaveBeenCalled();
        expect(helper.apri).toHaveBeenCalledTimes(1);
        expect(helper.apri).toHaveBeenCalledWith({
            sorgente: '/api/pagamenti/transazioni/tx-9/ricevuta?userId=u1',
            nomeFile: 'ricevuta-famiglia.pdf',
            mime: 'application/pdf',
            etichetta: 'ricevuta-transazione',
        });
    });

    it('sul web la ricevuta del passo di ESITO resta un link in una scheda nuova', async () => {
        const link = await registraEArrivaAllEsito();
        expect(link.getAttribute('href')).toBe('/api/pagamenti/transazioni/tx-9/ricevuta?userId=u1');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        fireEvent.click(link);
        expect(clicSeguito).toEqual([true]);
        expect(helper.apri).not.toHaveBeenCalled();
    });

    it('sul web la ricevuta resta un link in una scheda nuova', async () => {
        stubTransazioni();
        render(<TransazioniPanel userId="u1" scuolaId="s1" />);
        const link = await screen.findByRole('link', { name: /Ricevuta/ });
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.getAttribute('href')).toBe('/api/pagamenti/transazioni/tx-1/ricevuta?userId=u1');
        fireEvent.click(link);
        expect(clicSeguito).toEqual([true]);
        expect(helper.apri).not.toHaveBeenCalled();
    });
});

/* ─── Cruscotto: export dello scadenzario ───────────────────────────────────────────────── */

describe('PaymentsDashboard — export dello scadenzario', () => {
    function stubDashboard() {
        return stubFetch([
            ['/api/pagamenti?', () => jsonRes({ success: true, data: [] })],
            ['/api/admin/students', () => jsonRes([])],
            ['/settings/categorie', () => jsonRes({ success: true, data: [{ id: 'c1', nome: 'Retta', slug: 'retta' }] })],
            ['/settings/aruba', () => jsonRes({ success: true, data: { abilitato: true } })],
        ]);
    }

    it('nell\'app l\'XLSX si SCARICA con l\'helper, sulla route della sede', async () => {
        nat.nativo = true;
        stubDashboard();
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        fireEvent.click(await screen.findByRole('link', { name: 'Esporta XLSX' }));

        expect(clicSeguito).toEqual([false]);
        expect(helper.apri).not.toHaveBeenCalled();
        expect(helper.scarica).toHaveBeenCalledWith({
            sorgente: '/api/pagamenti/export?tipo=scadenzario&userId=u1&scuola_id=s1',
            nomeFile: 'scadenzario.xlsx',
            mime: MIME_XLSX,
            etichetta: 'export-scadenzario',
        });
    });

    it('sul web il clic segue l\'href', async () => {
        stubDashboard();
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        const link = await screen.findByRole('link', { name: 'Esporta XLSX' });
        fireEvent.click(link);
        expect(clicSeguito).toEqual([true]);
        expect(helper.scarica).not.toHaveBeenCalled();
    });
});

/* ─── Cassa: giustificativo (URL firmato di altra origine) ──────────────────────────────── */

describe('CassaPanel — giustificativo di cassa', () => {
    const PATH = 'sc-1/2026/0000-scontrino detersivi.PDF';
    const FIRMATO = 'https://storage.example.test/firmato/giustificativo?token=x';
    const RIGA = {
        id: 'm1', scuola_id: 'sc-1', tipo: 'uscita', importo: 20, metodo: 'contanti',
        data: '2026-07-20', categoria_id: 'c1', descrizione: 'Detersivi', note: null, allegato_path: PATH,
        incasso_id: null, chiusura_id: null, registrato_da: 'u1', creato_il: '2026-07-20T10:00:00Z',
        storno_di: null, stornato_il: null, storno_motivo: null, origine: 'cassa', categoria_nome: 'Pulizie',
    };
    function stubCassa(allegato: () => Response) {
        return stubFetch([
            ['/cassa/movimenti', () => jsonRes({ disponibile: true, movimenti: [RIGA] })],
            ['/cassa/allegato', allegato],
        ]);
    }

    it('nell\'app si APRE l\'URL firmato con l\'helper, col solo nome generico + estensione; niente window.open', async () => {
        nat.nativo = true;
        const fetchFinta = stubCassa(() => jsonRes({ url: FIRMATO }));
        const apri = vi.spyOn(window, 'open').mockReturnValue(null);
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);

        await waitFor(() => expect(helper.apri).toHaveBeenCalledTimes(1));
        expect(helper.apri).toHaveBeenCalledWith({
            sorgente: FIRMATO,
            nomeFile: 'giustificativo-cassa.pdf',
            etichetta: 'giustificativo-cassa',
        });
        expect(apri).not.toHaveBeenCalled();
        expect(fetchFinta.mock.calls.some(([u]) => String(u) === `/api/pagamenti/cassa/allegato?userId=u1&path=${encodeURIComponent(PATH)}`)).toBe(true);
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
        expect(screen.queryByText(AVVISO_RIPROVA)).toBeNull();
    });

    it('sul web resta window.open sull\'URL firmato, e l\'helper non parte', async () => {
        stubCassa(() => jsonRes({ url: FIRMATO }));
        const apri = vi.spyOn(window, 'open').mockReturnValue(null);
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);
        await waitFor(() => expect(apri).toHaveBeenCalledWith(FIRMATO, '_blank', 'noopener'));
        expect(helper.apri).not.toHaveBeenCalled();
    });

    it('nell\'app, senza URL firmato (403) → avviso «riprova» (il binario non c\'entra) e nessun helper', async () => {
        nat.nativo = true;
        stubCassa(() => jsonRes({ error: 'Allegato non accessibile' }, 403));
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);
        expect(await screen.findByText(AVVISO_RIPROVA)).toBeInTheDocument();
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
        expect(helper.apri).not.toHaveBeenCalled();
    });

    it('nell\'app, la fetch dell\'allegato lancia → avviso «riprova»', async () => {
        nat.nativo = true;
        stubCassa(() => { throw new TypeError('Failed to fetch'); });
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);
        expect(await screen.findByText(AVVISO_RIPROVA)).toBeInTheDocument();
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
        expect(helper.apri).not.toHaveBeenCalled();
    });

    it('nell\'app, helper non riuscito per il server (http-404) → avviso «riprova»', async () => {
        nat.nativo = true;
        stubCassa(() => jsonRes({ url: FIRMATO }));
        helper.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-404' });
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);
        expect(await screen.findByText(AVVISO_RIPROVA)).toBeInTheDocument();
        expect(screen.queryByText(AVVISO_AGGIORNA)).toBeNull();
    });

    it('nell\'app, helper col binario senza plugin → avviso «aggiorna l\'app»', async () => {
        nat.nativo = true;
        stubCassa(() => jsonRes({ url: FIRMATO }));
        helper.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:file-viewer', binarioDaAggiornare: true });
        render(<CassaPanel userId="u1" scuolaId="sc-1" />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Apri giustificativo' }))[0]);
        expect(await screen.findByText(AVVISO_AGGIORNA)).toBeInTheDocument();
        expect(screen.queryByText(AVVISO_RIPROVA)).toBeNull();
    });
});

/* ─── Le funzioni pure ──────────────────────────────────────────────────────────────────── */

describe('nomeGiustificativo e daAvvisare', () => {
    it('del percorso tiene SOLO l\'estensione (minuscola): il nome originale può contenere un nome di persona', () => {
        expect(nomeGiustificativo('sc/2026/uuid-Nome Cognome ricevuta.JPG')).toBe('giustificativo-cassa.jpg');
        expect(nomeGiustificativo('sc/2026/uuid-senza-estensione')).toBe('giustificativo-cassa');
        expect(nomeGiustificativo('sc/2026/uuid-strano.est-lunghissima')).toBe('giustificativo-cassa');
        expect(nomeGiustificativo('sc/2026.d/uuid')).toBe('giustificativo-cassa');
    });

    it('avvisa solo quando l\'utente non ha ottenuto niente che si veda', () => {
        expect(daAvvisare({ esito: 'nativo-file' })).toBe(false);
        expect(daAvvisare({ esito: 'nativo-anteprima' })).toBe(false);
        expect(daAvvisare({ esito: 'ripiego-condivisione', motivo: 'http-500' })).toBe(false);
        expect(daAvvisare({ esito: 'non-riuscito', motivo: 'annullato' })).toBe(false);
        expect(daAvvisare({ esito: 'non-riuscito', motivo: 'http-403' })).toBe(true);
        expect(daAvvisare({ esito: 'ripiego-appunti', motivo: 'x' })).toBe(true);
    });

    it('«aggiorna l\'app» SOLO col binario da aggiornare; ogni altro fallimento è «riprova»', () => {
        expect(tipoAvviso({ esito: 'nativo-file' })).toBeNull();
        expect(tipoAvviso({ esito: 'non-riuscito', motivo: 'annullato' })).toBeNull();
        expect(tipoAvviso({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem', binarioDaAggiornare: true })).toBe('aggiorna');
        expect(tipoAvviso({ esito: 'ripiego-appunti', motivo: 'plugin-assenti:share', binarioDaAggiornare: true })).toBe('aggiorna');
        for (const motivo of ['http-401', 'http-403', 'http-500', 'corpo-vuoto', 'foglio-non-aperto']) {
            expect(tipoAvviso({ esito: 'non-riuscito', motivo })).toBe('riprova');
        }
        expect(tipoAvviso({ esito: 'non-riuscito', motivo: 'http-500', binarioDaAggiornare: false })).toBe('riprova');
        expect(tipoAvviso({ esito: 'ripiego-appunti', motivo: 'x' })).toBe('riprova');
    });
});
