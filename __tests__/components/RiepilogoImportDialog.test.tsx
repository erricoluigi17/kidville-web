import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RiepilogoImportDialog } from '@/components/features/admin/pagamenti/RiepilogoImportDialog';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IL RIEPILOGO DELL'IMPORT — e la conferma che si DIGITA.
 *
 * ─── LA DECISIONE CHE QUESTI TEST TENGONO FERMA ─────────────────────────────
 *
 * Per annullare in blocco si scrive **il numero** dei movimenti da riaprire. Non
 * una spunta: una spunta si clicca di riflesso, e questo è il gesto che storna
 * denaro vero. Il numero, a differenza di una parola fissa, **cambia da un
 * import all'altro** — per scriverlo bisogna guardare l'elenco che si sta per
 * disfare, che è tutto il punto.
 *
 * ⚠️ E IL NUMERO È QUELLO DEL SERVER, non la lunghezza dell'elenco disegnato:
 * sono lo stesso numero solo finché a dirlo è una fonte sola. Qui si misura
 * proprio quello — un numero «quasi giusto» non abilita niente.
 *
 * ─── L'ALTRA DECISIONE: CHIUDERE NON È ANNULLARE ────────────────────────────
 *
 * «Chiudi» significa «ho guardato, va bene così», ed è il gesto da cui parte
 * l'avviso alle famiglie (la fase automatica non ne manda apposta). Perciò le
 * due uscite del popup chiamano due callback DIVERSE, e il test lo verifica in
 * entrambi i versi: dopo un annullo riuscito `onChiudi` NON deve scattare, o si
 * manderebbero gli avvisi di ciò che si è appena disfatto.
 */

const IMP = 'ffffffff-ffff-4fff-8fff-fffffffffff0';

/** L'elenco come lo restituisce `GET …/annulla-import`. */
const RIGHE = [
    {
        id: 'm1',
        data_operazione: '2026-09-18',
        importo: 150,
        causale: 'BONIFICO RETTA OTTOBRE #K7MXN3P',
        voce: 'Anna Bianchi · Retta ottobre',
        motivi: ['codice_voce', 'residuo_esatto'],
        codice: '#K7MXN3P',
        composita: false,
        fuori_perimetro: false,
    },
    {
        id: 'm2',
        data_operazione: '2026-09-19',
        importo: 300,
        causale: 'BONIFICO FAMIGLIA',
        voce: 'Luca Verdi · Retta ottobre',
        motivi: ['codice_fiscale', 'somma_esatta'],
        codice: null,
        composita: true,
        fuori_perimetro: false,
    },
];

const dati = (over: Record<string, unknown> = {}) => ({
    import_id: IMP,
    righe: RIGHE,
    n: RIGHE.length,
    oltre_tetto: false,
    tetto: 200,
    annullabile: true,
    fuori_perimetro: 0,
    ...over,
});

function stubFetch(over: Record<string, unknown> = {}, esitoPost?: Record<string, unknown>) {
    return vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
            return {
                ok: true,
                status: 200,
                json: async () =>
                    esitoPost ?? {
                        success: true,
                        data: {
                            riaperti: 2,
                            falliti: [],
                            credito_gia_speso: 0,
                            incassi_stornati: 2,
                            transazioni_annullate: 1,
                            fatture: [],
                        },
                    },
            };
        }
        expect(String(url)).toContain(`import_id=${IMP}`);
        return { ok: true, status: 200, json: async () => ({ success: true, disponibile: true, data: dati(over) }) };
    });
}

