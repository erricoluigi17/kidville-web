import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

/**
 * La pagina «Comunica un'assenza» del genitore (nido · infanzia · primaria).
 *
 * ─── COS'ERA, PRIMA DI QUESTO TEST ──────────────────────────────────────────
 * Un modulo CIECO: si compilava, si inviava, e da lì in poi non si vedeva più
 * niente. Nessun elenco di ciò che si era comunicato, nessun modo di ritirare
 * una comunicazione sbagliata, nessuno stato di caricamento, nessun messaggio
 * quando la lettura falliva. E un difetto di FUSO alla riga 16
 * (`new Date().toISOString().slice(0, 10)`, cioè UTC) che fra mezzanotte e le
 * due del mattino italiane proponeva IERI come primo giorno selezionabile — una
 * data che il server, che ora la valida, rifiuta.
 *
 * I test qui sotto misurano il comportamento a schermo, non l'implementazione:
 * il testo che il genitore legge, l'URL che parte davvero, e il nome accessibile
 * del bottone che annulla (un «Annulla» nudo, ripetuto tre volte, per chi usa
 * uno screen reader è tre volte la stessa parola su tre assenze diverse).
 */

const stub = vi.hoisted(() => ({
    pathname: '/parent/attendance',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

/**
 * next-intl con il formattatore VERO (`use-intl`, la libreria che gli sta sotto),
 * al posto del mock globale di `test/setup.ts`.
 *
 * Non è pignoleria: il mock globale risolve `t('chiave')` sulla stringa GREZZA e
 * IGNORA i valori. Con quello, `t('attendanceAnnullaAria', { data })` renderebbe
 * «Annulla l'assenza comunicata per il {data}» — un'etichetta accessibile che
 * dice a tutti la stessa cosa, cioè esattamente il difetto che questo file deve
 * impedire, e che sarebbe passato per verde.
 */
vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl');
    const messaggi = {
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
        common: (await import('../../messages/it/common.json')).default,
    };
    const traduttore = (ns?: string) =>
        createTranslator({
            locale: 'it',
            messages: messaggi as never,
            namespace: ns as never,
            // Un namespace non caricato qui non deve far esplodere il render: si
            // ripiega su «ns.chiave», come fa il mock globale.
            onError: () => {},
            getMessageFallback: ({ namespace, key }: { namespace?: string; key: string }) =>
                namespace ? `${namespace}.${key}` : key,
        });
    return {
        useTranslations: (ns?: string) => traduttore(ns),
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}));

/** Identità del genitore: mutabile, così un test può provare il caso «non pronta». */
const identita = vi.hoisted(() => ({
    parentId: 'p-1' as string | null,
    studentId: 's-1' as string | null,
    ready: true,
}));

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: identita.parentId,
        studentId: identita.studentId,
        figliIds: identita.studentId ? [identita.studentId] : [],
        ready: identita.ready,
    }),
}));

import ParentAttendancePage from '@/app/(dashboard)/parent/attendance/page';

const fetchMock = vi.fn();

/**
 * Una risposta della GET /api/parent/presenze con l'elenco `comunicate`.
 *
 * `comunicateLette` è il flag additivo con cui il server DICHIARA se l'elenco è
 * stato letto davvero: la sua query può fallire lasciando la risposta un 200
 * valido con `comunicate: []`, e senza il flag questa pagina non ha modo di
 * distinguere «non ne hai» da «non sono riuscito a leggerle».
 */
function presenzeCon(comunicate: unknown[], comunicateLette = true) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            success: true,
            data: {
                schoolType: 'infanzia',
                oggi: { stato: null, orario_entrata: null, orario_uscita: null },
                riepilogo: { from: '2026-07-12', to: '2026-08-11', presenze: 0, assenze: 0, ritardi: 0, uscite: 0 },
                comunicate,
                comunicateLette,
            },
        }),
    };
}

/** La stessa risposta di un server che il flag non lo manda ANCORA. */
function presenzeSenzaFlag(comunicate: unknown[]) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            success: true,
            data: {
                schoolType: 'infanzia',
                oggi: { stato: null, orario_entrata: null, orario_uscita: null },
                riepilogo: { from: '2026-07-12', to: '2026-08-11', presenze: 0, assenze: 0, ritardi: 0, uscite: 0 },
                comunicate,
            },
        }),
    };
}

function rispostaErrore(status: number, corpo: Record<string, unknown>) {
    return { ok: false, status, json: async () => corpo };
}

