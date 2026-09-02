import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

import itTeacherServizi from '../../messages/it/teacherServizi.json';
import itShared from '../../messages/it/shared.json';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * «MODULISTICA» DEL DOCENTE — i filtri che vanno SUL SERVER.
 *
 *  1. 🔴 IL PARAMETRO CHE ESISTEVA E NESSUNO MANDAVA.
 *     `GET /api/teacher/medical-certificates` dichiara `stato` nel proprio schema
 *     `zod` dal primo giorno e lo applica con `.eq('stato', stato)`. L'interfaccia
 *     non gliel'ha mai passato: la scheda scaricava tutto — validati, rifiutati e
 *     nuovi mescolati — e chi doveva validare i certificati di oggi se li cercava
 *     a occhio. Non c'era una riga da scrivere sul server: bastava dire il nome.
 *     Il banco puro verifica che il NOME coincida con lo schema; qui si verifica
 *     che parta davvero, dentro una `fetch` vera.
 *
 *  2. LA CORNICE CHE NON SI SVUOTA. Sezione e modulo non sono filtri: sono la
 *     domanda. «Pulisci filtri» non li tocca e non entrano nel conteggio — se li
 *     azzerasse, il gesto che promette di rimettere ordine lascerebbe una
 *     schermata vuota che nessun messaggio saprebbe spiegare.
 *
 *  3. VUOTO ≠ NESSUN RISULTATO, come per la famiglia: `certificati_medici` ha zero
 *     righe in produzione.
 *
 * ⚠️ Nessun dato personale nei dati di prova: il repository è PUBBLICO.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const DOCENTE = 'e0000000-0000-4000-8000-00000000000e';

const h = vi.hoisted(() => ({ fetchMock: vi.fn(), query: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/teacher/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: DOCENTE, ruolo: 'educator', pronto: true }),
}));

const MODULO = {
  id: 'form-1',
  title: 'Autorizzazione gita al museo',
  description: '',
  target_classes: ['Girasoli', 'Margherite'],
};

const ALUNNI = [
  { student_id: 'a1', nome: 'Primo', cognome: 'Diprova', status: 'green', submission: null },
  { student_id: 'a2', nome: 'Seconda', cognome: 'Esempio', status: 'red', submission: null },
];

const CERTIFICATO = {
  id: 'cert-1',
  alunno_id: 'a1',
  nome_alunno: 'Primo',
  cognome_alunno: 'Diprova',
  file_path: 'x/y.pdf',
  data_inizio: '2026-08-20',
  data_fine: '2026-08-24',
  stato: 'in_validazione',
  note: '',
  creato_il: '2026-08-20T08:00:00.000Z',
};

function rispondi({ certificati = [CERTIFICATO], alunni = ALUNNI, moduli = [MODULO] } = {}) {
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo });
    if (u.includes('/api/educator-sections')) return json({ sectionNames: ['Girasoli', 'Margherite'] });
    if (u.includes('/api/admin/forms')) return json(moduli);
    if (u.includes('/api/teacher/modulistica')) return json(alunni);
    if (u.includes('/api/teacher/medical-certificates')) return json({ success: true, data: certificati });
    return json({});
  });
}

/** Gli indirizzi chiamati su una porta, in ordine. */
const chiamate = (frammento: string): string[] =>
  h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(frammento));

const apriScheda = (etichetta: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(etichetta, 'i') }));

/**
 * Apre il foglio dei filtri e lo restituisce.
 *
 * Sezione, modulo e stato dei certificati sono tendine, e nella variante compatta
 * `BarraFiltri` tiene in prima riga i soli campi di tipo `chip`: tutto il resto
 * scende qui. È il percorso vero su un telefono — e provare la scorciatoia
 * (toccare un controllo che a schermo non c'è) misurerebbe una schermata che non
 * esiste. Che la cornice resti comunque LEGGIBILE senza aprire niente lo dice il
 * sottotitolo della testata, «… · Sezione Girasoli».
 */
