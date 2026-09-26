import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Il pannello «Ticket mensa» con più sedi insieme (P7, 2026-09-26).
//
// Il difetto: i prezzi dei pacchetti (`ticket_pacchetti`) si chiedevano con
// `GET /api/admin/settings` SENZA `scuola_id`. Con più sedi la route risponde
// 400 (`resolveScuolaScrittura`), il pannello leggeva `d.success` falso e
// lasciava i pacchetti vuoti — in silenzio. E con una sede sola ma un alunno
// scelto da un chip dei morosi, i pacchetti di una sede potevano restare
// proposti per il bambino di un'altra. Qui si misura:
//  · i pacchetti si chiedono con la sede dell'ALUNNO scelto, mai senza sede;
//  · la risposta di una sede non si mostra sotto l'alunno di un'altra (anche se
//    arriva in ritardo, anche se il server risponde con una sede diversa);
//  · il guasto si vede ed è registrato;
//  · con più sedi la sede compare nei chip dei morosi, nell'elenco e
//    nell'intestazione; con una sola, niente cambia.

const sediMock = vi.hoisted(() => ({
  valore: {
    sedi: [] as { id: string; nome: string }[],
    effettive: [] as string[],
  },
}));

vi.mock('@/lib/context/sede-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/sede-context')>()),
  useSediAttive: () => sediMock.valore,
}));

vi.mock('@/lib/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/client')>()),
  logClient: vi.fn(),
}));

import { TicketMensaPanel } from '@/components/features/admin/pagamenti/TicketMensaPanel';
import { logClient } from '@/lib/logging/client';

const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SEDE_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const AL_A = { id: 'al-a', nome: 'Primo', cognome: 'Alfa', classe_sezione: '1A', scuola_id: SEDE_A };
const AL_B = { id: 'al-b', nome: 'Secondo', cognome: 'Beta', classe_sezione: '2B', scuola_id: SEDE_B };

const PACCHETTI: Record<string, { label: string; pezzi: number; costo: number }[]> = {
  [SEDE_A]: [{ label: 'Mensile A', pezzi: 20, costo: 90 }],
  [SEDE_B]: [{ label: 'Mensile B', pezzi: 15, costo: 60 }],
};

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

interface Opzioni {
  alunni?: unknown[];
  morosi?: unknown[];
  /** Risposta della GET delle impostazioni, per sede chiesta. */
  impostazioni?: (sede: string | null) => Response | Promise<Response>;
}

