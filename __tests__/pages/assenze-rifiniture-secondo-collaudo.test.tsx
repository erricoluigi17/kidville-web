import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

// =============================================================================
// «Comunica un'assenza» — le rifiniture del SECONDO collaudo (2026-08-07).
//
// Undici rilievi etichettati «minori» dal collaudatore. L'etichetta dice quanto
// è grave il sintomo, non quanto costa: fra questi ce n'è uno in cui il pulsante
// primario è COPERTO dalla barra di navigazione (137px di sovrapposizione su
// 145: il genitore tocca «COMUNICA ASSENZA» e finisce sugli Avvisi), e uno in
// cui ricomunicare lo stesso giorno CANCELLA il motivo già scritto — che è un
// dato sanitario di un minore, e sparisce senza una parola.
//
// Questo file misura il DOM e il CSS veri delle due schermate gemelle:
//   · `/parent/attendance`            (nido e infanzia)
//   · la card montata in `/parent/primaria/assenze`
// Ogni sezione porta il numero del rilievo che chiude.
// =============================================================================

const RADICE = process.cwd();
const CSS = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8');
/** Il CSS senza commenti: una regola citata in un commento non è una regola. */
const CSS_VIVO = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

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

/**
 * next-intl col formattatore VERO (`use-intl`): il mock globale di `test/setup.ts`
 * ignora i valori interpolati, e qui si misurano frasi che i valori li portano.
 */
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
import itAssenze from '../../messages/it/parentAssenze.json';
import itPrimaria from '../../messages/it/parentPrimaria.json';
import itServizi from '../../messages/it/parentServizi.json';

/** 22:30 UTC del 10 agosto = 00:30 dell'11 a Roma: «oggi» è l'11. */
const ADESSO = new Date('2026-08-10T22:30:00Z');
const OGGI = '2026-08-11';

const fetchMock = vi.fn();
let comunicate: { id: string; data: string; giustificazione_testo: string | null; stato: string }[];
/** Trattiene la GET dell'elenco finché il test non la sblocca (M9). */
let trattieniGet: (() => void) | null;

function corpoPresenze() {
    return {
        success: true,
        data: {
            schoolType: 'infanzia',
            oggi: { stato: null, orario_entrata: null, orario_uscita: null },
            riepilogo: { from: '2026-07-12', to: '2026-08-11', presenze: 0, assenze: 0, ritardi: 0, uscite: 0 },
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
    trattieniGet = null;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const metodo = init?.method ?? 'GET';
        if (metodo !== 'GET') {
            return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true }) });
        }
        const risposta = { ok: true, status: 200, json: async () => corpoPresenze() };
        if (trattieniGet) {
            return new Promise((res) => {
                trattieniGet = () => res(risposta);
            });
        }
        return Promise.resolve(risposta);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

/** L'ultima POST partita, già decodificata. */
function ultimaPost(): Record<string, unknown> {
    const post = (fetchMock.mock.calls as [string, RequestInit | undefined][])
        .filter(([, init]) => init?.method === 'POST');
    expect(post.length, 'nessuna POST è partita').toBeGreaterThan(0);
    return JSON.parse(String(post[post.length - 1][1]!.body));
}

/** Monta la card della primaria e aspetta che la prima lettura sia finita. */
async function montaCard() {
    render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
    await act(async () => {});
}

/** Apre il modulo della card (nasce chiuso). */
const apriCard = () => fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }));

