import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

import itParentServizi from '../../messages/it/parentServizi.json';
import itShared from '../../messages/it/shared.json';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * «MODULISTICA» DEL GENITORE — la barra filtri, montata davvero.
 *
 * I descrittori hanno il loro banco puro (`__tests__/lib/filtri-modulistica-parent`),
 * che misura QUALE RIGA PASSA. Qui si monta la pagina, e si misurano le tre cose che
 * un banco puro non può vedere:
 *
 *  1. 🔴 CHE L'ELENCO SI RIEMPIA. `GET /api/parent/medical-certificates` risponde
 *     `{ success, data }` — lo fa da sempre — e questa pagina scriveva
 *     `if (Array.isArray(mData)) setMedCerts(mData)`. `Array.isArray` su un oggetto
 *     è `false`, quindi la scheda «Certificati medici» della famiglia era VUOTA
 *     SEMPRE, qualunque cosa ci fosse nel database. Nessun errore, nessun log,
 *     nessun test rosso: la stessa firma del guasto delle email di credenziali —
 *     «non c'è niente» e «non è mai arrivato niente» hanno lo stesso aspetto.
 *     Metterci sopra dei filtri senza accorgersene avrebbe voluto dire filtrare
 *     l'insieme vuoto e chiamarlo lavoro fatto.
 *
 *  2. VUOTO ≠ NESSUN RISULTATO. `forms_templates`, `forms_submissions` e
 *     `certificati_medici` hanno ZERO righe in produzione: per una famiglia questo
 *     è il caso NORMALE, non il caso limite. Dire «nessun risultato con questi
 *     filtri» a chi non ha filtri attivi lo manda a cercare un filtro che non
 *     esiste.
 *
 *  3. IL `pending` CABLATO DIVENTATO FILTRO. La scheda apriva su
 *     `assignedForms.filter(f => f.status === 'pending')`. Il filtro deve mostrare
 *     ESATTAMENTE quello all'apertura — altrimenti la famiglia si troverebbe
 *     davanti anche i moduli già firmati e scaduti — e deve poter mostrare gli altri.
 *
 * ⚠️ Le etichette si leggono dai cataloghi, non si ricopiano: una prova che ripete
 * a mano il testo resta verde anche quando il catalogo cambia sotto.
 * ⚠️ Nessun dato personale nei dati di prova: il repository è PUBBLICO.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const GENITORE = 'c0000000-0000-4000-8000-00000000000c';

const h = vi.hoisted(() => ({ fetchMock: vi.fn(), query: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/parent/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: GENITORE, ruolo: 'genitore', pronto: true }),
}));

// Il catalogo dei prestampati ha i suoi banchi: qui interessano le altre tre schede.
vi.mock('@/components/features/prestampati/PrestampatiGenitore', () => ({
  PrestampatiGenitore: () => null,
}));

/** Due moduli assegnati: uno da compilare, uno già firmato. */
const DA_COMPILARE = {
  form_id: 'f-pending',
  title: 'Autorizzazione gita al museo',
  description: 'Uscita didattica di mezza giornata',
  form_type: 'autorizzazione',
  fields: [],
  expiration_date: null,
  student: { id: 's1', nome: 'Primo', cognome: 'Diprova', classe_sezione: 'Girasoli' },
  status: 'pending',
};
const GIA_FIRMATO = {
  ...DA_COMPILARE,
  form_id: 'f-signed',
  title: 'Consenso fotografie',
  form_type: 'sondaggio',
  status: 'signed',
};

/** Un certificato medico, come lo serve DAVVERO la rotta: `{ success, data }`. */
const CERTIFICATO = {
  id: 'cert-1',
  alunno_id: 's1',
  fileName: 'certificato-di-prova.pdf',
  creato_il: '2026-08-20T08:00:00.000Z',
  stato: 'in_validazione',
  data_inizio: '2026-08-20',
  data_fine: '2026-08-24',
  note: null,
  giorni_coperti: [],
  alunno: { nome: 'Primo', cognome: 'Diprova' },
};

interface Risposte {
  forms?: unknown;
  submissions?: unknown;
  certificati?: unknown;
}

