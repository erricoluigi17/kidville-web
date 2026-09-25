import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

/**
 * Mensa del GENITORE: niente «oggi» dopo il cutoff, niente giorni passati.
 *
 * Il server rifiuta già (`entroCutoff` in ora di Roma, codice `MENSA_OLTRE_CUTOFF`);
 * qui si prova che lo SCHERMO dice la stessa cosa:
 *  · i pulsanti di oggi si spengono dopo il cutoff della sede (ora italiana), anche se
 *    la pagina resta aperta oltre l'orario (timer) o il tocco arriva prima del timer;
 *  · i giorni passati secondo il calendario di ROMA sono sempre spenti (fra mezzanotte
 *    e le 2 italiane la data UTC è ancora ieri: con `toISOString()` ieri era «oggi»);
 *  · la risposta `MENSA_OLTRE_CUTOFF` mostra «Oltre le HH:MM…» invece dell'errore generico.
 *
 * L'orologio è finto SOLO per `Date` e `setInterval`: `setTimeout` resta vero, così
 * `waitFor` continua a funzionare.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/parent/mensa',
}));

// Dexie non gira in jsdom: con lo store di lettura finto la GET del menu può rispondere
// `ok: true` e il componente riceve davvero i giorni (stesso mock del test «stato vuoto»).
vi.mock('@/lib/offline/db', () => ({
  db: {
    cache_read: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { MensaCalendar, bloccoGiorno, RICONTROLLO_CUTOFF_MS } from '@/components/features/parent/mensa/MensaCalendar';
import itMensa from '../../messages/it/mensa.json';
import itShared from '../../messages/it/shared.json';

const IT = itMensa as Record<string, string>;
const GENERICO_CUTOFF = (itShared as Record<string, string>).erroreMensaOltreCutoff;
const oltre = (ora: string) => IT.oltreCutoffOggi.replace('{ora}', ora);

const fetchMock = vi.fn();

// Mercoledì 7 ottobre 2026: ora LEGALE (UTC+2). 07:29:50Z = 09:29:50 a Roma.
const IERI = '2026-10-06';
const OGGI = '2026-10-07';
const DOMANI = '2026-10-08';

function giorno(data: string) {
  return { data, attivo: true, chiuso: false, portate: { primo: 'Pasta' }, allergeni: null };
}

interface Scenario {
  giorni: string[];
  prenotati: string[];
  cutoffOra: string | null;
  post?: () => unknown;
  del?: () => unknown;
}

function installaFetch(s: Scenario) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    if (url.includes('/api/mensa/menu')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: s.giorni.map(giorno) }) });
    }
    if (url.includes('/api/mensa/prenotazioni') && metodo === 'POST') {
      return Promise.resolve({ status: 201, json: async () => s.post?.() });
    }
    if (url.includes('/api/mensa/prenotazioni') && metodo === 'DELETE') {
      return Promise.resolve({ status: 400, json: async () => s.del?.() });
    }
    if (url.includes('/api/mensa/prenotazioni')) {
      return Promise.resolve({
        status: 200,
        json: async () => ({
          success: true,
          data: {
            saldo: 5,
            prenotazioni: s.prenotati.map((data) => ({ data, stato: 'prenotato', origine: 'genitore' })),
            cutoffOra: s.cutoffOra,
          },
        }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
  });
}

const chiamate = (metodo: string) =>
  fetchMock.mock.calls.filter(([u, init]) => String(u).includes('/api/mensa/prenotazioni') && (init as RequestInit | undefined)?.method === metodo);

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bloccoGiorno (pura, ora e data di Roma)', () => {
  it('ora legale: 09:30:00 ancora dentro, 09:30:01 fuori; il giorno dopo sempre libero', () => {
    expect(bloccoGiorno(OGGI, '09:30', new Date('2026-10-07T07:30:00Z'))).toBeNull();
    expect(bloccoGiorno(OGGI, '09:30:00', new Date('2026-10-07T07:30:01Z'))).toBe('oltreCutoff');
    expect(bloccoGiorno(DOMANI, '09:30', new Date('2026-10-07T20:00:00Z'))).toBeNull();
  });

  it('ora solare: 09:31 italiane sono 08:31 UTC → oltre; 10:29 UTC non sono ancora le 11:30', () => {
    expect(bloccoGiorno('2026-12-02', '09:30', new Date('2026-12-02T08:31:00Z'))).toBe('oltreCutoff');
    expect(bloccoGiorno('2026-12-02', '09:30', new Date('2026-12-02T08:29:00Z'))).toBeNull();
  });

  it('giorno passato secondo ROMA, anche quando la data UTC è ancora quella', () => {
    // 23:30Z del 1/12 = 00:30 del 2/12 a Roma: il 1/12 è già passato.
    expect(bloccoGiorno('2026-12-01', '09:30', new Date('2026-12-01T23:30:00Z'))).toBe('passato');
    // E il passato è bloccato anche senza cutoff noto.
    expect(bloccoGiorno(IERI, null, new Date('2026-10-07T05:00:00Z'))).toBe('passato');
  });

  it('senza cutoffOra oggi non si blocca sullo schermo (arbitra il server)', () => {
    expect(bloccoGiorno(OGGI, null, new Date('2026-10-07T15:00:00Z'))).toBeNull();
  });
});

describe('MensaCalendar — pulsanti di oggi e dei giorni passati', () => {
  it('prima del cutoff Disdici è acceso; il timer lo spegne quando la pagina resta aperta oltre il cutoff', async () => {
    vi.setSystemTime(new Date('2026-10-07T07:29:50Z')); // 09:29:50 a Roma
    installaFetch({ giorni: [IERI, OGGI, DOMANI], prenotati: [OGGI], cutoffOra: '09:30:00' });

    render(<MensaCalendar userId="P1" studentId="S1" />);

    const disdici = await screen.findByRole('button', { name: IT.disdici });
    expect(disdici).toBeEnabled();
    const prenota = screen.getAllByRole('button', { name: IT.prenotaPranzo });
    expect(prenota).toHaveLength(2);
    expect(prenota[0]).toBeDisabled(); // ieri: sempre spento
    expect(prenota[1]).toBeEnabled();  // domani: libero
    expect(screen.queryByText(oltre('09:30'))).not.toBeInTheDocument();

    // Mezzo minuto dopo (09:30:20 a Roma) il timer ricontrolla l'orologio.
    act(() => { vi.advanceTimersByTime(RICONTROLLO_CUTOFF_MS); });

    expect(await screen.findByText(oltre('09:30'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: IT.disdici })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: IT.prenotato })).toBeDisabled();
    expect(screen.getByRole('button', { name: IT.prenotato })).toHaveAccessibleDescription(oltre('09:30'));
    // Domani resta prenotabile: il blocco riguarda solo oggi.
    expect(screen.getAllByRole('button', { name: IT.prenotaPranzo })[1]).toBeEnabled();
  });

  it('dopo il cutoff all\'apertura: Prenota di oggi spento, con la frase «Oltre le HH:MM»', async () => {
    vi.setSystemTime(new Date('2026-10-07T08:00:00Z')); // 10:00 a Roma
    installaFetch({ giorni: [OGGI, DOMANI], prenotati: [], cutoffOra: '09:30' });

    render(<MensaCalendar userId="P1" studentId="S1" />);

    expect(await screen.findByText(oltre('09:30'))).toBeInTheDocument();
    const prenota = screen.getAllByRole('button', { name: IT.prenotaPranzo });
    expect(prenota[0]).toBeDisabled();
    expect(prenota[1]).toBeEnabled();
    // Il pulsante spento dice PERCHÉ a lettore di schermo e tastiera: la frase è la sua
    // descrizione accessibile. Domani non ha nessuna descrizione di blocco.
    expect(prenota[0]).toHaveAccessibleDescription(oltre('09:30'));
    expect(prenota[1]).not.toHaveAttribute('aria-describedby');
  });

  it('00:30 italiane con la data UTC ancora a ieri: ieri è passato e spento, oggi è acceso', async () => {
    vi.setSystemTime(new Date('2026-12-01T23:30:00Z')); // 2/12 00:30 a Roma
    installaFetch({ giorni: ['2026-12-01', '2026-12-02'], prenotati: [], cutoffOra: '09:30' });

    render(<MensaCalendar userId="P1" studentId="S1" />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: IT.prenotaPranzo })).toHaveLength(2));
    const [ieri, oggi] = screen.getAllByRole('button', { name: IT.prenotaPranzo });
    expect(ieri).toBeDisabled();
    expect(oggi).toBeEnabled();
    expect(screen.queryByText(oltre('09:30'))).not.toBeInTheDocument();
  });

  it('ritorno in primo piano: l\'orologio va oltre il cutoff senza timer, e visibilitychange spegne Disdici', async () => {
    let stato: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => stato });
    try {
      vi.setSystemTime(new Date('2026-10-07T07:29:50Z')); // 09:29:50 a Roma
      installaFetch({ giorni: [OGGI], prenotati: [OGGI], cutoffOra: '09:30:00' });

      render(<MensaCalendar userId="P1" studentId="S1" />);
      expect(await screen.findByRole('button', { name: IT.disdici })).toBeEnabled();

      // Il telefono va in tasca: l'orologio passa il cutoff (09:30:10) ma il timer NON scatta.
      vi.setSystemTime(new Date('2026-10-07T07:30:10Z'));
      stato = 'hidden';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      // Pagina ancora nascosta: nessun ricontrollo, Disdici resta com'era.
      expect(screen.getByRole('button', { name: IT.disdici })).toBeEnabled();

      // La pagina torna visibile: il ricontrollo spegne il pulsante e spiega perché.
      stato = 'visible';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });

      expect(await screen.findByText(oltre('09:30'))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: IT.disdici })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: IT.prenotato })).toBeDisabled();
      expect(chiamate('DELETE')).toHaveLength(0);
    } finally {
      // Si toglie la proprietà propria: torna a valere quella del prototipo di jsdom.
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('ricontrollo al tocco: il timer non è ancora passato ma il cutoff sì → nessuna POST, frase mostrata, pulsante spento', async () => {
    vi.setSystemTime(new Date('2026-10-07T07:29:50Z'));
    installaFetch({ giorni: [OGGI], prenotati: [], cutoffOra: '09:30' });

    render(<MensaCalendar userId="P1" studentId="S1" />);
    const prenota = await screen.findByRole('button', { name: IT.prenotaPranzo });
    expect(prenota).toBeEnabled();

    // L'orologio va avanti di 20 s SENZA far scattare il timer (09:30:10 a Roma).
    vi.setSystemTime(new Date('2026-10-07T07:30:10Z'));
    fireEvent.click(prenota);

    // La frase arriva nel riquadro dei messaggi (role=status), non solo sotto la card.
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((el) => el.textContent === oltre('09:30'))).toBe(true),
    );
    expect(chiamate('POST')).toHaveLength(0);
    expect(screen.getByRole('button', { name: IT.prenotaPranzo })).toBeDisabled();
  });

  it('ricontrollo al tocco oltre la MEZZANOTTE di Roma: ieri è «passato» → frase del catalogo, non «il pasto di oggi»', async () => {
    // 23:59:50 a Roma con cutoff 23:59:59: oggi è ancora prenotabile.
    vi.setSystemTime(new Date('2026-10-07T21:59:50Z'));
    installaFetch({ giorni: [OGGI], prenotati: [], cutoffOra: '23:59:59' });

    render(<MensaCalendar userId="P1" studentId="S1" />);
    const prenota = await screen.findByRole('button', { name: IT.prenotaPranzo });
    expect(prenota).toBeEnabled();

    // Il tocco arriva a 00:00:10 dell'8/10 senza che il timer sia passato: il 7/10 è ieri.
    vi.setSystemTime(new Date('2026-10-07T22:00:10Z'));
    fireEvent.click(prenota);

    await waitFor(() =>
      expect(screen.getAllByRole('status').some((el) => el.textContent === GENERICO_CUTOFF)).toBe(true),
    );
    expect(screen.queryByText(oltre('23:59'))).not.toBeInTheDocument();
    expect(chiamate('POST')).toHaveLength(0);
    expect(screen.getByRole('button', { name: IT.prenotaPranzo })).toBeDisabled();
  });
});

describe('MensaCalendar — risposta MENSA_OLTRE_CUTOFF del server', () => {
  it('DELETE 400 MENSA_OLTRE_CUTOFF → «Oltre le 09:30…», non l\'errore generico', async () => {
    vi.setSystemTime(new Date('2026-10-07T07:00:00Z')); // 09:00 a Roma: lo schermo lascia provare
    installaFetch({
      giorni: [OGGI], prenotati: [OGGI], cutoffOra: '09:30:00',
      del: () => ({ error: 'Oltre l\'orario limite: disdetta non più possibile', codice: 'MENSA_OLTRE_CUTOFF' }),
    });

    render(<MensaCalendar userId="P1" studentId="S1" />);
    fireEvent.click(await screen.findByRole('button', { name: IT.disdici }));

    await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1));
    const box = await screen.findByText(oltre('09:30'));
    expect(box).toHaveAttribute('role', 'status');
    expect(screen.queryByText(GENERICO_CUTOFF)).not.toBeInTheDocument();
    expect(screen.queryByText(IT.errore)).not.toBeInTheDocument();
    expect(screen.queryByText(/disdetta non più possibile/)).not.toBeInTheDocument();
  });

  it('POST con esito MENSA_OLTRE_CUTOFF → «Oltre le 09:30…», non la prosa «(cutoff)» del server', async () => {
    vi.setSystemTime(new Date('2026-10-07T07:00:00Z'));
    installaFetch({
      giorni: [OGGI], prenotati: [], cutoffOra: '09:30',
      post: () => ({ success: true, data: { saldo: 5, esiti: [{ data: OGGI, ok: false, motivo: 'Oltre l\'orario limite (cutoff)', codice: 'MENSA_OLTRE_CUTOFF' }] } }),
    });

    render(<MensaCalendar userId="P1" studentId="S1" />);
    fireEvent.click(await screen.findByRole('button', { name: IT.prenotaPranzo }));

    await waitFor(() => expect(chiamate('POST')).toHaveLength(1));
    const box = await screen.findByText(oltre('09:30'));
    expect(box).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/\(cutoff\)/)).not.toBeInTheDocument();
    // Il corpo della POST porta davvero quel giorno e quell'alunno.
    const [, init] = chiamate('POST')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ alunno_id: 'S1', date: [OGGI] });
  });

  it('rifiuto MENSA_OLTRE_CUTOFF arrivato dopo la mezzanotte di Roma → frase del catalogo, non «il pasto di oggi»', async () => {
    vi.setSystemTime(new Date('2026-10-07T07:00:00Z')); // 09:00 a Roma: lo schermo lascia provare
    installaFetch({
      giorni: [OGGI], prenotati: [], cutoffOra: '09:30',
      post: () => {
        // Mentre la risposta è in volo l'orologio passa la mezzanotte (8/10 00:00:10 a
        // Roma): quando arriva il rifiuto, il giorno chiesto è ormai IERI.
        vi.setSystemTime(new Date('2026-10-07T22:00:10Z'));
        return { success: true, data: { saldo: 5, esiti: [{ data: OGGI, ok: false, motivo: 'Oltre l\'orario limite (cutoff)', codice: 'MENSA_OLTRE_CUTOFF' }] } };
      },
    });

    render(<MensaCalendar userId="P1" studentId="S1" />);
    fireEvent.click(await screen.findByRole('button', { name: IT.prenotaPranzo }));

    await waitFor(() => expect(chiamate('POST')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((el) => el.textContent === GENERICO_CUTOFF)).toBe(true),
    );
    expect(screen.queryByText(oltre('09:30'))).not.toBeInTheDocument();
    expect(screen.queryByText(/\(cutoff\)/)).not.toBeInTheDocument();
  });
});