function installFetch(o: Opzioni = {}) {
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') return jsonRes({ success: true, data: { saldo_ticket: 1 } }, 201);
    if (u.includes('/api/admin/students')) return jsonRes(o.alunni ?? [AL_A, AL_B]);
    if (u.includes('/api/admin/settings')) {
      const sede = new URL(u, 'http://x').searchParams.get('scuola_id');
      if (o.impostazioni) return o.impostazioni(sede);
      if (!sede) return jsonRes({ error: 'Sede da specificare', codice: 'SEDE_DA_SPECIFICARE' }, 400);
      return jsonRes({ success: true, data: { scuola_id: sede, ticket_pacchetti: PACCHETTI[sede] ?? [] } });
    }
    if (u.includes('/ticket/storico')) return jsonRes({ success: true, data: { saldo_ticket: 0, ultimo_carico: null, movimenti: [] } });
    if (u.includes('/ticket/morosi')) return jsonRes({ success: true, data: o.morosi ?? [] });
    if (u.includes('/api/pagamenti/ticket?')) return jsonRes({ success: true, data: { saldo_ticket: 0 } });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const urls = (fn: ReturnType<typeof installFetch>) => fn.mock.calls.map(([u]) => String(u));
const chiamateImpostazioni = (fn: ReturnType<typeof installFetch>) =>
  urls(fn).filter((u) => u.includes('/api/admin/settings'));

function piuSedi() {
  sediMock.valore = {
    sedi: [{ id: SEDE_A, nome: 'Plesso Alfa' }, { id: SEDE_B, nome: 'Plesso Beta' }],
    effettive: [SEDE_A, SEDE_B],
  };
}

beforeEach(() => {
  piuSedi();
  vi.mocked(logClient).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('i pacchetti si chiedono con la sede dell’alunno scelto', () => {
  it('scegliendo un alunno di A e poi uno di B, ciascuno vede SOLO i pacchetti della propria sede', async () => {
    const fn = installFetch();
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mensile B/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Secondo Beta/ }));
    expect(await screen.findByRole('button', { name: /Mensile B/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mensile A/ })).toBeNull();

    const chieste = chiamateImpostazioni(fn).map((u) => new URL(u, 'http://x').searchParams.get('scuola_id'));
    expect(chieste).toEqual([SEDE_A, SEDE_B]);
  });

  it('non si chiedono mai le impostazioni SENZA sede (con più sedi è un 400 muto)', async () => {
    const fn = installFetch();
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    await screen.findByRole('button', { name: /Mensile A/ });

    for (const u of chiamateImpostazioni(fn)) {
      expect(new URL(u, 'http://x').searchParams.get('scuola_id')).toBeTruthy();
    }
    expect(urls(fn).join(' ')).not.toMatch(/scuola_id=(undefined|null)(&|$|\s)/);
  });

  it('una risposta di A che arriva DOPO la scelta di B non compare sotto B', async () => {
    let sbloccaA: (r: Response) => void = () => {};
    installFetch({
      impostazioni: (sede) => {
        if (sede === SEDE_A) return new Promise<Response>((r) => { sbloccaA = r; });
        return jsonRes({ success: true, data: { scuola_id: sede, ticket_pacchetti: PACCHETTI[sede!] } });
      },
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    fireEvent.click(screen.getByRole('button', { name: /Secondo Beta/ }));
    expect(await screen.findByRole('button', { name: /Mensile B/ })).toBeTruthy();

    sbloccaA(jsonRes({ success: true, data: { scuola_id: SEDE_A, ticket_pacchetti: PACCHETTI[SEDE_A] } }));
    // Si aspetta una PRESENZA (il pacchetto di B, ancora lì) dopo che A è arrivata:
    // il ciclo di microtask della risposta di A si chiude prima del prossimo giro.
    await new Promise((r) => setTimeout(r, 0));
    expect(await screen.findByRole('button', { name: /Mensile B/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mensile A/ })).toBeNull();
  });

  it('se il server risponde con le impostazioni di un’ALTRA sede, i prezzi non si propongono', async () => {
    installFetch({
      impostazioni: () => jsonRes({ success: true, data: { scuola_id: SEDE_B, ticket_pacchetti: PACCHETTI[SEDE_B] } }),
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));

    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toMatch(/pacchetti della sede di questo alunno/);
    expect(screen.queryByRole('button', { name: /Mensile B/ })).toBeNull();
    expect(vi.mocked(logClient)).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'ticket-mensa-pacchetti-sede-diversa' }),
    );
  });

  it('un caricamento fallito si VEDE, si registra, e «Riprova» lo ripete con la stessa sede', async () => {
    let tentativi = 0;
    const fn = installFetch({
      impostazioni: (sede) => {
        tentativi++;
        if (tentativi === 1) return jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, 403);
        return jsonRes({ success: true, data: { scuola_id: sede, ticket_pacchetti: PACCHETTI[sede!] } });
      },
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));

    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toMatch(/Non è stato possibile caricare i pacchetti/);
    expect(vi.mocked(logClient)).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: 'ticket-mensa-pacchetti-non-caricati', stato: 403 }),
    );

    fireEvent.click(within(avviso).getByRole('button', { name: /Riprova/ }));
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    // Dopo una PRESENZA (i pacchetti arrivati): l'avviso del primo tentativo non c'è
    // più. Lo toglie l'avvio del nuovo caricamento; senza, i due stati convivrebbero.
    expect(screen.queryByText(/Non è stato possibile caricare i pacchetti/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    const chieste = chiamateImpostazioni(fn).map((u) => new URL(u, 'http://x').searchParams.get('scuola_id'));
    expect(chieste).toEqual([SEDE_A, SEDE_A]);
  });

  it('la rete che cade sul caricamento dei pacchetti lascia un avviso e un log', async () => {
    installFetch({ impostazioni: () => { throw new TypeError('Failed to fetch'); } });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Non è stato possibile caricare i pacchetti/);
    expect(vi.mocked(logClient)).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'ticket-mensa-pacchetti-non-caricati: TypeError' }),
    );
  });

  it('una risposta 200 col corpo JSON `null` lascia un avviso E un log (non un fallimento muto)', async () => {
    installFetch({ impostazioni: () => jsonRes(null, 200) });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Non è stato possibile caricare i pacchetti/);
    expect(vi.mocked(logClient)).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: 'ticket-mensa-pacchetti-risposta-inattesa', stato: 200 }),
    );
    expect(screen.queryByRole('button', { name: /Mensile A/ })).toBeNull();
  });

  it('passando a un alunno di un’altra sede, ticket e importo scelti col pacchetto di prima si azzerano', async () => {
    installFetch();
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Mensile A/ }));
    const importo = () => (screen.getAllByRole('spinbutton')[1] as HTMLInputElement).value;
    expect(importo()).toBe('90');

    fireEvent.click(screen.getByRole('button', { name: /Secondo Beta/ }));
    await screen.findByRole('button', { name: /Mensile B/ });
    // 90 € era il prezzo di A: sotto il bambino di B non deve restare proposto.
    expect(importo()).toBe('50');
    expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value).toBe('10');
  });

  it('un moroso senza sede, con più sedi selezionate: nessun pacchetto e la ragione a schermo', async () => {
    const fn = installFetch({
      alunni: [],
      morosi: [{ alunno_id: 'al-x', nome: 'Terzo', cognome: 'Gamma', classe_sezione: null, scuola_id: null, scuola_nome: null, saldo_ticket: -3, ultimo_carico: null }],
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Terzo Gamma/ }));

    // L'avviso sta in una regione `role="status"` (aria-live polite): chi usa un
    // lettore di schermo deve sapere che ticket e importo vanno inseriti a mano.
    const stato = screen.getByRole('status');
    expect(await within(stato).findByText(/La sede di questo alunno non è indicata/)).toBeTruthy();
    expect(chiamateImpostazioni(fn)).toEqual([]);
    // Nell'intestazione la sede ignota si dice UNA volta: non «Sede: Sede non indicata».
    const intestazione = screen.getByTestId('ticket-alunno-scelto');
    expect(intestazione.textContent).toContain('Sede non indicata');
    expect(intestazione.textContent).not.toContain('Sede: Sede');
  });

  // Due alunni della STESSA sede cliccati di fila, con la prima GET ancora in volo.
  // Prima partivano due GET per la stessa sede, e l'esito che arrivava per ultimo
  // si sommava all'altro: pacchetti a schermo E l'avviso «non è stato possibile
  // caricare…». Ora per una sede c'è una sola richiesta in volo, e lo stato a
  // schermo è uno solo.
  const AL_A2 = { id: 'al-a2', nome: 'Quarto', cognome: 'Alfa', classe_sezione: '1A', scuola_id: SEDE_A };
  const rifiuto = () => jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, 403);
  const successoA = () => jsonRes({ success: true, data: { scuola_id: SEDE_A, ticket_pacchetti: PACCHETTI[SEDE_A] } });

  it('stessa sede cliccata due volte: la prima GET FALLISCE (la seconda riuscirebbe) → solo l’avviso, niente pacchetti', async () => {
    let sbloccaPrima: (r: Response) => void = () => {};
    let n = 0;
    const fn = installFetch({
      alunni: [AL_A, AL_A2],
      impostazioni: () => {
        n++;
        if (n === 1) return new Promise<Response>((r) => { sbloccaPrima = r; });
        return successoA();
      },
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    fireEvent.click(screen.getByRole('button', { name: /Quarto Alfa/ }));
    sbloccaPrima(rifiuto());

    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toMatch(/Non è stato possibile caricare i pacchetti/);
    expect(screen.queryByRole('button', { name: /Mensile A/ })).toBeNull();
    expect(chiamateImpostazioni(fn)).toHaveLength(1);
  });

  it('stessa sede cliccata due volte: la prima GET RIESCE (la seconda fallirebbe) → pacchetti, nessun avviso', async () => {
    let sbloccaPrima: (r: Response) => void = () => {};
    let n = 0;
    const fn = installFetch({
      alunni: [AL_A, AL_A2],
      impostazioni: () => {
        n++;
        if (n === 1) return new Promise<Response>((r) => { sbloccaPrima = r; });
        return rifiuto();
      },
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));
    fireEvent.click(screen.getByRole('button', { name: /Quarto Alfa/ }));
    sbloccaPrima(successoA());

    // Si aspetta la PRESENZA dei pacchetti: a quel punto l'unica GET è chiusa.
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chiamateImpostazioni(fn)).toHaveLength(1);
  });

  it('il caricamento dei pacchetti si annuncia nella regione di stato', async () => {
    let sblocca: (r: Response) => void = () => {};
    installFetch({ impostazioni: () => new Promise<Response>((r) => { sblocca = r; }) });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Primo Alfa/ }));

    const stato = screen.getByRole('status');
    expect(await within(stato).findByText(/Caricamento dei pacchetti della sede/)).toBeTruthy();
    sblocca(jsonRes({ success: true, data: { scuola_id: SEDE_A, ticket_pacchetti: PACCHETTI[SEDE_A] } }));
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    expect(stato.textContent).toBe('');
  });

  it('dal CHIP di un moroso di B, con più sedi: pacchetti chiesti con la sede di B e proposti', async () => {
    // Il chip è la via d'ingresso principale per i morosi. La sede che porta la sua
    // riga (`scuola_id`) deve arrivare fino alla GET dei pacchetti: con più sedi la
    // pagina non ne ha una da prestare. L'elenco alunni è vuoto, così l'unico
    // «Secondo Beta» cliccabile è il chip.
    const fn = installFetch({
      alunni: [],
      morosi: [{ alunno_id: AL_B.id, nome: AL_B.nome, cognome: AL_B.cognome, classe_sezione: '2B', scuola_id: SEDE_B, scuola_nome: 'Plesso Beta', saldo_ticket: -4, ultimo_carico: null }],
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    const chip = await screen.findByRole('button', { name: /Secondo Beta/ });
    fireEvent.click(chip);

    expect(await screen.findByRole('button', { name: /Mensile B/ })).toBeTruthy();
    expect(chiamateImpostazioni(fn).map((u) => new URL(u, 'http://x').searchParams.get('scuola_id'))).toEqual([SEDE_B]);
    expect(screen.queryByText(/La sede di questo alunno non è indicata/)).toBeNull();
    expect(screen.getByTestId('ticket-alunno-scelto').textContent).toContain('Sede: Plesso Beta');
  });
});

