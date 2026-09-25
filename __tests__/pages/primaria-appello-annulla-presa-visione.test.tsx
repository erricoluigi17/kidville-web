import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Appello PRIMARIA — «Annulla presa visione» della giustifica (spec 2026-09-24,
 * punto 2; compito A5).
 *
 * Che cosa lega questo file:
 *  (a) il comando c'è solo dove la presa visione c'è (giustificata + `giust_vista_il`);
 *  (b) chiede conferma, e senza conferma non parte niente;
 *  (c) chiama `DELETE /api/primaria/presenze/giust-vista` con la presenza della riga;
 *  (d) col 2xx la riga torna a «Giustificata · presa visione» da rifare;
 *  (e) un rifiuto del server si mostra TRADOTTO dal suo codice, e la riga non cambia;
 *  (f) senza rete non parte niente: si dice che serve la connessione;
 *  (g) il comando c'è SOLO dove la GET dice `presa_visione_annullabile` (chi l'ha
 *      presa, Segreteria, Direzione): a un altro docente della classe non si offre;
 *  (h) la sua icona non è la ↺ di «Annulla appello»: su telefono l'etichetta è
 *      nascosta, e due gesti diversi non possono avere la stessa faccia;
 *  (i) mentre la DELETE è in volo il bottone è fermo: un secondo clic non manda
 *      una seconda DELETE;
 *  (j) la DELETE porta `vistaIl` = il `giust_vista_il` della riga A SCHERMO: il
 *      server toglie solo la presa visione che la persona ha visto e confermato;
 *  (k) dopo un 403 NON_TUA (permesso cambiato fra lettura e clic) si rilegge, e
 *      il comando che il server rifiuterebbe sempre sparisce.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

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
            get: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
            put: vi.fn(async () => undefined),
            where: vi.fn(() => ({ anyOf: () => ({ toArray: async () => [] }) })),
            update: vi.fn(async () => undefined),
        },
    },
}));

const DOCENTE = 'd0c00000-0000-4000-8000-000000000001';
const SEZIONE = '11111111-1111-4111-8111-111111111111';
const A = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Primo', cognome: 'Alunno' };
const B = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Secondo', cognome: 'Bambino' };
const PRESENZA_A = 'cccc1111-0000-4000-8000-000000000001';
/** Nella forma di PostgREST, microsecondi e fuso compresi: la pagina la rimanda com'è. */
const VISTA_IL = '2026-09-25T07:30:00.123456+00:00';

const fetchMock = vi.fn();
let rispostaDelete: { status: number; corpo: unknown } = { status: 200, corpo: {} };
let righeGet: Array<Record<string, unknown>> = [];
/** Se valorizzata, la DELETE resta in volo finché il test non la risolve a mano. */
let deletePendente: Promise<{ status: number; corpo: unknown }> | null = null;
/** Se valorizzata, dopo la DELETE la GET risponde con queste righe (lo stato «vero» sul server). */
let righeGetDopoDelete: Array<Record<string, unknown>> | null = null;

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
        presenza_id: null,
        stato: 'presente',
        orario_entrata: null,
        orario_uscita: null,
        note_appello: null,
        giustificata: false,
        giustificazione_testo: null,
        giust_vista_il: null,
        appello_fatto: true,
        presa_visione_annullabile: false,
        ...extra,
    };
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    righeGet = [
        riga(A, { presenza_id: PRESENZA_A, stato: 'assente', giustificata: true, giust_vista_il: VISTA_IL, presa_visione_annullabile: true }),
        riga(B),
    ];
    deletePendente = null;
    righeGetDopoDelete = null;
    rispostaDelete = { status: 200, corpo: { success: true, presenza: { id: PRESENZA_A, giust_vista_il: null } } };
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';
        if (u.includes('/api/primaria/appello') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: righeGet }) });
        }
        if (u.includes('/api/primaria/presenze/giust-vista') && metodo === 'DELETE') {
            const risposta = (r: { status: number; corpo: unknown }) =>
                ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.corpo });
            if (righeGetDopoDelete) righeGet = righeGetDopoDelete;
            if (deletePendente) return deletePendente.then(risposta);
            return Promise.resolve(risposta(rispostaDelete));
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