// =============================================================================
// M17 — IL PULSANTE PRIMARIO SOTTO LA BARRA DI NAVIGAZIONE.
//
// Misurato sull'emulatore: pulsante [105,1687][976,1832], bottom-nav
// [42,1695][1036,1855] → 137px di sovrapposizione su 145. `adb shell input tap
// 540 1760` (il centro visivo di «COMUNICA ASSENZA») apre /parent/avvisi.
//
// Il `pb-24` della pagina protegge il FONDO del documento, non un elemento a
// metà: finché il modulo è più alto della viewport, il pulsante cade dentro la
// fascia della barra e resta lì fino a quando qualcuno scorre.
// =============================================================================
describe('M17 · il pulsante di invio non finisce mai sotto la barra di navigazione', () => {
    it('l\'altezza della barra è una VARIABILE, dichiarata accanto a quella dell\'AppBar', () => {
        const blocco = CSS_VIVO.match(/\[data-kv-shell\]\s*\{([^}]*)\}/);
        expect(blocco, 'nessun blocco `[data-kv-shell] { … }` in globals.css').not.toBeNull();
        expect(
            blocco![1],
            'la barra in fondo non dichiara la propria altezza: senza una variabile, ' +
                'chi deve stargli sopra è costretto a indovinare un numero',
        ).toMatch(/--kv-bottomnav-h\s*:/);
    });

    it('e quella variabile è la MISURA della barra vera, non una stima', () => {
        // Le due grandezze si leggono da `BottomNav.tsx`, non si ricordano: se
        // domani la pillola cresce, questo test cade prima del telefono.
        const nav = fs.readFileSync(
            path.join(RADICE, 'src', 'components', 'features', 'parent', 'BottomNav.tsx'),
            'utf8',
        );
        const altezzaPillola = nav.match(/<nav\b[^>]*\bh-\[(\d+)px\]/);
        expect(altezzaPillola, 'la barra `<nav>` non dichiara più la sua altezza `h-[Npx]`').not.toBeNull();
        expect(nav).toMatch(/paddingBottom:\s*'max\(12px,\s*env\(safe-area-inset-bottom\)\)'/);

        const dichiarazione = CSS_VIVO.match(/--kv-bottomnav-h\s*:\s*([^;]+);/);
        expect(dichiarazione).not.toBeNull();
        const valore = dichiarazione![1].replace(/\s+/g, '');
        expect(
            valore,
            `--kv-bottomnav-h deve valere l'altezza della pillola (${altezzaPillola![1]}px) più il suo ` +
                'margine inferiore (max(12px, env(safe-area-inset-bottom))): qualunque altro numero è ' +
                'una stima, e su un telefono con la safe-area diversa sbaglia.',
        ).toBe(`calc(${altezzaPillola![1]}px+max(12px,env(safe-area-inset-bottom)))`);
    });

    it('il pulsante «COMUNICA ASSENZA» sta APPOGGIATO sopra la barra, non sotto', async () => {
        render(<ParentAttendancePage />);
        const invia = await screen.findByRole('button', { name: /^Comunica assenza$/i });

        // Il ricovero è l'antenato che si incolla: si cerca risalendo, così la
        // struttura può cambiare senza che il test diventi una fotografia.
        let ricovero: HTMLElement | null = invia.parentElement;
        while (ricovero && !ricovero.className.split(/\s+/).includes('sticky')) {
            ricovero = ricovero.parentElement;
        }
        expect(
            ricovero,
            'il pulsante primario non è ancorato: alla prima apertura, senza scorrere, cade dentro ' +
                'la fascia della bottom-nav e un tocco al suo centro apre /parent/avvisi',
        ).not.toBeNull();
        expect(
            ricovero!.className,
            'l\'ancoraggio non usa l\'altezza dichiarata della barra: un numero scritto a mano ' +
                'sbaglia appena la safe-area cambia',
        ).toMatch(/bottom-\[var\(--kv-bottomnav-h\)\]/);
        // Sotto la barra (z-50), mai sopra: un pulsante che copre la navigazione
        // sarebbe lo stesso difetto al contrario.
        expect(ricovero!.className).toMatch(/(^|\s)z-40(\s|$)/);
    });
});

