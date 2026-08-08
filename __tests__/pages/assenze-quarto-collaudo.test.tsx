import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

// =============================================================================
// «Comunica un'assenza» — il QUARTO collaudo (2026-08-08).
//
// Due bloccanti, e sono **lo stesso difetto misurato due volte**: qualcosa che
// il genitore deve vedere nasce sotto uno strato appiccicato.
//
//  · Q22 — sulla card della primaria il pulsante che INVIA è coperto al 100%
//    dalla bottom-nav (`fixed`, `z-50`): `page.mouse.click(112, 823)` partendo da
//    /parent/primaria/assenze arriva su **/parent/diary**. È letteralmente il
//    difetto chiuso il 07/08 sulla schermata gemella, mai portato sulla porta
//    accanto. La card si difendeva con `pb-24`, che è esattamente il rimedio che
//    il commento della gemella dichiara insufficiente.
//
//  · Q21 — sulla gemella il piede appiccicato che ha chiuso Q22 il 07/08 copre
//    ora il messaggio di RIFIUTO che il piede stesso genera (100% su iPhone
//    14/15/15 Pro, 63% su 16/17 Pro) e la riga che spiega perché il comando è
//    spento (100%). `focus()` scrolla solo ciò che è GEOMETRICAMENTE fuori
//    viewport e non sa niente degli strati appiccicati.
//
// ─── PERCHÉ IL RIMEDIO SCELTO È «I MESSAGGI DENTRO IL PIEDE» ─────────────────
// Le due strade proposte dal rilievo erano `scroll-margin-bottom` sui riquadri
// d'esito, oppure portarli DENTRO il piede sopra al pulsante. Vale la seconda,
// per una ragione misurabile: `scroll-margin-bottom` agisce solo quando il
// browser decide di portare un elemento in vista, cioè **solo su chi riceve il
// fuoco**. La riga di stato (`#attendance-stato-comando`) il fuoco non lo riceve
// mai — è la descrizione del pulsante, non un ricovero — e resterebbe coperta
// esattamente com'era. Dentro il piede, invece, non c'è nessuno stato del mondo
// in cui un messaggio dell'azione possa finire sotto qualcosa: il piede è la
// cosa più in basso che esista, e ciò che sta dentro di lui sta sopra la barra.
//
// Il corollario, ed è la regola che questo file blocca: **tutto ciò che parla
// dell'azione vive nel piede dell'azione**. Ciò che parla del CAMPO (l'avviso
// «svuotare non cancella», Q10) sta sopra il campo, dove l'informazione serve —
// non nella fascia fra il campo e il piede, che è la zona coperta.
//
// Gli altri rilievi chiusi qui: Q10 · Q24 · Q26 · Q27 · Q28.
//
// ⚠️ COSA QUESTO FILE NON PUÒ FARE, DETTO INVECE CHE PROMESSO. jsdom non fa
// layout: `getBoundingClientRect()` è tutto zeri, quindi la SOVRAPPOSIZIONE in
// pixel — che è la misura con cui Q21 e Q22 sono stati trovati — qui non si
// misura, e un test che dicesse di misurarla mentirebbe. Quello che si blocca è
// l'INVARIANTE STRUTTURALE da cui la sovrapposizione discende (il comando e i
// suoi messaggi stanno dentro un ricovero ancorato a `--kv-bottomnav-h`), che è
// la stessa forma già verificata sull'emulatore il 2026-08-08 con 49/49 tocchi a
// segno. La misura dei rettangoli a 390×844 resta al collaudo mobile.
// =============================================================================

const RADICE = process.cwd();

const stub = vi.hoisted(() => ({
    pathname: '/parent/attendance',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}));