async function apriFoglio(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itShared.filtriTitolo}`) }));
  return screen.findByRole('dialog');
}

async function montaPagina() {
  const { default: Pagina } = await import('@/app/(dashboard)/teacher/modulistica/page');
  render(<Pagina />);
  await waitFor(() => expect(screen.queryByText(itTeacherServizi.modulisticaCaricamento)).toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  h.query = '';
  rispondi();
  vi.stubGlobal('fetch', h.fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · 🔴 Il filtro `stato` parte davvero
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · certificati medici', () => {
  it('la prima lettura porta già la sezione: nessuna richiesta senza cornice', async () => {
    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);

    await waitFor(() => expect(chiamate('/api/teacher/medical-certificates').length).toBeGreaterThan(0));
    for (const url of chiamate('/api/teacher/medical-certificates')) {
      expect(url).toContain('class_name=Girasoli');
    }
  });

  it('scegliendo «In validazione» il parametro `stato` arriva alla rotta', async () => {
    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);
    await screen.findByText(/Diprova/);

    const foglio = await apriFoglio();
    fireEvent.change(within(foglio).getByLabelText(itTeacherServizi.modulisticaFiltroStato), {
      target: { value: 'in_validazione' },
    });

    // È il guadagno che questo ramo esiste per incassare: prima di oggi
    // `stato=` non compariva in NESSUNA richiesta di questa schermata.
    await waitFor(() =>
      expect(chiamate('/api/teacher/medical-certificates').some((u) => u.includes('stato=in_validazione'))).toBe(true),
    );
  });

  it('a zero certificati dice VUOTO, non «nessun risultato con questi filtri»', async () => {
    rispondi({ certificati: [] });
    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);

    expect(await screen.findByText(itTeacherServizi.modulisticaNessunCert)).toBeInTheDocument();
    expect(screen.queryByText(itShared.filtriSenzaRisultatiTitolo)).toBeNull();
  });

  it('con una ricerca che non pesca nulla dice «nessun risultato»', async () => {
    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);
    await screen.findByText(/Diprova/);

    fireEvent.change(screen.getByRole('searchbox', { name: itTeacherServizi.modulisticaFiltroCercaAlunno }), {
      target: { value: 'cognome-che-non-esiste' },
    });

    expect(await screen.findByText(itShared.filtriSenzaRisultatiTitolo)).toBeInTheDocument();
    expect(screen.queryByText(itTeacherServizi.modulisticaNessunCert)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · La cornice: sezione e modulo non sono filtri
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · semaforo', () => {
  it('la sezione e il modulo partono nella query, e l’elenco si disegna', async () => {
    await montaPagina();

    await waitFor(() => expect(chiamate('/api/teacher/modulistica').length).toBeGreaterThan(0));
    const ultima = chiamate('/api/teacher/modulistica').at(-1) ?? '';
    expect(ultima).toContain('class_name=Girasoli');
    expect(ultima).toContain('form_id=form-1');
    expect(await screen.findByText(/Esempio/)).toBeInTheDocument();
  });

  it('la cornice NON è contata fra i filtri attivi: la pastiglia resta senza numero', async () => {
    await montaPagina();
    await screen.findByText(/Esempio/);

    // `conteggio-filtri` esiste solo quando `nAttivi > 0`. Sezione e modulo sono
    // `obbligatorio: true`: sono la domanda, non una restrizione aggiunta.
    expect(screen.queryByTestId('conteggio-filtri')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: itTeacherServizi.modulisticaFiltroCercaAlunno }), {
      target: { value: 'esempio' },
    });
    expect(await screen.findByTestId('conteggio-filtri')).toHaveTextContent('1');
  });

  it('«Pulisci filtri» toglie la ricerca e LASCIA la sezione e il modulo', async () => {
    await montaPagina();
    await screen.findByText(/Esempio/);

    fireEvent.change(screen.getByRole('searchbox', { name: itTeacherServizi.modulisticaFiltroCercaAlunno }), {
      target: { value: 'esempio' },
    });
    await waitFor(() => expect(screen.queryByText(/Diprova/)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: itShared.filtriPulisci }));

    // La ricerca se n'è andata…
    expect(await screen.findByText(/Diprova/)).toBeInTheDocument();
    // …e la cornice è ancora quella: l'ultima richiesta non ha perso la sezione.
    const ultima = chiamate('/api/teacher/modulistica').at(-1) ?? '';
    expect(ultima).toContain('class_name=Girasoli');
    expect(ultima).toContain('form_id=form-1');
  });

  it('senza moduli per la sezione l’elenco è VUOTO e lo dice con la frase giusta', async () => {
    rispondi({ moduli: [], alunni: [] });
    await montaPagina();

    expect(await screen.findByText(itTeacherServizi.modulisticaNessunModuloSezione)).toBeInTheDocument();
    // Nessuna richiesta del semaforo senza un modulo: sarebbe una domanda senza oggetto.
    expect(chiamate('/api/teacher/modulistica')).toEqual([]);
  });

  it('le due schede guardano la STESSA sezione: cambiandola nel semaforo, i certificati la seguono', async () => {
    await montaPagina();
    await screen.findByText(/Esempio/);

    const foglio = await apriFoglio();
    fireEvent.change(within(foglio).getByLabelText(itTeacherServizi.modulisticaFiltroSezione), {
      target: { value: 'Margherite' },
    });
    await waitFor(() =>
      expect((chiamate('/api/teacher/modulistica').at(-1) ?? '')).toContain('class_name=Margherite'),
    );

    apriScheda(itTeacherServizi.modulisticaTabMedici);
    await waitFor(() => expect(chiamate('/api/teacher/medical-certificates').length).toBeGreaterThan(0));
    // Se le due barre tenessero due copie della sezione, qui arriverebbe ancora
    // «Girasoli»: il docente guarderebbe i certificati di un'altra sezione senza
    // che niente glielo dica.
    expect(chiamate('/api/teacher/medical-certificates').at(-1) ?? '').toContain('class_name=Margherite');
  });

  /**
   * ⚠️ L'ALTRA DIREZIONE, e questa prova esiste perché la prima NON bastava.
   *
   * Misurato: togliendo `onSezione` da `PannelloCertificatiMedici` la prova qui
   * sopra restava VERDE — perché cambia la sezione dal SEMAFORO, cioè esercita
   * solo il verso semaforo → pagina → certificati. Un test che non si è mai visto
   * fallire non è un test, e questo mezzo invariante era scoperto.
   *
   * Se la scheda dei certificati si tenesse una copia propria della sezione, il
   * difetto sarebbe silenzioso e a doppia faccia: la barra direbbe «Margherite»,
   * la testata della pagina «Girasoli», e tornando al semaforo si guarderebbero i
   * consensi di un'altra sezione senza che niente lo dica.
   */
  it('…e anche al contrario: cambiandola nei certificati, il semaforo la segue', async () => {
    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);
    await screen.findByText(/Diprova/);

    const foglio = await apriFoglio();
    fireEvent.change(within(foglio).getByLabelText(itTeacherServizi.modulisticaFiltroSezione), {
      target: { value: 'Margherite' },
    });

    // La testata della pagina è l'unica cornice sempre leggibile senza aprire il
    // foglio: se resta indietro, il docente non ha modo di accorgersi dello scarto.
    expect(await screen.findByText(/Sezione Margherite/)).toBeInTheDocument();

    apriScheda(itTeacherServizi.modulisticaTabSemaforo);
    await waitFor(() =>
      expect(chiamate('/api/teacher/modulistica').at(-1) ?? '').toContain('class_name=Margherite'),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · Le righe non spariscono mentre si ricarica
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · il ricaricamento non svuota la schermata', () => {
  it('durante una nuova lettura le righe restano, attenuate e con `aria-busy`', async () => {
    // Inizializzata con una funzione vuota e non con `null`: TypeScript non vede
    // l'assegnamento dentro l'esecutore della Promise e restringerebbe il tipo a
    // `never`, rendendo la chiamata più sotto un errore di compilazione.
    let sblocca: () => void = () => {};
    const attesa = new Promise<void>((r) => { sblocca = r; });
    h.fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo });
      if (u.includes('/api/educator-sections')) return json({ sectionNames: ['Girasoli', 'Margherite'] });
      if (u.includes('/api/admin/forms')) return json([MODULO]);
      if (u.includes('/api/teacher/medical-certificates')) {
        // La SECONDA lettura resta appesa: è il momento in cui una barra filtri
        // scritta male sostituisce la tabella con uno spinner.
        if (chiamate('/api/teacher/medical-certificates').length > 1) {
          return attesa.then(() => ({ ok: true, status: 200, json: async () => ({ success: true, data: [CERTIFICATO] }) }));
        }
        return json({ success: true, data: [CERTIFICATO] });
      }
      return json({});
    });

    await montaPagina();
    apriScheda(itTeacherServizi.modulisticaTabMedici);
    const riga = await screen.findByText(/Diprova/);
    const contenitore = riga.closest('[aria-busy]');
    expect(contenitore).not.toBeNull();

    const foglio = await apriFoglio();
    fireEvent.change(within(foglio).getByLabelText(itTeacherServizi.modulisticaFiltroStato), {
      target: { value: 'validato' },
    });

    await waitFor(() => expect(contenitore).toHaveAttribute('aria-busy', 'true'));
    // Attenuate e inerti, non sparite: chi guarda non perde il posto in cui era.
    expect(contenitore?.className).toContain('opacity-60');
    expect(contenitore?.className).toContain('pointer-events-none');
    expect(screen.getByText(/Diprova/)).toBeInTheDocument();

    sblocca();
    await waitFor(() => expect(contenitore).toHaveAttribute('aria-busy', 'false'));
  });
});