const monta = (props: Partial<Parameters<typeof RiepilogoImportDialog>[0]> = {}) => {
    const onChiudi = vi.fn();
    const onAnnullato = vi.fn();
    render(
        <RiepilogoImportDialog importId={IMP} userId="u1" onChiudi={onChiudi} onAnnullato={onAnnullato} {...props} />,
    );
    return { onChiudi, onAnnullato };
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('l’elenco: che cosa ha chiuso la macchina, e PERCHÉ', () => {
    beforeEach(() => vi.stubGlobal('fetch', stubFetch()));

    it('mostra importo, voce e il motivo in parole — col codice, quando c’è', async () => {
        monta();
        expect(await screen.findByText('Anna Bianchi · Retta ottobre')).toBeInTheDocument();
        // Il codice si legge dal CAMPO, non dalla frase: qui si verifica che a
        // schermo ci finisca davvero.
        expect(screen.getByText(/codice voce #K7MXN3P/)).toBeInTheDocument();
        expect(screen.getByText(/importo esatto/)).toBeInTheDocument();
        // La riga composita dice l'altra coppia di motivi.
        expect(screen.getByText(/codice fiscale in causale · somma esatta delle voci/)).toBeInTheDocument();
    });

    it('il conteggio in testa è quello che poi va digitato', async () => {
        monta();
        expect(await screen.findByText('2 movimenti chiusi da soli')).toBeInTheDocument();
    });

    it('🔴 l’elenco si chiede UNA volta sola, non a ogni render', async () => {
        // ⚠️ QUESTO TEST NASCE DA UN DIFETTO VERO, trovato mentre lo si scriveva:
        // finché la frase d'errore stava dentro lo stato, `carica` doveva
        // chiamare `t()`; `t` finiva nelle dipendenze della sua `useCallback`;
        // `useTranslations` ricrea `t` a OGNI render; e l'effetto che chiama
        // `carica` ripartiva ogni volta. Una GET dietro l'altra — ed è lo stesso
        // difetto che `RiconciliazionePanel` ha già pagato una volta, misurato in
        // 1.470 richieste in 300 ms. Il sintomo visibile era peggiore del
        // traffico: ogni risposta azzerava l'errore appena scritto dall'annullo,
        // quindi un rifiuto del server non compariva MAI a schermo.
        const fetchMock = stubFetch();
        vi.stubGlobal('fetch', fetchMock);
        monta();
        await screen.findByText('Anna Bianchi · Retta ottobre');
        // Si digita: è un render in più, e prima ne provocava un'altra.
        fireEvent.change(screen.getByTestId('riepimp-conferma'), { target: { value: '1' } });
        fireEvent.change(screen.getByTestId('riepimp-conferma'), { target: { value: '2' } });
        await new Promise((r) => setTimeout(r, 30));
        const get = fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method !== 'POST');
        expect(get).toHaveLength(1);
    });
});

describe('la conferma si DIGITA, e si digita il numero', () => {
    beforeEach(() => vi.stubGlobal('fetch', stubFetch()));

    it('il pulsante nasce SPENTO: senza il numero non si storna niente', async () => {
        monta();
        const bottone = (await screen.findByTestId('riepimp-annulla')) as HTMLButtonElement;
        expect(bottone.disabled).toBe(true);
    });

    it('🔴 un numero SBAGLIATO non lo accende (nemmeno uno vicino)', async () => {
        monta();
        const campo = await screen.findByTestId('riepimp-conferma');
        fireEvent.change(campo, { target: { value: '3' } });
        expect((screen.getByTestId('riepimp-annulla') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(campo, { target: { value: '1' } });
        expect((screen.getByTestId('riepimp-annulla') as HTMLButtonElement).disabled).toBe(true);
    });

    it('il numero GIUSTO lo accende, e l’annullo parte con `conferma: true`', async () => {
        const fetchMock = stubFetch();
        vi.stubGlobal('fetch', fetchMock);
        const { onAnnullato, onChiudi } = monta();

        fireEvent.change(await screen.findByTestId('riepimp-conferma'), { target: { value: '2' } });
        const bottone = screen.getByTestId('riepimp-annulla') as HTMLButtonElement;
        expect(bottone.disabled).toBe(false);
        fireEvent.click(bottone);

        await waitFor(() => expect(onAnnullato).toHaveBeenCalledTimes(1));
        const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === 'POST');
        expect(JSON.parse((post![1] as { body: string }).body)).toEqual({ import_id: IMP, conferma: true });
        expect(onAnnullato.mock.calls[0][0]).toMatchObject({ riaperti: 2 });
        // 🔴 Dopo un annullo NON si chiude passando da `onChiudi`: quello manda
        // gli avvisi alle famiglie, e qui non c'è più nessun pagamento da
        // annunciare — si è appena disfatto.
        expect(onChiudi).not.toHaveBeenCalled();
    });

    it('gli spazi attorno al numero non contano, il testo sì', async () => {
        monta();
        const campo = await screen.findByTestId('riepimp-conferma');
        fireEvent.change(campo, { target: { value: ' 2 ' } });
        expect((screen.getByTestId('riepimp-annulla') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.change(campo, { target: { value: 'due' } });
        expect((screen.getByTestId('riepimp-annulla') as HTMLButtonElement).disabled).toBe(true);
    });

    it('dice in PROSA che cosa succede, fatture comprese', async () => {
        monta();
        expect(
            await screen.findByText(/Le 2 righe tornano in coda, gli incassi vengono stornati e i saldi ticket rientrano/),
        ).toBeInTheDocument();
        expect(
            screen.getByText('Le fatture già emesse restano emesse e vanno annullate a parte.'),
        ).toBeInTheDocument();
    });
});

describe('quando il pulsante NON si offre, si dice perché — prima, non dopo', () => {
    it('righe di una sede che non gestisci: nessun campo, nessun pulsante, una frase', async () => {
        vi.stubGlobal('fetch', stubFetch({ annullabile: false, fuori_perimetro: 1 }));
        monta();
        expect(await screen.findByText(/non gestisci/)).toBeInTheDocument();
        expect(screen.queryByTestId('riepimp-annulla')).toBeNull();
        expect(screen.queryByTestId('riepimp-conferma')).toBeNull();
    });

    it('oltre il tetto: si rimanda al registro filtrato per import', async () => {
        vi.stubGlobal('fetch', stubFetch({ annullabile: false, oltre_tetto: true }));
        monta();
        expect(await screen.findByText(/riaprili a gruppi/)).toBeInTheDocument();
        expect(screen.queryByTestId('riepimp-annulla')).toBeNull();
    });

    it('marca assente sull’ambiente: si dice, invece di mostrare un elenco vuoto', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ success: true, disponibile: false, data: null }),
        })));
        monta();
        // Un elenco vuoto si leggerebbe come «non ha chiuso niente», che è
        // un'altra affermazione e sarebbe falsa.
        expect(await screen.findByText(/non è disponibile su questo ambiente/)).toBeInTheDocument();
        expect(screen.queryByTestId('riepimp-annulla')).toBeNull();
    });
});

