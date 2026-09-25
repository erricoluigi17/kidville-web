import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Appello PRIMARIA — «Annulla» per singolo alunno (spec 2026-09-24, punto 6; compito A4).
 *
 * Che cosa lega questo file:
 *  (a) il comando c'è solo OGGI (data di Roma) e solo dove l'appello c'è;
 *  (b) chiede conferma, e senza conferma non parte niente;
 *  (c) chiama `DELETE /api/primaria/appello` con sezione, alunno e data nella query;
 *  (d) aggiorna la riga secondo l'ESITO del server — `cancellata` la svuota,
 *      `ripristinata-comunicazione` la riporta ad «assente» tenendo la giustifica;
 *  (e) senza rete non si accoda niente: si dice che serve la connessione;
 *  (f) il cambio ancora in CODA OFFLINE per quell'alunno si ritira PRIMA della
 *      DELETE — altrimenti il flush successivo riscriverebbe l'appello annullato;
 *  (g) un rifiuto motivato del server si mostra tradotto e fa rileggere l'elenco.
 *
 * La coda è un finto store che si comporta come Dexie nelle due cose che contano:
 * `get` legge davvero per chiave e `delete` toglie davvero. Un mock piatto qui
 * sarebbe verde anche senza il ritiro dalla coda.
 */

type RigaCoda = { id: string; alunno_id: string; data: string; stato: string; sync_status: string };

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    ordine: [] as string[],
    coda: new Map<string, { id: string; alunno_id: string; data: string; stato: string; sync_status: string }>(),
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(`userId=${DOCENTE}`),
    useParams: () => ({ sectionId: SEZIONE }),
    usePathname: () => `/teacher/primaria/${SEZIONE}/appello`,
}));
vi.mock('@/lib/offline/db', () => ({
    db: {
        primaria_appello: {
            get: vi.fn(async (id: string) => h.coda.get(id)),
            delete: vi.fn(async (id: string) => {
                h.ordine.push(`coda-delete:${id}`);
                h.coda.delete(id);
            }),
            put: vi.fn(async (r: RigaCoda) => { h.coda.set(r.id, r); }),
            where: vi.fn(() => ({ anyOf: () => ({ toArray: async () => [] }) })),
            update: vi.fn(async () => undefined),
        },
    },
}));

const DOCENTE = 'd0c00000-0000-4000-8000-000000000001';
const SEZIONE = '11111111-1111-4111-8111-111111111111';
const A = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Primo', cognome: 'Alunno' };
const B = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Secondo', cognome: 'Bambino' };

import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
const OGGI = oggiFiscaleISO();

const fetchMock = vi.fn();
let rispostaDelete: { status: number; corpo: unknown } = { status: 200, corpo: {} };
let righeGet: Array<Record<string, unknown>> = [];
/** Se valorizzata, la DELETE resta in volo finché il test non la risolve. */
let deleteSospesa: Promise<unknown> | null = null;
/** Se valorizzata, la POST di «Tutti presenti» resta in volo finché il test non la risolve. */
let postSospesa: Promise<unknown> | null = null;

const chiamate = (metodo: string, frammento: string) =>
    fetchMock.mock.calls.filter(
        ([u, init]) =>
            String(u).includes(frammento) &&
            ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
    );

function riga(alunno: typeof A, extra: Record<string, unknown> = {}) {
    return {
        id: alunno.id,
        nome: alunno.nome,
        cognome: alunno.cognome,
        presenza_id: `pres-${alunno.id.slice(0, 4)}`,
        stato: 'presente',
        orario_entrata: null,
        orario_uscita: null,
        note_appello: null,
        giustificata: false,
        giustificazione_testo: null,
        giust_vista_il: null,
        // Default: l'appello l'ha fatto la scuola (`registrato_da` non NULL sul server).
        appello_fatto: true,
        ...extra,
    };
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    h.ordine.length = 0;
    h.coda.clear();
    righeGet = [riga(A), riga(B)];
    deleteSospesa = null;
    postSospesa = null;
    rispostaDelete = {
        status: 200,
        corpo: { success: true, esito: 'cancellata', presenza: null },
    };
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';
        if (u.includes('/api/primaria/appello') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: righeGet }) });
        }
        if (u.includes('/api/primaria/appello') && metodo === 'DELETE') {
            h.ordine.push('fetch-delete');
            if (deleteSospesa) return deleteSospesa;
            const { status, corpo } = rispostaDelete;
            return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => corpo });
        }
        if (u.includes('/api/primaria/appello') && metodo === 'POST' && postSospesa) {
            h.ordine.push('fetch-post');
            return postSospesa;
        }
        if (u.includes('/api/primaria/classe/')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { alunni: [] } }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
});

