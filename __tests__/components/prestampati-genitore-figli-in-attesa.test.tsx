import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import itPrestampati from '../../messages/it/prestampatiGenitore.json';
import itParentServizi from '../../messages/it/parentServizi.json';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * «NON HO FIGLI» E «I MIEI FIGLI NON SONO ANCORA VISIBILI» — due elenchi vuoti, due
 * cause opposte, e per un giorno la stessa frase.
 *
 * ─── IL DIFETTO, e perché nessuno lo vedeva ─────────────────────────────────────
 *
 * Dal 2026-09-05 `GET /api/parent/students` non restituisce più i bambini senza classe,
 * ritirati o archiviati. Per quattro account genitore in produzione quelli erano TUTTI i
 * figli: la home ha avuto subito la sua schermata di cortesia («Stiamo completando
 * l'iscrizione…»), la modulistica no. E la modulistica sta nella BottomNav, cioè a UN
 * TOCCO da quella home: le stesse famiglie leggevano di là «l'iscrizione è in lavorazione»
 * e di qua «non risulta nessun bambino collegato a questo accesso».
 *
 * La seconda frase è FALSA, e non per sfumatura: i legami di famiglia esistono — è proprio
 * la loro esistenza a rendere vero `in_attesa`, che senza legami sarebbe falso. Delle due
 * schermate che si contraddicevano, quella che diceva il falso era anche quella che chiude
 * la strada: da lì si chiede il certificato di frequenza, quello della detrazione.
 *
 * Il campo che le distingue era GIÀ nel corpo che la pagina scaricava: `in_attesa` viaggia
 * accanto a `data`, e `modulistica/page.tsx` leggeva solo `data`. Nessuna lettura in più,
 * nessuna query nuova: un campo tenuto invece che buttato.
 *
 * ─── COSA MISURA QUESTO FILE, e nell'ordine in cui si rompe ─────────────────────
 *
 *  1. il pannello, montato da solo: con `inAttesa` dice l'iscrizione in lavorazione, senza
 *     dice il legame mancante — e nessuno dei due rami si è mangiato l'altro;
 *  2. la PAGINA, montata davvero: `in_attesa: true` arriva fino al pannello. È la metà che
 *     un banco sul solo componente non può vedere — la prop si può dichiarare e non
 *     passare mai, ed è esattamente ciò che succedeva;
 *  3. la rete giù NON diventa «iscrizione in lavorazione»: `sJson?.in_attesa === true` e
 *     non «tutto ciò che non è falso». Mandare in segreteria chi è semplicemente offline
 *     sarebbe peggio del silenzio.
 *
 * ⚠️ Le frasi si leggono dal catalogo italiano, non si ricopiano: una prova che ripete a
 * mano il testo resta verde anche quando il catalogo cambia sotto.
 * ⚠️ Nessun dato personale nelle fixture: il repository è PUBBLICO, e qui passano
 * anagrafiche di minori.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  query: '',
  genitore: 'c0000000-0000-4000-8000-00000000000c',
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/parent/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: h.genitore, role: 'genitore', ready: true }),
}));

import { PrestampatiGenitore } from '@/components/features/prestampati/PrestampatiGenitore';
import ParentModulisticaPage from '@/app/(dashboard)/parent/modulistica/page';

/** Il figlio finto, per la prova di controllo con l'elenco NON vuoto. */
const FIGLIO = { id: 'a1000000-0000-4000-8000-00000000000a', nome: 'Bimba', cognome: 'Di Prova' };

/**
 * Le cinque letture della pagina. Solo `students` cambia da una prova all'altra: le altre
 * quattro rispondono vuoto, che per una famiglia è il caso normale.
 *
 * `students: null` significa RETE GIÙ — la `fetch` rifiuta, e la pagina la raccoglie con
 * il suo `.catch(() => null)`.
 */
function rispondi(students: unknown | null) {
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo });
    if (u.includes('/api/parent/students')) {
      return students === null ? Promise.reject(new TypeError('Failed to fetch')) : json(students);
    }
    if (u.includes('/api/parent/medical-certificates')) return json({ success: true, data: [] });
    if (u.includes('/api/me')) return json({ nome: 'Genitore', cognome: 'Di Prova' });
    return json([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.query = 'tab=certificati';
  rispondi({ success: true, data: [], in_attesa: true });
  vi.stubGlobal('fetch', h.fetchMock);
});

afterEach(() => cleanup());

