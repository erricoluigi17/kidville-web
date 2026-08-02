import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import itPresenze from '../../messages/it/teacherPresenze.json';
import enPresenze from '../../messages/en/teacherPresenze.json';

/**
 * Appello — una presenza che NON è stata salvata non può sembrare salvata.
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 * `handleSetStato` fa un update ottimistico (la riga mostra subito «Ingresso:
 * 16:49»), poi la POST. Se la POST fallisce, il `catch` faceva due sole cose:
 * `logClient(...)` e il rollback dello stato. A schermo, nulla. Per un secondo
 * la maestra vede l'orario d'ingresso comparire — poi la riga torna com'era e
 * il contatore resta «0 / 10 registrati». Chi ha appena cliccato «Presente»
 * legge quella sequenza come «fatto»: crede di aver segnato il bambino, e il
 * bambino non risulta registrato da nessuna parte.
 *
 * Il log serve a noi il giorno dopo. La maestra ha bisogno di saperlo ADESSO,
 * mentre il bambino è davanti a lei — nello stesso file `handlePanicAlert`
 * l'errore lo dice, con un `alert()`: qui non lo diceva nessuno.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 * Fallimento del salvataggio ⇒ (1) un avviso VISIBILE con `role="alert"`, che
 * (2) nomina il bambino — con dieci righe uguali, «errore» senza nome non dice
 * a quale tornare — e (3) offre «Riprova» che rifà davvero la richiesta.
 * Il rollback resta: la riga deve tornare a «da registrare», che è la verità.
 * E l'avviso non deve comparire quando la POST riesce, altrimenti «allarme
 * sempre» passerebbe il test senza distinguere niente.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/teacher/attendance',
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'docente-0000-4000-8000-000000000001', role: 'docente', ready: true }),
}));
// La tabella mensile non c'entra con l'appello del giorno e trascina l'export PDF.
vi.mock('@/components/features/teacher/attendance/MonthlyAttendanceTable', () => ({
    MonthlyAttendanceTable: () => null,
}));
vi.mock('@/lib/offline/db', () => ({}));

const SEZIONE = 'TEST Infanzia';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const NOME_COMPLETO = `${ALUNNO.nome} ${ALUNNO.cognome}`;

type EsitoPost = 'ok' | '503' | 'rete' | '401';

interface RigaPresenza {
    id: string;
    alunno_id: string;
    data: string;
    stato: string;
    orario_entrata: string | null;
    orario_uscita: string | null;
}

let esitoPost: EsitoPost;
/**
 * Il finto server tiene memoria di ciò che ha accettato, e il GET del giorno lo
 * ripete. Non è zelo: la pagina ricarica l'appello dopo ogni interazione, e un
 * mock che risponde sempre `[]` cancellerebbe la presenza appena salvata — il
 * test misurerebbe il mock invece del contratto.
 */
let salvate: RigaPresenza[];
const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    esitoPost = '503';
    salvate = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';

        if (u.includes('/api/educator-sections')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) });
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        }
        if (u.includes('/api/attendance/delegates')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        if (u.includes('/api/attendance/daily') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => salvate });
        }
        if (u.includes('/api/attendance/daily') && metodo === 'POST') {
            if (esitoPost === 'rete') return Promise.reject(new TypeError('Failed to fetch'));
            if (esitoPost === '401') {
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Non autenticato' }),
                });
            }
            if (esitoPost === '503') {
                return Promise.resolve({
                    ok: false,
                    status: 503,
                    json: async () => ({ error: 'Servizio non disponibile' }),
                });
            }
            const inviato = JSON.parse(init?.body ?? '{}') as Partial<RigaPresenza>;
            const riga: RigaPresenza = {
                id: 'rec-1',
                alunno_id: String(inviato.alunno_id),
                data: String(inviato.data),
                stato: String(inviato.stato),
                orario_entrata: inviato.orario_entrata ?? null,
                orario_uscita: inviato.orario_uscita ?? null,
            };
            salvate = [riga];
            return Promise.resolve({ ok: true, status: 200, json: async () => riga });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherAttendancePage from '@/app/(dashboard)/teacher/attendance/page';

const avviso = () => screen.queryByRole('alert');
const postSalvataggio = () =>
    fetchMock.mock.calls.filter(
        ([u, init]) => String(u).includes('/api/attendance/daily') && (init as { method?: string } | undefined)?.method === 'POST',
    );