/** next-intl col formattatore VERO: qui si misurano frasi che interpolano numeri. */
vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl');
    const messaggi = {
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
        parentAssenze: (await import('../../messages/it/parentAssenze.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
        common: (await import('../../messages/it/common.json')).default,
    };
    const traduttore = (ns?: string) =>
        createTranslator({
            locale: 'it',
            messages: messaggi as never,
            namespace: ns as never,
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

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }));

import ParentAttendancePage from '@/app/(dashboard)/parent/attendance/page';
import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard';
import {
    GIORNI_MASSIMI_IN_ANTICIPO,
    ultimoGiornoComunicabile,
    rifiutoDelGiorno,
} from '@/lib/presenze/finestra-comunicazione';
import itAssenze from '../../messages/it/parentAssenze.json';
import itPrimaria from '../../messages/it/parentPrimaria.json';
import itServizi from '../../messages/it/parentServizi.json';
import itShared from '../../messages/it/shared.json';

/** 22:30 UTC del 10 agosto = 00:30 dell'11 a Roma: «oggi» è l'11. */
const ADESSO = new Date('2026-08-10T22:30:00Z');
const OGGI = '2026-08-11';

const fetchMock = vi.fn();
let comunicate: { id: string; data: string; giustificazione_testo: string | null; stato: string }[];
/** La GET dell'elenco fallisce (Q26). */
let getRotta: boolean;

function corpoPresenze() {
    return {
        success: true,
        data: {
            schoolType: 'infanzia',
            oggi: { stato: null, orario_entrata: null, orario_uscita: null },
            riepilogo: { from: '2026-07-12', to: OGGI, presenze: 0, assenze: 0, ritardi: 0, uscite: 0 },
            comunicate,
            comunicateLette: true,
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ADESSO);
    identita.parentId = 'p-1';
    identita.studentId = 's-1';
    identita.ready = true;
    comunicate = [];
    getRotta = false;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const metodo = init?.method ?? 'GET';
        if (metodo !== 'GET') {
            return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true }) });
        }
        if (getRotta) {
            return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => corpoPresenze() });
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

/** Le POST partite finora. */
const post = () =>
    (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([, i]) => i?.method === 'POST');

/** Il primo antenato `sticky` di un nodo — il «piede» dell'azione. */
function piede(el: HTMLElement): HTMLElement | null {
    let n: HTMLElement | null = el.parentElement;
    while (n && !n.className.split(/\s+/).includes('sticky')) n = n.parentElement;
    return n;
}

/** Monta la card della primaria col modulo APERTO. */
async function cardAperta() {
    render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }));
}

/** Il pulsante d'invio, schermata per schermata. */
const inviaAttendance = () =>
    screen.getByRole('button', {
        name: new RegExp(`^(${itServizi.attendanceComunicaAssenza}|${itServizi.attendanceInvio})$`, 'i'),
    });
const inviaCard = () =>
    screen.getByRole('button', {
        name: new RegExp(`^(${itPrimaria.comunicaInvia}|${itPrimaria.comunicaInvio})$`, 'i'),
    });

// =============================================================================
// Q22 + Q9 — IL PULSANTE DELLA CARD SOTTO LA BARRA DI NAVIGAZIONE.
// =============================================================================
describe('Q22 · anche sulla card della primaria il comando sta APPOGGIATO sopra la barra', () => {
    it('il pulsante d\'invio della card vive in un ricovero ancorato a `--kv-bottomnav-h`', async () => {
        await cardAperta();
        const ricovero = piede(inviaCard());

        expect(
            ricovero,
            'il pulsante che INVIA la comunicazione non è ancorato: a 390×844, modulo appena ' +
                'aperto e senza scorrere, cade dentro la fascia della bottom-nav e un tocco al suo ' +
                'centro apre /parent/diary (misurato: page.mouse.click(112,823))',
        ).not.toBeNull();
        expect(
            ricovero!.className,
            'l\'ancoraggio non usa l\'altezza DICHIARATA della barra: `pb-24` riserva spazio in ' +
                'fondo al documento, mentre il pulsante sta a metà pagina',
        ).toMatch(/bottom-\[var\(--kv-bottomnav-h\)\]/);
        // Sotto la barra (z-50), mai sopra.
        expect(ricovero!.className).toMatch(/(^|\s)z-40(\s|$)/);
        // …e una superficie opaca sua, come la gemella: senza, ciò che passa
        // sotto viene coperto a metà parola dal solo riempimento del bottone.
        expect(ricovero!.className).toMatch(/(^|\s)bg-kidville-\S+/);
    });

    it('e ha lo stesso trattamento visivo della gemella: taglia piena, larghezza piena', async () => {
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);
        const gemella = inviaAttendance().className;
        cleanup();

        await cardAperta();
        const card = inviaCard().className;

        const taglia = (c: string) => c.match(/h-\[?\d+px\]?|h-\d+/)?.[0] ?? '(nessuna)';
        expect(
            taglia(card),
            'la stessa azione primaria è alta 36px di qua e 54px di là: due prodotti per un ' +
                'genitore che ha un figlio per grado',
        ).toBe(taglia(gemella));
        expect(card, 'il comando primario non prende la larghezza piena come sulla gemella').toMatch(
            /(^|\s)w-full(\s|$)/,
        );
    });
});

