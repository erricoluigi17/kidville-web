import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Appello PRIMARIA — la finestra di «Ritardo» e «Uscita anticipata» (compito A4,
 * spec 2026-09-26 punto 2b; contratto della POST in `contratti/A3.md`).
 *
 * Che cosa lega questo file:
 *  (a) toccando «Ritardo» o «Uscita» si apre una FINESTRA (dialog accessibile) e non
 *      parte nessuna POST finché non si preme «Salva»; «Presente» e «Assente» salvano
 *      subito come prima;
 *  (b) l'ora è PRECOMPILATA con l'ora di Roma di adesso, ed è modificabile;
 *  (c) con la spunta «Giustificato» la nota è OBBLIGATORIA: «Salva» resta fermo e un
 *      messaggio dice perché; lo stesso vale per un'ora svuotata (niente POST con
 *      `orarioEntrata: ''`, che il server rifiuterebbe e la coda rispedirebbe per sempre);
 *  (d) «Salva» manda la POST esistente con l'orario giusto (ingresso per il ritardo,
 *      uscita per l'uscita anticipata — mai l'altro), il flag e la nota;
 *  (e) «Annulla» non cambia niente: né POST, né stato a schermo;
 *  (f) riaprendo un alunno già in ritardo, la finestra mostra i valori SALVATI;
 *  (g) nella lista un ritardo giustificato si vede, con la nota;
 *  (h) senza rete il cambio va in coda con i campi nuovi (altrimenti il flush lo
 *      rispedirebbe senza flag, e il contratto A3 lo spegnerebbe);
 *      «Presente» su un ritardo giustificato spegne il flag e conserva l'ora a schermo;
 *  (i) un 422 del server non va in coda: si dice a schermo e si rilegge l'elenco; i due
 *      codici del contratto (nota mancante, stato non ammesso) hanno messaggi DIVERSI; e
 *      l'avviso sparisce cambiando giorno;
 *  (j) la segreteria usa la STESSA pagina (re-export in `admin/`);
 *  (k) un «Annulla» che ripristina la comunicazione del genitore azzera a schermo la
 *      nota del docente, come fa il server: la finestra non la ripropone e «Salva» non
 *      la riscrive.
 *
 * L'orologio: si ferma SOLO `Date` (i timer restano veri, `waitFor` ne ha bisogno) su
 * un istante noto — 07:42 UTC del 7 settembre, cioè 09:42 a Roma (ora legale). Se la
 * pagina proponesse l'ora del dispositivo in UTC, (b) leggerebbe 07:42 e sarebbe rosso.
 */

type RigaCoda = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    coda: new Map<string, Record<string, unknown> & { id: string }>(),
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
// La coda offline è un finto store che SALVA davvero per chiave: il test (h) legge ciò
// che la pagina ci ha messo, non una chiamata qualunque.
vi.mock('@/lib/offline/db', () => ({
    db: {
        primaria_appello: {
            get: vi.fn(async (id: string) => h.coda.get(id)),
            delete: vi.fn(async (id: string) => { h.coda.delete(id); }),
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
const OGGI = '2026-09-07';

const fetchMock = vi.fn();
let righeGet: Array<Record<string, unknown>> = [];
let rispostaPost: { status: number; corpo: unknown } = { status: 200, corpo: { success: true, data: [] } };

const chiamate = (metodo: string, frammento: string) =>
    fetchMock.mock.calls.filter(
        ([u, init]) =>
            String(u).includes(frammento) &&
            ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
    );
const corpoDi = (c: unknown[]) => JSON.parse((c[1] as { body?: string })?.body ?? '{}') as Record<string, unknown>;
const postAppello = () => chiamate('POST', '/api/primaria/appello');

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
        assenza_oraria_giustificata: false,
        giustificata: false,
        giustificazione_testo: null,
        giust_vista_il: null,
        appello_fatto: true,
        presa_visione_annullabile: false,
        ...extra,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    h.coda.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T07:42:00.000Z'));
    righeGet = [riga(A), riga(B)];
    rispostaPost = { status: 200, corpo: { success: true, data: [] } };
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';
        if (u.includes('/api/primaria/appello') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: righeGet }) });
        }
        if (u.includes('/api/primaria/appello') && metodo === 'POST') {
            const { status, corpo } = rispostaPost;
            return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => corpo });
        }
        if (u.includes('/api/primaria/classe/')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { alunni: [] } }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
});

