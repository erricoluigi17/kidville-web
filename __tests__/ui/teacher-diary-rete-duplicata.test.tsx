import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * /teacher/diary: la stessa configurazione NON si chiede quattro volte.
 *
 * È la pagina che ha reso rossa la CI (run 30854274465 su `main`). Dal trace:
 * tutte le chiamate rispondono 200 e i due POST salvano davvero, ma prima di
 * arrivare alla verifica di persistenza la pagina spende ~14 s in richieste
 * DUPLICATE — `/api/diary/config` quattro volte, `/api/educator-sections` due.
 * Il test scadeva a 30 s con l'ultima GET ancora in volo.
 *
 * Il quattro non è un mistero: due punti del codice la chiedono (il chrome
 * della pagina, per nascondere le sezioni primaria, e `useDiaryDay`, per sapere
 * se l'umore è attivo) e la CI esegue l'E2E su `next dev`, dove StrictMode
 * invoca ogni effect DUE volte. Per questo il test monta la pagina dentro
 * `<StrictMode>`: è l'ambiente che fallisce davvero, non una sua semplificazione.
 *
 * Si contano le RICHIESTE, non l'esistenza di una cache: una cache scritta e
 * poi ignorata riporta il contatore a quattro.
 */

const stub = vi.hoisted(() => ({
  pathname: '/teacher/diary',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

import TeacherDiaryPage from '@/app/(dashboard)/teacher/diary/page';
import { invalidaDiarioConfigCache } from '@/lib/diary/config-cache';
import { invalidaEducatorSectionsCache } from '@/lib/sezioni/educator-sections-cache';

const DOCENTE = '7c1e4a20-2222-4333-8444-555555555555';

let chiamate: string[] = [];
const fetchMock = vi.fn();

const conta = (frammento: string) => chiamate.filter((u) => u.includes(frammento)).length;

beforeEach(() => {
  vi.clearAllMocks();
  invalidaDiarioConfigCache();
  invalidaEducatorSectionsCache();
  chiamate = [];
  window.localStorage.clear();
  window.localStorage.setItem('kv_teacher_id', DOCENTE);

  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    chiamate.push(u);
    if (u.includes('/api/diary/config')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ routine_attive: ['umore'], diario_primaria_visibile: true }),
      });
    }
    if (u.includes('/api/educator-sections')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ sections: [{ name: 'Girasoli', school_type: 'infanzia' }] }),
      });
    }
    if (u.includes('/api/diary/students')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [{ id: 'a1', nome: 'Aurora', cognome: 'Bianchi', note_mediche: null }],
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/teacher/diary — la rete non si moltiplica al caricamento', () => {
  it('un solo ingresso in pagina: UNA /api/diary/config e UNA /api/educator-sections', async () => {
    render(
      <StrictMode>
        <TeacherDiaryPage />
      </StrictMode>,
    );

    // La pagina è pronta quando ha risolto la sezione e sta chiedendo gli
    // alunni: quella richiesta parte SOLO dopo che sezioni e config sono
    // arrivate, quindi è il segnale che il caricamento è finito davvero.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Diario del giorno' })).toBeInTheDocument(),
    );
    await waitFor(() => expect(conta('/api/diary/students')).toBeGreaterThan(0));

    expect(
      conta('/api/diary/config'),
      'La configurazione del diario è stata chiesta più di una volta nello stesso '
        + `ingresso in pagina (osservate: ${conta('/api/diary/config')}). `
        + 'È il tempo che ha fatto scadere l\'E2E in CI.',
    ).toBe(1);
    expect(
      conta('/api/educator-sections'),
      'Le sezioni del docente sono state chieste più di una volta nello stesso '
        + `ingresso in pagina (osservate: ${conta('/api/educator-sections')}).`,
    ).toBe(1);
  });

  it('docenti DIVERSI = risposte diverse: la cache è indicizzata sull\'identità', async () => {
    const primo = render(<TeacherDiaryPage />);
    await waitFor(() =>
      expect(chiamate.some((u) => u.includes('/api/diary/students') && u.includes('Girasoli'))).toBe(true),
    );
    primo.unmount();

    // Secondo docente: altre sezioni. Con una chiave di cache fissa vedrebbe
    // le sezioni del primo — cioè bambini che non sono suoi.
    const ALTRO = '9a9a9a9a-3333-4444-8555-666666666666';
    window.localStorage.setItem('kv_teacher_id', ALTRO);
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      chiamate.push(u);
      if (u.includes('/api/diary/config')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ routine_attive: [], diario_primaria_visibile: true }),
        });
      }
      if (u.includes('/api/educator-sections')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sections: [{ name: 'Coccinelle', school_type: 'infanzia' }] }),
        });
      }
      if (u.includes('/api/diary/students')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: 'b1', nome: 'Bruno', cognome: 'Verdi', note_mediche: null }],
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    render(<TeacherDiaryPage />);
    await waitFor(() => expect(conta('/api/educator-sections')).toBe(2));
    await waitFor(() =>
      expect(chiamate.filter((u) => u.includes('/api/diary/students')).length).toBeGreaterThan(1),
    );

    // La sezione su cui lavora è la sua, non quella del docente precedente.
    const sezioni = chiamate.filter((u) => u.includes('/api/diary/students'));
    expect(
      sezioni.some((u) => u.includes('Coccinelle')),
      'Il secondo docente sta lavorando sulla sezione del primo: la cache delle '
        + `sezioni non è indicizzata sull'identità. Chiamate: ${sezioni.join(' | ')}`,
    ).toBe(true);
    expect(conta('/api/educator-sections')).toBe(2);
  });
});