describe('PrestampatiGenitore · un elenco vuoto non ha una causa sola', () => {
  it('con `inAttesa` dice che l’iscrizione è in lavorazione, non che il bambino non esiste', () => {
    render(<PrestampatiGenitore figli={[]} inAttesa />);

    expect(screen.getByText(itPrestampati.vuotoFigliInAttesa)).toBeInTheDocument();
    // La frase falsa non deve restare accanto a quella vera: si contraddirebbero da sole.
    expect(screen.queryByText(itPrestampati.vuotoFigli)).toBeNull();
  });

  it('senza `inAttesa` resta la frase di prima — il ramo non è collassato su una sola', () => {
    render(<PrestampatiGenitore figli={[]} />);

    expect(screen.getByText(itPrestampati.vuotoFigli)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
  });

  it('con un figlio visibile non compare nessuna delle due: si sceglie il modulo', () => {
    render(<PrestampatiGenitore figli={[FIGLIO]} inAttesa />);

    expect(screen.queryByText(itPrestampati.vuotoFigli)).toBeNull();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
    expect(screen.getByLabelText(itPrestampati.scegliFiglio)).toBeInTheDocument();
  });

  /**
   * ⚠️ E NEMMENO DUE FRASI BASTAVANO. Misurato in produzione il 2026-09-06: dei 4 account
   * senza figli visibili, 3 hanno l'unico figlio senza sezione e 1 ce l'ha ARCHIVIATO. A
   * quest'ultimo il pannello prometteva moduli «appena la classe è assegnata»: un'attesa
   * che non finirà. E la promessa era doppiamente vuota, perché a valle
   * `alunnoNonStampabile` (`@/lib/prestampati/prefill.ts`) rifiuta con 409 ogni
   * generazione su chi non è più iscritto — anche mostrandogli il figlio nel selettore,
   * il documento non uscirebbe. La strada vera è la segreteria, e la frase deve dire quella.
   */
  it('con motivo `archiviato` la frase toglie la classe e lascia la segreteria', () => {
    render(<PrestampatiGenitore figli={[]} inAttesa motivoAssenza="archiviato" />);

    expect(screen.getByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
    expect(screen.queryByText(itPrestampati.vuotoFigli)).toBeNull();
    // La sola strada rimasta va detta, e va detto che il certificato si può ancora avere:
    // è il documento della detrazione, e riguarda un anno davvero frequentato.
    expect(itPrestampati.vuotoFigliNonPiuIscritto).toContain('segreteria');
    expect(itPrestampati.vuotoFigliNonPiuIscritto).toContain('frequenza');
  });

  it('con motivo `ritirato` la frase è la stessa: il 409 non distingue i due', () => {
    render(<PrestampatiGenitore figli={[]} inAttesa motivoAssenza="ritirato" />);

    expect(screen.getByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
  });

  it('con motivo `senza-sezione` resta l’attesa: per lui la classe arriva davvero', () => {
    // Il ramo nuovo non si è mangiato quello vecchio: sono i 3 account su 4 per cui
    // «appena la classe è assegnata» è un'informazione giusta, e il bambino è ISCRITTO —
    // `alunnoNonStampabile` per lui non scatta, il certificato uscirebbe.
    render(<PrestampatiGenitore figli={[]} inAttesa motivoAssenza="senza-sezione" />);

    expect(screen.getByText(itPrestampati.vuotoFigliInAttesa)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeNull();
  });

  it('motivo assente (server più vecchio del client) ⇒ frase generica, non un vuoto', () => {
    render(<PrestampatiGenitore figli={[]} inAttesa />);

    expect(screen.getByText(itPrestampati.vuotoFigliInAttesa)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeNull();
  });
});

describe('parent/modulistica · `in_attesa` arriva fino al pannello, invece di essere buttato', () => {
  it('`data: []` con `in_attesa: true` → la scheda Certificati dice l’iscrizione in lavorazione', async () => {
    render(<ParentModulisticaPage />);

    expect(await screen.findByText(itPrestampati.vuotoFigliInAttesa)).toBeInTheDocument();
    // E la frase che negava l'esistenza dei figli non c'è più: è il punto di tutto il
    // rilievo, perché a un tocco di qui la home dice l'esatto contrario.
    expect(screen.queryByText(itPrestampati.vuotoFigli)).toBeNull();
    // La stessa cosa che legge sulla home, con le stesse parole: le due schermate della
    // stessa famiglia non si contraddicono più.
    expect(itParentServizi.inAttesaTesto).toContain('segreteria');
    expect(itPrestampati.vuotoFigliInAttesa).toContain('segreteria');
  });

  it('`data: []` senza `in_attesa` → resta «nessun bambino collegato»', async () => {
    rispondi({ success: true, data: [] });
    render(<ParentModulisticaPage />);

    expect(await screen.findByText(itPrestampati.vuotoFigli)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
  });

  it('rete giù → NON si dice «iscrizione in lavorazione» a chi è soltanto offline', async () => {
    rispondi(null);
    render(<ParentModulisticaPage />);

    expect(await screen.findByText(itPrestampati.vuotoFigli)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
  });

  it('`motivo_assenza: archiviato` arriva fino al pannello, e non si ferma alla pagina', async () => {
    // La metà che un banco sul solo componente non può vedere: la prop si può dichiarare
    // e non passare mai. È già successo con `inAttesa`, nello stesso file, ieri.
    rispondi({ success: true, data: [], in_attesa: true, motivo_assenza: 'archiviato' });
    render(<ParentModulisticaPage />);

    expect(await screen.findByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliInAttesa)).toBeNull();
    // Le due schermate della stessa famiglia continuano a dire la stessa cosa: la home
    // (`parentServizi`) e la modulistica (`prestampatiGenitore`) mandano dove si va davvero.
    expect(itParentServizi.nonPiuIscrittoTesto).toContain('segreteria');
    expect(itPrestampati.vuotoFigliNonPiuIscritto).toContain('segreteria');
  });

  it('un motivo che non è dei TRE non sceglie una frase: si ricade sulla generica', async () => {
    rispondi({ success: true, data: [], in_attesa: true, motivo_assenza: 'trasferito' });
    render(<ParentModulisticaPage />);

    expect(await screen.findByText(itPrestampati.vuotoFigliInAttesa)).toBeInTheDocument();
    expect(screen.queryByText(itPrestampati.vuotoFigliNonPiuIscritto)).toBeNull();
  });
});