afterEach(() => {
    confirmSpy.mockRestore();
});

import AppelloPrimariaPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/appello/page';

const bottoneAnnulla = (id: string) =>
    document.querySelector(`#btn-annulla-appello-${id}`) as HTMLButtonElement | null;

/** Il bottone di stato di una riga, per titolo («Presente», «Assente», …). */
function bottoneStato(alunno: typeof A, titolo: string): HTMLButtonElement {
    const li = screen.getByText(`${alunno.cognome} ${alunno.nome}`).closest('li')!;
    return li.querySelector(`button[title="${titolo}"]`) as HTMLButtonElement;
}

async function apri() {
    render(<AppelloPrimariaPage />);
    await waitFor(() => expect(screen.getByText(`${A.cognome} ${A.nome}`)).toBeInTheDocument());
}

describe('appello primaria — «Annulla» per singolo alunno', () => {
    it('c\'è solo sulle righe con l\'appello fatto, e ha un nome accessibile che dice chi', async () => {
        righeGet = [riga(A), riga(B, { stato: null, presenza_id: null, appello_fatto: false })];
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        expect(bottoneAnnulla(A.id)!.getAttribute('aria-label')).toBe(`Annulla l’appello di ${A.cognome} ${A.nome}`);
        // B non ha appello: niente da annullare.
        expect(bottoneAnnulla(B.id)).toBeNull();
    });

    it('su un giorno che non è oggi il comando non compare', async () => {
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        const campoData = screen.getByLabelText('Data dell’appello');
        fireEvent.change(campoData, { target: { value: '01/09/2025' } });
        // Si aspetta la RILETTURA del giorno nuovo (una presenza, non un'assenza).
        await waitFor(() => expect(chiamate('GET', 'data=2025-09-01').length).toBeGreaterThan(0));
        await waitFor(() => expect(screen.getByText(`${A.cognome} ${A.nome}`)).toBeInTheDocument());
        expect(bottoneAnnulla(A.id)).toBeNull();
        expect(bottoneAnnulla(B.id)).toBeNull();
    });

    it('chiede conferma: senza conferma nessuna DELETE parte', async () => {
        confirmSpy.mockReturnValue(false);
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        fireEvent.click(bottoneAnnulla(A.id)!);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(String(confirmSpy.mock.calls[0][0])).toContain(`${A.cognome} ${A.nome}`);
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
    });

    it('confermato: DELETE con sezione, alunno e data di OGGI; «cancellata» svuota la riga', async () => {
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(1));
        const url = new URL(String(chiamate('DELETE', '/api/primaria/appello')[0][0]), 'http://x');
        expect(url.pathname).toBe('/api/primaria/appello');
        expect(url.searchParams.get('sectionId')).toBe(SEZIONE);
        expect(url.searchParams.get('alunnoId')).toBe(A.id);
        expect(url.searchParams.get('data')).toBe(OGGI);

        // La riga torna «da registrare»: nessuno stato acceso, e niente più Annulla.
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Appello annullato per ${A.cognome} ${A.nome}: è di nuovo da registrare.`));
        expect(bottoneStato(A, 'Presente').className).not.toContain('bg-kidville-success');
        expect(bottoneAnnulla(A.id)).toBeNull();
        // L'altra riga non si tocca.
        expect(bottoneStato(B, 'Presente').className).toContain('bg-kidville-success');
        expect(bottoneAnnulla(B.id)).not.toBeNull();
        // Nessuna POST: annullare non è salvare uno stato.
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
    });

    it('«ripristinata-comunicazione»: resta ASSENTE con la giustifica del genitore, e Annulla sparisce', async () => {
        righeGet = [
            riga(A, { stato: 'ritardo', orario_entrata: '09:10', giustificata: true, giustificazione_testo: 'Motivo di prova' }),
            riga(B),
        ];
        rispostaDelete = {
            status: 200,
            corpo: {
                success: true,
                esito: 'ripristinata-comunicazione',
                presenza: { id: 'pres-aaaa', alunno_id: A.id, data: OGGI, stato: 'assente', orario_entrata: null, orario_uscita: null },
            },
        };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        expect(document.querySelector(`#btn-orario-entrata-${A.id}`)).not.toBeNull();

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('resta l’assenza comunicata dal genitore'));
        expect(bottoneStato(A, 'Assente').className).toContain('bg-kidville-error');
        expect(bottoneStato(A, 'Ritardo').className).not.toContain('bg-kidville-warn');
        // Un assente non ha orari: il chip d'ingresso se ne va.
        expect(document.querySelector(`#btn-orario-entrata-${A.id}`)).toBeNull();
        // La giustifica del genitore resta, con la sua presa visione.
        expect(screen.getByText('Giustificata · presa visione')).toBeInTheDocument();
        // Sotto c'è solo la comunicazione: non c'è più niente da annullare.
        expect(bottoneAnnulla(A.id)).toBeNull();
    });

    it('rifatto l\'appello su una riga tornata alla comunicazione, «Annulla» torna', async () => {
        righeGet = [riga(A, { giustificata: true }), riga(B)];
        rispostaDelete = {
            status: 200,
            corpo: { success: true, esito: 'ripristinata-comunicazione', presenza: { id: 'pres-aaaa', stato: 'assente' } },
        };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        fireEvent.click(bottoneAnnulla(A.id)!);
        await waitFor(() => expect(bottoneAnnulla(A.id)).toBeNull());

        fireEvent.click(bottoneStato(A, 'Presente'));
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
    });

    it('il cambio in CODA OFFLINE per quell\'alunno si ritira PRIMA della DELETE; gli altri restano', async () => {
        h.coda.set(`${A.id}|${OGGI}`, { id: `${A.id}|${OGGI}`, alunno_id: A.id, data: OGGI, stato: 'assente', sync_status: 'pending' });
        h.coda.set(`${B.id}|${OGGI}`, { id: `${B.id}|${OGGI}`, alunno_id: B.id, data: OGGI, stato: 'ritardo', sync_status: 'pending' });
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(h.ordine).toContain('fetch-delete'));
        expect(h.ordine).toEqual([`coda-delete:${A.id}|${OGGI}`, 'fetch-delete']);
        expect(h.coda.has(`${A.id}|${OGGI}`)).toBe(false);
        expect(h.coda.has(`${B.id}|${OGGI}`)).toBe(true);
    });

    it('senza rete: nessuna conferma, nessuna DELETE, niente in coda — si dice che serve la connessione', async () => {
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Per annullare l’appello serve la connessione'));
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
        expect(h.ordine).toHaveLength(0);
        // La riga resta com'era.
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
    });

    it('la fetch che lancia (rete caduta a metà): riga intatta, avviso, log d\'errore', async () => {
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Per annullare l’appello serve la connessione'));
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'error',
            messaggio: 'appello-primaria-annullamento-fallito: TypeError',
        }));
    });

    it('409 NIENTE_DA_ANNULLARE: messaggio tradotto, elenco riletto, Annulla sparisce, log `warn` col codice', async () => {
        rispostaDelete = {
            status: 409,
            corpo: { error: 'prosa del server', codice: 'NIENTE_DA_ANNULLARE' },
        };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        // La verità del server, che la rilettura porterà a schermo: su A c'è solo la
        // comunicazione del genitore.
        righeGet = [riga(A, { stato: 'assente', giustificata: true, appello_fatto: false }), riga(B)];

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('C’è solo la comunicazione del genitore'));
        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));
        expect(bottoneAnnulla(A.id)).toBeNull();
        expect(bottoneAnnulla(B.id)).not.toBeNull();
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'warn',
            messaggio: 'appello-primaria-annullamento-rifiutato',
            stato: 409,
            campi: { error_code: 'NIENTE_DA_ANNULLARE' },
        }));
    });

    it('409 APPELLO_ANNULLA_SOLO_OGGI: messaggio suo, e la riga NON cambia', async () => {
        rispostaDelete = { status: 409, corpo: { error: 'x', codice: 'APPELLO_ANNULLA_SOLO_OGGI' } };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('L’appello si può annullare solo nel giorno stesso.'));
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
        expect(bottoneAnnulla(A.id)).not.toBeNull();
    });

    it('500 APPELLO_NON_ANNULLATO: messaggio generico e log `error`', async () => {
        rispostaDelete = { status: 500, corpo: { error: 'x', codice: 'APPELLO_NON_ANNULLATO' } };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(bottoneAnnulla(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Non sono riuscito ad annullare l’appello. Riprova.'));
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 500 }));
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
    });

    it('la sola comunicazione del genitore (`appello_fatto: false`) NON mostra Annulla; con l\'appello fatto sì', async () => {
        // Stessa riga, stesso stato e stessa giustifica: cambia solo chi l'ha scritta.
        righeGet = [
            riga(A, { stato: 'assente', giustificata: true, appello_fatto: false }),
            riga(B, { stato: 'assente', giustificata: true, appello_fatto: true }),
        ];
        await apri();
        await waitFor(() => expect(bottoneAnnulla(B.id)).not.toBeNull());
        expect(bottoneStato(A, 'Assente').className).toContain('bg-kidville-error');
        expect(bottoneAnnulla(A.id)).toBeNull();
    });

    it('dopo «ripristinata-comunicazione», «Tutti presenti» rende di nuovo annullabile quell\'alunno', async () => {
        righeGet = [riga(A, { stato: 'ritardo', giustificata: true }), riga(B)];
        rispostaDelete = {
            status: 200,
            corpo: { success: true, esito: 'ripristinata-comunicazione', presenza: { id: 'pres-aaaa', stato: 'assente' } },
        };
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        fireEvent.click(bottoneAnnulla(A.id)!);
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('resta l’assenza comunicata dal genitore'));
        expect(bottoneAnnulla(A.id)).toBeNull();

        fireEvent.click(screen.getByText('Tutti presenti'));

        await waitFor(() => expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(1));
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
    });

    describe('il cambio ritirato dalla coda offline, quando la DELETE non va a buon fine', () => {
        const CHIAVE_A = () => `${A.id}|${OGGI}`;
        const inCodaA = () => ({ id: CHIAVE_A(), alunno_id: A.id, data: OGGI, stato: 'ritardo', sync_status: 'pending' });

        it('DELETE 500: il cambio TORNA in coda, identico', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 500, corpo: { error: 'x', codice: 'APPELLO_NON_ANNULLATO' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Non sono riuscito ad annullare l’appello. Riprova.'));
            // È passato davvero dal ritiro (non è rimasto lì per caso)…
            expect(h.ordine[0]).toBe(`coda-delete:${CHIAVE_A()}`);
            // …e ci è tornato, con lo stato da spedire e `pending`.
            await waitFor(() => expect(h.coda.get(CHIAVE_A())).toEqual(inCodaA()));
        });

        it('la fetch che lancia: il cambio TORNA in coda', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Per annullare l’appello serve la connessione'));
            expect(h.ordine[0]).toBe(`coda-delete:${CHIAVE_A()}`);
            await waitFor(() => expect(h.coda.get(CHIAVE_A())).toEqual(inCodaA()));
        });

        it('404 PRESENZA_NON_TROVATA con un cambio ritirato: l\'appello stava solo in coda — è ANNULLATO, non un errore', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 404, corpo: { error: 'x', codice: 'PRESENZA_NON_TROVATA' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            // Sul server A non ha riga: la rilettura lo dirà.
            righeGet = [riga(A, { stato: null, presenza_id: null, appello_fatto: false }), riga(B)];

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`Appello annullato per ${A.cognome} ${A.nome}`));
            expect(screen.queryByRole('alert')).toBeNull();
            expect(h.coda.has(CHIAVE_A())).toBe(false);
            expect(bottoneStato(A, 'Presente').className).not.toContain('bg-kidville-success');
            expect(bottoneAnnulla(A.id)).toBeNull();
        });

        it('409 NIENTE_DA_ANNULLARE con un cambio ritirato: sotto resta la comunicazione — annullato, e NON si rimette in coda', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 409, corpo: { error: 'x', codice: 'NIENTE_DA_ANNULLARE' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            righeGet = [riga(A, { stato: 'assente', giustificata: true, appello_fatto: false }), riga(B)];

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('resta l’assenza comunicata dal genitore'));
            expect(h.coda.has(CHIAVE_A())).toBe(false);
            await waitFor(() => expect(bottoneStato(A, 'Assente').className).toContain('bg-kidville-error'));
            expect(bottoneAnnulla(A.id)).toBeNull();
        });

        /**
         * Dopo un annullamento RIUSCITO la rilettura dell'elenco può fallire (GET che
         * lancia, 502 HTML che non è JSON). `load` non ha un `catch` suo: se quel
         * rilancio arrivasse al `catch` dell'annullamento, il cambio appena ritirato
         * TORNEREBBE in coda e l'avviso «ok» diventerebbe «serve la connessione» — e
         * il primo flush riscriverebbe l'appello annullato.
         */
        const rileggiRompendo = (rottura: 'lancia' | 'non-json') => {
            const base = fetchMock.getMockImplementation()!;
            fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
                if (String(url).includes('/api/primaria/appello') && (init?.method ?? 'GET') === 'GET') {
                    h.ordine.push('fetch-get-rotta');
                    if (rottura === 'lancia') return Promise.reject(new TypeError('Failed to fetch'));
                    return Promise.resolve({
                        ok: false,
                        status: 502,
                        json: async () => { throw new SyntaxError('Unexpected token <'); },
                    });
                }
                return base(url, init);
            });
        };

        it('404 PRESENZA_NON_TROVATA con un cambio ritirato e la RILETTURA che lancia: resta annullato, niente torna in coda', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 404, corpo: { error: 'x', codice: 'PRESENZA_NON_TROVATA' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            rileggiRompendo('lancia');

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(h.ordine).toContain('fetch-get-rotta'));
            await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
                livello: 'error',
                messaggio: expect.stringContaining('appello-primaria-rilettura-dopo-annullamento-fallita'),
            })));
            expect(screen.getByRole('status')).toHaveTextContent(`Appello annullato per ${A.cognome} ${A.nome}`);
            expect(screen.queryByRole('alert')).toBeNull();
            expect(h.coda.has(CHIAVE_A())).toBe(false);
            // Nessun rimettere-in-coda: la `put` del finto store non è mai stata chiamata.
            const { db } = await import('@/lib/offline/db');
            expect(db.primaria_appello.put).not.toHaveBeenCalled();
        });

        it('200 con esito sconosciuto e la rilettura che non è JSON (502 HTML): il cambio ritirato NON torna in coda, nessun allarme', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 200, corpo: { success: true, esito: 'qualcosa-di-nuovo' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            rileggiRompendo('non-json');

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
                messaggio: expect.stringContaining('appello-primaria-rilettura-dopo-annullamento-fallita'),
            })));
            // Il bottone torna attivo: l'annullamento è concluso.
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeDisabled());
            expect(screen.queryByRole('alert')).toBeNull();
            expect(h.coda.has(CHIAVE_A())).toBe(false);
            const { db } = await import('@/lib/offline/db');
            expect(db.primaria_appello.put).not.toHaveBeenCalled();
            expect(h.logClient).not.toHaveBeenCalledWith(expect.objectContaining({
                messaggio: expect.stringContaining('appello-primaria-annullamento-fallito'),
            }));
        });

        /**
         * Il gemello del 404 qui sopra, per il 409: sul server c'è solo la comunicazione
         * del genitore e il cambio stava solo in coda. La riga deve tornare «Assente»
         * SUBITO, senza aspettare la rilettura: se la rilettura fallisce, a schermo
         * resterebbe lo stato del cambio appena tolto (che non esiste più da nessuna
         * parte) accanto all'avviso verde, con «Annulla» ancora attivo.
         */
        it('409 NIENTE_DA_ANNULLARE con un cambio ritirato e la RILETTURA che lancia: la riga torna alla comunicazione, niente torna in coda', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            rispostaDelete = { status: 409, corpo: { error: 'x', codice: 'NIENTE_DA_ANNULLARE' } };
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
            rileggiRompendo('lancia');

            fireEvent.click(bottoneAnnulla(A.id)!);

            await waitFor(() => expect(h.ordine).toContain('fetch-get-rotta'));
            await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
                livello: 'error',
                messaggio: expect.stringContaining('appello-primaria-rilettura-dopo-annullamento-fallita'),
            })));
            expect(screen.getByRole('status')).toHaveTextContent('resta l’assenza comunicata dal genitore');
            expect(screen.queryByRole('alert')).toBeNull();
            expect(bottoneStato(A, 'Assente').className).toContain('bg-kidville-error');
            expect(bottoneStato(A, 'Presente').className).not.toContain('bg-kidville-success');
            expect(bottoneAnnulla(A.id)).toBeNull();
            expect(h.coda.has(CHIAVE_A())).toBe(false);
            const { db } = await import('@/lib/offline/db');
            expect(db.primaria_appello.put).not.toHaveBeenCalled();
        });

        it('un cambio più recente entrato in coda nel frattempo NON viene sovrascritto', async () => {
            h.coda.set(CHIAVE_A(), inCodaA());
            let risolvi: (v: unknown) => void = () => {};
            deleteSospesa = new Promise((r) => { risolvi = r; });
            await apri();
            await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

            fireEvent.click(bottoneAnnulla(A.id)!);
            await waitFor(() => expect(h.ordine).toContain('fetch-delete'));
            // Mentre la DELETE è in volo arriva in coda un cambio nuovo (un'altra scheda).
            const nuovo = { ...inCodaA(), stato: 'assente' };
            h.coda.set(CHIAVE_A(), nuovo);
            risolvi({ ok: false, status: 500, json: async () => ({ codice: 'APPELLO_NON_ANNULLATO' }) });

            await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Non sono riuscito'));
            expect(h.coda.get(CHIAVE_A())).toEqual(nuovo);
        });
    });

    it('mentre la DELETE è in volo, la riga di quell\'alunno è ferma: nessuno stato né orario si può segnare', async () => {
        righeGet = [riga(A, { stato: 'ritardo', orario_entrata: '09:10' }), riga(B)];
        let risolvi: (v: unknown) => void = () => {};
        deleteSospesa = new Promise((r) => { risolvi = r; });
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(bottoneAnnulla(A.id)!);
        await waitFor(() => expect(h.ordine).toContain('fetch-delete'));

        expect(bottoneStato(A, 'Assente')).toBeDisabled();
        // Il chip dell'orario si apre, ma il salvataggio è fermo (`inCorso`).
        fireEvent.click(document.querySelector(`#btn-orario-entrata-${A.id}`)!);
        expect(document.querySelector(`#btn-salva-orario-entrata-${A.id}`)).toBeDisabled();
        fireEvent.click(document.querySelector(`#btn-salva-orario-entrata-${A.id}`)!);
        expect(chiamate('PATCH', '/api/attendance/daily')).toHaveLength(0);
        fireEvent.click(bottoneStato(A, 'Assente'));
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
        // L'altra riga resta viva.
        expect(bottoneStato(B, 'Assente')).not.toBeDisabled();

        risolvi({ ok: true, status: 200, json: async () => ({ success: true, esito: 'cancellata', presenza: null }) });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Appello annullato'));
        expect(bottoneStato(A, 'Assente')).not.toBeDisabled();
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
    });

    it('mentre la DELETE è in volo, «Tutti presenti» è fermo: nessuna POST in blocco può superarla', async () => {
        let risolvi: (v: unknown) => void = () => {};
        deleteSospesa = new Promise((r) => { risolvi = r; });
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(bottoneAnnulla(A.id)!);
        await waitFor(() => expect(h.ordine).toContain('fetch-delete'));

        const tutti = screen.getByText('Tutti presenti').closest('button')!;
        expect(tutti).toBeDisabled();
        fireEvent.click(tutti);
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);

        risolvi({ ok: true, status: 200, json: async () => ({ success: true, esito: 'cancellata', presenza: null }) });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Appello annullato'));
        // Finito l'annullamento, «Tutti presenti» torna disponibile.
        expect(tutti).not.toBeDisabled();
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
    });

    it('mentre la POST di «Tutti presenti» è in volo, «Annulla» è fermo: né conferma né DELETE', async () => {
        let risolvi: (v: unknown) => void = () => {};
        postSospesa = new Promise((r) => { risolvi = r; });
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());

        fireEvent.click(screen.getByText('Tutti presenti'));
        await waitFor(() => expect(h.ordine).toContain('fetch-post'));

        expect(bottoneAnnulla(A.id)).toBeDisabled();
        expect(bottoneAnnulla(B.id)).toBeDisabled();
        fireEvent.click(bottoneAnnulla(A.id)!);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);

        risolvi({ ok: true, status: 200, json: async () => ({ success: true }) });
        // Finita la POST, ogni alunno si annulla di nuovo singolarmente.
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeDisabled());
        expect(bottoneAnnulla(B.id)).not.toBeDisabled();
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
    });

    it('mentre la POST singola di un alunno è in volo, il SUO «Annulla» è fermo: né conferma né DELETE', async () => {
        // B senza appello: segnare «Presente» fa comparire «Annulla» subito
        // (`appello_fatto: true` ottimistico), mentre la POST non è ancora arrivata.
        righeGet = [riga(A), riga(B, { stato: null, presenza_id: null, appello_fatto: false })];
        let risolvi: (v: unknown) => void = () => {};
        postSospesa = new Promise((r) => { risolvi = r; });
        await apri();
        expect(bottoneAnnulla(B.id)).toBeNull();

        fireEvent.click(bottoneStato(B, 'Presente'));
        await waitFor(() => expect(h.ordine).toContain('fetch-post'));

        await waitFor(() => expect(bottoneAnnulla(B.id)).not.toBeNull());
        expect(bottoneAnnulla(B.id)).toBeDisabled();
        fireEvent.click(bottoneAnnulla(B.id)!);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
        // La corsa è per alunno: l'altra riga resta annullabile.
        expect(bottoneAnnulla(A.id)).not.toBeDisabled();

        risolvi({ ok: true, status: 200, json: async () => ({ success: true }) });
        await waitFor(() => expect(bottoneAnnulla(B.id)).not.toBeDisabled());
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
    });

    it('mentre la DELETE è in volo, il campo data è fermo; finita, torna modificabile', async () => {
        let risolvi: (v: unknown) => void = () => {};
        deleteSospesa = new Promise((r) => { risolvi = r; });
        await apri();
        await waitFor(() => expect(bottoneAnnulla(A.id)).not.toBeNull());
        const campoData = screen.getByLabelText('Data dell’appello');
        expect(campoData).not.toBeDisabled();

        fireEvent.click(bottoneAnnulla(A.id)!);
        await waitFor(() => expect(h.ordine).toContain('fetch-delete'));

        expect(campoData).toBeDisabled();

        risolvi({ ok: true, status: 200, json: async () => ({ success: true, esito: 'cancellata', presenza: null }) });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Appello annullato'));
        expect(campoData).not.toBeDisabled();
    });

    it('«Tutti presenti» resta com\'è: una POST in blocco, nessuna DELETE', async () => {
        await apri();
        fireEvent.click(screen.getByText('Tutti presenti'));
        await waitFor(() => expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(1));
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
    });
});