afterEach(() => {
    vi.useRealTimers();
});

import AppelloPrimariaPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/appello/page';
import AppelloSegreteriaPage from '@/app/(dashboard)/admin/primaria/[sectionId]/appello/page';

function rigaDi(alunno: typeof A): HTMLElement {
    return screen.getByText(`${alunno.cognome} ${alunno.nome}`).closest('li') as HTMLElement;
}
function bottoneStato(alunno: typeof A, titolo: string): HTMLButtonElement {
    return rigaDi(alunno).querySelector(`button[title="${titolo}"]`) as HTMLButtonElement;
}

async function apri(Pagina: () => React.ReactElement = AppelloPrimariaPage) {
    render(<Pagina />);
    await waitFor(() => expect(screen.getByText(`${A.cognome} ${A.nome}`)).toBeInTheDocument());
    // Il GET è arrivato davvero (una presenza, non un'assenza).
    expect(chiamate('GET', `data=${OGGI}`).length).toBeGreaterThan(0);
}

const finestra = () => screen.getByRole('dialog');
const campoOra = () => within(finestra()).getByLabelText(/^Ora di (ingresso|uscita)$/) as HTMLInputElement;
const spunta = () => within(finestra()).getByRole('checkbox', { name: /Giustificato/ }) as HTMLInputElement;
const campoNota = () => within(finestra()).getByLabelText(/^Nota/) as HTMLTextAreaElement;
const salva = () => within(finestra()).getByRole('button', { name: 'Salva' }) as HTMLButtonElement;
const annullaFinestra = () => within(finestra()).getByRole('button', { name: 'Annulla' }) as HTMLButtonElement;

