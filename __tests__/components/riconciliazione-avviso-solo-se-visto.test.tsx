import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 L'AVVISO ALLE FAMIGLIE PARTE SOLO SE QUALCUNO HA GUARDATO L'ELENCO.
 *
 * È la decisione del titolare che tutto questo lotto esiste per proteggere: gli
 * abbinamenti automatici NON avvisano nessuno (la fase automatica tace apposta —
 * un avviso mandato non si disfa, e la macchina può sbagliare); l'avviso parte
 * quando **la segreteria ha guardato il riepilogo e non l'ha annullato**.
 *
 * Il difetto che questi test chiudono era proprio lì: il pannello mandava la POST
 * a `riepilogo-visto` a OGNI chiusura del popup, senza distinguere «ho letto
 * l'elenco e l'ho lasciato stare» da «non sono riuscito a leggerlo». Bastava un
 * 503 sulla lettura, o un'uscita mentre l'elenco era ancora in volo, e partivano
 * gli avvisi «Pagamento registrato» per tutti gli abbinamenti di quell'import —
 * senza che una riga fosse mai comparsa a schermo. È l'unica cosa irreversibile
 * del meccanismo: un annullo in blocco riprende gli storni, gli avvisi no.
 *
 * ⚠️ QUI SI MISURA IL PANNELLO, non il popup: il popup dichiara `visto`, ma è
 * questa riga a decidere se la POST parte. Il test del popup
 * (`RiepilogoImportDialog.test.tsx`) misura l'altra metà.
 *
 * ⚠️ IL PRIMO TEST È IL CONTROLLO POSITIVO, e senza non varrebbe niente il
 * resto: un pannello che non chiamasse MAI `riepilogo-visto` passerebbe tutti i
 * test negativi — cioè avvisi che non partono mai, che è il difetto opposto e
 * altrettanto reale.
 */

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

/** `logClient` spiato, il resto del modulo VERO: `nomeErrore` serve davvero al pannello. */
const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>();
  return { ...vero, logClient: logSpy };
});

const IMP = 'ffffffff-ffff-4fff-8fff-fffffffffff0';

/** Quello che il POST dell'import restituisce: due righe chiuse dalla macchina. */
const ESITO_IMPORT = {
  nuovi: 5,
  duplicati: 0,
  scartate: 0,
  suggeriti: 2,
  da_abbinare: 1,
  import_id: IMP,
  auto_singole: 1,
  auto_composite: 1,
  auto_saltati: 0,
};

/** L'elenco come lo restituisce `GET …/annulla-import`. */
const RIEPILOGO = {
  import_id: IMP,
  righe: [
    {
      id: 'm1',
      data_operazione: '2026-09-18',
      importo: 150,
      causale: 'BONIFICO RETTA',
      voce: 'Anna Bianchi · Retta ottobre',
      motivi: ['codice_voce'],
      codice: '#K7MXN3P',
      composita: false,
      fuori_perimetro: false,
    },
  ],
  n: 1,
  oltre_tetto: false,
  tetto: 200,
  annullabile: true,
  fuori_perimetro: 0,
};

type Lettura = 'ok' | 'rifiutata' | 'pendente';

/**
 * Lo stato della lettura è una SCATOLA mutabile, non un parametro fisso: l'ultimo
 * test deve poter far guarire il server fra una chiusura e la successiva — che è
 * esattamente il rimedio che si sta misurando (riapri, e allora l'avviso parte).
 */
/** Una fattura rimasta viva su un movimento riaperto: `numeri` è ciò che si mostra. */
type FattureVive = { movimento_id: string; numeri: string[] }[];

/** L'esito dello storno in blocco: `falliti` è ciò che distingue i due rami. */
const esitoAnnullo = (falliti: number, fatture: FattureVive = []) => ({
  riaperti: RIEPILOGO.n - falliti,
  falliti: Array.from({ length: falliti }, (_, i) => ({
    movimento_id: `m${i}`,
    stato: 409,
    codice: 'RIAPERTURA_CREDITO_SPESO',
  })),
  credito_gia_speso: falliti,
  incassi_stornati: RIEPILOGO.n - falliti,
  transazioni_annullate: 0,
  fatture,
});