const bottone = (id: string) =>
    document.querySelector(`#btn-annulla-presa-visione-${id}`) as HTMLButtonElement | null;

async function apri() {
    render(<AppelloPrimariaPage />);
    await waitFor(() => expect(screen.getByText(`${A.cognome} ${A.nome}`)).toBeInTheDocument());
}

describe('appello primaria — «Annulla presa visione»', () => {
    it('c’è solo accanto a una presa visione, con un nome accessibile che dice chi', async () => {
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        expect(bottone(A.id)!.getAttribute('aria-label')).toBe(`Annulla la presa visione della giustifica di ${A.cognome} ${A.nome}`);
        expect(screen.getByText('✓ giustif. vista')).toBeInTheDocument();
        // B non ha giustifica: niente da annullare.
        expect(bottone(B.id)).toBeNull();
    });

    it('giustificata ma NON ancora vista: c’è la presa visione da dare, non l’annullamento', async () => {
        righeGet = [riga(A, { presenza_id: PRESENZA_A, stato: 'assente', giustificata: true, giust_vista_il: null }), riga(B)];
        await apri();
        await waitFor(() => expect(screen.getByText('Giustificata · presa visione')).toBeInTheDocument());
        expect(bottone(A.id)).toBeNull();
    });

    it('chiede conferma: senza conferma nessuna DELETE parte', async () => {
        confirmSpy.mockReturnValue(false);
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        fireEvent.click(bottone(A.id)!);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(String(confirmSpy.mock.calls[0][0])).toContain(`${A.cognome} ${A.nome}`);
        expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(0);
    });

    it('confermato: DELETE sulla presenza della riga; col 2xx torna «Giustificata · presa visione»', async () => {
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        fireEvent.click(bottone(A.id)!);

        await waitFor(() => expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(1));
        const url = new URL(String(chiamate('DELETE', '/api/primaria/presenze/giust-vista')[0][0]), 'http://x');
        expect(url.pathname).toBe('/api/primaria/presenze/giust-vista');
        expect(url.searchParams.get('presenzaId')).toBe(PRESENZA_A);
        // QUALE presa visione: quella della riga a schermo, identica al carattere.
        expect(url.searchParams.get('vistaIl')).toBe(VISTA_IL);

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
            `Presa visione annullata per ${A.cognome} ${A.nome}: la giustifica è di nuovo da prendere in visione.`,
        ));
        expect(bottone(A.id)).toBeNull();
        expect(screen.queryByText('✓ giustif. vista')).toBeNull();
        expect(screen.getByText('Giustificata · presa visione')).toBeInTheDocument();
        // Annullare la presa visione non è rifare l'appello.
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
        expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(0);
    });

    it('rifiuto 403 PRESA_VISIONE_NON_TUA: messaggio tradotto dal codice, la riga NON cambia', async () => {
        rispostaDelete = { status: 403, corpo: { error: 'Presa visione di un altro docente', codice: 'PRESA_VISIONE_NON_TUA' } };
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        fireEvent.click(bottone(A.id)!);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
            'La presa visione l’ha data un altro docente: può annullarla lui, oppure la Segreteria o la Direzione.',
        ));
        expect(screen.getByText('✓ giustif. vista')).toBeInTheDocument();
        expect(bottone(A.id)).not.toBeNull();
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'warn',
            messaggio: 'appello-primaria-presa-visione-non-annullata',
            stato: 403,
            campi: { error_code: 'PRESA_VISIONE_NON_TUA' },
        }));
    });

    it('403 NON_TUA e la GET ora dice `presa_visione_annullabile: false`: si rilegge, il comando sparisce, il messaggio resta', async () => {
        rispostaDelete = { status: 403, corpo: { error: 'Presa visione di un altro docente', codice: 'PRESA_VISIONE_NON_TUA' } };
        // Sul server la presa visione è ora di un collega: la GET non offre più il comando.
        righeGetDopoDelete = [
            riga(A, { presenza_id: PRESENZA_A, stato: 'assente', giustificata: true, giust_vista_il: '2026-09-25T10:15:00.654321+00:00', presa_visione_annullabile: false }),
            riga(B),
        ];
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        fireEvent.click(bottone(A.id)!);

        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));
        await waitFor(() => expect(bottone(A.id)).toBeNull());
        // La presa visione c'è ancora (del collega): si toglie il comando, non la riga.
        expect(screen.getByText('✓ giustif. vista')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(
            'La presa visione l’ha data un altro docente: può annullarla lui, oppure la Segreteria o la Direzione.',
        );
        expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(1);
    });

    it('409 PRESA_VISIONE_CAMBIATA: si rilegge l’elenco', async () => {
        rispostaDelete = { status: 409, corpo: { error: 'x', codice: 'PRESA_VISIONE_CAMBIATA' } };
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        fireEvent.click(bottone(A.id)!);
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('La presa visione è cambiata nel frattempo'));
        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));
    });

    it('senza rete: nessuna DELETE, e si dice che serve la connessione', async () => {
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
        fireEvent.click(bottone(A.id)!);
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
            'Per annullare la presa visione serve la connessione',
        ));
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(0);
    });

    it('presa visione di un ALTRO docente (`presa_visione_annullabile: false`): il comando non c’è', async () => {
        righeGet = [
            riga(A, { presenza_id: PRESENZA_A, stato: 'assente', giustificata: true, giust_vista_il: VISTA_IL, presa_visione_annullabile: false }),
            riga(B),
        ];
        await apri();
        // Si aspetta la PRESENZA della presa visione, non l'assenza del bottone:
        // prima che i dati arrivino il bottone non c'è comunque.
        await waitFor(() => expect(screen.getByText('✓ giustif. vista')).toBeInTheDocument());
        expect(bottone(A.id)).toBeNull();
        expect(screen.queryByRole('button', { name: /Annulla la presa visione/ })).toBeNull();
    });

    it('icona diversa da «Annulla appello»: `EyeOff`, non la ↺ `RotateCcw`', async () => {
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());
        const annullaAppello = document.querySelector(`#btn-annulla-appello-${A.id}`);
        // Sulla stessa riga ci sono tutti e due i comandi: è il caso che confondeva.
        expect(annullaAppello).not.toBeNull();
        expect(annullaAppello!.querySelector('svg.lucide-rotate-ccw')).not.toBeNull();
        expect(bottone(A.id)!.querySelector('svg.lucide-eye-off')).not.toBeNull();
        expect(bottone(A.id)!.querySelector('svg.lucide-rotate-ccw')).toBeNull();
    });

    it('DELETE in volo: il bottone è fermo e un secondo clic non manda una seconda DELETE', async () => {
        let risolvi!: (r: { status: number; corpo: unknown }) => void;
        deletePendente = new Promise((res) => { risolvi = res; });
        await apri();
        await waitFor(() => expect(bottone(A.id)).not.toBeNull());

        fireEvent.click(bottone(A.id)!);
        await waitFor(() => expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(1));
        await waitFor(() => expect(bottone(A.id)!.disabled).toBe(true));

        fireEvent.click(bottone(A.id)!);
        fireEvent.click(bottone(A.id)!);
        expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(1);
        // Il bottone fermo non chiede nemmeno una seconda conferma.
        expect(confirmSpy).toHaveBeenCalledTimes(1);

        risolvi({ status: 200, corpo: { success: true, presenza: { id: PRESENZA_A, giust_vista_il: null } } });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
            `Presa visione annullata per ${A.cognome} ${A.nome}`,
        ));
        expect(chiamate('DELETE', '/api/primaria/presenze/giust-vista')).toHaveLength(1);
        expect(bottone(A.id)).toBeNull();
        expect(screen.getByText('Giustificata · presa visione')).toBeInTheDocument();
    });
});