describe('chiudere NON è annullare', () => {
    beforeEach(() => vi.stubGlobal('fetch', stubFetch()));

    it('«Chiudi» chiama `onChiudi(true)` — è il gesto da cui partono gli avvisi', async () => {
        const { onChiudi, onAnnullato } = monta();
        fireEvent.click(await screen.findByTestId('riepimp-chiudi'));
        expect(onChiudi).toHaveBeenCalledTimes(1);
        // `true` = «l'elenco era a schermo, e l'ho lasciato stare».
        expect(onChiudi).toHaveBeenCalledWith(true);
        expect(onAnnullato).not.toHaveBeenCalled();
    });

    it('anche la ✕ della testa passa da `onChiudi`', async () => {
        const { onChiudi } = monta();
        fireEvent.click(await screen.findByRole('button', { name: 'Chiudi il riepilogo dell’import' }));
        expect(onChiudi).toHaveBeenCalledTimes(1);
        expect(onChiudi).toHaveBeenCalledWith(true);
    });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 CHIUDERE UNA SCHERMATA VUOTA NON È «AVER GUARDATO».
 *
 * Questi tre test stanno sul cuore della decisione del titolare: l'avviso alle
 * famiglie parte quando la segreteria **ha guardato** il riepilogo e non l'ha
 * annullato. Finché la chiusura era una sola, il popup non sapeva distinguere
 * «ho letto l'elenco e l'ho lasciato stare» da «non sono riuscito a leggerlo» —
 * e le due uscite che non mostrano NIENTE (la lettura fallita, e l'uscita mentre
 * l'elenco è ancora in volo) mandavano comunque gli avvisi di tutto l'import.
 * Avvisi che nessun annullo riprende: sono l'unica cosa irreversibile di questo
 * meccanismo, e partivano proprio quando nessuno aveva visto una riga.
 *
 * ⚠️ Il controllo POSITIVO sta qui sopra (`onChiudi(true)` a lettura riuscita):
 * senza, un componente che chiamasse SEMPRE `onChiudi(false)` passerebbe tutti e
 * tre questi test — cioè un popup da cui nessun avviso parte mai.
 */
describe('🔴 l’avviso parte solo se l’elenco è stato davvero mostrato', () => {
    it('chiusura dopo una LETTURA FALLITA ⇒ `onChiudi(false)`: nessun avviso', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 503,
            json: async () => ({ error: 'guasto', codice: 'ANNULLO_IMPORT_NON_LETTO' }),
        })));
        const { onChiudi } = monta();
        // Si aspetta la PRESENZA del guasto, non l'assenza dell'elenco: «non c'è
        // la lista» è vero anche mentre la fetch è ancora in volo.
        await screen.findByText(/nessuna riga è stata toccata/);
        fireEvent.click(screen.getByTestId('riepimp-chiudi'));
        expect(onChiudi).toHaveBeenCalledWith(false);
    });

    it('chiusura MENTRE CARICA ⇒ `onChiudi(false)`: l’Escape di mezzo secondo non è un consenso', async () => {
        // Una GET che non risponde mai: il popup resta nello stato di
        // caricamento, che è esattamente la finestra in cui si può uscire con
        // Escape o dallo sfondo senza aver visto niente.
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const { onChiudi } = monta();
        // Il caricamento è a schermo: si aspetta la presenza di quello.
        expect(await screen.findByRole('status')).toHaveTextContent(/Sto leggendo che cosa è stato chiuso/);
        fireEvent.click(screen.getByTestId('riepimp-chiudi'));
        expect(onChiudi).toHaveBeenCalledWith(false);
    });

    it('chiusura dopo un ANNULLO RIFIUTATO ⇒ `onChiudi(false)`: chi chiudeva voleva disfare', async () => {
        const fetchMock = stubFetch();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
            if (init?.method === 'POST') {
                return { ok: false, status: 403, json: async () => ({ error: 'no', codice: 'ANNULLO_IMPORT_FUORI_PERIMETRO' }) };
            }
            return fetchMock(url, init);
        }));
        const { onChiudi } = monta();
        fireEvent.change(await screen.findByTestId('riepimp-conferma'), { target: { value: '2' } });
        fireEvent.click(screen.getByTestId('riepimp-annulla'));
        await screen.findByText(/annullarli è uno storno/);
        fireEvent.click(screen.getByTestId('riepimp-chiudi'));
        // L'elenco lo si era letto, ma chi chiude aveva appena chiesto di
        // DISFARLO: mandare gli avvisi di quelle righe sarebbe il verso
        // sbagliato. Si tace, e il riepilogo resta riapribile dalla fascia.
        expect(onChiudi).toHaveBeenCalledWith(false);
    });
});

