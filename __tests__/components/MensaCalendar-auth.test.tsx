import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// MensaCalendar importa (transitivamente, via fetchFigliIds) use-parent-identity
// che a sua volta importa next/navigation. Il componente NON usa quei hook, ma
// il mock rende l'import innocuo in jsdom.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/parent/mensa',
}));

import { MensaCalendar, decidiAzioneMensaAuth } from '@/components/features/parent/mensa/MensaCalendar';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem('kv_student_id', 'stale');
  vi.stubGlobal('fetch', fetchMock);
});

function menuVuoto() {
  return { json: async () => ({ success: true, data: [] }) };
}
function prenStatus(status: number) {
  return { status, json: async () => ({ error: 'x' }) };
}
function prenOk() {
  return { status: 200, json: async () => ({ success: true, data: { saldo: 5, prenotazioni: [], cutoffOra: null } }) };
}
function studentsOk(ids: string[]) {
  return { ok: true, json: async () => ({ success: true, data: ids.map((id) => ({ id })) }) };
}

describe('decidiAzioneMensaAuth (classificazione pura 401/403)', () => {
  it('401 → sessione scaduta', () => {
    expect(decidiAzioneMensaAuth(401, false)).toEqual({ tipo: 'sessioneScaduta' });
    expect(decidiAzioneMensaAuth(401, true)).toEqual({ tipo: 'sessioneScaduta' });
  });
  it('403 primo tentativo → autorecupero', () => {
    expect(decidiAzioneMensaAuth(403, false)).toEqual({ tipo: 'autorecupero' });
  });
  it('403 con recupero già tentato → non collegato', () => {
    expect(decidiAzioneMensaAuth(403, true)).toEqual({ tipo: 'nonCollegato' });
  });
  it('200/altri → ok', () => {
    expect(decidiAzioneMensaAuth(200, false)).toEqual({ tipo: 'ok' });
    expect(decidiAzioneMensaAuth(500, false)).toEqual({ tipo: 'ok' });
  });
});

describe('MensaCalendar — 401 vs 403 (niente più "Sessione non valida")', () => {
  it('401 → messaggio "Sessione scaduta" + link a /auth/login', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenStatus(401));
      return Promise.resolve(studentsOk([]));
    });

    render(<MensaCalendar userId="P1" studentId="stale" />);

    await waitFor(() => expect(screen.getByText(/Sessione scaduta/i)).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /accedi/i });
    expect(link).toHaveAttribute('href', '/auth/login');
    // Il vecchio messaggio generico NON deve comparire.
    expect(screen.queryByText(/Sessione non valida/i)).not.toBeInTheDocument();
  });

  it('403 persistente (nessun figlio da recuperare) → "non risulta collegato"', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenStatus(403));
      if (url.includes('/api/parent/students')) return Promise.resolve(studentsOk([]));
      return Promise.resolve(menuVuoto());
    });

    render(<MensaCalendar userId="P1" studentId="stale" />);

    await waitFor(() => expect(screen.getByText(/non risulta collegato/i)).toBeInTheDocument());
    expect(screen.queryByText(/Sessione non valida/i)).not.toBeInTheDocument();
  });

  it('401 → il messaggio è ANNUNCIATO agli screen reader (role=alert) e il focus va al link', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenStatus(401));
      return Promise.resolve(studentsOk([]));
    });

    render(<MensaCalendar userId="P1" studentId="stale" />);

    // Il box non è più un <div> muto: ha role="alert" così lo screen reader lo legge.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Sessione scaduta/i);
    // Il focus si sposta sull'azione di recupero (link "Accedi di nuovo").
    await waitFor(() => expect(screen.getByRole('link', { name: /accedi/i })).toHaveFocus());
  });

  it('403 persistente → il messaggio "non risulta collegato" è annunciato (role=alert)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenStatus(403));
      if (url.includes('/api/parent/students')) return Promise.resolve(studentsOk([]));
      return Promise.resolve(menuVuoto());
    });

    render(<MensaCalendar userId="P1" studentId="stale" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/non risulta collegato/i);
  });

  it('403 poi autorecupero con figlio valido → dati mostrati, nessun errore auth', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/mensa/menu')) return Promise.resolve(menuVuoto());
      if (url.includes('/api/parent/students')) return Promise.resolve(studentsOk(['buono']));
      if (url.includes('/api/mensa/prenotazioni')) {
        // 403 per l'alunno stantio, 200 per quello recuperato.
        return Promise.resolve(url.includes('alunno_id=buono') ? prenOk() : prenStatus(403));
      }
      return Promise.resolve(menuVuoto());
    });

    render(<MensaCalendar userId="P1" studentId="stale" />);

    // La cache stantia viene ripulita durante l'autorecupero.
    await waitFor(() => expect(window.localStorage.getItem('kv_student_id')).not.toBe('stale'));
    // Nessun messaggio d'errore auth alla fine.
    await waitFor(() =>
      expect(screen.queryByText(/non risulta collegato|Sessione scaduta|Sessione non valida/i)).not.toBeInTheDocument(),
    );
  });
});
