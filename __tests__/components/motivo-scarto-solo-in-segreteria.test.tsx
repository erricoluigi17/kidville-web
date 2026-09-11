import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen, cleanup, waitFor, act, fireEvent, within } from '@testing-library/react';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL MOTIVO DELLO SCARTO SI LEGGE IN SEGRETERIA, E SOLO LÌ.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 *
 * `fatture_emesse.sdi_scarto_motivo` era scritta in quattro punti e letta da
 * nessuna rotta: quando lo SDI respinge una fattura, la Segreteria riceve la
 * notifica «Fattura scartata dallo SDI» e poi non ha nessuno schermo dove
 * leggerne il perché. Correggere e ritrasmettere senza sapere che cosa è stato
 * contestato è tirare a indovinare su un documento fiscale.
 *
 * ─── I QUATTRO PUNTI IN CUI IL RIQUADRO SI RENDE ───────────────────────────
 *
 * `MotiviScarto` è montato in quattro rami di `FatturaButton.tsx`, e qui sono
 * coperti tutti e quattro — perché tre di essi sono *dentro* `EmessaLinks`, e
 * un ramo scoperto è un ramo che domani qualcuno cancella senza accorgersene:
 *
 *  1. `ScartoLinks`            → `fattura_stato = 'scartata'`, accanto a «Riprova»;
 *  2. `EmessaLinks`, 0 comandi → «emessa» con la quota a `sdi_stato = 2` (errore
 *     di upload) e NESSUN PDF nel bucket: il caso misurato in produzione il
 *     2026-09-11, in cui la riga rendeva **niente** e il perché restava invisibile;
 *  3. `EmessaLinks`, 1 comando → due quote (genitori separati), una scaricabile
 *     e una respinta;
 *  4. `EmessaLinks`, N comandi → l'elenco a tendina «Fatture (N)». Qui il riquadro
 *     sta FUORI dal `{open && …}`: si legge senza aprire niente, e resta **uno**
 *     anche a tendina aperta.
 *
 * ─── E LA PELLE DEL GENITORE NON LO MOSTRA MAI ─────────────────────────────
 *
 * Il motore (`useFattureScaricabili`) è UNO SOLO per le due pelli. La prosa
 * tecnica di Aruba/SDI è per chi ritrasmette, non per una famiglia: il server la
 * omette già dal corpo della risposta (`fattura-list-motivo-scarto.test.ts`), e
 * qui si chiude l'altra metà — che nessuno la renda a schermo il giorno in cui il
 * server tornasse a mandarla.
 *
 * ⚠️ E IL LOCK È SUL COMPORTAMENTO, NON SU UNA STRINGA NEI FILE. La prima
 * versione di questa prova cercava il testo `sdi_scarto_motivo` nei sorgenti di
 * `src/components/features/parent/`: un accesso INDIRETTO — una destrutturazione
 * `const { scarti } = useFattureScaricabili(…)`, una variabile intermedia, un
 * campo passato a un figlio — non contiene quella stringa e sarebbe passato. È la
 * stessa classe di difetto («il lock cerca la PRESENZA di un testo ed è cieco al
 * ramo») che questo repo ha già pagato due volte. Adesso la prova RENDE le due
 * pelli con LA STESSA riga di risposta e pretende esiti opposti; il controllo
 * testuale resta, ma come rete SECONDARIA.
 *
 * ⚠️ LE TRAPPOLE EVITATE, tutte già pagate qui dentro:
 *  · un `waitFor` su un'ASSENZA passa PRIMA che i dati arrivino: qui ogni
 *    asserzione di assenza viene DOPO un'evidenza positiva che il render è
 *    avvenuto (la sentinella che il motivo ce l'ha, o il link «Apri»);
 *  · un `waitFor` che può non avverarsi PAGA IL TIMEOUT INTERO (5 s, vedi
 *    `test/setup.ts`) a ogni giro: qui non ne è rimasto nessuno su una
 *    condizione NON monotona — vedi `elencoChiestoUnaVolta` e `attendiElenco`;
 *  · `getByText` pesca i sosia: il riquadro si prende per `data-testid` e si
 *    legge il suo `textContent`, non si cerca una frase nel documento;
 *  · un mock piatto è verde con e senza la correzione: il `fetch` finto qui
 *    risponde PER PAGAMENTO, e la risposta si consegna quando decide la prova.
 */

/** I testi italiani reali: il mock di next-intl risolve sui cataloghi (vedi `test/setup.ts`). */
const CONTABILITA = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>;
const PAGAMENTI = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/pagamenti.json'), 'utf8'),
) as Record<string, string>;