// =============================================================================
// Q21 + Q23 — IL PIEDE CHE COPRE IL MESSAGGIO CHE IL PIEDE STESSO GENERA.
// =============================================================================
describe('Q21+Q23 · i messaggi dell\'azione vivono DENTRO il piede, sopra al pulsante', () => {
    it('/parent/attendance: il riquadro di RIFIUTO nasce dentro il piede del comando', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        // Il rifiuto più ordinario che questa funzione produca: un giorno passato.
        fireEvent.change(campo, { target: { value: '2020-01-01' } });
        fireEvent.click(inviaAttendance());

        const avviso = await screen.findByRole('alert');
        expect(avviso).toHaveTextContent(itShared.erroreAssenzaDataPassata);
        expect(
            piede(avviso),
            'il messaggio di rifiuto nasce SOTTO il piede appiccicato che contiene il pulsante: ' +
                'misurato a 390×844, 34px di sovrapposizione su 34 — il genitore vedente preme, la ' +
                'schermata non cambia di un pixel, e l\'unica conclusione ragionevole è ripremere',
        ).toBe(piede(inviaAttendance()));
    });

    it('/parent/attendance: la riga che dice perché il comando è spento sta nel piede', async () => {
        identita.studentId = null;
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);

        const riga = screen.getByText(itAssenze.nessunAlunno);
        expect(
            piede(riga),
            'la riga di stato non riceve MAI il fuoco, quindi nessuno `scroll-margin-bottom` la ' +
                'porterà mai in vista: un comando disabilitato senza motivo visibile',
        ).toBe(piede(inviaAttendance()));
    });

    it('card primaria: e anche la riga che dice perché il comando è spento — che qui non c\'era', async () => {
        // Non è un rilievo del collaudo: è la stessa forma cercata sulla porta
        // accanto. La gemella ha questa riga dal terzo ciclo («un pulsante spento
        // e senza spiegazione è solo un no-op più silenzioso»), la card no.
        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), { target: { value: '' } });

        const riga = screen.getByText(itAssenze.giornoMancante);
        expect(riga.closest('[role="status"]'), 'la riga non è annunciata').toBeTruthy();
        expect(piede(riga)).toBe(piede(inviaCard()));
        // …e il motivo del blocco è LEGATO al comando, non solo scritto accanto.
        const ids = (inviaCard().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        expect(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain(
            itAssenze.giornoMancante,
        );
    });

    it('card primaria: anche qui il rifiuto nasce dentro il piede', async () => {
        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), {
            target: { value: '2020-01-01' },
        });
        fireEvent.click(inviaCard());

        const avviso = await screen.findByRole('alert');
        expect(
            piede(avviso),
            'sulla primaria il riquadro di rifiuto cade a y=794→844 ed è coperto al 100% dalla ' +
                'bottom-nav: il fuoco ci arriva, ma atterra su un testo che nessuno può leggere',
        ).toBe(piede(inviaCard()));
    });

    it('e in nessuna delle due il fuoco finisce su <body> dopo un rifiuto', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        fireEvent.change(campo, { target: { value: '2020-01-01' } });
        fireEvent.click(inviaAttendance());
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        expect((document.activeElement as HTMLElement).getAttribute('role')).toBe('alert');
        cleanup();

        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), {
            target: { value: '2020-01-01' },
        });
        fireEvent.click(inviaCard());
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        expect((document.activeElement as HTMLElement).getAttribute('role')).toBe('alert');
    });
});

