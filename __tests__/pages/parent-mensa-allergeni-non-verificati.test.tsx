import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// =============================================================================
// FASE 11 — «errori non ignorati»: il banner degli allergeni della mensa del genitore.
//
// Prima un controllo caduto (500, rete giù) e un menù senza allergeni davano la stessa schermata:
// nessun banner. Per un bambino allergico è la differenza fra «puoi prenotare» e «non lo so».
// Ora il controllo caduto lo dice, e il pericolo vero resta il banner rosso di sempre.
// =============================================================================

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/auth/use-parent-identity', () => ({
  useParentIdentity: () => ({ parentId: 'genitore-1', studentId: 'alunno-1', ready: true }),
}));
vi.mock('@/components/features/parent/mensa/MensaCalendar', () => ({ MensaCalendar: () => <div data-testid="calendario" /> }));
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto') }));

import ParentMensaPage from '@/app/(dashboard)/parent/mensa/page';

const fetchMock = vi.fn();

beforeEach(() => {
  h.logClient.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function risposta(stato: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } });
}

describe('/parent/mensa — allergeni', () => {
  it('controllo caduto con un 500: lo dice a schermo, e lascia la riga nel log', async () => {
    fetchMock.mockResolvedValue(risposta(500, { error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' }));
    render(<ParentMensaPage />);
    expect(await screen.findByText('Allergeni non verificati')).toBeTruthy();
    expect(screen.queryByText('Allergeni nel menù di oggi')).toBeNull();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', messaggio: 'mensa-allergeni-non-verificati: http 500' }));
  });

  it('rete giù: stesso avviso', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ParentMensaPage />);
    expect(await screen.findByText('Allergeni non verificati')).toBeTruthy();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'mensa-allergeni-non-verificati: TypeError' }));
  });

  it('pericolo vero: il banner rosso di sempre, senza l’avviso del controllo caduto', async () => {
    fetchMock.mockResolvedValue(risposta(200, { pericolo: true, conflitti_label: ['Glutine'] }));
    render(<ParentMensaPage />);
    expect(await screen.findByText('Allergeni nel menù di oggi')).toBeTruthy();
    expect(screen.queryByText('Allergeni non verificati')).toBeNull();
    expect(h.logClient).not.toHaveBeenCalled();
  });
});
