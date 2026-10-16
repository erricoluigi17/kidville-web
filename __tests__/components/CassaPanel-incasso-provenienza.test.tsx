import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SEDE_A } from '../fixtures/sedi';
import { creaFintoSupabase } from '../fixtures/finto-supabase';

const h = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]>, sede: '' }));
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ({ user: { id: 'staff-1', role: 'segreteria', scuola_id: h.sede } }) }));
vi.mock('@/lib/auth/scope', async orig => ({ ...(await orig<typeof import('@/lib/auth/scope')>()), resolveScuoleAttive: async () => [h.sede] }));
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db) }));
vi.mock('@/lib/context/admin-identity', () => ({ useAdminIdentity: () => ({ userId: 'staff-1', ruolo: 'segreteria' }) }));
vi.mock('@/lib/context/sede-context', async orig => ({ ...(await orig<typeof import('@/lib/context/sede-context')>()), useSediAttive: () => ({ sedi: [{ id: h.sede, nome: 'Sede Alfa' }], effettive: [h.sede] }) }));
vi.mock('@/lib/logging/logger', async orig => ({ ...(await orig<typeof import('@/lib/logging/logger')>()), logOk: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn() }));

import { GET } from '@/app/api/pagamenti/cassa/movimenti/route';
import { CassaPanel } from '@/components/features/admin/pagamenti/CassaPanel';

afterEach(() => vi.unstubAllGlobals());

describe('registro UI collegato alla GET: cassa dell’incasso', () => {
  it('l’incasso Saggio appare e resta nel filtro Saggio invece di finire in generale', async () => {
    h.sede = SEDE_A;
    const categoria = 'dddddddd-0000-4000-8000-00000000000d';
    h.db = {
      schools: [{ id: SEDE_A, nome: 'Sede Alfa' }],
      cassa_movimenti: [],
      payment_categories: [{ id: categoria, nome: 'Saggio' }],
      incassi: [
        { id: 'i-saggio', importo: 30, metodo: 'contanti', data_incasso: '2026-10-16', creato_il: '2026-10-16T10:00:00Z', stornato_il: null, pagamenti: { scuola_id: SEDE_A, categoria_id: categoria } },
        { id: 'i-generale', importo: 20, metodo: 'contanti', data_incasso: '2026-10-16', creato_il: '2026-10-16T11:00:00Z', stornato_il: null, pagamenti: { scuola_id: SEDE_A, categoria_id: null } },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => GET(new Request(new URL(String(url), 'http://localhost'), { headers: { 'x-user-id': 'staff-1' } }))));
    render(<CassaPanel userId="staff-1" scuolaId={SEDE_A} />);
    await screen.findByRole('option', { name: 'Saggio' });
    fireEvent.change(screen.getByLabelText('Cassa di provenienza'), { target: { value: categoria } });
    expect(screen.getAllByTestId('cassa-movimento-card')).toHaveLength(1);
    expect(screen.getByTestId('cassa-movimento-card').textContent).toContain('Saggio');
    expect(screen.getByTestId('cassa-movimento-card').textContent).toContain('+ € 30,00');
    expect(within(screen.getByTestId('cassa-movimenti-tabella')).getByText('Saggio')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Cassa di provenienza'), { target: { value: '__generale__' } });
    expect(screen.getAllByTestId('cassa-movimento-card')).toHaveLength(1);
    expect(screen.getByTestId('cassa-movimento-card').textContent).toContain('+ € 20,00');
  });
});