function rispondi({ forms = [], submissions = [], certificati = { success: true, data: [] } }: Risposte = {}) {
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo });
    if (u.includes('/api/parent/forms')) return json(forms);
    if (u.includes('/api/parent/submissions')) return json(submissions);
    if (u.includes('/api/parent/medical-certificates')) return json(certificati);
    if (u.includes('/api/parent/students')) {
      return json({ success: true, data: [{ id: 's1', nome: 'Primo', cognome: 'Diprova' }] });
    }
    if (u.includes('/api/me')) return json({ nome: 'Genitore', cognome: 'Diprova' });
    return json({});
  });
}

/** Apre una delle quattro schede per il testo della sua linguetta. */
const apriScheda = (etichetta: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(etichetta, 'i') }));

async function montaPagina() {
  const { default: Pagina } = await import('@/app/(dashboard)/parent/modulistica/page');
  render(<Pagina />);
  // La pagina parte con lo spinner: si aspetta che le quattro letture siano finite.
  await waitFor(() => expect(screen.queryByText(itParentServizi.modulisticaCaricamento)).toBeNull());
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
// 1 · 🔴 La scheda che era vuota per sempre
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · i certificati medici arrivano davvero a schermo', () => {
  it('legge il `{ success, data }` della rotta e mostra il certificato', async () => {
    rispondi({ certificati: { success: true, data: [CERTIFICATO] } });
    await montaPagina();
    apriScheda(itParentServizi.modulisticaTabMedici);

    // Il nome del file è ciò che la famiglia riconosce: se resta invisibile, la
    // scheda sta dicendo «non hai mai caricato niente» a chi ha appena caricato.
    expect(await screen.findByText(/certificato-di-prova\.pdf/)).toBeInTheDocument();
  });

  it('a zero certificati dice VUOTO, non «nessun risultato con questi filtri»', async () => {
    rispondi({ certificati: { success: true, data: [] } });
    await montaPagina();
    apriScheda(itParentServizi.modulisticaTabMedici);

    expect(await screen.findByText(itParentServizi.modulisticaNessunCertMedico)).toBeInTheDocument();
    expect(screen.queryByText(itShared.filtriSenzaRisultatiTitolo)).toBeNull();
  });

  it('con un filtro che non pesca nulla dice «nessun risultato», e offre di pulirlo', async () => {
    rispondi({ certificati: { success: true, data: [CERTIFICATO] } });
    await montaPagina();
    apriScheda(itParentServizi.modulisticaTabMedici);
    await screen.findByText(/certificato-di-prova\.pdf/);

    fireEvent.change(screen.getByRole('searchbox', { name: itParentServizi.modulisticaFiltroCercaCertificato }), {
      target: { value: 'questo-testo-non-esiste' },
    });

    expect(await screen.findByText(itShared.filtriSenzaRisultatiTitolo)).toBeInTheDocument();
    expect(screen.queryByText(itParentServizi.modulisticaNessunCertMedico)).toBeNull();
    expect(screen.queryByText(/certificato-di-prova\.pdf/)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · Il `pending` cablato, diventato un filtro con lo stesso riposo
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · «Da compilare» apre su ciò che c’è da fare', () => {
  it('all’apertura mostra il modulo da compilare e NON quello già firmato', async () => {
    rispondi({ forms: [DA_COMPILARE, GIA_FIRMATO] });
    await montaPagina();

    expect(await screen.findByText(DA_COMPILARE.title)).toBeInTheDocument();
    expect(screen.queryByText(GIA_FIRMATO.title)).toBeNull();
  });

  /**
   * Il percorso VERO su un telefono: «Stato» è un `multi`, e nella variante
   * compatta `BarraFiltri` tiene in prima riga i soli campi di tipo `chip` — tutto
   * il resto scende nel foglio che si apre dal basso. Quindi si tocca «Filtri»,
   * poi la pastiglia. Provarlo per il percorso corto (la pastiglia già a schermo)
   * avrebbe misurato una schermata che non esiste.
   */
  it('dal foglio, accendendo anche «Firmato», il modulo firmato compare (OR dentro il campo)', async () => {
    rispondi({ forms: [DA_COMPILARE, GIA_FIRMATO] });
    await montaPagina();
    await screen.findByText(DA_COMPILARE.title);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itShared.filtriTitolo}`) }));
    const foglio = await screen.findByRole('dialog');

    // La CTA del piede dice quante righe si vedranno chiudendo, e il numero cambia
    // mentre si tocca: è la micro-interazione che evita il giro «chiudi, guarda,
    // riapri, correggi».
    const mostra = within(foglio).getByTestId('foglio-mostra');
    expect(mostra.textContent).toMatch(/1/);

    fireEvent.click(within(foglio).getByRole('button', { name: itParentServizi.modulisticaStatoFirmato }));
    await waitFor(() => expect(mostra.textContent).toMatch(/2/));

    // Escape chiude il foglio (e il tasto Indietro di Android passa dallo stesso
    // gestore, `useOverlayIndietro`).
    fireEvent.keyDown(foglio, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(await screen.findByText(GIA_FIRMATO.title)).toBeInTheDocument();
    expect(screen.getByText(DA_COMPILARE.title)).toBeInTheDocument();
  });

  it('a zero moduli assegnati dice VUOTO con la frase della scheda', async () => {
    rispondi({ forms: [] });
    await montaPagina();

    expect(await screen.findByText(itParentServizi.modulisticaNessunModulo)).toBeInTheDocument();
    expect(screen.queryByText(itShared.filtriSenzaRisultatiTitolo)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · Il conteggio annunciato, e la ricerca dell'archivio
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · «Archivio firmati»', () => {
  const FIRMATO = {
    id: 'a1',
    answers: {},
    is_signed: true,
    pdf_path: '',
    created_at: '2026-08-14T09:30:00.000Z',
    origine: 'online',
    forms_templates: { title: 'Autorizzazione gita al museo', description: '' },
    alunni: { nome: 'Primo', cognome: 'Diprova' },
  };

  it('il numero dei risultati si ANNUNCIA, e cambia con la ricerca', async () => {
    rispondi({ submissions: [FIRMATO, { ...FIRMATO, id: 'a2', forms_templates: { title: 'Consenso fotografie', description: '' } }] });
    await montaPagina();
    apriScheda(itParentServizi.modulisticaTabArchivio);

    const conteggi = await screen.findAllByTestId('conteggio-risultati');
    // `role="status"` + `aria-live`: chi non vede l'elenco accorciarsi riceve il
    // numero solo da qui.
    const conteggio = conteggi[conteggi.length - 1];
    expect(conteggio).toHaveAttribute('role', 'status');
    expect(conteggio.textContent).toMatch(/2/);

    fireEvent.change(screen.getByRole('searchbox', { name: itParentServizi.modulisticaFiltroCercaArchivio }), {
      target: { value: 'fotografie' },
    });

    await waitFor(() => expect(screen.queryByText('Autorizzazione gita al museo')).toBeNull());
    expect(screen.getByText('Consenso fotografie')).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · Nessun parametro nuovo verso le rotte `parent/*`
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica genitore · le rotte restano quelle di prima', () => {
  it('nessuna chiamata a `parent/*` porta un parametro di filtro', async () => {
    rispondi({ forms: [DA_COMPILARE], certificati: { success: true, data: [CERTIFICATO] } });
    await montaPagina();
    fireEvent.change(screen.getByRole('searchbox', { name: itParentServizi.modulisticaFiltroCercaModulo }), {
      target: { value: 'museo' },
    });
    apriScheda(itParentServizi.modulisticaTabMedici);

    const chiamate = h.fetchMock.mock.calls.map((c) => String(c[0]));
    expect(chiamate.length).toBeGreaterThan(3);
    for (const url of chiamate.filter((u) => u.includes('/api/parent/'))) {
      // Il carico di una famiglia è già tutto in memoria: filtrare a schermo è la
      // decisione, e una `?q=` verso una rotta che non la dichiara sarebbe un
      // parametro scartato in silenzio — cioè un filtro che non filtra.
      expect(url, `la rotta ha ricevuto un filtro: ${url}`).not.toMatch(/[?&](q|stato|figlio|origine|modulo)=/);
    }
  });
});
