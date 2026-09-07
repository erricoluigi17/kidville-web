import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TicketMensaPanel } from '@/components/features/admin/pagamenti/TicketMensaPanel';

// Il pannello «Ticket mensa» dopo due correzioni:
//  · la conferma del salvataggio è un overlay animato che si chiude da sé, non
//    più un paragrafino inline che restava a schermo fino al cambio di bambino;
//  · una seconda ricarica nello stesso giorno apre un dialogo che mostra QUELLA
//    di stamattina, invece di registrare in silenzio un pagamento due volte.
//
// La sonda che distingue il prima dal dopo è `[data-particle]`: i coriandoli
// esistono solo dentro `SaveCelebration`. Un test che cercasse solo il testo
// resterebbe verde in entrambi i mondi, perché la frase è la stessa.

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const AL = { id: 'al-1', nome: 'Bambino', cognome: 'Uno', classe_sezione: '1A' };

interface MockOpts {
  /** cosa risponde il POST di ricarica, in ordine di chiamata */
  risposte?: { status: number; body: unknown }[];
}

function installFetch(opts: MockOpts = {}) {
  const risposte = [...(opts.risposte ?? [{ status: 201, body: { success: true, data: { saldo_ticket: 12, pagamento_id: 'p1', incasso_registrato: true } } }])];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u.includes('/api/pagamenti/ticket')) {
      const r = risposte.shift() ?? { status: 500, body: {} };
      return jsonRes(r.body, r.status);
    }
    if (u.includes('/api/admin/students')) return jsonRes([AL]);
    if (u.includes('/api/admin/settings')) return jsonRes({ success: true, data: { ticket_pacchetti: [] } });
    if (u.includes('/ticket/storico')) return jsonRes({ success: true, data: { saldo_ticket: 2, ultimo_carico: null, movimenti: [] } });
    if (u.includes('/ticket/morosi')) return jsonRes({ success: true, data: [] });
    if (u.includes('/api/pagamenti/ticket?')) return jsonRes({ success: true, data: { saldo_ticket: 2 } });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Monta, sceglie il bambino, e restituisce il bottone di ricarica. */
async function apriSuUnBambino() {
  const riga = await screen.findByRole('button', { name: /Bambino Uno/ });
  fireEvent.click(riga);
  return await screen.findByRole('button', { name: /Ricarica|Aggiungi/i });
}

describe('la conferma del salvataggio si vede', () => {
  it('dopo una ricarica riuscita compare la celebrazione animata, non un paragrafo inline', async () => {
    installFetch();
    const { container } = render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    const btn = await apriSuUnBambino();
    fireEvent.click(btn);

    // I coriandoli esistono SOLO dentro SaveCelebration: è questa asserzione che
    // il pannello di prima non poteva soddisfare.
    await waitFor(() => expect(container.querySelectorAll('[data-particle]').length).toBeGreaterThan(0));
    // ...ed è annunciata anche a chi non guarda lo schermo.
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('il bottone si disabilita mentre la richiesta è in volo: due click non fanno due ricariche', async () => {
    let sblocca: (v: Response) => void = () => {};
    const attesa = new Promise<Response>((r) => { sblocca = r; });
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST' && u.includes('/api/pagamenti/ticket')) return attesa;
      if (u.includes('/api/admin/students')) return jsonRes([AL]);
      if (u.includes('/api/admin/settings')) return jsonRes({ success: true, data: { ticket_pacchetti: [] } });
      if (u.includes('/ticket/storico')) return jsonRes({ success: true, data: { saldo_ticket: 2, ultimo_carico: null, movimenti: [] } });
      if (u.includes('/ticket/morosi')) return jsonRes({ success: true, data: [] });
      return jsonRes({ success: true, data: { saldo_ticket: 2 } });
    });
    vi.stubGlobal('fetch', fn);

    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    const btn = await apriSuUnBambino();
    fireEvent.click(btn);
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(btn);
    fireEvent.click(btn);

    const post = fn.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(post).toHaveLength(1);
    sblocca(jsonRes({ success: true, data: { saldo_ticket: 12 } }, 201));
  });
});

describe('il duplicato si vede prima di registrarlo', () => {
  const CORPO_409 = {
    error: 'Oggi a questo bambino è già stata registrata una ricarica.',
    codice: 'TICKET_RICARICA_DUPLICATA',
    precedente: { creato_il: '2026-09-07T09:30:00.000Z', pezzi: 10, importo: 50 },
  };

  it('il 409 apre un dialogo con ora, ticket e importo della ricarica di stamattina', async () => {
    installFetch({ risposte: [{ status: 409, body: CORPO_409 }] });
    const { container } = render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());

    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toBeTruthy();
    expect(dialogo.textContent).toMatch(/11:30/);          // 09:30 UTC = 11:30 a Roma
    expect(dialogo.textContent).toMatch(/10/);
    expect(dialogo.textContent).toMatch(/50,00/);          // importo localizzato, non «50»
    // niente si è ancora registrato: nessuna celebrazione
    expect(container.querySelectorAll('[data-particle]').length).toBe(0);
  });

  it('«Registra comunque» rimanda la richiesta CON la conferma nominata', async () => {
    const fn = installFetch({
      risposte: [
        { status: 409, body: CORPO_409 },
        { status: 201, body: { success: true, data: { saldo_ticket: 22 } } },
      ],
    });
    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /Registra comunque/i }));

    await waitFor(() => {
      const post = fn.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
      expect(post).toHaveLength(2);
      // Senza questa asserzione resterebbe verde un client che rimanda la stessa
      // richiesta SENZA il flag: un giro infinito di 409.
      expect(JSON.parse(String((post[1][1] as RequestInit).body)).conferma_duplicato).toBe('gia_ricaricato_oggi');
    });
  });

  it('«Annulla» chiude e non manda nessuna seconda richiesta', async () => {
    const fn = installFetch({ risposte: [{ status: 409, body: CORPO_409 }] });
    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /Annulla/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fn.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
  });

  it('un importo non registrato non si spaccia per «€ 0,00»', async () => {
    installFetch({ risposte: [{ status: 409, body: { ...CORPO_409, precedente: { ...CORPO_409.precedente, importo: null } } }] });
    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());

    const dialogo = await screen.findByRole('dialog');
    expect(dialogo.textContent).not.toMatch(/0,00/);
    expect(dialogo.textContent).toMatch(/non registrato/i);
  });
});

describe('gli errori si vedono a schermo, non in un alert del browser', () => {
  it('un 500 mostra un avviso e non chiama window.alert', async () => {
    const spia = vi.fn();
    vi.stubGlobal('alert', spia);
    installFetch({ risposte: [{ status: 500, body: { error: 'Errore aggiornamento saldo' } }] });
    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(spia).not.toHaveBeenCalled();
  });

  it('la rete che cade lascia un segno invece del silenzio', async () => {
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST' && u.includes('/api/pagamenti/ticket')) throw new TypeError('Failed to fetch');
      if (u.includes('/api/admin/students')) return jsonRes([AL]);
      if (u.includes('/api/admin/settings')) return jsonRes({ success: true, data: { ticket_pacchetti: [] } });
      if (u.includes('/ticket/storico')) return jsonRes({ success: true, data: { saldo_ticket: 2, ultimo_carico: null, movimenti: [] } });
      if (u.includes('/ticket/morosi')) return jsonRes({ success: true, data: [] });
      return jsonRes({ success: true, data: { saldo_ticket: 2 } });
    });
    vi.stubGlobal('fetch', fn);
    render(<TicketMensaPanel userId="u1" scuolaId="sc-1" />);
    fireEvent.click(await apriSuUnBambino());
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