vi.mock('framer-motion', async () => {
    const React = await import('react');
    const motion = new Proxy({}, {
        get: (_t, tag: string) => function Mock(props: Record<string, unknown>) {
            const { children, initial, animate, exit, transition, whileHover, whileTap, layout, variants, ...resto } = props as Record<string, unknown>;
            void initial; void animate; void exit; void transition; void whileHover; void whileTap; void layout; void variants;
            return React.createElement(tag, resto, children as React.ReactNode);
        },
    });
    return { motion, AnimatePresence: ({ children }: { children?: unknown }) => children };
});

// Il realtime di Supabase non deve toccare la rete: canale finto, `removeChannel` no-op.
vi.mock('@/lib/supabase/browser-client', () => {
    const channel = {
        on() { return channel; },
        subscribe() { return channel; },
    };
    return { getSupabase: () => ({ channel: () => channel, removeChannel: () => {} }) };
});

import { FatturaButton } from '@/components/features/admin/pagamenti/FatturaButton';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';

/** uuid sintetici: il repository è pubblico. */
const PAG = '85320395-0000-4000-8000-0000000000a1';
const SENT = '85320395-0000-4000-8000-0000000000a2';
const UTENTE = 'bbbbbbbb-0000-4000-8000-0000000000a3';
const F1 = 'cccccccc-0000-4000-8000-0000000000a4';
const F2 = 'cccccccc-0000-4000-8000-0000000000a5';
const F3 = 'cccccccc-0000-4000-8000-0000000000a6';

/** Prosa tecnica del provider: un codice SDI vero, nessun dato di nessuno. */
const MOTIVO = '00311 - Codice destinatario non valido';
const MOTIVO_SENT = '00404 - Fattura duplicata';

const riga = (o: {
    id?: string; numero?: number; pdf?: boolean; motivo?: string | null;
} = {}) => ({
    id: o.id ?? F1,
    numero: o.numero ?? 1948,
    anno: 2026,
    quota_label: null,
    intestatario: 'Intestatario',
    pdf_disponibile: o.pdf ?? false,
    sdi_stato_label: 'Scartata dallo SDI',
    sdi_scarto_motivo: o.motivo ?? null,
});

/** `fetch` sotto controllo: l'elenco si consegna QUANDO decide la prova, e per QUALE pagamento. */
let consegnaPer: Record<string, ((righe: unknown[]) => void) | undefined> = {};
let chiamate: string[] = [];

/** La voce del genitore, già fatturata: senza, la card non monta nemmeno i comandi. */
const VOCE = {
    id: PAG,
    alunno_id: 'a1',
    scuola_id: 'sede-1',
    descrizione: 'Retta Settembre',
    importo: 250,
    importo_pagato: 250,
    sconto: 0,
    scadenza: '2026-09-10',
    stato: 'pagato',
    tipo: 'singolo',
    obbligatorio: true,
    fattura_stato: 'emessa',
    causale_suggerita: null,
    // Dati SINTETICI: il bambino non esiste e quello non è un codice fiscale.
    alunni: { nome: 'Mara', cognome: 'Bianchi', codice_fiscale: 'AAAAAA00A00A000A' },
};