// =============================================================================
// Q10 — L'AVVISO SUL MOTIVO NASCE NELLA FASCIA COPERTA.
// =============================================================================
describe('Q10 · «il motivo resta anche svuotando il campo» si legge senza scorrere', () => {
    beforeEach(() => {
        comunicate = [{ id: 'g-1', data: OGGI, giustificazione_testo: 'Visita medica', stato: 'assente' }];
    });

    it('/parent/attendance: l\'avviso sta SOPRA il campo, non fra il campo e il piede', async () => {
        render(<ParentAttendancePage />);
        const motivo = await screen.findByDisplayValue('Visita medica');
        fireEvent.change(motivo, { target: { value: '' } });

        const avviso = await screen.findByText(itAssenze.motivoNonCancellabile);
        expect(
            avviso.compareDocumentPosition(motivo) & Node.DOCUMENT_POSITION_FOLLOWING,
            'l\'avviso nasce sotto la textarea, cioè nella fascia che il piede appiccicato copre: ' +
                'misurato a 390×844, dei suoi 82px zero sono visibili e non ostruiti. E compare in ' +
                'reazione a un gesto fatto GUARDANDO il campo: nessuno ha motivo di scorrere.',
        ).toBeTruthy();
        // …e non è finito nel piede: parla del CAMPO, non dell'azione.
        expect(piede(avviso)).toBeNull();
    });

    it('card primaria: stessa posizione, stessa ragione', async () => {
        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), { target: { value: OGGI } });
        const motivo = screen.getByLabelText(itPrimaria.comunicaMotivoLabel);
        expect(motivo).toHaveValue('Visita medica');
        fireEvent.change(motivo, { target: { value: '' } });

        const avviso = await screen.findByText(itAssenze.motivoNonCancellabile);
        expect(
            avviso.compareDocumentPosition(motivo) & Node.DOCUMENT_POSITION_FOLLOWING,
            'la card ripete la posizione della gemella: l\'avviso sotto il campo, cioè sotto la barra',
        ).toBeTruthy();
    });
});

// =============================================================================
// Q24 — IL CAMPO RESTA «NON VALIDO» DOPO CHE IL GENITORE HA CORRETTO.
// =============================================================================
describe('Q24 · correggere il giorno toglie il marchio di non valido', () => {
    it('/parent/attendance: dopo il rifiuto `aria-invalid` c\'è, e sparisce alla correzione', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        fireEvent.change(campo, { target: { value: '2020-01-01' } });
        fireEvent.click(inviaAttendance());
        await screen.findByRole('alert');

        // CONTROLLO POSITIVO: il campo si dichiara non valido, ed è giusto.
        expect(campo).toHaveAttribute('aria-invalid', 'true');

        fireEvent.change(campo, { target: { value: '2026-08-20' } });

        expect(
            campo.getAttribute('aria-invalid'),
            'il campo continua a dirsi non valido su un valore giusto, e a rimandare a un errore ' +
                'che il genitore ha già risolto: chi usa uno screen reader torna sul campo e sente ' +
                '«non valido» (WCAG 4.1.2 e 3.3.1)',
        ).toBeNull();
        expect(
            screen.queryByText(itShared.erroreAssenzaDataPassata),
            'il messaggio di rifiuto resta a schermo dopo la correzione: descrive un errore che non c\'è più',
        ).not.toBeInTheDocument();
    });

    it('card primaria: il rifiuto sulla data marca il campo e la correzione lo libera', async () => {
        await cardAperta();
        const campo = screen.getByLabelText(itPrimaria.comunicaDataLabel);
        fireEvent.change(campo, { target: { value: '2020-01-01' } });
        fireEvent.click(inviaCard());
        await screen.findByRole('alert');

        expect(
            campo,
            'la card non marca affatto il campo: la stessa diagnosi, su due schermate, in due modi',
        ).toHaveAttribute('aria-invalid', 'true');

        fireEvent.change(campo, { target: { value: '2026-08-20' } });
        expect(campo.getAttribute('aria-invalid')).toBeNull();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

// =============================================================================
// Q26 — L'ELENCO ROTTO SENZA VIA D'USCITA.
// =============================================================================
describe('Q26 · quando l\'elenco non si legge, ENTRAMBE offrono un «Riprova»', () => {
    it('la card mostra un comando di ricarica accanto all\'errore, e rilegge davvero', async () => {
        getRotta = true;
        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
        await act(async () => {});
        expect(await screen.findByText(itPrimaria.comunicaElencoNonLetto)).toBeInTheDocument();

        const riprova = screen.getByRole('button', { name: new RegExp(`^${itAssenze.riprova}$`, 'i') });
        expect(
            riprova,
            'la card dice che non ce l\'ha fatta e non offre nessun modo di riprovare: l\'unica ' +
                'uscita è ricaricare la pagina a mano — e finché l\'elenco manca, le assenze già ' +
                'comunicate non sono annullabili',
        ).toBeInTheDocument();

        // …e ripara per davvero: il guasto sparisce, l'elenco compare.
        getRotta = false;
        comunicate = [{ id: 'r-1', data: '2026-08-20', giustificazione_testo: null, stato: 'assente' }];
        fireEvent.click(riprova);
        expect(await screen.findByText('20/08/2026')).toBeInTheDocument();
        expect(screen.queryByText(itPrimaria.comunicaElencoNonLetto)).not.toBeInTheDocument();
    });

    it('CONTROLLO POSITIVO: la gemella ce l\'ha già, e il confronto è quello', async () => {
        getRotta = true;
        render(<ParentAttendancePage />);
        expect(await screen.findByText(itServizi.attendanceElencoErrore)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: new RegExp(itServizi.attendanceRiprova, 'i') })).toBeInTheDocument();
    });
});

// =============================================================================
// Q27 — LA GUARDIA SULLA DATA PASSATA SU UNA SOLA DELLE DUE PORTE.
// =============================================================================
describe('Q27 · nessuna delle due schermate manda al server un giorno che sa già rifiutato', () => {
    it('card primaria: con una data passata forzata nel campo, NESSUNA POST parte', async () => {
        await cardAperta();
        // È ciò che fa il selettore nativo di iOS, che `min` non lo rispetta: il
        // valore entra nel campo con `input`/`change`, esattamente come qui.
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), {
            target: { value: '2026-01-15' },
        });
        fireEvent.click(inviaCard());

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(
            post(),
            'la richiesta esce dal dispositivo per farsi rifiutare: consuma il budget del tetto di ' +
                'frequenza e il genitore scopre l\'errore solo dopo un giro di rete',
        ).toHaveLength(0);
        expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAssenzaDataPassata);
    });

    it('e nemmeno un giorno OLTRE il tetto dei 60 giorni: vale per tutte e due', async () => {
        const oltre = ultimoGiornoComunicabile(OGGI).replace(/\d{2}$/, (d) => String(Number(d) + 1).padStart(2, '0'));
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        fireEvent.change(campo, { target: { value: oltre } });
        fireEvent.click(inviaAttendance());
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(post(), '/parent/attendance manda al server una data che il server rifiuta').toHaveLength(0);
        cleanup();

        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), { target: { value: oltre } });
        fireEvent.click(inviaCard());
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(post()).toHaveLength(0);
    });

    it('CONTROLLO POSITIVO: un giorno DENTRO la finestra parte eccome', async () => {
        await cardAperta();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), {
            target: { value: ultimoGiornoComunicabile(OGGI) },
        });
        fireEvent.click(inviaCard());
        await waitFor(() => expect(post()).toHaveLength(1));
    });
});

