import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

/**
 * ─── ⚠️ IL RUOLO, DAL 2026-09-02, DECIDE SE LE CARD ESISTONO ────────────────
 * I totali economici della Contabilità sono riservati alla Direzione (admin +
 * coordinator). `useRuoloCockpit()` fuori dal provider vale `''`, cioè «nessun
 * ruolo, quindi niente»: senza questo mock il blocco dei KPI non verrebbe reso
 * affatto e questo file — che parla di FORMATO degli importi — fallirebbe
 * parlando d'altro.
 *
 * Il ruolo è una variabile e non una costante perché in fondo al file c'è il
 * gruppo che collauda proprio il contrario: che alla segreteria quelle card non
 * compaiano. Un mock che rispondesse sempre «admin» renderebbe quel gruppo
 * incapace di fallire.
 */
const identita = vi.hoisted(() => ({ ruolo: 'admin' }));
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => identita.ruolo,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { AgendaScadenze } from '@/components/features/admin/pagamenti/AgendaScadenze';

/**
 * Gli importi della Contabilità a SCHERMO, in italiano.
 *
 * Il difetto misurato: su `/admin/pagamenti` le 4 card KPI stampavano «€ 2892.00» — punto
 * decimale e migliaia non raggruppate — mentre il tab «Cassa», a un clic di distanza, mostrava
 * «€ 2.301,62» perché passa da `formatEuro`. Due formati di valuta nella stessa schermata.
 *
 * Il test di `formatEuro` (in `__tests__/format/valuta.test.ts`) era verde: collaudava la
 * FUNZIONE, non i punti d'uso. Questi test guardano invece quello che l'operatore legge davvero,
 * ed è l'unico posto dove il difetto era visibile.
 *
 * Gli importi scelti sono a quattro cifre di proposito: l'it-IT ha `minimumGroupingDigits = 2`,
 * quindi 1234 è precisamente il numero che smaschera sia il punto decimale sia il raggruppamento
 * mancante.
 *
 * ─── ⚠️ IL CALENDARIO NON È UN DETTAGLIO, QUI ───────────────────────────────
 * Questo file è stato scritto il 2026-08-03 e ha cominciato a fallire da solo il
 * 2026-09-01, senza che nessuno toccasse né il test né il componente. Misurato:
 *
 *     data di esecuzione     «€ 1.234,50»    «€ 2.000,00»
 *     2026-08-03                  2 ✅             2 ✅
 *     2026-09-01                  4 ❌             2
 *     2026-10-01                  2               4 ❌
 *
 * La causa: le asserzioni contavano le occorrenze su TUTTO il documento, mentre
 * il commento accanto diceva «due card». Sotto le card ci sono l'agenda e la
 * tabella dei pagamenti, e QUALI righe mostrino dipende da che giorno è oggi:
 * ad agosto nessuno dei due pagamenti finti cadeva nel mese, la tabella era
 * vuota, e i conteggi tornavano **per coincidenza**.
 *
 * Due conseguenze, ed entrambe sono state corrette:
 *   1. si asserisce sulla SINGOLA CARD, non sul documento: che sotto ci siano
 *      quegli stessi importi è normale e non deve rompere niente;
 *   2. l'orologio è CONGELATO — e non ad agosto. Ad agosto la tabella era vuota,
 *      quindi il secondo test («nessun punto decimale in tutta la schermata»)
 *      non guardava la tabella affatto: passava perché non c'era niente da
 *      guardare. La data scelta la riempie, insieme all'agenda.
 *
 * `PROVE_SU_PIU_MESI` ripete le stesse asserzioni su tre mesi diversi: se un
 * domani qualcuno riportasse il conteggio globale, quel test lo direbbe subito
 * invece di aspettare il cambio di mese.
 */

const CATEGORIE = { success: true, data: [{ id: 'c1', nome: 'Retta', slug: 'retta' }] };
const ARUBA = { success: true, data: { abilitato: true } };

/** Due pagamenti che portano i KPI a cifre con le migliaia. */
const PAGAMENTI = {
    success: true,
    data: [
        {
            id: 'p1', alunno_id: 'a1', descrizione: 'Retta Settembre', importo: 1234.5,
            importo_pagato: 1234.5, stato: 'pagato', tipo: 'singolo', fattura_stato: 'non_richiesta',
            scadenza: '2026-09-05', categoria_id: 'c1', periodo_competenza: '2026-09-01',
            alunni: { nome: 'Mario', cognome: 'Rossi' },
        },
        {
            id: 'p2', alunno_id: 'a2', descrizione: 'Retta Ottobre', importo: 2000,
            importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', fattura_stato: 'non_richiesta',
            scadenza: '2026-10-05', categoria_id: 'c1', periodo_competenza: '2026-10-01',
            alunni: { nome: 'Ada', cognome: 'Bianchi' },
        },
    ],
};