interface Scenario {
  lettura: Lettura;
  falliti?: number;
  /** Le fatture che l'annullo ha trovato ancora valide: il punto 5 della consegna. */
  fatture?: FattureVive;
  /** `riepilogo-visto` ha letto solo una parte dell'import: quante righe. */
  vistoTroncato?: number;
}

function stubFetch(box: Scenario | Lettura = 'ok') {
  const stato: Scenario = typeof box === 'string' ? { lettura: box, falliti: 0 } : box;
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    const lettura = stato.lettura;
    // ⚠️ Prima le due rotte figlie: il loro indirizzo CONTIENE quello del
    // registro, e un `includes` nell'ordine sbagliato risponderebbe l'elenco dei
    // movimenti a una richiesta di riepilogo — verde per la ragione sbagliata.
    if (u.includes('/riconciliazione/annulla-import')) {
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: esitoAnnullo(stato.falliti ?? 0, stato.fatture ?? []) }),
        };
      }
      if (lettura === 'pendente') return new Promise(() => {});
      if (lettura === 'rifiutata') {
        return { ok: false, status: 503, json: async () => ({ error: 'giù', codice: 'ANNULLO_IMPORT_NON_LETTO' }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, disponibile: true, data: RIEPILOGO }) };
    }
    if (u.includes('/riconciliazione/riepilogo-visto')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            letti: stato.vistoTroncato ?? 2,
            notificati: 2,
            gia_notificati: 0,
            troncato: stato.vistoTroncato !== undefined,
          },
        }),
      };
    }
    if (u.includes('/api/pagamenti/riconciliazione')) {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, data: ESITO_IMPORT }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [], fatturazione_disponibile: true, conteggi: { da_fatturare: 0, fatturate: 0, parziale: false } }),
      };
    }
    if (u.includes('/api/pagamenti?')) return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

/** Carica un estratto conto e aspetta che il riepilogo si apra da solo. */
async function importaEApri(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['data;importo'], 'estratto.csv', { type: 'text/csv' })] },
  });
  // Si aspetta la PRESENZA del pulsante di chiusura del popup: «il popup non c'è»
  // sarebbe vero anche mentre l'import è ancora in volo.
  return screen.findByTestId('riepimp-chiudi');
}