/**
 * IL CORPO DELLE VOCI È UNA COSTANTE, E NON UN LETTERALE NUOVO A OGNI CHIAMATA.
 *
 * ⚠️ Sembra un dettaglio di stile ed è la differenza fra un test deterministico e
 * uno che dipende dalla velocità della macchina. `StoricoPagamenti` ha
 * `const load = useCallback(…, [userId, t])` e `useEffect(() => { load() }, [load])`.
 * Il mock di next-intl (`test/setup.ts`) restituisce una `t` NUOVA a ogni render —
 * il vero `useTranslations` la memoizza, quindi il ciclo non esiste nel prodotto —
 * perciò `load` cambia identità a ogni render e il suo effetto rilancia la GET.
 * Con un `data: [VOCE]` nuovo a ogni risposta, `setPagamenti` non può mai fermarsi
 * su un valore uguale: render → nuova `t` → nuova `load` → GET → render…
 *
 * MISURATO QUI, il 2026-09-11: con il letterale, **186 GET in 300 ms** e nessun
 * limite superiore; con questa costante, **2**, e stabili. Non è rumore: è la
 * CPU che un `waitFor` di questo file deve condividere coi suoi stessi timer —
 * e con gli altri file in parallelo. Un `waitFor` da 5 s, in quella condizione,
 * aveva davanti a sé tremila render.
 *
 * `data` e `sedi` sono gli STESSI riferimenti a ogni risposta: `setPagamenti` e
 * `setSedi` ricevono il valore che hanno già, React esce dal giro, e il ciclo
 * muore alla seconda GET.
 */
const CORPO_VOCI = { success: true, data: [VOCE], sedi: [] as unknown[] };

beforeEach(() => {
    vi.clearAllMocks();
    chiamate = [];
    consegnaPer = {};
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request) => {
        const u = String(url);
        chiamate.push(u);
        // ⚠️ L'ORDINE DEI RAMI CONTA: `/api/pagamenti/fattura/list?…` contiene anche
        // `/api/pagamenti`, e invertirli servirebbe l'elenco delle VOCI al posto
        // dell'elenco delle FATTURE.
        if (u.includes('/api/pagamenti/fattura/list')) {
            const quale = new URL(u, 'http://localhost').searchParams.get('pagamento_id') ?? '';
            return new Promise<Response>((risolvi) => {
                consegnaPer[quale] = (righe: unknown[]) =>
                    risolvi({ ok: true, status: 200, json: async () => ({ success: true, data: righe }) } as unknown as Response);
            });
        }
        if (u.includes('/api/pagamenti')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => CORPO_VOCI } as unknown as Response);
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => null } as unknown as Response);
    }));
});

// I contenitori montati a mano (il test delle due pelli) non li toglie `cleanup`:
// restano divi vuoti appesi a `body`, e il giro dopo un `document.body.textContent`
// leggerebbe anche quelli.
afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
});

const chiamateElenco = (quale: string) =>
    chiamate.filter((u) => u.includes('/api/pagamenti/fattura/list') && u.includes(quale));

/**
 * L'elenco è stato chiesto, UNA volta sola — e si misura SENZA aspettare.
 *
 * ⚠️ `render()` di Testing Library gira dentro `act()`: quando ritorna, gli
 * effetti di montaggio sono già stati eseguiti e la GET è già partita. Il
 * `waitFor` che c'era qui non serviva a niente di reale, e costava: la sua
 * condizione — `toHaveLength(1)` — NON È MONOTONA, perché un conteggio che
 * arrivasse a 2 non torna a 1. Una condizione che non può più avverarsi dentro un
 * `waitFor` paga il TIMEOUT INTERO (5 s, `test/setup.ts`) e poi fallisce lo
 * stesso: tre test così sono sedici secondi e mezzo di attesa per dire una cosa
 * che si sapeva subito. Qui l'errore è immediato, e dice il numero che ha trovato.
 */
function elencoChiestoUnaVolta(quale: string): void {
    expect(
        chiamateElenco(quale),
        `L'elenco delle fatture di ${quale} va chiesto una volta e una sola: `
        + `\`render()\` gira dentro \`act()\`, quindi a questo punto la GET è già partita.`,
    ).toHaveLength(1);
    expect(
        typeof consegnaPer[quale],
        `Nessuna risposta in attesa per ${quale}: il ramo del \`fetch\` finto non ha registrato il risolutore.`,
    ).toBe('function');
}