/** Monta la pagina e aspetta che la riga del bambino sia sullo schermo. */
async function apriAppello() {
    render(<TeacherAttendancePage />);
    await waitFor(() => expect(screen.getByText(NOME_COMPLETO)).toBeInTheDocument());
}

async function segnaPresente() {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itPresenze.presente}$`) }));
}

describe('Appello — il salvataggio fallito si vede, e si può ripetere', () => {
    it('POST 503: compare un avviso che nomina il bambino e offre «Riprova»', async () => {
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        const banner = avviso()!;
        expect(within(banner).getByText(NOME_COMPLETO)).toBeInTheDocument();
        expect(
            within(banner).getByRole('button', { name: new RegExp(itPresenze.riprova, 'i') }),
        ).toBeInTheDocument();
    });

    it('rete giù: stesso avviso — non solo per un 503 con corpo', async () => {
        esitoPost = 'rete';
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        expect(within(avviso()!).getByText(NOME_COMPLETO)).toBeInTheDocument();
    });

    it('l’avviso non sostituisce il log, e il log continua a non contenere il nome', async () => {
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', route: '/teacher/attendance' }),
        );
        // Dati di minori: il nome resta sullo schermo della maestra, fuori dai log.
        const scritto = JSON.stringify(h.logClient.mock.calls);
        expect(scritto).not.toContain(ALUNNO.nome);
        expect(scritto).not.toContain(ALUNNO.cognome);
    });

    /**
     * IL PERCHÉ DEL GUASTO DEVE ARRIVARE AL LOG, NON SOLO IL FATTO.
     *
     * La riga scritta qui era `presenza-salvataggio-fallito: <classe dell'errore>`
     * e nient'altro: nessuno stato HTTP. E il logger di rete scarta di proposito i
     * 401/400 (`livelloFetch`, per non annegare `app_log`), quindi un salvataggio
     * respinto per SESSIONE SCADUTA non lasciava NESSUNA riga che dicesse perché —
     * misurato in produzione: la riga delle 14:50 del 2026-08-02 non ha né un log
     * di rete né uno di route corrispondente.
     *
     * «Presenza non salvata» e «sessione scaduta» richiedono due interventi
     * diversi: uno si ritenta, l'altro si rifà il login. Senza lo stato, alle 3 di
     * notte le due si leggono uguali.
     */
    it('il log porta lo STATO HTTP: 401 (sessione scaduta) e 503 non si leggono uguali', async () => {
        esitoPost = '401';
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', route: '/teacher/attendance', stato: 401 }),
        );
    });

    it('…e lo stato non è cablato: con il 503 la riga porta 503', async () => {
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ stato: 503 }));
    });

    it('rete giù: nessuno stato inventato (non c\'è stata risposta)', async () => {
        esitoPost = 'rete';
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(avviso()).toBeInTheDocument());
        const chiamata = h.logClient.mock.calls.find((c) => c[0]?.evento === 'fetch');
        expect(chiamata?.[0]?.stato).toBeUndefined();
    });

    it('«Riprova» rifà la richiesta: se il server risponde, l’avviso sparisce', async () => {
        await apriAppello();
        await segnaPresente();
        await waitFor(() => expect(avviso()).toBeInTheDocument());
        expect(postSalvataggio()).toHaveLength(1);

        esitoPost = 'ok';
        fireEvent.click(within(avviso()!).getByRole('button', { name: new RegExp(itPresenze.riprova, 'i') }));

        await waitFor(() => expect(avviso()).not.toBeInTheDocument());
        expect(postSalvataggio()).toHaveLength(2);
        // …e ora la presenza risulta davvero registrata.
        expect(screen.getByText(new RegExp(itPresenze.ingresso))).toBeInTheDocument();
    });

    it('CONTROLLO POSITIVO — POST 200: nessun avviso, e la riga resta registrata', async () => {
        esitoPost = 'ok';
        await apriAppello();
        await segnaPresente();

        await waitFor(() => expect(screen.getByText(new RegExp(itPresenze.ingresso))).toBeInTheDocument());
        expect(avviso()).not.toBeInTheDocument();
        expect(h.logClient).not.toHaveBeenCalled();
    });
});

describe('Appello — i18n delle stringhe nuove', () => {
    it('le chiavi dell’avviso esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['salvataggioFallito', 'salvataggioFallitoAiuto', 'riprovaPer']) {
            expect(itPresenze, `manca in it/teacherPresenze.json: ${k}`).toHaveProperty(k);
            expect(enPresenze, `manca in en/teacherPresenze.json: ${k}`).toHaveProperty(k);
        }
    });
});