// =============================================================================
// M19 — LA TASTIERA APERTA SPINGE IL CAMPO SOTTO L'APPBAR.
//
// Misurato: dopo `tapOn` sul campo «Motivo» + `inputText "prova"`, il testo
// compare SOLO nella barra dei suggerimenti della tastiera; nella pagina si vede
// il bordo inferiore del campo, il resto è dietro l'AppBar verde. Il browser
// porta in vista il campo calcolando il bordo del layout, e l'AppBar è `sticky`
// sopra di esso.
// =============================================================================
describe('M19 · con la tastiera aperta il campo attivo resta sotto l\'AppBar, non dietro', () => {
    it('i campi della shell riservano al fuoco l\'altezza dell\'AppBar (`scroll-margin-top`)', () => {
        const regole = [...CSS_VIVO.matchAll(/([^{}]+)\{([^}]*)\}/g)]
            .map(([, sel, corpo]) => ({ sel: sel.trim().replace(/\s+/g, ' '), corpo }))
            .filter((r) => /scroll-margin-top/.test(r.corpo));

        expect(
            regole.length,
            'nessuna regola `scroll-margin-top` in globals.css: quando la tastiera si apre il ' +
                'campo a fuoco viene scrollato esattamente sotto l\'AppBar e si scrive alla cieca',
        ).toBeGreaterThan(0);

        const suiCampi = regole.filter((r) => /\[data-kv-shell\]/.test(r.sel) && /\binput\b/.test(r.sel));
        expect(suiCampi.length, 'la riserva non è agganciata ai campi della shell').toBeGreaterThan(0);
        for (const r of suiCampi) {
            expect(
                r.corpo,
                'la riserva deve valere ESATTAMENTE l\'altezza dichiarata dell\'AppBar ' +
                    '(`--kv-appbar-h`, che in shell nativa ingloba la safe-area): un numero fisso ' +
                    'sbaglia sui telefoni col notch',
            ).toMatch(/scroll-margin-top:\s*var\(--kv-appbar-h\)/);
        }
        // …e copre anche l'area di testo del motivo, che è la sola misurata rotta.
        expect(suiCampi.map((r) => r.sel).join(' ')).toMatch(/textarea/);
    });
});