describe('con più sedi la sede si vede', () => {
  it('le GET di elenco partono SENZA scuola_id, mai con «undefined»/«null»', async () => {
    const fn = installFetch();
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    await screen.findByRole('button', { name: /Primo Alfa/ });
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/ticket/morosi'))).toBe(true));

    const elenco = urls(fn).filter((u) => u.includes('/api/admin/students') || u.includes('/ticket/morosi'));
    expect(elenco).toHaveLength(2);
    for (const u of elenco) {
      expect(u).not.toContain('scuola_id');
      expect(u).not.toMatch(/undefined|null/);
    }
  });

  it('nome della sede nell’elenco, nel chip del moroso e nell’intestazione dell’alunno scelto', async () => {
    installFetch({
      morosi: [{ alunno_id: AL_B.id, nome: AL_B.nome, cognome: AL_B.cognome, classe_sezione: '2B', scuola_id: SEDE_B, scuola_nome: 'Plesso Beta', saldo_ticket: -4, ultimo_carico: null }],
    });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);

    const rigaA = await screen.findByRole('button', { name: /Primo Alfa/ });
    expect(rigaA.textContent).toContain('Plesso Alfa');
    const bottoniB = await screen.findAllByRole('button', { name: /Secondo Beta/ });
    // uno è il chip dei morosi, l'altro la riga dell'elenco: entrambi dicono la sede
    expect(bottoniB).toHaveLength(2);
    for (const b of bottoniB) expect(b.textContent).toContain('Plesso Beta');

    fireEvent.click(rigaA);
    const intestazione = await screen.findByTestId('ticket-alunno-scelto');
    expect(intestazione.textContent).toContain('Primo Alfa');
    // Etichetta e valore vengono da UNA chiave del catalogo con segnaposto, non da
    // una concatenazione nel JSX.
    expect(intestazione.textContent).toContain('Sede: Plesso Alfa');
  });

  it('una sede che non ha un nome si dice «Sede non indicata», non un uuid', async () => {
    const ignota = 'cccccccc-0000-4000-8000-000000000003';
    installFetch({ alunni: [{ ...AL_A, scuola_id: ignota }] });
    render(<TicketMensaPanel userId="u1" scuolaId={null} />);
    const riga = await screen.findByRole('button', { name: /Primo Alfa/ });
    expect(riga.textContent).toContain('Sede non indicata');
    expect(riga.textContent).not.toContain(ignota);
  });
});