describe('gli errori si dicono, non si tacciono', () => {
    it('un rifiuto del server sull’annullo resta a schermo, e non si dichiara fatto', async () => {
        const fetchMock = stubFetch();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
            if (init?.method === 'POST') {
                return {
                    ok: false,
                    status: 403,
                    json: async () => ({ error: 'fuori perimetro', codice: 'ANNULLO_IMPORT_FUORI_PERIMETRO' }),
                };
            }
            return fetchMock(url, init);
        }));
        const { onAnnullato } = monta();

        fireEvent.change(await screen.findByTestId('riepimp-conferma'), { target: { value: '2' } });
        fireEvent.click(screen.getByTestId('riepimp-annulla'));

        // La frase è quella del CATALOGO, non la prosa italiana del server: il
        // codice è dichiarato in `CODICI_ERRORE`.
        expect(await screen.findByText(/annullarli è uno storno/)).toBeInTheDocument();
        expect(onAnnullato).not.toHaveBeenCalled();
    });

    it('la lettura fallita non diventa un elenco vuoto', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => ({ error: 'guasto', codice: 'ANNULLO_IMPORT_NON_LETTO' }),
        })));
        monta();
        expect(await screen.findByText(/nessuna riga è stata toccata/)).toBeInTheDocument();
        expect(screen.queryByTestId('riepimp-annulla')).toBeNull();
    });
});