const VOCI = [
    { id: 'pr-1', data: '2026-08-12', giustificazione_testo: 'Visita medica', stato: 'assente' },
    { id: 'pr-2', data: '2026-08-13', giustificazione_testo: null, stato: 'assente' },
];

beforeEach(() => {
    vi.clearAllMocks();
    identita.parentId = 'p-1';
    identita.studentId = 's-1';
    identita.ready = true;
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. IL FUSO. Il primo giorno selezionabile è oggi IN ITALIA, non in UTC.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — la data proposta è quella italiana', () => {
    it('alle 00:30 di Roma (22:30Z del giorno prima) propone e ammette l\'11, non il 10', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-10T22:30:00Z'));
        fetchMock.mockResolvedValue(presenzeCon([]));

        render(<ParentAttendancePage />);

        const campo = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);
        // `min` in UTC direbbe 2026-08-10: un giorno che il server rifiuta con
        // ASSENZA_DATA_PASSATA, proposto dal modulo stesso come primo valido.
        expect(campo).toHaveAttribute('min', '2026-08-11');
        expect(campo).toHaveValue('2026-08-11');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GLI STATI: caricamento, elenco, vuoto, errore.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — elenco delle assenze già comunicate', () => {
    it('mostra le assenze comunicate, con la data e il motivo', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);

        expect(await screen.findByText('12/08/2026')).toBeInTheDocument();
        expect(screen.getByText('13/08/2026')).toBeInTheDocument();
        // Il motivo è del genitore e a lui si mostra (nei LOG invece non entra mai).
        expect(screen.getByText(/Visita medica/)).toBeInTheDocument();
    });

    it('la lettura passa dalla GET /api/parent/presenze del figlio, con l\'identità', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toContain('/api/parent/presenze?');
        expect(url).toContain('studentId=s-1');
        expect((init?.headers as Record<string, string>)['x-user-id']).toBe('p-1');
    });

    it('finché la risposta non arriva dichiara che sta caricando (niente schermata muta)', async () => {
        let sblocca: (v: unknown) => void = () => {};
        fetchMock.mockReturnValue(new Promise((res) => { sblocca = res; }));

        render(<ParentAttendancePage />);

        expect(await screen.findByText(/Caricamento/i)).toBeInTheDocument();
        sblocca(presenzeCon([]));
    });

    it('nessuna assenza comunicata → lo dice, non lascia il vuoto', async () => {
        fetchMock.mockResolvedValue(presenzeCon([]));

        render(<ParentAttendancePage />);

        expect(await screen.findByText(/Non hai comunicato nessuna assenza/i)).toBeInTheDocument();
    });

    it('lettura fallita → messaggio d\'errore e possibilità di riprovare (non una lista vuota)', async () => {
        fetchMock.mockResolvedValue(rispostaErrore(500, { error: 'boom' }));

        render(<ParentAttendancePage />);

        // «Nessuna assenza» sarebbe una BUGIA: il genitore ne avrebbe e non lo saprebbe.
        expect(await screen.findByText(/Non è stato possibile caricare/i)).toBeInTheDocument();
        expect(screen.queryByText(/Non hai comunicato nessuna assenza/i)).not.toBeInTheDocument();

        fetchMock.mockResolvedValue(presenzeCon(VOCI));
        fireEvent.click(screen.getByRole('button', { name: /riprova/i }));

        expect(await screen.findByText('12/08/2026')).toBeInTheDocument();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // IL 200 CHE MENTE. La GET degrada a `comunicate: []` quando la sua query
    // fallisce — scelta giusta, la home non deve rompersi per un elenco
    // accessorio — ma la risposta resta formalmente valida. Il ramo d'errore qui
    // sopra c'era già e funzionava; su QUESTO guasto non veniva mai raggiunto, e
    // il genitore leggeva «Non hai comunicato nessuna assenza» avendone.
    // ─────────────────────────────────────────────────────────────────────────
    it('200 ma il server dichiara di NON aver letto l\'elenco → errore e Riprova, non «non ne hai»', async () => {
        fetchMock.mockResolvedValue(presenzeCon([], false));

        render(<ParentAttendancePage />);

        expect(await screen.findByText(/Non è stato possibile caricare/i)).toBeInTheDocument();
        expect(screen.queryByText(/Non hai comunicato nessuna assenza/i)).not.toBeInTheDocument();

        // E si riprova come dall'errore di rete: la via d'uscita è la stessa.
        fetchMock.mockResolvedValue(presenzeCon(VOCI));
        fireEvent.click(screen.getByRole('button', { name: /riprova/i }));

        expect(await screen.findByText('12/08/2026')).toBeInTheDocument();
    });

    it('un server che il flag non lo manda ancora NON produce un errore inventato', async () => {
        // Rilascio a scaglioni, o app installata prima del server: `comunicateLette`
        // arriva `undefined`. «Non lo dichiara» non è «dichiara di no» — leggerlo
        // come un guasto trasformerebbe ogni risposta buona in un allarme.
        fetchMock.mockResolvedValue(presenzeSenzaFlag(VOCI));

        render(<ParentAttendancePage />);

        expect(await screen.findByText('12/08/2026')).toBeInTheDocument();
        expect(screen.queryByText(/Non è stato possibile caricare/i)).not.toBeInTheDocument();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. L'ANNULLAMENTO.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — annullare una comunicazione', () => {
    it('il bottone Annulla chiama DELETE con l\'alunno e la data, e ricarica l\'elenco', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
            return Promise.resolve(presenzeCon([VOCI[1]]));
        });

        fireEvent.click(screen.getByRole('button', { name: /annulla.*12\/08\/2026/i }));

        await waitFor(() => {
            const del = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE');
            expect(del, 'nessuna DELETE partita').toBeTruthy();
            const [url, init] = del as [string, RequestInit];
            expect(url).toContain('/api/parent/presenze/comunica-assenza');
            expect(url).toContain('studentId=s-1');
            expect(url).toContain('data=2026-08-12');
            expect((init.headers as Record<string, string>)['x-user-id']).toBe('p-1');
        });

        // Ricaricato: la voce annullata sparisce, l'altra resta.
        await waitFor(() => expect(screen.queryByText('12/08/2026')).not.toBeInTheDocument());
        expect(screen.getByText('13/08/2026')).toBeInTheDocument();
    });

    it('cancellazione fallita sul server (500 + ASSENZA_NON_ANNULLATA) → la frase del catalogo, non «annullata»', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                return Promise.resolve(rispostaErrore(500, { error: 'Errore interno', codice: 'ASSENZA_NON_ANNULLATA' }));
            }
            return Promise.resolve(presenzeCon(VOCI));
        });

        fireEvent.click(screen.getByRole('button', { name: /annulla.*12\/08\/2026/i }));

        // Il punto: l'assenza è ANCORA registrata, e il genitore deve saperlo.
        expect(await screen.findByText(/l['’]assenza è ancora registrata/i)).toBeInTheDocument();
        expect(screen.queryByText(/^Assenza annullata\.$/)).not.toBeInTheDocument();
    });

    it('appello già fatto (409 + codice) → la frase del CATALOGO, e la voce resta in elenco', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                return Promise.resolve(rispostaErrore(409, {
                    error: 'Assenza già registrata dal docente',
                    codice: 'ASSENZA_GIA_REGISTRATA',
                }));
            }
            return Promise.resolve(presenzeCon(VOCI));
        });

        fireEvent.click(screen.getByRole('button', { name: /annulla.*12\/08\/2026/i }));

        expect(await screen.findByText(/L['’]insegnante ha già registrato la presenza/i)).toBeInTheDocument();
        // La prosa del server non si mostra MAI nelle schermate famiglia (T10-F1).
        expect(screen.queryByText(/Assenza già registrata dal docente/)).not.toBeInTheDocument();
        // Il rifiuto non cancella niente: la voce è ancora lì.
        expect(screen.getByText('12/08/2026')).toBeInTheDocument();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ACCESSIBILITÀ.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — accessibilità', () => {
    it('le etichette sono ASSOCIATE ai campi (htmlFor/id), non solo scritte sopra', async () => {
        fetchMock.mockResolvedValue(presenzeCon([]));

        render(<ParentAttendancePage />);

        const giorno = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);
        expect(giorno.tagName).toBe('INPUT');
        const motivo = screen.getByLabelText(/^Motivo/i);
        expect(motivo.tagName).toBe('TEXTAREA');
    });

    it('ogni «Annulla» dice QUALE assenza annulla', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        // Due bottoni omonimi sono, per uno screen reader, la stessa voce due volte.
        const bottoni = screen.getAllByRole('button', { name: /annulla/i });
        const nomi = bottoni.map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
        expect(nomi.some((n) => n.includes('12/08/2026'))).toBe(true);
        expect(nomi.some((n) => n.includes('13/08/2026'))).toBe(true);
    });

    it('annullata la riga, il FUOCO non finisce nel vuoto: va sull\'esito', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
            return Promise.resolve(presenzeCon([VOCI[1]]));
        });

        // Chi naviga da tastiera arriva sul bottone col Tab e lo attiva con Invio:
        // il fuoco è SUL bottone quando parte l'azione. `fireEvent.click` non
        // sposta il fuoco da solo, quindi lo si mette dove sarebbe davvero.
        const bottone = screen.getByRole('button', { name: /annulla.*12\/08\/2026/i });
        bottone.focus();
        expect(document.activeElement).toBe(bottone);

        fireEvent.click(bottone);

        // La riga sparisce, e con lei il bottone che teneva il fuoco: senza un
        // ricovero il fuoco torna su `<body>` — chi usa la tastiera riparte dal
        // primo elemento della pagina, chi usa uno screen reader perde il posto
        // e non sente mai l'esito (WCAG 2.4.3, stesso motivo per cui `Modal.tsx`
        // ripristina il fuoco alla chiusura).
        await waitFor(() => expect(screen.queryByText('12/08/2026')).not.toBeInTheDocument());
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body);
            expect(document.activeElement?.textContent).toMatch(/Assenza annullata/i);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4-bis. LA CONFERMA D'INVIO — il ramo che è rimasto indietro.