describe('appello primaria — la finestra di ritardo e uscita anticipata', () => {
    it('(a)(b) «Ritardo» apre un dialog con l\'ora di Roma di adesso, e non salva niente', async () => {
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));

        const dialogo = await screen.findByRole('dialog');
        // Il nome accessibile è il titolo visibile, e il corpo dice di chi si parla.
        expect(dialogo).toHaveAccessibleName('Ritardo');
        expect(within(dialogo).getByText(`${A.cognome} ${A.nome}`)).toBeInTheDocument();
        expect(campoOra().value).toBe('09:42');
        expect(spunta().checked).toBe(false);
        expect(postAppello()).toHaveLength(0);
    });

    it('(a) «Assente» NON apre la finestra: salva subito come prima', async () => {
        await apri();
        fireEvent.click(bottoneStato(B, 'Assente'));
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(corpoDi(postAppello()[0])).toMatchObject({ alunnoId: B.id, stato: 'assente' });
        expect(corpoDi(postAppello()[0])).not.toHaveProperty('assenzaOrariaGiustificata');
    });

    it('(a) «Presente» su un ritardo giustificato: niente finestra, flag spento, ora d\'ingresso conservata', async () => {
        // 06:05 UTC = 08:05 a Roma.
        righeGet = [
            riga(A, { stato: 'ritardo', orario_entrata: '2026-09-07T06:05:00+00:00', note_appello: 'Terapia', assenza_oraria_giustificata: true }),
            riga(B),
        ];
        await apri();
        const chipIngresso = () =>
            within(rigaDi(A)).queryByRole('button', { name: /d.ingresso di .*\(ora: 08:05\)/ });
        expect(within(rigaDi(A)).getByText('Giustificato: Terapia')).toBeInTheDocument();
        expect(chipIngresso()).not.toBeNull();

        fireEvent.click(bottoneStato(A, 'Presente'));
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        expect(screen.queryByRole('dialog')).toBeNull();

        const corpo = corpoDi(postAppello()[0]);
        expect(corpo).toEqual({ sectionId: SEZIONE, data: OGGI, alunnoId: A.id, stato: 'presente' });
        // Il flag NON si nomina: per contratto A3 una POST che non lo nomina lo spegne.
        expect(corpo).not.toHaveProperty('assenzaOrariaGiustificata');
        // Né l'orario né la nota: il server li conserva.
        expect(corpo).not.toHaveProperty('orarioEntrata');
        expect(corpo).not.toHaveProperty('noteAppello');

        // A schermo come sul server: niente più «Giustificato», l'ora d'ingresso resta.
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
        expect(within(rigaDi(A)).queryByText(/Giustificato/)).toBeNull();
        expect(chipIngresso()).not.toBeNull();
    });

    it('(c) con la spunta la nota è obbligatoria: «Salva» fermo e un messaggio che dice perché', async () => {
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');

        expect(salva().disabled).toBe(false);
        fireEvent.click(spunta());
        expect(salva().disabled).toBe(true);
        const avviso = within(finestra()).getByText(/la nota è obbligatoria/);
        // Il messaggio è legato sia al campo sia al bottone: chi usa uno screen reader
        // sente il motivo sul campo da riempire.
        expect(campoNota().getAttribute('aria-describedby')).toContain(avviso.id);
        expect(campoNota().getAttribute('aria-invalid')).toBe('true');
        expect(campoNota()).toBeRequired();

        // Una nota di soli spazi non è un motivo.
        fireEvent.change(campoNota(), { target: { value: '   ' } });
        expect(salva().disabled).toBe(true);

        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        expect(salva().disabled).toBe(false);
        expect(within(finestra()).queryByText(/la nota è obbligatoria/)).toBeNull();

        // Premere «Salva» fermo non manda niente (anche col submit del form).
        fireEvent.change(campoNota(), { target: { value: '' } });
        fireEvent.submit(salva().closest('form')!);
        expect(postAppello()).toHaveLength(0);
    });

    it('(c) la regione live del motivo è montata PRIMA della spunta: cambia il testo, non il nodo', async () => {
        // Una regione `aria-live` inserita nel DOM insieme al suo testo spesso non viene
        // annunciata: chi spunta «Giustificato» non saprebbe che la nota è obbligatoria.
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');

        const regioni = () => finestra().querySelectorAll('[aria-live="polite"]');
        expect(regioni()).toHaveLength(1);
        const regione = regioni()[0];
        expect(regione.textContent).toBe('');

        fireEvent.click(spunta());
        expect(regioni()).toHaveLength(1);
        // Lo STESSO nodo, ora col testo; ed è quello che il campo nota referenzia.
        expect(regioni()[0]).toBe(regione);
        expect(regione.textContent).toMatch(/la nota è obbligatoria/);
        expect(campoNota().getAttribute('aria-describedby')).toBe(regione.id);

        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        expect(regioni()[0]).toBe(regione);
        expect(regione.textContent).toBe('');
    });

    it('(c) ora svuotata: «Salva» fermo, il motivo nella STESSA regione live, e nessuna POST', async () => {
        // L'unica difesa contro un orario vuoto: con `''` il corpo partirebbe con
        // `orarioEntrata: ''`, il server risponderebbe 400, e la pagina lo tratterebbe come
        // guasto accodandolo offline — una riga rifiutata a ogni flush.
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');

        const regioni = () => finestra().querySelectorAll('[aria-live="polite"]');
        expect(regioni()).toHaveLength(1);
        const regione = regioni()[0];
        expect(regione.textContent).toBe('');
        expect(salva().disabled).toBe(false);

        fireEvent.change(campoOra(), { target: { value: '' } });
        expect(campoOra().value).toBe('');
        expect(salva().disabled).toBe(true);
        const avviso = within(finestra()).getByText('Indica l’orario per salvare.');
        expect(avviso).toBe(regione);
        expect(regioni()).toHaveLength(1);
        expect(campoOra().getAttribute('aria-invalid')).toBe('true');
        expect(campoOra().getAttribute('aria-describedby')).toBe(regione.id);
        // La nota, che non ha colpa, non viene segnata.
        expect(campoNota().getAttribute('aria-invalid')).toBe('false');

        // Nemmeno il submit da tastiera (Invio nel campo ora) fa partire la POST.
        fireEvent.submit(salva().closest('form')!);
        expect(postAppello()).toHaveLength(0);
        expect(h.coda.size).toBe(0);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Rimessa un'ora valida, si riparte: Salva libero, regione vuota, campo in regola.
        fireEvent.change(campoOra(), { target: { value: '10:15' } });
        expect(salva().disabled).toBe(false);
        expect(regioni()[0]).toBe(regione);
        expect(regione.textContent).toBe('');
        expect(campoOra().getAttribute('aria-invalid')).toBe('false');
        expect(campoOra().hasAttribute('aria-describedby')).toBe(false);

        fireEvent.click(salva());
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        expect(corpoDi(postAppello()[0])).toMatchObject({ stato: 'ritardo', orarioEntrata: '10:15' });
    });

    it('(d) «Salva» su un ritardo giustificato manda ora modificata, flag e nota — mai l\'uscita', async () => {
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');

        fireEvent.change(campoOra(), { target: { value: '10:05' } });
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: '  Terapia  ' } });
        fireEvent.click(salva());

        await waitFor(() => expect(postAppello()).toHaveLength(1));
        const corpo = corpoDi(postAppello()[0]);
        expect(corpo).toEqual({
            sectionId: SEZIONE,
            data: OGGI,
            alunnoId: A.id,
            stato: 'ritardo',
            orarioEntrata: '10:05',
            noteAppello: 'Terapia',
            assenzaOrariaGiustificata: true,
        });
        expect(screen.queryByRole('dialog')).toBeNull();
        // La riga mostra subito lo stato e l'indicazione «giustificato» con la nota.
        expect(bottoneStato(A, 'Ritardo').className).toContain('bg-kidville-warn');
        expect(within(rigaDi(A)).getByText('Giustificato: Terapia')).toBeInTheDocument();
    });

    it('(d) «Uscita» senza spunta manda l\'ora d\'USCITA e il flag spento, esplicito', async () => {
        await apri();
        fireEvent.click(bottoneStato(B, 'Uscita'));
        const dialogo = await screen.findByRole('dialog');
        expect(dialogo).toHaveAccessibleName('Uscita anticipata');
        expect(within(dialogo).getByLabelText('Ora di uscita')).toBeInTheDocument();

        fireEvent.click(salva());
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        const corpo = corpoDi(postAppello()[0]);
        expect(corpo).toMatchObject({ alunnoId: B.id, stato: 'uscita_anticipata', orarioUscita: '09:42', assenzaOrariaGiustificata: false });
        expect(corpo).not.toHaveProperty('orarioEntrata');
        // Nota vuota: `null` esplicito (la finestra mostrava la nota salvata, che era vuota).
        expect(corpo.noteAppello).toBeNull();
    });

    it('(e) «Annulla» non cambia niente: niente POST e lo stato resta quello di prima', async () => {
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.change(campoOra(), { target: { value: '11:00' } });
        fireEvent.click(annullaFinestra());

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(postAppello()).toHaveLength(0);
        expect(bottoneStato(A, 'Presente').className).toContain('bg-kidville-success');
        expect(bottoneStato(A, 'Ritardo').className).not.toContain('bg-kidville-warn');
    });

    it('(f)(g) un ritardo già giustificato si vede nella lista, e la finestra riapre i valori SALVATI', async () => {
        // 06:05 UTC = 08:05 a Roma: la finestra non deve proporre «adesso» (09:42).
        righeGet = [
            riga(A, { stato: 'ritardo', orario_entrata: '2026-09-07T06:05:00+00:00', note_appello: 'Terapia', assenza_oraria_giustificata: true }),
            riga(B),
        ];
        await apri();
        expect(within(rigaDi(A)).getByText('Giustificato: Terapia')).toBeInTheDocument();
        expect(within(rigaDi(B)).queryByText(/Giustificato/)).toBeNull();

        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        expect(campoOra().value).toBe('08:05');
        expect(spunta().checked).toBe(true);
        expect(campoNota().value).toBe('Terapia');

        // Salvando senza toccare niente, la giustificazione si RIMANDA (contratto A3:
        // una POST che non la nomina la spegne).
        fireEvent.click(salva());
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        expect(corpoDi(postAppello()[0])).toMatchObject({ orarioEntrata: '08:05', assenzaOrariaGiustificata: true, noteAppello: 'Terapia' });
    });

    it('(f) passando da un ritardo a un\'uscita, la finestra propone l\'ora di adesso e tiene la nota del giorno', async () => {
        righeGet = [riga(A, { stato: 'ritardo', orario_entrata: '2026-09-07T06:05:00+00:00', note_appello: 'Visita', assenza_oraria_giustificata: false })];
        await apri();
        fireEvent.click(bottoneStato(A, 'Uscita'));
        await screen.findByRole('dialog');
        expect(campoOra().value).toBe('09:42');
        // La nota è quella della riga: salvandola vuota si cancellerebbe senza che il
        // docente l'abbia mai vista.
        expect(campoNota().value).toBe('Visita');
    });

    it('(f)(g) un\'USCITA già giustificata si vede nella lista, e la finestra riapre l\'ora d\'USCITA salvata', async () => {
        // Entrambi gli orari valorizzati: 06:05 UTC = 08:05 (ingresso), 10:30 UTC = 12:30
        // (uscita). Una finestra che leggesse l'ingresso proporrebbe 08:05 come ora d'uscita,
        // e salvando la scriverebbe; una che partisse da «adesso» proporrebbe 09:42.
        righeGet = [
            riga(A, {
                stato: 'uscita_anticipata',
                orario_entrata: '2026-09-07T06:05:00+00:00',
                orario_uscita: '2026-09-07T10:30:00+00:00',
                note_appello: 'Visita',
                assenza_oraria_giustificata: true,
            }),
            riga(B),
        ];
        await apri();
        expect(within(rigaDi(A)).getByText('Giustificato: Visita')).toBeInTheDocument();
        expect(within(rigaDi(B)).queryByText(/Giustificato/)).toBeNull();

        fireEvent.click(bottoneStato(A, 'Uscita'));
        const dialogo = await screen.findByRole('dialog');
        expect(dialogo).toHaveAccessibleName('Uscita anticipata');
        expect(campoOra()).toBe(within(dialogo).getByLabelText('Ora di uscita'));
        expect(campoOra().value).toBe('12:30');
        expect(spunta().checked).toBe(true);
        expect(campoNota().value).toBe('Visita');

        fireEvent.click(salva());
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        const corpo = corpoDi(postAppello()[0]);
        expect(corpo).toMatchObject({
            alunnoId: A.id,
            stato: 'uscita_anticipata',
            orarioUscita: '12:30',
            assenzaOrariaGiustificata: true,
            noteAppello: 'Visita',
        });
        expect(corpo).not.toHaveProperty('orarioEntrata');
    });

    it('(h) una POST che risponde 500 va in coda e LASCIA TRACCIA: stato HTTP nel log, nota fuori', async () => {
        rispostaPost = { status: 500, corpo: { error: 'Errore interno' } };
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        await waitFor(() => expect(h.coda.get(`${A.id}|${OGGI}`)).toBeDefined());
        expect(postAppello()).toHaveLength(1);
        expect(h.coda.get(`${A.id}|${OGGI}`)).toMatchObject({ stato: 'ritardo', assenza_oraria_giustificata: true });
        // Un guasto del server che lascia in coda un dato su un minore è un ERRORE, come
        // per `annulla` e `annullaPresaVisione` nello stesso file (>= 500 → error).
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'appello-primaria-salvataggio-accodato: risposta-non-ok',
            route: '/teacher/primaria/appello',
            stato: 500,
        }));
        // Né la nota né l'orario né il nome entrano nel log.
        const registrato = JSON.stringify(h.logClient.mock.calls);
        expect(registrato).not.toContain('Terapia');
        expect(registrato).not.toContain('09:42');
        expect(registrato).not.toContain(A.cognome);
    });

    it('(h) una POST che risponde 403 (4xx diverso da 422) va in coda e lascia traccia a livello warn', async () => {
        rispostaPost = { status: 403, corpo: { error: 'Vietato' } };
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        await waitFor(() => expect(h.coda.get(`${A.id}|${OGGI}`)).toBeDefined());
        expect(postAppello()).toHaveLength(1);
        const chiamata = h.logClient.mock.calls
            .map(([e]) => e as Record<string, unknown>)
            .find((e) => String(e.messaggio).startsWith('appello-primaria-salvataggio-accodato'));
        expect(chiamata).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'appello-primaria-salvataggio-accodato: risposta-non-ok',
            route: '/teacher/primaria/appello',
            stato: 403,
        });
        const registrato = JSON.stringify(h.logClient.mock.calls);
        expect(registrato).not.toContain('Terapia');
        expect(registrato).not.toContain(A.cognome);
    });

    it('(h) una POST che non parte (rete) va in coda e lascia traccia a livello error, senza stato', async () => {
        await apri();
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: { method?: string }) =>
            String(url).includes('/api/primaria/appello') && init?.method === 'POST'
                ? Promise.reject(new TypeError('Failed to fetch'))
                : base(url, init));
        fireEvent.click(bottoneStato(B, 'Uscita'));
        await screen.findByRole('dialog');
        fireEvent.click(salva());

        await waitFor(() => expect(h.coda.get(`${B.id}|${OGGI}`)).toBeDefined());
        const chiamata = h.logClient.mock.calls
            .map(([e]) => e as Record<string, unknown>)
            .find((e) => String(e.messaggio).startsWith('appello-primaria-salvataggio-accodato'));
        expect(chiamata).toMatchObject({ livello: 'error', evento: 'fetch', messaggio: 'appello-primaria-salvataggio-accodato: TypeError' });
        expect(chiamata).not.toHaveProperty('stato');
    });

    it('(h) senza rete il cambio va in coda CON orario, flag e nota', async () => {
        Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
        await apri();
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        await waitFor(() => expect(h.coda.get(`${A.id}|${OGGI}`)).toBeDefined());
        expect(h.coda.get(`${A.id}|${OGGI}`)).toMatchObject({
            alunno_id: A.id,
            section_id: SEZIONE,
            data: OGGI,
            stato: 'ritardo',
            orario_entrata: '09:42',
            note_appello: 'Terapia',
            assenza_oraria_giustificata: true,
            sync_status: 'pending',
        });
        expect(h.coda.get(`${A.id}|${OGGI}`)).not.toHaveProperty('orario_uscita');
        expect(postAppello()).toHaveLength(0);
    });

    it('(i) un 422 del server non va in coda: si dice il motivo e si rilegge l\'elenco', async () => {
        rispostaPost = {
            status: 422,
            corpo: { error: 'Per giustificare…', codice: 'GIUSTIFICAZIONE_SENZA_NOTA' },
        };
        await apri();
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain(`${A.cognome} ${A.nome}`);
        expect(avviso.textContent).toMatch(/serve una nota/);
        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));
        expect(h.coda.size).toBe(0);
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            messaggio: 'appello-primaria-salvataggio-rifiutato',
            stato: 422,
            campi: { error_code: 'GIUSTIFICAZIONE_SENZA_NOTA' },
        }));
        // Nel log non entra la nota.
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Terapia');
    });

    it('(i) 422 GIUSTIFICAZIONE_STATO_NON_AMMESSO: un motivo DIVERSO da quello della nota', async () => {
        // I due rifiuti del contratto A3 hanno due rimedi diversi: scambiarli direbbe al
        // docente di scrivere una nota che ha già scritto.
        rispostaPost = {
            status: 422,
            corpo: { error: 'Si giustifica solo…', codice: 'GIUSTIFICAZIONE_STATO_NON_AMMESSO' },
        };
        await apri();
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        fireEvent.click(bottoneStato(B, 'Uscita'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain(`${B.cognome} ${B.nome}`);
        expect(avviso.textContent).toContain('Si possono giustificare solo');
        expect(avviso.textContent).not.toMatch(/serve una nota/);
        expect(avviso.textContent).not.toMatch(/Controlla i dati e riprova/);
        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));
        expect(h.coda.size).toBe(0);
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
            messaggio: 'appello-primaria-salvataggio-rifiutato',
            stato: 422,
            campi: { error_code: 'GIUSTIFICAZIONE_STATO_NON_AMMESSO' },
        }));
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Terapia');
    });

    it('(i) l\'avviso del 422 riguarda il suo giorno: cambiando data sparisce', async () => {
        rispostaPost = {
            status: 422,
            corpo: { error: 'Per giustificare…', codice: 'GIUSTIFICAZIONE_SENZA_NOTA' },
        };
        await apri();
        const getPrima = chiamate('GET', '/api/primaria/appello').length;
        fireEvent.click(bottoneStato(A, 'Ritardo'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());

        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toMatch(/serve una nota/);
        // La rilettura dopo il rifiuto è finita: da qui in poi l'elenco cambia solo col giorno.
        await waitFor(() => expect(chiamate('GET', '/api/primaria/appello').length).toBeGreaterThan(getPrima));

        // Il giorno prima ha un altro elenco: la sua PRESENZA dice che il cambio è avvenuto.
        const C = { id: 'cccc3333-0000-4000-8000-000000000003', nome: 'Terzo', cognome: 'Collega' };
        righeGet = [riga(C)];
        fireEvent.change(screen.getByRole('textbox', { name: 'Data dell’appello' }), { target: { value: '06/09/2026' } });
        await waitFor(() => expect(chiamate('GET', 'data=2026-09-06').length).toBeGreaterThan(0));
        await screen.findByText(`${C.cognome} ${C.nome}`);

        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText(/serve una nota/)).toBeNull();
    });

    it('(k) «Annulla» che ripristina la comunicazione del genitore azzera la nota: la finestra non la ripropone', async () => {
        // Il caso d'uso: il genitore aveva comunicato l'assenza, il bambino arriva tardi
        // dopo la terapia, il docente segna un ritardo giustificato e poi lo annulla. Sul
        // server `annullaAppelloAlunno` scrive `note_appello: null` (annulla-appello.ts):
        // a schermo la nota non deve sopravvivere, o «Salva» la riscriverebbe.
        righeGet = [
            riga(A, {
                stato: 'ritardo',
                orario_entrata: '2026-09-07T06:05:00+00:00',
                note_appello: 'Terapia',
                assenza_oraria_giustificata: true,
                giustificata: true,
                appello_fatto: true,
            }),
            riga(B),
        ];
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
            if (String(url).includes('/api/primaria/appello') && init?.method === 'DELETE') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ success: true, esito: 'ripristinata-comunicazione', presenza: { id: 'pres-aaaa', stato: 'assente' } }),
                });
            }
            return base(url, init);
        });

        try {
            await apri();
            expect(within(rigaDi(A)).getByText('Giustificato: Terapia')).toBeInTheDocument();
            const annullaAppello = () => document.querySelector(`#btn-annulla-appello-${A.id}`) as HTMLButtonElement | null;
            await waitFor(() => expect(annullaAppello()).not.toBeNull());
            fireEvent.click(annullaAppello()!);

            // Si aspetta la PRESENZA dell'avviso di ripristino, non l'assenza di qualcosa.
            await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('resta l’assenza comunicata dal genitore'));
            expect(chiamate('DELETE', '/api/primaria/appello')).toHaveLength(1);
            expect(bottoneStato(A, 'Assente').className).toContain('bg-kidville-error');

            fireEvent.click(bottoneStato(A, 'Ritardo'));
            await screen.findByRole('dialog');
            expect(campoNota().value).toBe('');
            expect(spunta().checked).toBe(false);

            // «Salva» senza toccare niente: la nota tolta dall'annullamento NON torna.
            fireEvent.click(salva());
            await waitFor(() => expect(postAppello()).toHaveLength(1));
            const corpo = corpoDi(postAppello()[0]);
            expect(corpo).toMatchObject({ alunnoId: A.id, stato: 'ritardo', orarioEntrata: '09:42', assenzaOrariaGiustificata: false });
            expect(corpo.noteAppello).toBeNull();
        } finally {
            confirmSpy.mockRestore();
        }
    });

    it('(j) la segreteria usa la stessa pagina: finestra e POST identiche', async () => {
        await apri(AppelloSegreteriaPage);
        fireEvent.click(bottoneStato(A, 'Uscita'));
        await screen.findByRole('dialog');
        fireEvent.click(spunta());
        fireEvent.change(campoNota(), { target: { value: 'Terapia' } });
        fireEvent.click(salva());
        await waitFor(() => expect(postAppello()).toHaveLength(1));
        expect(corpoDi(postAppello()[0])).toMatchObject({
            stato: 'uscita_anticipata', orarioUscita: '09:42', assenzaOrariaGiustificata: true, noteAppello: 'Terapia',
        });
    });
});