const STUDENTS = [
    { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: 'a2', nome: 'Ada', cognome: 'Bianchi', classe_sezione: 'Girasoli', stato: 'iscritto' },
];

function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        const body =
            u.startsWith('/api/pagamenti?') ? PAGAMENTI
                : u.startsWith('/api/admin/students') ? STUDENTS
                    : u.includes('/settings/categorie') ? CATEGORIE
                        : u.includes('/settings/aruba') ? ARUBA
                            : { success: true, data: [] };
        return { ok: true, json: async () => body };
    }));
}

/**
 * Il giorno in cui gira questo file. Scelto perché **riempie** sia la tabella dei
 * pagamenti sia i bucket dell'agenda (la scadenza del 05/10 ci cade dentro): il
 * test sul formato ha così qualcosa da guardare davvero. Un giorno in cui la
 * schermata è vuota lo renderebbe verde e cieco insieme.
 */
const GIORNO_FISSO = '2026-10-01T10:00:00';

/** Le quattro card KPI, e l'importo che ciascuna deve portare. */
const ATTESI: ReadonlyArray<readonly [string, string]> = [
    ['Incassato', '€ 1.234,50'],      // l'unico `importo_pagato`
    ['Da fatturare', '€ 1.234,50'],   // lo stesso pagamento, saldato e non fatturato
    ['Da incassare', '€ 2.000,00'],
    ['Scaduto (morosità)', '€ 2.000,00'],
];

/**
 * La card KPI che porta questa etichetta.
 *
 * ⚠️ Si cerca DENTRO il blocco dei KPI, non nel documento. Le etichette non sono
 * uniche nella schermata: «Da fatturare» è anche il badge di stato di una riga
 * della tabella, e al 2026-09-01 compariva **tre volte** — una nella card e due
 * nella lista. Un `getByText` globale lì fallisce con «found multiple», e un
 * conteggio globale (com'era fino al 2026-09-01) fallisce ancora peggio: in
 * silenzio, contando importi che stanno altrove.
 */
function cardKpi(etichetta: string): HTMLElement {
    const card = within(screen.getByTestId('kpi-contabilita'))
        .getByText(etichetta)
        .closest('.rounded-card');
    if (!card) throw new Error(`card KPI «${etichetta}»: etichetta trovata, card no`);
    return card as HTMLElement;
}

describe('PaymentsDashboard — i KPI della Contabilità in formato italiano', () => {
    beforeEach(() => {
        identita.ruolo = 'admin';
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date(GIORNO_FISSO));
        stubFetch();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('ogni card KPI stampa il suo importo come «€ 1.234,50», non «€ 1234.50»', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(cardKpi('Incassato')).toHaveTextContent('€ 1.234,50'));
        for (const [etichetta, importo] of ATTESI) {
            expect(cardKpi(etichetta)).toHaveTextContent(importo);
        }
    });

    it('in tutta la schermata non resta un solo importo col punto decimale', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(screen.getAllByText('€ 1.234,50').length).toBeGreaterThan(0));
        // La tabella e l'agenda ci sono davvero, a questa data: è la parte che ad
        // agosto non veniva guardata.
        expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
        // «1.234,50» ha tre cifre dopo il punto (raggruppamento); «1234.50» ne ha due:
        // il lookahead distingue il raggruppamento italiano dai centesimi anglosassoni.
        const anglosassoni = document.body.textContent?.match(/\d\.\d{2}(?!\d)/g) ?? [];
        expect(anglosassoni).toEqual([]);
    });
});

/**
 * IL LOCK CONTRO IL RITORNO DELLA BOMBA A OROLOGERIA.
 *
 * Le stesse asserzioni, su tre mesi diversi. Con il conteggio globale di prima,
 * agosto sarebbe passato e settembre e ottobre no — cioè esattamente ciò che è
 * successo, ma **subito** invece che al cambio di mese.
 */
describe('PaymentsDashboard — le card KPI non dipendono da che giorno è oggi', () => {
    beforeEach(stubFetch);
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([
        ['2026-08-03T10:00:00', 'tabella e agenda vuote'],
        ['2026-09-01T10:00:00', 'in tabella il pagamento saldato'],
        ['2026-10-01T10:00:00', 'in tabella e in agenda quello scaduto'],
    ])('al %s (%s) le card portano gli stessi importi', async (quando) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date(quando));
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(cardKpi('Incassato')).toHaveTextContent('€ 1.234,50'));
        for (const [etichetta, importo] of ATTESI) {
            expect(cardKpi(etichetta)).toHaveTextContent(importo);
        }
    });
});