// =============================================================================
// M1 + M2 — I DUE RICOVERI DEL FUOCO.
//
// M1: con `data-contrast="high"` il fuoco di questi elementi resta VERDE
// (`box-shadow: rgb(0,106,95)`) mentre in tutta la pagina è giallo. È la
// trappola nota dell'`@theme inline`: `focus:ring-kidville-green` porta l'hex
// INLINATO e non partecipa al remap dei token.
// M2: l'anello del titolo di conferma è un rettangolo a spigolo vivo, in
// un'interfaccia dove ogni superficie è arrotondata — il gemello 30 righe più su
// ha `rounded-xl px-1`.
// =============================================================================
describe('M1+M2 · il fuoco dei messaggi di esito: giallo in Alto Contrasto, e arrotondato', () => {
    it('globals.css ribalta a giallo l\'anello dei ricoveri del fuoco', () => {
        const regola = CSS_VIVO.match(
            /\[data-contrast="high"\][^{]*\.kv-fuoco-esito[^{]*\{([^}]*)\}/,
        );
        expect(
            regola,
            'nessuna regola Alto Contrasto per `.kv-fuoco-esito`: l\'anello resta verde mentre ' +
                'il resto della pagina lo ha giallo, e `focus:ring-*` non si ribalta da solo',
        ).not.toBeNull();
        expect(regola![1].toUpperCase()).toContain('#FFE500');
    });

    it('ogni destinazione del fuoco porta la classe e un raggio (niente spigoli vivi)', async () => {
        const ricoveri: HTMLElement[] = [];

        // 1. invio riuscito → il titolo della conferma
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);
        fireEvent.click(screen.getByRole('button', { name: itServizi.attendanceComunicaAssenza }));
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        ricoveri.push(document.activeElement as HTMLElement);

        // 2. ritorno al modulo → il paragrafo introduttivo
        fireEvent.click(screen.getByRole('button', { name: itServizi.attendanceComunicaAltra }));
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        ricoveri.push(document.activeElement as HTMLElement);
        cleanup();

        // 3. annullamento riuscito → il paragrafo d'esito
        comunicate = [{ id: 'x-1', data: '2026-08-20', giustificazione_testo: null, stato: 'assente' }];
        render(<ParentAttendancePage />);
        fireEvent.click(await screen.findByRole('button', { name: new RegExp('^' + itServizi.attendanceAnnullaAria.split('{')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        ricoveri.push(document.activeElement as HTMLElement);
        cleanup();

        // 4-5. la card gemella: conferma e rifiuto
        comunicate = [];
        await montaCard();
        apriCard();
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }));
        await waitFor(() => expect(document.activeElement).not.toBe(document.body));
        ricoveri.push(document.activeElement as HTMLElement);

        expect(ricoveri.length).toBe(4);
        for (const el of ricoveri) {
            expect(
                el.className.split(/\s+/),
                `«${(el.textContent ?? '').slice(0, 40)}»: il ricovero del fuoco non porta ` +
                    '`kv-fuoco-esito`, quindi in Alto Contrasto il suo anello resta verde',
            ).toContain('kv-fuoco-esito');
            expect(
                el.className,
                `«${(el.textContent ?? '').slice(0, 40)}»: anello a spigolo vivo in un'interfaccia ` +
                    'dove ogni superficie è arrotondata — sembra il bordo di un campo, non un fuoco',
            ).toMatch(/(^|\s)rounded-\S+/);
        }
    });
});

// =============================================================================
// M18 — IL GIORNO SVUOTATO E IL PULSANTE CHE PARTE LO STESSO.
//
// Il selettore data nativo di Android offre CLEAR. Con il campo vuoto il
// pulsante restava attivo, la richiesta partiva, il server rispondeva 400 e a
// schermo compariva «Impossibile comunicare l'assenza in questo momento» — che
// parla di un guasto temporaneo mentre il problema è un campo vuoto. La card
// gemella lo faceva già bene (`disabled={inviando || !data || …}`).
// =============================================================================
describe('M18 · col giorno vuoto il modulo non parte, e non mente sul perché', () => {
    it('il pulsante è disabilitato finché il giorno manca', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        const invia = screen.getByRole('button', { name: itServizi.attendanceComunicaAssenza });
        expect(invia).toBeEnabled();

        fireEvent.change(campo, { target: { value: '' } });

        expect(
            invia,
            'col giorno svuotato la richiesta parte e torna un errore che parla «di questo ' +
                'momento» invece che del campo mancante',
        ).toBeDisabled();
        fireEvent.click(invia);
        expect(
            (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(
                ([, i]) => i?.method === 'POST',
            ),
        ).toHaveLength(0);
    });
});

// =============================================================================
// M4 — DUE CAMPI DATA DIVERSI PER LA STESSA FUNZIONE.
//
// `/parent/attendance` usa l'`<input type="date">` nativo, la card della
// primaria un campo di testo mascherato. L'onda 1 ha MISURATO su iOS perché il
// campo nativo resta (il selettore si tocca invece di digitare, e `min` dà un
// pavimento che un campo mascherato non può imporre): la coerenza si fa
// portando la card sul campo nativo, non il contrario.
//
// Effetto collaterale che il rilievo non chiedeva ed è il più utile: la card NON
// aveva nessun pavimento: si poteva digitare una data passata e scoprirlo solo
// dal rifiuto del server.
// =============================================================================
describe('M4 · le due schermate hanno lo STESSO campo data, con lo stesso pavimento', () => {
    it('entrambe usano il campo data nativo con `min` = oggi (fuso italiano)', async () => {
        render(<ParentAttendancePage />);
        const attendance = await screen.findByLabelText(itServizi.attendanceGiorno);
        expect(attendance).toHaveAttribute('type', 'date');
        expect(attendance).toHaveAttribute('min', OGGI);
        cleanup();

        await montaCard();
        apriCard();
        const card = screen.getByLabelText(itPrimaria.comunicaDataLabel);
        expect(
            card.getAttribute('type'),
            'la card usa ancora un campo diverso da quello della schermata gemella',
        ).toBe('date');
        expect(
            card,
            'la card non ha nessun pavimento: si poteva scrivere una data passata e scoprirlo ' +
                'solo dal rifiuto del server',
        ).toHaveAttribute('min', OGGI);
    });

    it('e su entrambe il campo ha un\'istruzione PERSISTENTE e visibile (WCAG 3.3.2)', async () => {
        const controlla = (campo: HTMLElement, dove: string) => {
            const ids = (campo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
            expect(ids.length, `${dove}: il campo data non ha nessuna descrizione associata`).toBeGreaterThan(0);
            const testi = ids.map((id) => document.getElementById(id));
            for (const nodo of testi) expect(nodo, `${dove}: aria-describedby punta a un id inesistente`).not.toBeNull();
            expect(testi.map((n) => n!.textContent ?? '').join(' ').trim().length).toBeGreaterThan(0);
            // Visibile, non per soli screen reader: chi vede male legge tanto quanto chi ascolta.
            for (const nodo of testi) expect(nodo!.className).not.toMatch(/sr-only|hidden/);
        };

        render(<ParentAttendancePage />);
        controlla(await screen.findByLabelText(itServizi.attendanceGiorno), '/parent/attendance');
        cleanup();

        await montaCard();
        apriCard();
        controlla(screen.getByLabelText(itPrimaria.comunicaDataLabel), 'card primaria');
    });
});

// =============================================================================
// M9 — «NON HAI COMUNICATO ASSENZE» DETTO PRIMA DI AVER CHIESTO.
//
// Lo stato iniziale `useState([])` è indistinguibile da «letto e vuoto»: al
// primo ingresso la card afferma di non avere niente mentre la GET è ancora in
// volo (≈2s sul server di collaudo). Il genitore che apre la pagina per
// annullare un'assenza legge che non ne ha comunicate — e può ricomunicarla.
// La pagina sorella modella il terzo stato dal ciclo 1 (`caricandoElenco`).
// =============================================================================
describe('M9 · la card non dichiara «nessuna assenza» prima di aver chiesto al server', () => {
    it('mentre la GET è in volo dice che sta caricando, e NON che non ce ne sono', async () => {
        trattieniGet = () => {};
        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);

        expect(
            screen.queryByText(itPrimaria.comunicaElencoVuoto),
            'la card afferma «non hai comunicato assenze» mentre la lettura è ancora in volo: ' +
                'è una frase falsa detta a chi ne ha, e che gli toglie il modo di annullarle',
        ).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent(/Caricamento/i);

        comunicate = [{ id: 'y-1', data: '2026-08-20', giustificazione_testo: null, stato: 'assente' }];
        await act(async () => { trattieniGet!(); });
        expect(await screen.findByText('20/08/2026')).toBeInTheDocument();
    });

    it('a lettura finita e davvero vuota, la frase torna (il terzo stato non nasconde il secondo)', async () => {
        await montaCard();
        expect(screen.getByText(itPrimaria.comunicaElencoVuoto)).toBeInTheDocument();
    });
});

// =============================================================================
// M16 — IL MODULO SOLLECITA UN DATO DI SALUTE E NON DICE NIENTE DEL TRATTAMENTO.
//
// Il segnaposto è «Es. febbre, visita medica, motivi familiari…»: è una raccolta
// di categoria particolare (art. 9 GDPR) su un MINORE. La schermata non dice chi
// lo legge, per quanto resta, né rimanda all'informativa — che il genitore non
// sta leggendo nel momento in cui scrive «febbre».
// =============================================================================
describe('M16 · sotto il motivo c\'è scritto chi lo legge, per quanto, e dove sta l\'informativa', () => {
    const controllaNota = (campo: HTMLElement, dove: string) => {
        const ids = (campo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const nodi = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
        const testo = nodi.map((n) => n.textContent ?? '').join(' ');
        expect(testo, `${dove}: il campo del motivo non dichiara chi legge il dato`).toMatch(/insegnanti/i);
        expect(testo, `${dove}: il campo del motivo non dichiara per quanto resta`).toMatch(/dodici mesi/i);
        const link = nodi.flatMap((n) => [...n.querySelectorAll('a')]);
        expect(link.length, `${dove}: nessun rimando all'informativa accanto al campo`).toBeGreaterThan(0);
        expect(link[0].getAttribute('href')).toBe('/privacy');
    };

    it('/parent/attendance lo dice accanto al campo', async () => {
        render(<ParentAttendancePage />);
        await screen.findByLabelText(itServizi.attendanceGiorno);
        controllaNota(screen.getByLabelText(itServizi.attendanceMotivo), '/parent/attendance');
    });

    it('e la card della primaria lo dice con le STESSE parole', async () => {
        await montaCard();
        apriCard();
        controllaNota(screen.getByLabelText(itPrimaria.comunicaMotivoLabel), 'card primaria');
    });

    it('i mesi dichiarati sono quelli che il lavoro di scadenza applica davvero', () => {
        const cartella = path.join(RADICE, 'supabase', 'migrations');
        const sql = fs
            .readdirSync(cartella)
            .filter((f) => /retention_motivo_assenza/.test(f))
            .map((f) => fs.readFileSync(path.join(cartella, f), 'utf8'))
            .join('\n');
        const mesi = sql.match(/v_mesi\s+constant\s+int\s*:=\s*(\d+)/i);
        expect(mesi, 'la migrazione della scadenza non dichiara più `v_mesi`').not.toBeNull();
        expect(
            Number(mesi![1]),
            `L'interfaccia promette «dodici mesi» al genitore mentre il lavoro ne applica ` +
                `${mesi![1]}. Una promessa sul trattamento di un dato sanitario di un minore non ` +
                'può essere approssimativa: o si cambia la frase, o si cambia il lavoro.',
        ).toBe(12);
        expect(itAssenze.motivoPrivacy).toMatch(/dodici mesi/i);
    });
});

// =============================================================================
// M21 — RICOMUNICARE LO STESSO GIORNO CANCELLA IL MOTIVO GIÀ SCRITTO.
//
// Misurato nel browser: due invii sulla stessa data 2026-08-20 dallo stesso
// account. Dopo il primo (motivo «collaudo tecnico») l'elenco diceva
// «20/08/2026 · collaudo tecnico»; dopo il secondo con il motivo VUOTO, HTTP 201
// e «20/08/2026» — il motivo sparito, senza un avviso e senza un errore.
//
// LA REGOLA SCELTA, e il perché: **il campo «Motivo» non è un foglio bianco, è
// lo specchio di ciò che risulta archiviato per il giorno scelto.** Quando il
// giorno cambia, il campo si riallinea a quel giorno; lasciarlo com'è significa
// riconfermare, non cancellare. Cancellare resta possibile — si svuota il campo
// a mano, che è un gesto, non una dimenticanza.
//
// ⚠️ La seconda metà della difesa è del SERVER e NON è in questo file: l'UPDATE
// di `comunica-assenza/route.ts:295` normalizza a NULL qualunque motivo vuoto,
// quindi un client diverso (o una versione vecchia dell'app dello store)
// continua a cancellare. La route non è di questo intervento: sta nel resoconto.
// =============================================================================
describe('M21 · ricomunicare lo stesso giorno non cancella il motivo già archiviato', () => {
    beforeEach(() => {
        comunicate = [
            { id: 'g-1', data: '2026-08-20', giustificazione_testo: 'Visita medica', stato: 'assente' },
        ];
    });

    it('scegliere un giorno GIÀ comunicato riporta nel campo il motivo che c\'è', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        const motivo = screen.getByLabelText(itServizi.attendanceMotivo);
        expect(motivo).toHaveValue('');

        fireEvent.change(campo, { target: { value: '2026-08-20' } });

        expect(
            motivo,
            'il modulo riparte vuoto su un giorno che un motivo ce l\'ha già: premere «Comunica ' +
                'assenza» senza toccare niente lo cancella, ed è un dato sanitario di un minore',
        ).toHaveValue('Visita medica');
    });

    it('e l\'invio manda quel motivo, non una stringa vuota', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        fireEvent.change(campo, { target: { value: '2026-08-20' } });
        fireEvent.click(screen.getByRole('button', { name: itServizi.attendanceComunicaAssenza }));

        await waitFor(() => expect(ultimaPost().motivo).toBe('Visita medica'));
    });

    it('il modulo AVVISA che quel giorno è già stato comunicato', async () => {
        render(<ParentAttendancePage />);
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno);
        expect(screen.queryByText(itAssenze.giaComunicataAvviso)).not.toBeInTheDocument();

        fireEvent.change(campo, { target: { value: '2026-08-20' } });

        expect(screen.getByText(itAssenze.giaComunicataAvviso)).toBeInTheDocument();
    });

    it('e la conferma dice «aggiornata», non «comunicata»: sono due fatti diversi', async () => {
        render(<ParentAttendancePage />);
        fireEvent.change(await screen.findByLabelText(itServizi.attendanceGiorno), { target: { value: '2026-08-20' } });
        fireEvent.click(screen.getByRole('button', { name: itServizi.attendanceComunicaAssenza }));

        expect(await screen.findByText(itAssenze.aggiornataTitolo)).toBeInTheDocument();
    });

    it('la card: RIAPRENDO il modulo sullo stesso giorno il motivo torna quello archiviato', async () => {
        // Il buco che la sola regola «riallinea al cambio di giorno» lascia
        // aperto: dopo un invio riuscito la card chiude il modulo e svuota il
        // campo. Riaprendolo — stesso giorno, che ORA una comunicazione ce l'ha —
        // il campo è vuoto, e premere «Invia» una seconda volta cancellerebbe il
        // motivo appena scritto. Nessun cambio di data, quindi nessun
        // riallineamento: il modulo va risincronizzato anche quando si APRE.
        comunicate = [];
        await montaCard();
        apriCard();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), { target: { value: '2026-08-20' } });
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaMotivoLabel), { target: { value: 'Visita medica' } });
        // Il server ha registrato: da qui in poi la GET la restituisce.
        comunicate = [{ id: 'g-9', data: '2026-08-20', giustificazione_testo: 'Visita medica', stato: 'assente' }];
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }));
        await screen.findByText('20/08/2026');

        apriCard();

        expect(
            screen.getByLabelText(itPrimaria.comunicaMotivoLabel),
            'il modulo riaperto è vuoto su un giorno che un motivo ce l\'ha: il prossimo invio ' +
                'lo cancella, ed è un dato sanitario di un minore',
        ).toHaveValue('Visita medica');
    });

    it('la card della primaria si comporta allo stesso modo', async () => {
        await montaCard();
        apriCard();
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), {
            target: { value: '2026-08-20' },
        });

        expect(screen.getByLabelText(itPrimaria.comunicaMotivoLabel)).toHaveValue('Visita medica');
        expect(screen.getByText(itAssenze.giaComunicataAvviso)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }));
        await waitFor(() => expect(ultimaPost().motivo).toBe('Visita medica'));
        expect(await screen.findByText(itAssenze.aggiornataTitolo)).toBeInTheDocument();
    });
});