/**
 * Come sopra, ma per la card del genitore, dove la GET dell'elenco arriva DOPO
 * quella delle voci e non può essere già partita al ritorno di `render()`.
 *
 * L'attesa è su una condizione MONOTONA — «il risolutore esiste»: una volta
 * registrato non sparisce, quindi o si avvera subito o il test è davvero rotto.
 * L'esattezza («una volta sola») si misura dopo, sincrona.
 */
async function attendiElenco(quale: string): Promise<void> {
    await waitFor(() => expect(typeof consegnaPer[quale]).toBe('function'));
    elencoChiestoUnaVolta(quale);
}

/**
 * Consegna la risposta dell'elenco E ASPETTA CHE SIA STATA ASSORBITA.
 *
 * ⚠️ Fra `risolvi(…)` e lo schermo ci sono almeno DUE microtask (`await res.json()`
 * e il `setStato` che React deve applicare): un `await Promise.resolve()` ne
 * consuma uno solo e lascerebbe il componente ancora in caricamento — cioè
 * renderebbe verde per il motivo sbagliato ogni asserzione di assenza.
 *
 * Se non c'è niente in attesa si SOLLEVA subito, con un messaggio che lo dice: il
 * `?.` che c'era prima trasformava «la GET non è mai partita» in un test che
 * prosegue e cade cinque secondi più in là, su un'altra riga.
 */
async function consegnaEAssorbi(quale: string, righe: unknown[]): Promise<void> {
    const consegna = consegnaPer[quale];
    if (!consegna) {
        throw new Error(
            `Nessuna GET dell'elenco in attesa per ${quale}: o il componente non l'ha chiesta, `
            + `o è già stata consegnata. Chiamate viste: ${JSON.stringify(chiamate)}`,
        );
    }
    // Consegnata una volta, il risolutore non serve più: tenerlo farebbe passare
    // in silenzio una seconda consegna sulla stessa promessa (che non fa niente).
    consegnaPer[quale] = undefined;
    await act(async () => { consegna(righe); });
}

/** Le ancore della fattura DI UN pagamento: due card non si confondono. */
const ancoreDi = (pagamento: string, radice: ParentNode = document) =>
    [...radice.querySelectorAll<HTMLAnchorElement>(`a[href*="pagamento_id=${pagamento}"]`)];

const riquadri = () => screen.queryAllByTestId('fattura-scarto');
const riquadriIn = (radice: HTMLElement) => within(radice).queryAllByTestId('fattura-scarto');

