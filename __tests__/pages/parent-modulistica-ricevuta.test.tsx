import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import itParentServizi from '../../messages/it/parentServizi.json';

/**
 * «MODULISTICA» DEL GENITORE — la ricevuta di firma, e da chi la chiede.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────────
 *
 * `ricevuta-firma-un-motore-solo.test.ts` legge il SORGENTE: verifica che in questa pagina
 * non ci sia più un motore PDF e che l'indirizzo della rotta sia quello giusto. È una prova
 * di forma, e per quello va bene — ma non monta niente, quindi non può dire se il pulsante
 * «Ricevuta PDF» chiama davvero qualcuno, né con quale id.
 *
 * Qui la pagina si monta. Le due cose che misura sono le due che il difetto aveva rotto:
 *
 *  1. il pulsante dell'Archivio firmati chiede `GET /api/fea/receipt?entita=forms&id=<id
 *     della submission>` — cioè il foglio lo disegna il server, sulla carta intestata vera,
 *     con il solo nome del firmatario. Prima lo disegnava jsPDF nel browser, con dentro il
 *     CODICE FISCALE del genitore, il suo indirizzo IP e lo User-Agent — inventandoli
 *     quando il log non li aveva (`log?.ip || '192.168.1.45'`);
 *  2. `?tab=archivio` apre l'Archivio. Non è scontato dopo questo ramo: la lettura di
 *     `?tab=` è appena passata dentro un `<Suspense>`, e un confine di sospensione
 *     sbagliato si vede solo montando — non lo direbbe né `tsc` né un grep.
 *
 * ⚠️ Le etichette si leggono dal catalogo italiano, non si ricopiano: una prova che ripete
 * a mano il testo resta verde anche quando il catalogo cambia sotto.
 */

const GENITORE = 'c0000000-0000-4000-8000-00000000000c';
const SUBMISSION = 'd0000000-0000-4000-8000-00000000000d';

const h = vi.hoisted(() => ({ fetchMock: vi.fn(), query: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/parent/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: GENITORE, ruolo: 'genitore', pronto: true }),
}));

// Il pannello dei prestampati ha i suoi test: qui interessa la scheda ARCHIVIO.
vi.mock('@/components/features/prestampati/PrestampatiGenitore', () => ({
  PrestampatiGenitore: () => null,
}));

/** La riga d'archivio: un modulo firmato, come lo serve `GET /api/parent/submissions`. */
const FIRMATO = {
  id: SUBMISSION,
  answers: {},
  is_signed: true,
  pdf_path: '',
  created_at: '2026-08-14T09:30:00.000Z',
  forms_templates: { title: 'Autorizzazione di prova', description: 'Descrizione di prova' },
  // Nomi inventati: il repository è pubblico e qui passano dati di minori veri.
  alunni: { nome: 'Bimba', cognome: 'Di Prova' },
};

/** Le chiamate fatte a una porta, in ordine. */
const chiamate = (frammento: string): string[] =>
  h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(frammento));

beforeEach(() => {
  vi.clearAllMocks();
  h.query = '';
  h.fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/parent/submissions')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => [FIRMATO] });
    }
    if (String(url).includes('/api/fea/receipt')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
        json: async () => ({}),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  });
  vi.stubGlobal('fetch', h.fetchMock);
  // `createObjectURL` non esiste in jsdom: senza, il clic sul pulsante lancerebbe e la
  // prova fallirebbe per il banco di prova invece che per il prodotto.
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:prova', revokeObjectURL: () => {} }));
});

afterEach(() => cleanup());

import ParentModulisticaPage from '@/app/(dashboard)/parent/modulistica/page';

describe('parent/modulistica — la ricevuta di firma la disegna il server', () => {
  it('`?tab=archivio` apre l’Archivio anche col confine di sospensione', async () => {
    h.query = 'tab=archivio';
    render(<ParentModulisticaPage />);
    // Il titolo del modulo firmato compare: siamo nella scheda giusta, e il `<Suspense>`
    // non ha lasciato la pagina vuota.
    expect(await screen.findByText(FIRMATO.forms_templates.title)).toBeInTheDocument();
  });

  it('il pulsante chiede la ricevuta alla rotta, con l’id della submission', async () => {
    h.query = 'tab=archivio';
    render(<ParentModulisticaPage />);
    await screen.findByText(FIRMATO.forms_templates.title);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(itParentServizi.modulisticaRicevutaPdf) }));

    await waitFor(() => expect(chiamate('/api/fea/receipt')).toHaveLength(1));
    const url = chiamate('/api/fea/receipt')[0];
    // `entita=forms`: la ricevuta è ancorata alla riga di `forms_submissions`. Con un
    // `entita` diverso la rotta risponde 400, e il pulsante non farebbe niente.
    expect(url).toContain('entita=forms');
    expect(url).toContain(SUBMISSION);
  });
});