// =============================================================================
// Q28 — IL CAMPO DICHIARA IL PAVIMENTO E NON IL SOFFITTO.
// =============================================================================
describe('Q28 · il campo del giorno dichiara l\'intervallo INTERO, e l\'aiuto lo dice', () => {
    it('il tetto vive in UN POSTO SOLO: la route non ne dichiara una copia propria', () => {
        // ─────────────────────────────────────────────────────────────────────
        // QUESTA PROVA È CAMBIATA IL 2026-08-08, ED È IL PUNTO.
        //
        // Prima leggeva il sorgente della route e verificava che i DUE numeri
        // coincidessero. Era una difesa vera, e ha fatto il suo lavoro — ma
        // ammetteva l'esistenza di due copie invece di toglierla, e prima o poi
        // qualcuno avrebbe cambiato il numero di là, visto il rosso, e aggiornato
        // il lock. È esattamente la forma di difetto che questo intero ciclo ha
        // inseguito per tre giri: una regola valida per più strade applicata alla
        // strada in cui era stata misurata.
        //
        // Ora la route IMPORTA il numero da `@/lib/presenze/finestra-comunicazione`
        // e lo ri-esporta (i suoi test lo leggono da lì, ed è giusto che lo
        // leggano dalla rotta che lo applica). Non c'è più niente da tenere
        // allineato: c'è una definizione sola, e questa prova verifica che resti
        // sola.
        // ─────────────────────────────────────────────────────────────────────
        const route = fs.readFileSync(
            path.join(RADICE, 'src', 'app', 'api', 'parent', 'presenze', 'comunica-assenza', 'route.ts'),
            'utf8',
        );
        // `GIORNI_MASSIMI\w*` e non il nome esatto: la prima stesura di questa prova
        // cercava solo `GIORNI_MASSIMI_IN_ANTICIPO`, e una copia battezzata
        // `GIORNI_MASSIMI_IN_ANTICIPO_COPIA` le passava sotto il naso — verificato
        // mutando il sorgente, non dedotto. Una difesa che si aggira cambiando il
        // nome della variabile non è una difesa.
        const dichiarazionePropria = route.match(/(?:const|let|var)\s+GIORNI_MASSIMI\w*\s*=\s*\d+/);
        expect(
            dichiarazionePropria,
            'La route ha ricominciato a dichiarare il proprio `GIORNI_MASSIMI_IN_ANTICIPO`. ' +
                'Due numeri per lo stesso tetto divergono al primo ritocco, e il genitore si ' +
                'ritrova un calendario più largo di quello che il server accetta: importalo da ' +
                '`@/lib/presenze/finestra-comunicazione`, che è il posto unico.',
        ).toBeNull();
        expect(
            route.includes("from '@/lib/presenze/finestra-comunicazione'"),
            'La route non importa più il tetto dal posto unico: o lo importa, o è tornata ad avere una copia.',
        ).toBe(true);
        // E il numero deve restare un numero sensato: un lock che accetta
        // qualunque valore non protegge dal refuso che lo azzera.
        expect(GIORNI_MASSIMI_IN_ANTICIPO).toBeGreaterThan(0);
        expect(GIORNI_MASSIMI_IN_ANTICIPO).toBeLessThanOrEqual(365);
    });

    it('entrambi i campi hanno `min` = oggi E `max` = oggi + il tetto', async () => {
        const soffitto = ultimoGiornoComunicabile(OGGI);
        render(<ParentAttendancePage />);
        const a = await screen.findByLabelText(itServizi.attendanceGiorno);
        expect(a).toHaveAttribute('min', OGGI);
        expect(
            a.getAttribute('max'),
            'il calendario nativo offre giorni che il server rifiuta: il vincolo non era ' +
                'conoscibile prima di premere',
        ).toBe(soffitto);
        cleanup();

        await cardAperta();
        const c = screen.getByLabelText(itPrimaria.comunicaDataLabel);
        expect(c).toHaveAttribute('min', OGGI);
        expect(c.getAttribute('max')).toBe(soffitto);
    });

    it('l\'aiuto persistente dichiara il tetto, col numero preso dalla costante', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        const ids = (campo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const aiuto = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        expect(
            aiuto,
            '«puoi indicare oggi o un giorno futuro» è falsa oltre i 60 giorni: il genitore sceglie ' +
                'una data che il calendario gli offre e scopre solo dal rifiuto che non era ammessa',
        ).toContain(String(GIORNI_MASSIMI_IN_ANTICIPO));
        cleanup();

        await cardAperta();
        const c = screen.getByLabelText(itPrimaria.comunicaDataLabel);
        const idsC = (c.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const aiutoC = idsC.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        expect(aiutoC).toContain(String(GIORNI_MASSIMI_IN_ANTICIPO));
    });

    it('la regola del giorno ammesso è UNA, e sa dire quale dei due confini ha rotto', () => {
        expect(rifiutoDelGiorno('2026-08-10', OGGI)).toBe('ASSENZA_DATA_PASSATA');
        expect(rifiutoDelGiorno(OGGI, OGGI)).toBeNull();
        expect(rifiutoDelGiorno(ultimoGiornoComunicabile(OGGI), OGGI)).toBeNull();
        // Il giorno dopo il tetto: il codice è l'ALTRO, non «già passata» — che
        // manderebbe il genitore alla giustifica per un giorno che deve arrivare.
        expect(rifiutoDelGiorno('2026-10-11', OGGI)).toBe('ASSENZA_DATA_TROPPO_LONTANA');
        // Aritmetica di calendario in UTC: 60 giorni dall'11 agosto = 10 ottobre.
        expect(ultimoGiornoComunicabile(OGGI)).toBe('2026-10-10');
    });
});

// =============================================================================
// R19 — IL LINK ALL'INFORMATIVA SOTTO IL PIEDE (quinto collaudo, 2026-08-08).
//
// È del collaudo dopo, ma è la STESSA FAMIGLIA dei due bloccanti qui sopra —
// qualcosa che il genitore deve poter toccare nasce sotto uno strato
// appiccicato — e le utility per misurarla (`piede`, `cardAperta`) sono qui.
//
// Misura CDP sulla WebView a 390×731, pagina appena aperta, scrollY = 0:
//   piede appiccicato  y 568→659
//   link «Leggi l'informativa»  y 592→607   ← dentro la fascia del piede
//   document.elementFromPoint(centro del link) → BUTTON «Comunica assenza»
// e `adb shell input tap` sul link non apriva l'informativa: faceva partire la
// comunicazione (+1 POST nel log del server). Il difetto NON era la posizione
// nel documento: la nota era già stata spostata sopra il campo alle 02:54 dello
// stesso giorno, e il collaudo l'ha ritrovata coperta lo stesso — perché il
// piede si SOLLEVA sopra ciò che lo precede, e quanto ne copre dipende dallo
// scorrimento, non dall'ordine dei nodi.
//
// Riprodotto in Chromium a 390×731 (link 592→607 e textarea 617→729: le stesse
// coordinate della WebView) e misurate le due varianti:
//   nota sopra il campo  → elementFromPoint sul link = il pulsante  ❌
//   nota dentro il piede → elementFromPoint sul link = il link      ✅
//
// La regola che ne segue, e che questo lock blocca: **ciò che è INTERATTIVO non
// può stare nella fascia che il piede copre.** Un testo coperto si scopre
// scorrendo; un link coperto esegue un'altra azione — qui la scrittura di un
// dato sanitario di un minore.
// =============================================================================
describe('R19 · il link all\'informativa vive DENTRO il piede, non sotto', () => {
    it('/parent/attendance: il link sta nello stesso piede del pulsante che invia', async () => {
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);
        const link = screen.getByRole('link', { name: itAssenze.motivoPrivacyLink });

        // NON VACUO: se un giorno il piede smettesse di essere `sticky`,
        // `piede()` tornerebbe `null` per entrambi e il confronto qui sotto
        // sarebbe verde su due nulla. La prova che conta è che il ricovero ci sia.
        expect(piede(inviaAttendance()), 'il pulsante non ha più un ricovero appiccicato').not.toBeNull();
        expect(
            piede(link),
            'il link all\'informativa nasce fuori dal piede: a 390×731 cade nella fascia che il ' +
                'piede sollevato copre (link 592→607, piede 568→659) e un tocco al suo centro ' +
                'ESEGUE L\'INVIO invece di aprire l\'informativa',
        ).toBe(piede(inviaAttendance()));
    });

    it('card primaria: stessa posizione, perché è la stessa funzione', async () => {
        await cardAperta();
        const link = screen.getByRole('link', { name: itAssenze.motivoPrivacyLink });
        expect(piede(link)).toBe(piede(inviaCard()));
    });

    it('il campo resta legato alla nota: `aria-describedby` non chiede vicinanza', async () => {
        render(<ParentAttendancePage />);
        const motivo = await screen.findByPlaceholderText(itAssenze.motivoPlaceholder);
        const ids = (motivo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const testo = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        expect(
            testo,
            'la nota è nel piede, ma resta la descrizione del campo: chi ascolta la sente quando ' +
                'ci entra, non quando ci passa sopra',
        ).toContain(itAssenze.motivoPrivacyLink);
    });

    it('LA REGOLA: nessun comando nasce fra il campo motivo e il piede', async () => {
        render(<ParentAttendancePage />);
        const motivo = await screen.findByPlaceholderText(itAssenze.motivoPlaceholder);
        const modulo = motivo.closest('form')!;
        const ricovero = piede(inviaAttendance())!;

        const intercettabili = Array.from(
            modulo.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea'),
        ).filter(
            (el) =>
                // …viene DOPO la textarea nel documento (cioè è nella fascia che
                // il piede copre quando si solleva)…
                !!(motivo.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                // …e non è al riparo dentro il piede.
                !ricovero.contains(el),
        );

        expect(
            intercettabili.map((el) => `${el.tagName}: ${el.textContent?.trim().slice(0, 40)}`),
            'questi comandi nascono fra il campo e il piede: è la fascia che il piede sollevato ' +
                'copre, e un tocco su di loro finisce sul pulsante che invia. O stanno sopra il ' +
                'campo, o stanno dentro il piede.',
        ).toEqual([]);
    });
});
