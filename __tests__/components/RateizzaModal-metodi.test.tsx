import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RateizzaModal } from '@/components/features/admin/pagamenti/RateizzaModal';

/**
 * ─── «DIVIDI IN ACCONTI» NON CANCELLA IL «SOLO CONTANTI» (revisione, 2026-10-05) ──
 *
 * La modale SOSTITUISCE una voce: `POST /api/pagamenti/rate` crea padre + rate, poi
 * la voce originale si cancella. Il corpo della POST non portava i metodi ammessi, e
 * la voce «solo contanti» rinasceva pagabile con bonifico. Ora la modale manda i
 * metodi della voce che sostituisce (la rotta decide se scriverli); senza la prop
 * («Acquisto rapido») il corpo resta quello di prima.
 * Dati SINTETICI (il repo è pubblico).
 */

const CATALOGO_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>;
const testo = (k: string) => CATALOGO_IT[k] ?? `adminContabilita.${k}`;

const ALUNNO = { id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', nome: 'Tina', cognome: 'Blu', classe_sezione: '3 ANNI' };

function server() {
  const chiamate: { url: string; metodo: string; corpo?: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const metodo = init?.method ?? 'GET';
    chiamate.push({ url: String(url), metodo, corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    if (metodo === 'POST') return { ok: true, status: 201, json: async () => ({ success: true, data: {} }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  return { fetchMock, post: () => chiamate.filter((c) => c.metodo === 'POST'), delete: () => chiamate.filter((c) => c.metodo === 'DELETE') };
}

async function creaPiano() {
  fireEvent.click(screen.getByRole('button', { name: testo('rateGeneraUguali') }));
  const crea = screen.getByRole('button', { name: testo('rateCreaPiano') });
  await waitFor(() => expect(crea).toBeEnabled());
  fireEvent.click(crea);
}

describe('RateizzaModal — i metodi ammessi della voce sostituita', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('una voce «solo contanti»: la POST del piano porta metodi_ammessi = [contanti], poi l’originale si cancella', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    const onDone = vi.fn();
    render(
      <RateizzaModal
        alunno={ALUNNO}
        userId="u1"
        descrizione="Corso di nuoto"
        importoTotale={90}
        metodiAmmessi={['contanti']}
        replacePagamentoId="pg-originale"
        onClose={() => {}}
        onDone={onDone}
      />,
    );

    await creaPiano();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(s.post()).toHaveLength(1);
    expect(s.post()[0].url).toBe('/api/pagamenti/rate');
    expect(s.post()[0].corpo?.metodi_ammessi).toEqual(['contanti']);
    // La sostituzione avviene DOPO, sulla voce originale.
    expect(s.delete()).toHaveLength(1);
    expect(s.delete()[0].url).toContain('/api/pagamenti/pg-originale');
  });

  it('i metodi arrivano normalizzati: un valore ignoto non diventa un 400', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(
      <RateizzaModal
        alunno={ALUNNO}
        userId="u1"
        descrizione="Corso di nuoto"
        importoTotale={90}
        metodiAmmessi={['bonifico', 'pos']}
        replacePagamentoId="pg-originale"
        onClose={() => {}}
        onDone={() => {}}
      />,
    );

    await creaPiano();

    await waitFor(() => expect(s.post()).toHaveLength(1));
    expect(s.post()[0].corpo?.metodi_ammessi).toEqual(['bonifico']);
  });

  it('senza la prop («Acquisto rapido»): il corpo non nomina i metodi', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(
      <RateizzaModal alunno={ALUNNO} userId="u1" descrizione="Divisa" importoTotale={90} onClose={() => {}} onDone={() => {}} />,
    );

    await creaPiano();

    await waitFor(() => expect(s.post()).toHaveLength(1));
    // Àncora positiva: il corpo è quello del piano.
    expect(s.post()[0].corpo?.descrizione).toBe('Divisa');
    expect(s.post()[0].corpo).not.toHaveProperty('metodi_ammessi');
  });
});