describe('con una sede sola niente cambia', () => {
  beforeEach(() => {
    sediMock.valore = { sedi: [{ id: SEDE_A, nome: 'Plesso Alfa' }], effettive: [SEDE_A] };
  });

  it('elenchi con la sede, pacchetti della stessa sede, e nessun nome di sede a schermo', async () => {
    const fn = installFetch({ alunni: [AL_A] });
    render(<TicketMensaPanel userId="u1" scuolaId={SEDE_A} />);

    const riga = await screen.findByRole('button', { name: /Primo Alfa/ });
    expect(riga.textContent).not.toContain('Plesso Alfa');
    await waitFor(() => expect(urls(fn).some((u) => u.includes('/ticket/morosi'))).toBe(true));
    for (const u of urls(fn).filter((x) => x.includes('/api/admin/students') || x.includes('/ticket/morosi'))) {
      expect(new URL(u, 'http://x').searchParams.get('scuola_id')).toBe(SEDE_A);
    }

    fireEvent.click(riga);
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    expect(screen.getByTestId('ticket-alunno-scelto').textContent).not.toContain('Plesso Alfa');
    expect(chiamateImpostazioni(fn).map((u) => new URL(u, 'http://x').searchParams.get('scuola_id'))).toEqual([SEDE_A]);
  });

  it('un moroso senza sede nella riga usa la sede della pagina, che è l’unica selezionata', async () => {
    const fn = installFetch({
      alunni: [],
      morosi: [{ alunno_id: 'al-x', nome: 'Terzo', cognome: 'Gamma', classe_sezione: null, scuola_id: null, scuola_nome: null, saldo_ticket: -3, ultimo_carico: null }],
    });
    render(<TicketMensaPanel userId="u1" scuolaId={SEDE_A} />);
    fireEvent.click(await screen.findByRole('button', { name: /Terzo Gamma/ }));
    expect(await screen.findByRole('button', { name: /Mensile A/ })).toBeTruthy();
    expect(chiamateImpostazioni(fn).map((u) => new URL(u, 'http://x').searchParams.get('scuola_id'))).toEqual([SEDE_A]);
  });
});