// ═════════════════════════════════════════════════════════════════════════════
describe('segreteria · fattura scartata: il motivo sta accanto al pulsante che la rimanda', () => {
    it('prima non c’è (non si sa ancora), dopo la risposta si legge per esteso', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="scartata" />);

        // Evidenza POSITIVA che la riga è quella giusta: il comando di ritrasmissione c'è.
        expect(screen.getByRole('button').textContent).toContain(CONTABILITA.fatBtn_riprova);
        // …e l'elenco è stato chiesto: il vuoto qui sotto è «non lo so ancora».
        elencoChiestoUnaVolta(PAG);
        expect(riquadri()).toHaveLength(0);

        await consegnaEAssorbi(PAG, [riga({ motivo: MOTIVO })]);

        const box = screen.getByTestId('fattura-scarto');
        expect(box.textContent).toContain(CONTABILITA.fatBtn_scarto_titolo);
        // PER ESTESO: troncare l'unico testo che dice cosa correggere sarebbe
        // riaprire il difetto con un'altra faccia.
        expect(box.textContent).toContain(MOTIVO);
        expect(box.textContent).toContain('1948');
    });

    it('senza motivo non si inventa niente — e la sentinella dimostra che la risposta è arrivata', async () => {
        // Due pulsanti insieme: quello in prova (nessun motivo) e una SENTINELLA che
        // il motivo ce l'ha. Se lo schermo mostrasse un riquadro solo perché le
        // risposte non sono ancora arrivate, la sentinella sarebbe muta anche lei.
        render(
            <>
                <FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="scartata" />
                <FatturaButton pagamentoId={SENT} userId={UTENTE} fatturaStato="scartata" />
            </>,
        );
        elencoChiestoUnaVolta(PAG);
        elencoChiestoUnaVolta(SENT);

        await consegnaEAssorbi(PAG, [riga({ motivo: null })]);
        await consegnaEAssorbi(SENT, [riga({ id: F2, numero: 1949, motivo: MOTIVO_SENT })]);

        const visti = riquadri();
        expect(visti).toHaveLength(1);
        expect(visti[0].textContent).toContain(MOTIVO_SENT);
    });

    it('un motivo fatto di soli spazi vale «nessun motivo»', async () => {
        render(
            <>
                <FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="scartata" />
                <FatturaButton pagamentoId={SENT} userId={UTENTE} fatturaStato="scartata" />
            </>,
        );
        elencoChiestoUnaVolta(PAG);
        elencoChiestoUnaVolta(SENT);

        await consegnaEAssorbi(PAG, [riga({ motivo: '   ' })]);
        await consegnaEAssorbi(SENT, [riga({ id: F2, numero: 1949, motivo: MOTIVO_SENT })]);

        // Un riquadro con dentro il vuoto è peggio di nessun riquadro: dice che
        // c'è una spiegazione e non la dà.
        expect(riquadri()).toHaveLength(1);
        expect(riquadri()[0].textContent).toContain(MOTIVO_SENT);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('segreteria · fattura «emessa»: i tre rami di EmessaLinks, tutti e tre', () => {
    it('NESSUN comando (nessun PDF) — ma il motivo si legge lo stesso', async () => {
        // È il caso misurato in produzione (`sdi_stato = 2`): finora questa riga
        // rendeva NIENTE, ed è il buco più silenzioso dei due.
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="emessa" />);
        elencoChiestoUnaVolta(PAG);
        await consegnaEAssorbi(PAG, [riga({ pdf: false, motivo: MOTIVO })]);

        // Il comando resta assente: il PDF davvero non c'è, e un pulsante che dà 404
        // non è un miglioramento.
        expect(screen.queryAllByRole('link')).toHaveLength(0);
        expect(riquadri()).toHaveLength(1);
        expect(screen.getByTestId('fattura-scarto').textContent).toContain(MOTIVO);
    });

    it('UN comando e una quota respinta: i due link E il riquadro, una volta sola', async () => {
        // Genitori separati, due quote: una ha il suo PDF nel bucket, l'altra è stata
        // respinta e il file non ce l'ha. Il ramo `comandi.length === 1` rende i
        // comandi della prima e DEVE rendere il perché della seconda: è il ramo che
        // il lock precedente non toccava.
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="emessa" />);
        elencoChiestoUnaVolta(PAG);
        await consegnaEAssorbi(PAG, [
            riga({ id: F1, numero: 1948, pdf: true, motivo: null }),
            riga({ id: F2, numero: 1949, pdf: false, motivo: MOTIVO }),
        ]);

        // Evidenza POSITIVA: «Apri» e «Scarica» della quota scaricabile ci sono.
        const link = screen.queryAllByRole('link');
        expect(link).toHaveLength(2);
        expect(link[0].textContent).toContain(CONTABILITA.fatBtn_apri);
        expect(link[1].textContent).toContain(CONTABILITA.fatBtn_scarica);

        // UNO SOLO, e parla della quota giusta.
        expect(riquadri()).toHaveLength(1);
        const box = riquadri()[0];
        expect(box.textContent).toContain(MOTIVO);
        expect(box.textContent).toContain('1949');
        expect(box.textContent).not.toContain('1948');
    });

    it('PIÙ comandi e una quota respinta: il riquadro si legge senza aprire la tendina, e resta uno anche aperta', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="emessa" />);
        elencoChiestoUnaVolta(PAG);
        await consegnaEAssorbi(PAG, [
            riga({ id: F1, numero: 1948, pdf: true, motivo: null }),
            riga({ id: F2, numero: 1949, pdf: true, motivo: null }),
            riga({ id: F3, numero: 1950, pdf: false, motivo: MOTIVO }),
        ]);

        // Evidenza POSITIVA: il ramo a più comandi è quello a tendina.
        const tendina = screen.getByRole('button');
        expect(tendina.textContent).toContain(`${CONTABILITA.fatBtn_fatture} (2)`);
        // A tendina CHIUSA i link non sono a schermo…
        expect(screen.queryAllByRole('link')).toHaveLength(0);
        // …ma il riquadro sì: sta fuori dal `{open && …}`, ed è la ragione per cui
        // è scritto così — chi non apre niente deve comunque leggere il perché.
        expect(riquadri()).toHaveLength(1);
        expect(riquadri()[0].textContent).toContain(MOTIVO);

        fireEvent.click(tendina);

        // Aperta: i quattro comandi delle due quote compaiono, e il riquadro NON si
        // duplica — non è dentro il pannello, e nessuno ce l'ha ricopiato.
        expect(screen.queryAllByRole('link')).toHaveLength(4);
        expect(riquadri()).toHaveLength(1);
    });

    it('PDF disponibile e nessun motivo → i due comandi, e nessun riquadro', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="emessa" />);
        elencoChiestoUnaVolta(PAG);
        await consegnaEAssorbi(PAG, [riga({ pdf: true, motivo: null })]);

        // Evidenza positiva PRIMA dell'assenza: i comandi ci sono, quindi la
        // risposta è arrivata e il componente ha reso.
        expect(screen.queryAllByRole('link')).toHaveLength(2);
        expect(riquadri()).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('segreteria · gli stati in cui l’elenco non si chiede nemmeno', () => {
    // L'altra metà di «il riquadro compare in tutti i casi in cui deve»: nei due
    // stati in cui NON deve, non parte neanche la GET. In una tabella di rette
    // sono decine di righe, e una GET a testa per niente è la ragione per cui
    // `ScartoLinks` è dietro `stato === 'scartata'`.
    it.each([
        ['non_richiesta', CONTABILITA.fatBtn_invia],
        ['in_attesa', CONTABILITA.fatBtn_attesa_sdi],
    ])('stato «%s»: nessuna GET dell’elenco, nessun riquadro', (stato, testo) => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato={stato} />);

        // Evidenza POSITIVA che la riga ha reso ciò che le compete.
        expect(document.body.textContent ?? '').toContain(testo);
        expect(chiamateElenco(PAG)).toHaveLength(0);
        expect(riquadri()).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('genitore · la prosa del provider non arriva mai sulla card di famiglia', () => {
    it('LA STESSA riga: in segreteria accende il riquadro, sulla card di famiglia non lascia traccia', async () => {
        // ⚠️ QUESTO È IL LOCK, ed è sul COMPORTAMENTO. Le due pelli montano lo stesso
        // motore (`useFattureScaricabili`) e qui ricevono LO STESSO oggetto di
        // risposta, col campo che il server non manda più. La metà «segreteria» non è
        // ornamento: è ciò che impedisce a questa prova di essere verde per il motivo
        // sbagliato. Se domani il mock smettesse di consegnare quel campo, o il motore
        // smettesse di ricavarne gli scarti, il riquadro della segreteria sparirebbe e
        // il test cadrebbe — invece di dichiarare «il genitore non lo vede» su un dato
        // che non è mai arrivato a nessuno.
        const genitore = document.createElement('div');
        const segreteria = document.createElement('div');
        document.body.append(genitore, segreteria);

        render(<StoricoPagamenti userId={UTENTE} />, { container: genitore });
        render(<FatturaButton pagamentoId={SENT} userId={UTENTE} fatturaStato="emessa" />, { container: segreteria });

        // La segreteria chiede subito (l'effetto gira dentro l'`act` di `render`);
        // il genitore solo dopo l'elenco delle voci, che è una GET in più.
        elencoChiestoUnaVolta(SENT);
        expect(await within(genitore).findByText(VOCE.descrizione)).toBeInTheDocument();
        await attendiElenco(PAG);

        // UN SOLO oggetto per tutte e due: non due copie che possono divergere.
        const respinta = riga({ pdf: true, motivo: MOTIVO });
        await consegnaEAssorbi(SENT, [respinta]);
        await consegnaEAssorbi(PAG, [respinta]);

        // ── EVIDENZA POSITIVA n.1 — il campo è ARRIVATO, e la pelle che deve
        //    mostrarlo lo mostra.
        expect(riquadriIn(segreteria)).toHaveLength(1);
        expect(riquadriIn(segreteria)[0].textContent).toContain(MOTIVO);

        // ── EVIDENZA POSITIVA n.2 — la card di famiglia ha applicato LA STESSA
        //    risposta: le sue due ancore compaiono solo dopo.
        const ancore = ancoreDi(PAG, genitore);
        expect(ancore).toHaveLength(2);
        expect(ancore[0].textContent).toContain(PAGAMENTI.fatturaApri);

        // ── E SOLO ADESSO l'assenza, che a questo punto significa qualcosa.
        expect(riquadriIn(genitore)).toHaveLength(0);
        expect(genitore.textContent ?? '').not.toContain(MOTIVO);
        expect(genitore.textContent ?? '').not.toContain('Codice destinatario');
        // Nemmeno in un attributo (`title`, `aria-label`, `data-…`): l'HTML intero.
        expect(genitore.innerHTML).not.toContain('00311');
    });

    it('e nessun sorgente della pelle di famiglia nomina il canale del motivo (rete SECONDARIA)', () => {
        // ⚠️ QUESTA È LA SECONDA RETE, NON LA PRIMA. Da sola sarebbe cieca: un
        // accesso indiretto — `const { scarti } = useFattureScaricabili(…)`, una
        // variabile intermedia, un campo passato a un figlio — non contiene la
        // stringa `sdi_scarto_motivo` e passerebbe. Il lock vero è il test qui
        // sopra, che RENDE. Questo copre ciò che un render non vede: un `title=`
        // o un attributo dentro un componente che nessun test monta.
        //
        // Per lo stesso motivo i nomi vietati sono TRE e non uno: la colonna, il
        // tipo che la trasporta, e il campo con cui il motore la espone. Sono i
        // tre soli modi di nominare quel canale scrivendolo.
        const radice = join(process.cwd(), 'src/components/features/parent');
        const file: string[] = [];
        const cammina = (dir: string) => {
            for (const voce of readdirSync(dir)) {
                const p = join(dir, voce);
                if (statSync(p).isDirectory()) cammina(p);
                else if (/\.tsx?$/.test(voce)) file.push(p);
            }
        };
        cammina(radice);
        // Sanità: se la cartella cambiasse nome, il divieto qui sotto sarebbe verde sul nulla.
        expect(file.length).toBeGreaterThan(10);

        /**
         * I commenti si tolgono prima di cercare: «scarti» è anche una parola
         * italiana, e un lock che diventa rosso per una prosa in un commento è un
         * lock che qualcuno indebolirà. (Tagliare da `//` a fine riga può troncare
         * un URL dentro una stringa: non può creare un falso positivo, solo perdere
         * ciò che venisse DOPO l'URL sulla stessa riga.)
         */
        const senzaCommenti = (sorgente: string) =>
            sorgente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

        const VIETATI = [/\bsdi_scarto_motivo\b/, /\bScartoFattura\b/, /\bscarti\b/];
        const colpevoli = file
            .filter((f) => {
                const codice = senzaCommenti(readFileSync(f, 'utf8'));
                return VIETATI.some((r) => r.test(codice));
            })
            .map((f) => relative(process.cwd(), f));
        expect(
            colpevoli,
            'Il motivo di uno scarto è prosa tecnica di Aruba/SDI e non appartiene a una ' +
            'schermata di famiglia: il server non lo manda nemmeno (vedi `RUOLI_MOTIVO_SCARTO` ' +
            'in `src/app/api/pagamenti/fattura/list/route.ts`). Se serve un’informazione al ' +
            'genitore, si aggiunge una chiave di catalogo — non si rende il testo del provider.',
        ).toEqual([]);
    });
});