describe('PaymentsDashboard — i totali sono della Direzione (2026-09-02)', () => {
    /**
     * ⚠️ QUESTO GRUPPO COLLAUDA UN NASCONDIGLIO, NON UNA BARRIERA, e la
     * differenza va detta qui perché non si scopra dopo.
     *
     * Questi totali li somma il BROWSER (`calcolaTotaliPagamenti`) a partire
     * dalle righe che la segreteria deve legittimamente vedere: deve incassare,
     * sollecitare, fatturare. Nasconderli mette in ordine la vista; non impedisce
     * a nessuno di sommare le righe da sé, e nemmeno di esportarle in Excel
     * (`/api/pagamenti/export` resta aperto, per scelta del titolare).
     *
     * Dove il numero è un segreto vero — la home /admin, dove gli aggregati li
     * calcola il server — l'omissione è reale e ha i suoi test in
     * `__tests__/api/admin-dashboard-kpi-direzione.test.ts`.
     */
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date(GIORNO_FISSO));
        stubFetch();
    });
    afterEach(() => {
        identita.ruolo = 'admin';
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('alla SEGRETERIA il blocco dei KPI non c\'è affatto', async () => {
        identita.ruolo = 'segreteria';
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Si aspetta che la schermata sia carica guardando qualcosa che la
        // segreteria vede eccome: la riga del pagamento. Senza questa attesa il
        // test passerebbe anche su una pagina ancora vuota, cioè non proverebbe
        // niente.
        await waitFor(() => expect(screen.getByText('Retta Ottobre')).toBeInTheDocument());
        expect(screen.queryByTestId('kpi-contabilita')).toBeNull();
    });

    it('senza ruolo risolto (fetch in volo) i KPI restano nascosti', async () => {
        // `useRuoloCockpit()` vale `''` finché il provider non ha risposto. Si
        // sbaglia verso il NASCONDERE: un totale economico che compare per mezzo
        // secondo è comparso.
        identita.ruolo = '';
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(screen.getByText('Retta Ottobre')).toBeInTheDocument());
        expect(screen.queryByTestId('kpi-contabilita')).toBeNull();
    });

    it('alla DIREZIONE (coordinator) i KPI ci sono', async () => {
        identita.ruolo = 'coordinator';
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(cardKpi('Incassato')).toHaveTextContent('€ 1.234,50'));
    });
});

describe('AgendaScadenze — i totali dei bucket in formato italiano', () => {
    it('somma e stampa «€ 1.500,00» col punto separatore delle migliaia', () => {
        render(
            <AgendaScadenze
                pagamenti={[
                    { importo: 1000, importo_pagato: 0, scadenza: '2026-07-12', stato: 'da_pagare', tipo: 'singolo' },
                    { importo: 500, importo_pagato: 0, scadenza: '2026-07-13', stato: 'da_pagare', tipo: 'singolo' },
                ]}
                oggi="2026-07-10"
                attivo={null}
                onSelect={() => {}}
            />
        );
        expect(screen.getByRole('button', { name: /Questa settimana/ })).toHaveTextContent('€ 1.500,00');
        expect(document.body.textContent).not.toMatch(/\d\.\d{2}(?!\d)/);
    });

    it('senza `mostraImporti` restano i CONTEGGI e il clic, spariscono gli euro', () => {
        // Alla segreteria si tolgono gli importi, non lo strumento: i bucket sono
        // il filtro con cui trova gli scaduti da sollecitare. Toglierli interi
        // sarebbe stato levarle un pezzo di lavoro per nascondere un numero.
        const onSelect = vi.fn();
        render(
            <AgendaScadenze
                pagamenti={[
                    { importo: 1000, importo_pagato: 0, scadenza: '2026-07-12', stato: 'da_pagare', tipo: 'singolo' },
                    { importo: 500, importo_pagato: 0, scadenza: '2026-07-13', stato: 'da_pagare', tipo: 'singolo' },
                ]}
                oggi="2026-07-10"
                attivo={null}
                onSelect={onSelect}
                mostraImporti={false}
            />
        );
        const bucket = screen.getByRole('button', { name: /Questa settimana/ });
        expect(bucket).not.toHaveTextContent('€');
        expect(bucket).toHaveTextContent('2');
        bucket.click();
        expect(onSelect).toHaveBeenCalled();
    });
});
