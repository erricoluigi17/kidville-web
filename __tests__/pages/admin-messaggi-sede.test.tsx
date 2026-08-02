import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';
import itAdminComunicazioni from '../../messages/it/adminComunicazioni.json';
import enAdminComunicazioni from '../../messages/en/adminComunicazioni.json';

/**
 * W3-E · R72 — La rubrica «Con i genitori» non diceva a quale plesso si scrive.
 *
 * Ogni riga è `Cognome Nome` del genitore e sotto `bambino · classe`. Con «2 ANNI»
 * presente in due sedi e cognomi ricorrenti, due righe possono essere identiche:
 * la segreteria apre una conversazione con la famiglia sbagliata, in una scuola
 * che non è la sua interlocutrice. Il messaggio parte e resta.
 */

const h = vi.hoisted(() => ({
  sedi: [] as { id: string; nome: string }[],
  fetchMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/admin/messaggi',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'seg-1', role: 'segreteria', ready: true }),
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: h.sedi,
    selezionate: [],
    effettive: h.sedi.map((s) => s.id),
    sedeCorrente: h.sedi.length === 1 ? h.sedi[0].id : null,
    reFetchKey: h.sedi.map((s) => s.id).join(','),
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));

// Due famiglie omonime, una per sede: senza il plesso sono la stessa riga.
const CONTATTI = [
  { parentUserId: 'u-a', parentName: 'Rossi Anna', studentId: 's-a', studentName: 'Alfa Rossi', classe: '2 ANNI', scuolaId: SEDE_A },
  { parentUserId: 'u-b', parentName: 'Rossi Anna', studentId: 's-b', studentName: 'Alfa Rossi', classe: '2 ANNI', scuolaId: SEDE_B },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ];
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/api/admin/chat/contacts')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: CONTATTI }) });
    return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
  });
  vi.stubGlobal('fetch', h.fetchMock);
});

import MessaggiPage from '@/app/(dashboard)/admin/messaggi/page';

describe('/admin/messaggi — la rubrica dei genitori dice la sede', () => {
  it('con due sedi ogni contatto porta il nome del plesso', async () => {
    const { container } = render(<MessaggiPage />);
    await waitFor(() => expect(screen.getAllByText('Rossi Anna')).toHaveLength(2));
    const righe = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.includes('Rossi Anna'));
    expect(righe).toHaveLength(2);
    expect(within(righe[0] as HTMLElement).getByText(new RegExp(NOME_SEDE_A))).toBeInTheDocument();
    expect(within(righe[1] as HTMLElement).getByText(new RegExp(NOME_SEDE_B))).toBeInTheDocument();
  });

  it('con una sola sede accessibile la rubrica non la ripete su ogni riga', async () => {
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
    h.fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/admin/chat/contacts')
        ? Promise.resolve({ ok: true, json: async () => ({ success: true, data: [CONTATTI[0]] }) })
        : Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) }),
    );
    render(<MessaggiPage />);
    await waitFor(() => expect(screen.getByText('Rossi Anna')).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(NOME_SEDE_A))).not.toBeInTheDocument();
  });

  it('le chiavi usate esistono in entrambi i cataloghi', () => {
    expect(itAdminComunicazioni).toHaveProperty('messaggiSedeSconosciuta');
    expect(enAdminComunicazioni).toHaveProperty('messaggiSedeSconosciuta');
  });
});
