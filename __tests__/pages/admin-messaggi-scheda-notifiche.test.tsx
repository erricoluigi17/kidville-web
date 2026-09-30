import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';
import itAdminComunicazioni from '../../messages/it/adminComunicazioni.json';

/**
 * /admin/messaggi — la scheda «Notifiche spente» è della DIREZIONE (C2).
 *
 * Perché la visibilità si collauda qui e non solo nella route: il gate vero è
 * nella route (`requireStaff(request, RUOLI_DIREZIONE)`), ma una linguetta che
 * la segreteria può premere per ricevere un 403 è peggio di una linguetta
 * assente — e aprire questo elenco alla segreteria è una decisione del titolare,
 * non un adeguamento. L'elenco dice, nome per nome, quanti messaggi una collega
 * ha in attesa.
 */

const h = vi.hoisted(() => ({
  ruolo: 'coordinator' as string,
  fetchMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/admin/messaggi',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'chi-guarda', role: h.ruolo, ready: true }),
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));

const SENZA_PUSH = [{ id: 'd1', nome: 'Greco Fiora', ricevuti30g: 137, nonLetti: 12 }];

beforeEach(() => {
  vi.clearAllMocks();
  h.ruolo = 'coordinator';
  h.fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/api/admin/chat/vigilanza')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [], totale: 0 }),
      })
    }
    if (u.includes('/api/admin/chat/docenti-senza-push')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: SENZA_PUSH, totale: 1, docentiTotali: 9, giorni: 30 }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [], filtri: { docenti: [], genitori: [], classi: [] } }) });
  });
  vi.stubGlobal('fetch', h.fetchMock);
});

import MessaggiPage from '@/app/(dashboard)/admin/messaggi/page';

describe('/admin/messaggi — scheda «Notifiche spente»', () => {
  it('la Direzione vede la linguetta e apre l\'elenco', async () => {
    render(<MessaggiPage />);
    const linguetta = await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabNotificheDocenti, 'i') });
    await act(async () => { fireEvent.click(linguetta); });
    expect(await screen.findByText('Greco Fiora')).toBeInTheDocument();
    await waitFor(() =>
      expect(h.fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/admin/chat/docenti-senza-push')),
    );
  });

  it('se la veste cambia mentre la scheda è aperta, l\'elenco sparisce', async () => {
    // Le quattro insegnanti che sono anche genitori, e chi ha più di un ruolo,
    // cambiano veste dentro l'app (`kv-active-role`): lo STATO della scheda
    // scelta sopravvive al cambio, il permesso no. Senza il secondo controllo
    // nel guscio, l'elenco resterebbe a schermo con la linguetta già sparita.
    const { rerender } = render(<MessaggiPage />);
    const linguetta = await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabNotificheDocenti, 'i') });
    await act(async () => { fireEvent.click(linguetta); });
    expect(await screen.findByText('Greco Fiora')).toBeInTheDocument();

    h.ruolo = 'segreteria';
    await act(async () => { rerender(<MessaggiPage />); });
    expect(screen.queryByText('Greco Fiora')).not.toBeInTheDocument();
  });

  it('anche il REGISTRO sparisce se la veste cambia mentre è aperto', async () => {
    // La stessa difesa delle notifiche, sull'altra scheda della Direzione: il
    // registro degli accessi non è meno riservato dell'elenco, e lasciarne una
    // scoperta avrebbe reso il controllo un caso particolare invece di una
    // regola.
    const { rerender } = render(<MessaggiPage />);
    const linguetta = await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabRegistro, 'i') });
    await act(async () => { fireEvent.click(linguetta); });
    await waitFor(() =>
      expect(h.fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/admin/chat/vigilanza')),
    );
    const chiamateRegistro = () =>
      h.fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/chat/vigilanza')).length;
    const prima = chiamateRegistro();

    h.ruolo = 'segreteria';
    await act(async () => { rerender(<MessaggiPage />); });
    // Smontato: la linguetta è sparita e il registro non chiede più niente.
    expect(
      screen.queryByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabRegistro, 'i') }),
    ).not.toBeInTheDocument();
    expect(chiamateRegistro()).toBe(prima);
  });

  it('la segreteria NON vede la linguetta', async () => {
    h.ruolo = 'segreteria';
    render(<MessaggiPage />);
    // Si aspetta che la pagina abbia finito di montarsi, poi si guarda l'assenza:
    // un'assenza verificata su una pagina ancora vuota è vera per il motivo
    // sbagliato.
    expect(await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabTutti, 'i') })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabNotificheDocenti, 'i') }),
    ).not.toBeInTheDocument();
  });

  it('la segreteria non chiede quell\'elenco nemmeno da sola', async () => {
    h.ruolo = 'segreteria';
    render(<MessaggiPage />);
    await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabTutti, 'i') });
    expect(
      h.fetchMock.mock.calls.filter((c) => String(c[0]).includes('docenti-senza-push')),
    ).toHaveLength(0);
  });

  it('l\'admin vede la linguetta come la Direzione', async () => {
    h.ruolo = 'admin';
    render(<MessaggiPage />);
    expect(
      await screen.findByRole('button', { name: new RegExp(itAdminComunicazioni.messaggiTabNotificheDocenti, 'i') }),
    ).toBeInTheDocument();
  });
});