//
// Quando l'invio riesce, la pagina si TRASFORMA nella schermata di conferma. Chi
// usa uno screen reader non sente niente (nessuna live region nel nuovo albero) e
// chi usa la tastiera si ritrova il fuoco su `<body>`, cioè riparte dall'inizio
// della pagina. Il genitore cieco preme «Comunica assenza», sente silenzio, e non
// ha modo di sapere se l'assenza è partita: la tentazione naturale è ripremere.
//
// Non è ignoranza del pattern: lo STESSO file lo applica correttamente
// all'ANNULLAMENTO (test qui sopra, «il FUOCO non finisce nel vuoto»), con tanto
// di commento che cita WCAG 2.4.3 e `Modal.tsx`. Il ramo dell'invio è rimasto
// quello di prima. Qui si misura che sia stato riportato allo stesso standard:
// WCAG 4.1.3 (messaggi di stato), 2.4.3 (ordine di focus), 1.3.1 (l'`<h1>` della
// pagina non sparisce insieme al PageHeaderCard).
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — la conferma d\'invio si SENTE e non perde il fuoco', () => {
    /** Invia con successo e restituisce il bottone che aveva il fuoco. */
    async function inviaConSuccesso() {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, data: {} }) });
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        // Chi naviga da tastiera arriva sul bottone col Tab e lo attiva con Invio:
        // il fuoco è SUL bottone quando parte l'azione.
        const bottone = screen.getByRole('button', { name: /^Comunica assenza$/i });
        bottone.focus();
        expect(document.activeElement).toBe(bottone);
        fireEvent.click(bottone);
        await screen.findByText(/Assenza comunicata/i);
        return bottone;
    }

    it('l\'esito è in una LIVE REGION: chi non vede lo sente (WCAG 4.1.3)', async () => {
        const { container } = { container: document.body };
        await inviaConSuccesso();

        const viva = container.querySelector('[role="status"],[role="alert"],[aria-live]');
        expect(
            viva,
            'nessuna live region nella schermata di conferma: uno screen reader non annuncia niente',
        ).toBeTruthy();
        expect(viva!.textContent ?? '').toMatch(/Assenza comunicata/i);
    });

    it('il FUOCO non finisce su <body>: va sulla conferma (WCAG 2.4.3)', async () => {
        await inviaConSuccesso();

        await waitFor(() => {
            expect(document.activeElement, 'fuoco su <body>: si riparte dall\'inizio della pagina')
                .not.toBe(document.body);
            expect(document.activeElement?.textContent ?? '').toMatch(/Assenza comunicata/i);
        });
    });

    it('l\'<h1> della pagina resta: la conferma non è una pagina senza titolo (WCAG 1.3.1)', async () => {
        await inviaConSuccesso();

        const h1 = screen.getByRole('heading', { level: 1 });
        expect(h1).toHaveTextContent(/Comunica un['’]assenza/i);
    });

    it('aprendo la pagina il fuoco NON viene rubato, nemmeno con il doppio montaggio di StrictMode', async () => {
        // Il ricovero del fuoco deve scattare solo quando lo stato CAMBIA. Scritto
        // con un flag «primo render» sembrerebbe giusto e non lo è: StrictMode
        // monta, smonta e rimonta, l'effetto gira DUE volte al caricamento e alla
        // seconda il flag è già spento — il fuoco finirebbe sul campo data appena
        // si apre la pagina, e chi usa uno screen reader si ritroverebbe saltati
        // titolo e intestazione. Qui si monta esattamente come fa StrictMode.
        fetchMock.mockResolvedValue(presenzeCon([]));

        render(
            <StrictMode>
                <ParentAttendancePage />
            </StrictMode>,
        );
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        await waitFor(() => {
            expect(
                document.activeElement,
                `il fuoco è stato rubato da <${document.activeElement?.tagName}> al caricamento`,
            ).toBe(document.body);
        });
    });

    it('tornando al modulo il fuoco rientra nel modulo, non su <body>', async () => {
        await inviaConSuccesso();

        const indietro = screen.getByRole('button', { name: /Comunica un.altra assenza/i });
        indietro.focus();
        fireEvent.click(indietro);

        // Il bottone si smonta insieme alla conferma: senza un ricovero il fuoco
        // torna su `<body>`, e chi usa la tastiera deve ri-tabulare tutta la pagina
        // per arrivare al campo che è appena stato riaperto per lui.
        const giorno = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);
        const modulo = giorno.closest('form')!;
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body);
            expect(modulo.contains(document.activeElement)).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // LA REGRESSIONE iOS. Il ricovero del ciclo 2 mandava il fuoco SUL CAMPO
    // DATA. Su WebKit/iOS dare il fuoco a un `<input type="date">` APRE il
    // selettore nativo: un modale a tutto schermo che il genitore non ha
    // chiesto e da cui deve uscire con «Fine». Misurato dal collaudo mobile del
    // 2026-08-07: 2.759 righe `_UICalendarDateViewCell` nel log di sistema, e
    // l'elenco «Assenze già comunicate» non più raggiungibile perché coperto.
    //
    // Nessun test distingueva «fuoco sul campo data» da «fuoco su un
    // contenitore»: è per questo che la regressione è passata. Questo lo fa —
    // e non basta un `not.toBe(document.body)`, che era verde anche col difetto.
    // ─────────────────────────────────────────────────────────────────────────
    it('tornando al modulo il fuoco NON va sul campo data (su iOS aprirebbe il calendario nativo)', async () => {
        await inviaConSuccesso();

        const indietro = screen.getByRole('button', { name: /Comunica un.altra assenza/i });
        indietro.focus();
        fireEvent.click(indietro);

        const giorno = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));

        const attivo = document.activeElement as HTMLElement;
        // I tipi di campo che su WebKit aprono un selettore nativo al solo fuoco.
        const APRONO_UN_PICKER = ['date', 'time', 'datetime-local', 'month', 'week'];
        expect(
            attivo.tagName === 'INPUT' && APRONO_UN_PICKER.includes(attivo.getAttribute('type') ?? ''),
            `il fuoco è finito su <input type="${attivo.getAttribute('type')}">: su iOS questo APRE ` +
            'il selettore nativo a tutto schermo, che il genitore non ha chiesto',
        ).toBe(false);

        // Deve però restare un ricovero UTILE: dentro il modulo, fuori
        // dall'ordine di tabulazione (ci si arriva solo da codice), e PRIMA del
        // campo data — così il primo Tab porta esattamente dove si deve scrivere.
        expect(giorno.closest('form')!.contains(attivo)).toBe(true);
        expect(attivo.tabIndex, 'il ricovero non deve entrare nell\'ordine di tabulazione').toBe(-1);
        expect(
            attivo.compareDocumentPosition(giorno) & Node.DOCUMENT_POSITION_FOLLOWING,
            'il ricovero sta DOPO il campo data: il primo Tab non porterebbe al campo',
        ).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4-quater. IL RIFIUTO DEL SERVER — il ramo rimasto indietro un'altra volta.
//
// Il ciclo 1 ha dato un ricovero al fuoco per gli esiti POSITIVI (invio riuscito,
// annullamento riuscito). Il ramo RIFIUTATO no — cioè proprio il caso in cui
// l'utente ha bisogno di sapere cos'è successo. Misurato dal collaudo del
// 2026-08-07: dopo una POST che risponde 400 ASSENZA_DATA_PASSATA,
// `document.activeElement.tagName === 'BODY'`; idem dopo una DELETE che risponde
// 409. Chi naviga a Tab riparte dall'inizio della pagina (9 tabulazioni) e chi
// usa uno screen reader non arriva mai sul messaggio.
//
// Causa radice: quando React marca `disabled` l'elemento che ha il fuoco, il
// browser lo sfoca e il fuoco cade su `<body>`. I due effetti di ricovero
// esistenti guardano `isSubmitted` e `esitoAnnullamento`; `error` ed
// `erroreAnnullamento` non avevano né ref né effetto.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — il RIFIUTO del server non lascia il fuoco su <body>', () => {
    it('invio rifiutato (400): il fuoco va sul messaggio d\'errore, non su <body>', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(400, {
                    error: 'La data indicata è già passata',
                    codice: 'ASSENZA_DATA_PASSATA',
                }));
            }
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        const bottone = screen.getByRole('button', { name: /^Comunica assenza$/i });
        bottone.focus();
        expect(document.activeElement).toBe(bottone);

        fireEvent.click(bottone);
        await screen.findByText(/Puoi comunicare un['’]assenza solo da oggi in avanti/i);

        await waitFor(() => {
            expect(
                document.activeElement,
                'fuoco su <body>: chi usa la tastiera riparte dall\'inizio della pagina e non sente l\'errore',
            ).not.toBe(document.body);
            expect(document.activeElement?.textContent ?? '').toMatch(/solo da oggi in avanti/i);
        });
        expect((document.activeElement as HTMLElement).tabIndex).toBe(-1);
    });

    it('il campo data si dichiara NON VALIDO e rimanda al messaggio (aria-invalid + aria-describedby)', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(400, {
                    error: 'La data indicata è già passata',
                    codice: 'ASSENZA_DATA_PASSATA',
                }));
            }
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        const giorno = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);
        // Prima del rifiuto il campo NON è marcato: un campo perennemente
        // «non valido» è rumore, e uno screen reader lo annuncerebbe sempre.
        expect(giorno).not.toHaveAttribute('aria-invalid', 'true');

        fireEvent.click(screen.getByRole('button', { name: /^Comunica assenza$/i }));
        await screen.findByText(/solo da oggi in avanti/i);

        await waitFor(() => expect(giorno).toHaveAttribute('aria-invalid', 'true'));
        // `aria-describedby` porta PIÙ id da quando il campo ha anche
        // un'istruzione persistente (WCAG 3.3.2): il messaggio di rifiuto si
        // AGGIUNGE all'istruzione, non la sostituisce — chi ascolta deve sentire
        // sia cosa è ammesso sia perché è stato respinto. Si leggono tutti.
        const descritto = giorno.getAttribute('aria-describedby');
        expect(descritto, 'il campo non rimanda a nessun testo che spieghi il rifiuto').toBeTruthy();
        const descrizioni = descritto!.split(/\s+/).filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
        expect(descrizioni).toMatch(/solo da oggi in avanti/i);
    });

    it('un errore che NON riguarda la data non marca il campo come non valido', async () => {
        // `aria-invalid` su un campo corretto manda l'utente a correggere ciò che
        // non è sbagliato: il guasto era del server (500), non del giorno scelto.
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(500, { error: 'Errore interno', codice: 'ASSENZA_NON_SALVATA' }));
            }
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        const giorno = await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        fireEvent.click(screen.getByRole('button', { name: /^Comunica assenza$/i }));
        await screen.findByText(/Non siamo riusciti a registrare l['’]assenza/i);

        expect(giorno).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('annullamento rifiutato (409): il fuoco va sul messaggio d\'errore, non su <body>', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                return Promise.resolve(rispostaErrore(409, {
                    error: 'Assenza già registrata dal docente',
                    codice: 'ASSENZA_GIA_REGISTRATA',
                }));
            }
            return Promise.resolve(presenzeCon(VOCI));
        });

        const bottone = screen.getByRole('button', { name: /annulla.*12\/08\/2026/i });
        bottone.focus();
        expect(document.activeElement).toBe(bottone);

        fireEvent.click(bottone);
        await screen.findByText(/L['’]insegnante ha già registrato la presenza/i);

        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body);
            expect(document.activeElement?.textContent ?? '').toMatch(/ha già registrato la presenza/i);
        });
        expect((document.activeElement as HTMLElement).tabIndex).toBe(-1);
    });

    it('anche un SECONDO rifiuto identico riporta il fuoco sul messaggio', async () => {
        // Il caso che un effetto legato al solo TESTO dell'errore non coglie:
        // `setError('stessa frase')` non cambia lo stato, e il fuoco resterebbe
        // su <body> proprio a chi sta riprovando.
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(400, {
                    error: 'La data indicata è già passata',
                    codice: 'ASSENZA_DATA_PASSATA',
                }));
            }
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        for (const tentativo of [1, 2]) {
            const bottone = screen.getByRole('button', { name: /^Comunica assenza$/i });
            bottone.focus();
            fireEvent.click(bottone);
            await waitFor(() => {
                expect(document.activeElement, `tentativo ${tentativo}: fuoco su <body>`).not.toBe(document.body);
                expect(document.activeElement?.textContent ?? '').toMatch(/solo da oggi in avanti/i);
            });
            // Si sposta via, come farebbe l'utente che torna sul bottone col Tab.
            (document.activeElement as HTMLElement).blur();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4-ter. IL TELEFONO PICCOLO (320px).
//
// Nell'elenco «Assenze già comunicate», a 320px CSS l'ultima cifra dell'anno
// finisce FISICAMENTE sotto la pillola «Annulla»: `12/08/2026` si legge
// `12/08/202`, e non c'è nemmeno un'ellissi che lo segnali. Misurato dal collaudo
// con CSS e font di produzione: scatola del `<p>` 69px, testo reso 91px, 10px
// coperti; a 280px diventano 50.
//
// La catena: `Btn` porta `whitespace-nowrap` nella sua BASE e non ha `shrink-0`,
// quindi non si restringe mai; la colonna centrale ha `min-w-0 flex-1` e si
// restringe fino a 69px; il `<p>` della data non ha `truncate`, e `12/08/2026`
// non contiene spazi — non può andare a capo, quindi trabocca e il fondo opaco
// del bottone lo copre. La schermata gemella della primaria ha `truncate` +
// `shrink-0` (`ComunicaAssenzaCard.tsx`): la stessa lista, due strutture diverse.
//
// Il rimedio è in due tempi, perché il solo `truncate` mangerebbe l'anno — cioè
// il dato per cui la riga esiste:
//   1. la riga VA A CAPO (`flex-wrap` sul `<li>` + una base ipotetica NON nulla
//      sulla colonna centrale): sotto ~347px la pillola scende sulla seconda
//      linea e alla data restano 166px, cioè tutta intera;
//   2. `truncate` resta la RETE: se un giorno lo spazio mancasse comunque, si
//      degrada con l'ellissi invece di nascondere testo sotto un controllo opaco.
// `flex-1` NON basta ed è la trappola: è `flex: 1 1 0%`, larghezza ipotetica
// ZERO — con quella la riga non va a capo mai, si limita a schiacciare la colonna.
//
// jsdom non impagina, quindi qui non si misurano i pixel: si misurano le quattro
// dichiarazioni che li producono. I pixel li ha misurati il collaudo, e sono nel
// commento del componente.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — a 320px la data non finisce sotto «Annulla»', () => {
    it('la riga va a capo, la data degrada con l\'ellissi e il bottone non si restringe', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        const data = await screen.findByText('12/08/2026');

        expect(
            data.className,
            'il `<p>` della data non ha `truncate`: «12/08/2026» non ha spazi, non va a capo, ' +
            'e a 320px trabocca sotto la pillola «Annulla»',
        ).toMatch(/(^|\s)truncate(\s|$)/);

        const colonna = data.parentElement!;
        expect(
            colonna.className,
            'la colonna centrale ha ancora `flex-1` (base ipotetica 0%): con quella la riga ' +
            'non va a capo MAI, e a 320px la data resta schiacciata a 69px',
        ).not.toMatch(/(^|\s)flex-1(\s|$)/);
        expect(
            colonna.className,
            'alla colonna centrale manca una base ipotetica non nulla (`basis-*`): è ciò che ' +
            'fa scendere la pillola sulla seconda riga quando lo spazio non basta',
        ).toMatch(/(^|\s)basis-\S+(\s|$)/);

        const riga = colonna.closest('li')!;
        expect(
            riga.className,
            'il `<li>` non ha `flex-wrap`: la pillola non può scendere, e la data resta ' +
            'compressa sotto i 91px che le servono',
        ).toMatch(/(^|\s)flex-wrap(\s|$)/);

        const annulla = screen.getByRole('button', { name: /annulla.*12\/08\/2026/i });
        expect(
            annulla.className,
            'il bottone «Annulla» non ha `shrink-0`: `Btn` porta `whitespace-nowrap` nella sua ' +
            'BASE e non si restringe comunque, ma senza `shrink-0` il flex gli assegna una base ' +
            'contrattile e la riga si compone in modo diverso a ogni larghezza',
        ).toMatch(/(^|\s)shrink-0(\s|$)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. GLI ERRORI DELL'INVIO, tradotti dal catalogo.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — invio rifiutato dal server', () => {
    it('400 con codice ASSENZA_DATA_PASSATA → la frase tradotta, mai la prosa del server', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(400, {
                    error: 'La data indicata è già passata',
                    codice: 'ASSENZA_DATA_PASSATA',
                }));
            }
            return Promise.resolve(presenzeCon([]));
        });

        render(<ParentAttendancePage />);
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        fireEvent.click(screen.getByRole('button', { name: /^Comunica assenza$/i }));

        expect(await screen.findByText(/Puoi comunicare un['’]assenza solo da oggi in avanti/i)).toBeInTheDocument();
        expect(screen.queryByText('La data indicata è già passata')).not.toBeInTheDocument();
    });

    it('invio riuscito → conferma, e l\'elenco si aggiorna per quando si torna al modulo', async () => {
        let letture = 0;
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, data: {} }) });
            letture++;
            return Promise.resolve(presenzeCon(letture > 1 ? VOCI : []));
        });

        render(<ParentAttendancePage />);
        await screen.findByLabelText(/^Giorno dell['’]assenza$/i);

        fireEvent.click(screen.getByRole('button', { name: /^Comunica assenza$/i }));
        expect(await screen.findByText(/Assenza comunicata/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Comunica un.altra assenza/i }));
        // L'elenco è stato riletto dopo l'invio: la nuova comunicazione è visibile.
        expect(await screen.findByText('12/08/2026')).toBeInTheDocument();
        expect(letture).toBeGreaterThan(1);
    });

    it('un nuovo invio cancella l\'esito dell\'annullamento precedente (niente messaggi stantii)', async () => {
        fetchMock.mockResolvedValue(presenzeCon(VOCI));

        render(<ParentAttendancePage />);
        await screen.findByText('12/08/2026');

        // 1. Si annulla un'assenza: compare «Assenza annullata.».
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
            return Promise.resolve(presenzeCon([VOCI[1]]));
        });
        fireEvent.click(screen.getByRole('button', { name: /annulla.*12\/08\/2026/i }));
        expect(await screen.findByText(/^Assenza annullata\.$/)).toBeInTheDocument();

        // 2. Si comunica SUBITO una nuova assenza, e questa volta il server rifiuta.
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return Promise.resolve(rispostaErrore(500, { error: 'Errore interno', codice: 'ASSENZA_NON_SALVATA' }));
            }
            return Promise.resolve(presenzeCon([VOCI[1]]));
        });
        fireEvent.click(screen.getByRole('button', { name: /^Comunica assenza$/i }));

        // Il rifiuto tiene il genitore sul modulo, con l'elenco sotto: se
        // «Assenza annullata.» resta lì accanto all'errore appena comparso, le
        // due frasi si riferiscono a due azioni diverse e nessuno può capire
        // quale delle due è andata come dice.
        expect(await screen.findByText(/Non siamo riusciti a registrare l['’]assenza/i)).toBeInTheDocument();
        expect(screen.queryByText(/^Assenza annullata\.$/)).not.toBeInTheDocument();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. IDENTITÀ NON ANCORA PRONTA: non si chiama il backend a vuoto.
// ─────────────────────────────────────────────────────────────────────────────
describe('parent/attendance — identità non pronta', () => {
    it('senza figlio risolto non parte nessuna lettura', async () => {
        identita.ready = false;
        identita.studentId = null;
        fetchMock.mockResolvedValue(presenzeCon([]));

        render(<ParentAttendancePage />);
        await waitFor(() => expect(screen.getByText(/Comunica un['’]assenza/i)).toBeInTheDocument());

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