const postVisto = (f: ReturnType<typeof stubFetch>) =>
  f.mock.calls.filter(([u]) => String(u).includes('/riconciliazione/riepilogo-visto'));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('«riepilogo visto» parte dalla chiusura, ma solo da quella che ha guardato', () => {
  beforeEach(() => vi.clearAllMocks());

  it('✅ CONTROLLO POSITIVO: elenco letto e chiuso ⇒ la POST a `riepilogo-visto` parte', async () => {
    const f = stubFetch('ok');
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    // L'elenco è DAVVERO a schermo: è la condizione di cui la POST è la
    // conseguenza, e va verificata, non presunta. Si aspetta una PRESENZA —
    // il popup si monta prima che la GET risponda.
    expect(await screen.findByText('Anna Bianchi · Retta ottobre')).toBeInTheDocument();

    fireEvent.click(chiudi);
    await waitFor(() => expect(postVisto(f)).toHaveLength(1));
    const [, init] = postVisto(f)[0] as [string, { method: string; body: string }];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ import_id: IMP });
  });

  it('🔴 lettura RIFIUTATA e popup chiuso ⇒ NESSUNA POST: nessuno ha visto una riga', async () => {
    const f = stubFetch('rifiutata');
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    // A schermo c'è il guasto, non l'elenco: si aspetta la sua PRESENZA.
    await screen.findByText(/nessuna riga è stata toccata/);

    fireEvent.click(chiudi);
    // Si aspetta un fatto POSITIVO — il popup smontato — prima di misurare
    // l'assenza: «non è ancora partita» sarebbe vero anche un istante dopo il
    // click, e il test passerebbe anche sul codice difettoso.
    await waitFor(() => expect(screen.queryByTestId('riepimp-chiudi')).toBeNull());
    expect(postVisto(f)).toHaveLength(0);
  });

  it('🔴 popup chiuso MENTRE CARICA ⇒ NESSUNA POST: l’Escape di mezzo secondo non è un consenso', async () => {
    const f = stubFetch('pendente');
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    // Il popup è nello stato di caricamento: l'elenco non è mai comparso. Si
    // guarda il CORPO del popup — la frase sta anche nel titolo, e un
    // `getByText` su due sosia fallisce invece di misurare.
    expect(screen.getByTestId('riepimp-corpo')).toHaveTextContent(/Sto leggendo che cosa è stato chiuso/);

    fireEvent.click(chiudi);
    await waitFor(() => expect(screen.queryByTestId('riepimp-chiudi')).toBeNull());
    expect(postVisto(f)).toHaveLength(0);
  });

  it('il rimedio esiste: si riapre dalla fascia, e ALLORA l’avviso parte', async () => {
    // «Nel dubbio non avvisare» sarebbe solo un avviso perso, se non ci fosse la
    // via di ritorno: il pulsante della fascia riapre l'elenco sullo stesso
    // import, e la rotta è idempotente. Qui il server guarisce fra le due
    // chiusure, ed è la seconda a far partire la POST.
    const box: { lettura: Lettura } = { lettura: 'rifiutata' };
    const f = stubFetch(box);
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    await screen.findByText(/nessuna riga è stata toccata/);
    fireEvent.click(chiudi);
    await waitFor(() => expect(screen.queryByTestId('riepimp-chiudi')).toBeNull());
    expect(postVisto(f)).toHaveLength(0);

    // La fascia non è scaduta con la chiusura: l'`import_id` è ancora lì.
    box.lettura = 'ok';
    fireEvent.click(screen.getByTestId('recon-vedi-riepilogo-auto'));
    expect(await screen.findByText('Anna Bianchi · Retta ottobre')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('riepimp-chiudi'));
    await waitFor(() => expect(postVisto(f)).toHaveLength(1));
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DOPO UN ANNULLO PARZIALE LA PORTA RESTA APERTA.
 *
 * L'annullo in blocco non è atomico: sono N storni indipendenti, e qualcuno può
 * non riuscire (credito già speso, `KV410`). Quelle righe restano `confermato`
 * con la marca accesa — cioè famiglie che aspettano ancora il loro avviso.
 * Buttando via l'`import_id` non resterebbe nessuna porta da cui farlo partire:
 * né la riapertura del riepilogo né `riepilogo-visto`. Il pulsante della fascia
 * è quella porta, e dopo un annullo parziale deve restare.
 *
 * ⚠️ Col ramo «tutto riaperto» accanto, che è il controllo: se la fascia restasse
 * SEMPRE, il primo test passerebbe senza misurare niente.
 */
describe('annullo parziale: la fascia resta, perché restano righe da avvisare', () => {
  const annulla = async (container: HTMLElement) => {
    const chiudi = await importaEApri(container);
    await screen.findByText('Anna Bianchi · Retta ottobre');
    fireEvent.change(screen.getByTestId('riepimp-conferma'), { target: { value: String(RIEPILOGO.n) } });
    fireEvent.click(screen.getByTestId('riepimp-annulla'));
    await waitFor(() => expect(screen.queryByTestId('riepimp-chiudi')).toBeNull());
    return chiudi;
  };

  it('🔴 qualcosa NON è tornato in coda ⇒ «Vedi e annulla» è ancora lì', async () => {
    const f = stubFetch({ lettura: 'ok', falliti: 1 });
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await annulla(container);

    // Il fatto positivo da aspettare è la fascia dell'esito: senza, «il pulsante
    // c'è ancora» sarebbe vero anche prima che il pannello abbia reagito.
    await screen.findByText(/non è stato riaperto/);
    expect(screen.getByTestId('recon-vedi-riepilogo-auto')).toBeInTheDocument();
    // E l'annullo non manda avvisi: è ciò che si è appena disfatto.
    expect(postVisto(f)).toHaveLength(0);
  });

  it('✅ CONTROLLO: tutto riaperto ⇒ la fascia sparisce, non c’è più niente da guardare', async () => {
    const f = stubFetch({ lettura: 'ok', falliti: 0 });
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await annulla(container);

    await screen.findByText(/è tornato in coda\./);
    expect(screen.queryByTestId('recon-vedi-riepilogo-auto')).toBeNull();
    expect(postVisto(f)).toHaveLength(0);
  });

  /**
   * ─── LE FATTURE RIMASTE VIVE ARRIVANO A CHI OPERA ─────────────────────────
   *
   * Punto 5 della consegna: l'avviso sulle fatture si AGGREGA in «un elenco di
   * movimenti con i numeri di fattura». Il server lo costruiva davvero e lo
   * mandava nella risposta; il pannello mostrava solo riaperti e falliti, quindi
   * i numeri dei documenti — l'unica cosa con cui l'operatrice può andare ad
   * annullarli — non comparivano da nessuna parte. Il popup dice PRIMA, in
   * prosa, che le fatture emesse restano emesse: questo è il DOPO, cioè quali.
   */
  it('🔴 l’annullo lascia fatture vive ⇒ i NUMERI dei documenti finiscono a schermo', async () => {
    const f = stubFetch({
      lettura: 'ok',
      falliti: 0,
      fatture: [{ movimento_id: 'm1', numeri: ['12/2026', '13/2026'] }],
    });
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await annulla(container);

    const fascia = await screen.findByTestId('recon-annullo-fatture');
    expect(fascia).toHaveTextContent('12/2026');
    expect(fascia).toHaveTextContent('13/2026');
  });

  it('✅ CONTROLLO: nessuna fattura viva ⇒ nessun elenco (ed è il caso normale)', async () => {
    // L'automatismo non emette fatture: questo elenco dovrebbe essere vuoto
    // sempre. Senza questo controllo il test qui sopra passerebbe anche con una
    // fascia mostrata comunque, cioè con un avviso che grida sul caso normale.
    const f = stubFetch({ lettura: 'ok', falliti: 0 });
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await annulla(container);

    await screen.findByText(/è tornato in coda\./);
    expect(screen.queryByTestId('recon-annullo-fatture')).toBeNull();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 GLI AVVISI CHE NON SONO PARTITI SI DICONO, NON SI LOGGANO E BASTA.
 *
 * `riepilogo-visto` risponde `troncato: true` quando la finestra di lettura si
 * è chiusa prima dell'import: le righe oltre non hanno ricevuto l'avviso, e
 * riaprire il riepilogo NON le recupera — l'ordine di lettura è stabile e la
 * rotta ripescherebbe sempre le stesse. Il campo esisteva già; l'unico
 * chiamante guardava solo `r.ok` e lo buttava, quindi a schermo non compariva
 * niente e il solo segnale era un campo dentro un log.
 *
 * ⚠️ Col ramo normale accanto, che è il controllo: se la fascia comparisse
 * sempre, il primo test passerebbe senza misurare niente — e su ogni import
 * l'operatrice leggerebbe un allarme falso.
 */
describe('il troncamento degli avvisi arriva a schermo', () => {
  it('🔴 `troncato` nella risposta ⇒ la fascia dice quante righe sono state avvisate', async () => {
    const f = stubFetch({ lettura: 'ok', vistoTroncato: 2000 });
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    await screen.findByText('Anna Bianchi · Retta ottobre');

    fireEvent.click(chiudi);
    const fascia = await screen.findByTestId('recon-avvisi-troncati');
    // La frase deve dire la cosa che non si recupera da sola: riaprire il
    // riepilogo non serve. È l'unica informazione che rende il guasto riparabile
    // a mano, ed è il motivo per cui questa fascia esiste.
    expect(fascia).toHaveTextContent(/riaprire il riepilogo non le recupera/);
    expect(fascia).toHaveTextContent(/2\D?000/);
  });

  it('✅ CONTROLLO: risposta non troncata ⇒ nessuna fascia', async () => {
    const f = stubFetch('ok');
    vi.stubGlobal('fetch', f);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const chiudi = await importaEApri(container);
    await screen.findByText('Anna Bianchi · Retta ottobre');

    fireEvent.click(chiudi);
    // Si aspetta un fatto POSITIVO — la POST partita — prima di misurare
    // l'assenza: «la fascia non c'è» sarebbe vero anche un istante dopo il
    // click, e il test passerebbe anche sul codice difettoso.
    await waitFor(() => expect(postVisto(f)).toHaveLength(1));
    expect(screen.queryByTestId('recon-avvisi-troncati')).toBeNull();
  });
});
