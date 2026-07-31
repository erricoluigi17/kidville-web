import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from 'react';

/**
 * Il costo dell'identità a due passaggi: UNA chiamata, non due.
 *
 * `useTeacherIdentity` risolve l'uuid solo dopo l'idratazione — è ciò che chiude
 * il mismatch della bottom-nav. Ma `useTeacherGradi` riceve quel valore, e la
 * sua cache è indicizzata PER userId: col primo passaggio a `null` e il secondo
 * con l'uuid, le chiavi sono due e le GET a `/api/primaria/me` diventano due.
 * Sarebbe la beffa esatta del collaudo — chiudere l'errore di idratazione
 * raddoppiando le chiamate che lo stesso collaudo segnalava.
 *
 * Il test guarda la rete vera del componente (nessun mock di `useTeacherGradi`,
 * solo `fetch` strumentata) e conta.
 */

const TEACHER_ID = '7c1e4a20-2222-4333-8444-555555555555';

const stub = vi.hoisted(() => ({ pathname: '/teacher', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => new URLSearchParams(stub.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';

let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.pathname = '/teacher';
  stub.search = '';
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { gradi: ['infanzia'], ruolo: 'teacher' } }),
    }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('TeacherBottomNav — la rete non raddoppia per colpa dei due passaggi', () => {
  it('una sola GET a /api/primaria/me su un caricamento di /teacher', async () => {
    const html = renderToString(<TeacherBottomNav />);
    window.localStorage.setItem('kv_teacher_id', TEACHER_ID);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    await act(async () => {
      root = hydrateRoot(container, <TeacherBottomNav />);
    });

    const chiamate = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
      String(c[0]),
    );
    const me = chiamate.filter((u) => u.startsWith('/api/primaria/me'));

    expect(
      me,
      'I gradi del docente sono stati chiesti più di una volta: il primo passaggio ' +
        "(senza identità) e il secondo (con l'uuid) sono due chiavi diverse nella " +
        'cache di useTeacherGradi, quindi due GET su ogni pagina docente.',
    ).toHaveLength(1);
    // ...e con l'identità giusta, non quella "vuota" del primo passaggio.
    expect(me[0]).toContain(`userId=${TEACHER_ID}`);
  });
});
