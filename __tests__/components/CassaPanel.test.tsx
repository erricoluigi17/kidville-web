import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CassaPanel, direzioneNegativa, importoSegnato, importoTone } from '@/components/features/admin/pagamenti/CassaPanel';

// Segno «meno» tipografico (U+2212) usato dalla UI per gli importi in uscita.
const MENO = '−';

// Ruolo lato client controllabile (il gate VERO sono le API): il pannello lo usa
// solo come indizio cosmetico; ciò che decide i KPI è la presenza di `totali`.
const state = vi.hoisted(() => ({ ruolo: 'admin' as string }));
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: state.ruolo, withUser: (h: string) => h }),
}));

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const RIGA_VIRTUALE = {
  id: 'incasso:i1', scuola_id: 'sc-1', tipo: 'entrata', importo: 50, metodo: 'contanti',
  data: '2026-07-20', categoria_id: null, descrizione: 'Retta luglio', note: null, allegato_path: null,
  incasso_id: 'i1', chiusura_id: null, registrato_da: null, creato_il: '2026-07-20T09:00:00Z',
  storno_di: null, stornato_il: null, storno_motivo: null, origine: 'incasso', categoria_nome: null,
};
const RIGA_CASSA = {
  id: 'm1', scuola_id: 'sc-1', tipo: 'uscita', importo: 20, metodo: 'contanti',
  data: '2026-07-20', categoria_id: 'c1', descrizione: 'Detersivi', note: null, allegato_path: null,
  incasso_id: null, chiusura_id: null, registrato_da: 'u1', creato_il: '2026-07-20T10:00:00Z',
  storno_di: null, stornato_il: null, storno_motivo: null, origine: 'cassa', categoria_nome: 'Pulizie e igiene',
};

interface MockOpts {
  movimenti?: unknown[];
  disponibile?: boolean;
  totali?: unknown;
  saldo?: unknown;
}

function installFetch(opts: MockOpts = {}) {
  const { movimenti = [], disponibile = true, totali, saldo } = opts;
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/cassa/movimenti')) {
      const body: Record<string, unknown> = { disponibile, movimenti };
      if (totali) body.totali = totali;
      return jsonRes(body);
    }
    if (u.includes('/cassa/saldo')) return jsonRes(saldo ?? { disponibile: false });
    if (u.includes('/cassa/chiusura')) return jsonRes({ disponibile, chiusure: [] });
    if (u.includes('/cassa/report')) return jsonRes({ disponibile, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [] });
    if (u.includes('/cassa/categorie')) return jsonRes({ disponibile, categorie: [] });
    if (u.includes('/admin/settings/categorie')) return jsonRes({ success: true, data: [] });
    if (u.includes('/admin/settings')) return jsonRes({ success: true, data: { cassa_config: {} } });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); state.ruolo = 'admin'; });

describe('CassaPanel — i KPI seguono il payload, non il ruolo client', () => {
  it('senza `totali` nel payload NON renderizza alcun saldo/KPI (il server decide)', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] }); // niente totali
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi'); // tabella desktop + card mobile
    expect(screen.queryByText(/Saldo atteso/i)).toBeNull();
    expect(screen.queryByText(/Saldo/i)).toBeNull();
  });

  it('con `totali` (server = admin) mostra le StatCard KPI', async () => {
    state.ruolo = 'admin';
    installFetch({
      movimenti: [RIGA_CASSA],
      totali: { entrate: 50, uscite_contanti: 20, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
      saldo: { disponibile: true, fondo: 100, saldo_atteso: 130, entrate_contanti: 50, uscite_contanti: 20, prelievi: 0, rettifiche: 0, entrato_oggi: [{ metodo: 'contanti', totale: 50 }] },
    });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    expect(await screen.findByText(/Saldo atteso/i)).toBeInTheDocument();
    expect(screen.getByText(/Entrato oggi/i)).toBeInTheDocument();
    expect(screen.getByText(/Uscite del mese/i)).toBeInTheDocument();
  });
});

describe('CassaPanel — stati e permessi', () => {
  it('con disponibile:false mostra l\'empty-state per la CI non migrata', async () => {
    installFetch({ disponibile: false });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    expect(await screen.findByText(/Modulo cassa non ancora attivo su questo ambiente/i)).toBeInTheDocument();
  });

  it('una riga virtuale «da incasso» non offre lo storno da qui', async () => {
    state.ruolo = 'admin';
    installFetch({
      movimenti: [RIGA_VIRTUALE],
      totali: { entrate: 50, uscite_contanti: 0, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
      saldo: { disponibile: true, fondo: 100, saldo_atteso: 150, entrate_contanti: 50, uscite_contanti: 0, prelievi: 0, rettifiche: 0, entrato_oggi: [] },
    });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Retta luglio');
    expect(screen.getAllByText(/da incasso/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /Storna/ })).toHaveLength(0);
  });

  it('una riga di cassa reale non stornata offre lo storno', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    expect(screen.queryAllByRole('button', { name: /Storna/ }).length).toBeGreaterThan(0);
  });

  it('la segreteria (nessun `totali`) vede «Registra uscita» ma non «Svuota cassa»', async () => {
    state.ruolo = 'segreteria';
    installFetch({ movimenti: [RIGA_CASSA] });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    expect(screen.getByRole('button', { name: /Registra uscita/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Svuota cassa/i })).toBeNull();
  });
});

describe('importoSegnato/importoTone — il segno deriva dalla direzione, mai doppio (RC6)', () => {
  it('un\'uscita normale (importo positivo) esce col segno meno e tono error-strong', () => {
    const r = { tipo: 'uscita' as const, importo: 20 };
    expect(direzioneNegativa(r)).toBe(true);
    expect(importoSegnato(r)).toBe(`${MENO} € 20,00`);
    expect(importoTone(r)).toBe('text-kidville-error-strong');
  });

  it('un\'entrata normale (importo positivo) esce col segno più e tono success-strong', () => {
    const r = { tipo: 'entrata' as const, importo: 50 };
    expect(direzioneNegativa(r)).toBe(false);
    expect(importoSegnato(r)).toBe('+ € 50,00');
    expect(importoTone(r)).toBe('text-kidville-success-strong');
  });

  it('lo storno di un\'uscita (contro-movimento importo NEGATO) è una restituzione: «+ € 20,00» success-strong', () => {
    const r = { tipo: 'uscita' as const, importo: -20 };
    expect(direzioneNegativa(r)).toBe(false);
    expect(importoSegnato(r)).toBe('+ € 20,00');
    expect(importoTone(r)).toBe('text-kidville-success-strong');
  });

  it('lo storno di un\'entrata (contro-movimento importo NEGATO) sottrae: «− € 50,00» error-strong', () => {
    const r = { tipo: 'entrata' as const, importo: -50 };
    expect(direzioneNegativa(r)).toBe(true);
    expect(importoSegnato(r)).toBe(`${MENO} € 50,00`);
    expect(importoTone(r)).toBe('text-kidville-error-strong');
  });

  it('una rettifica negativa mostra «− € 2,00» con tono warn-strong', () => {
    const r = { tipo: 'rettifica' as const, importo: -2 };
    expect(direzioneNegativa(r)).toBe(true);
    expect(importoSegnato(r)).toBe(`${MENO} € 2,00`);
    expect(importoTone(r)).toBe('text-kidville-warn-strong');
  });

  it('un prelievo (uscita di cassa) esce col segno meno', () => {
    expect(importoSegnato({ tipo: 'prelievo', importo: 28 })).toBe(`${MENO} € 28,00`);
    expect(direzioneNegativa({ tipo: 'prelievo', importo: 28 })).toBe(true);
  });
});

/** Trova i Badge (span con la firma `rounded-pill`) con testo ESATTO. */
function badgeConTesto(container: HTMLElement, testo: string): HTMLElement[] {
  return Array.from(container.querySelectorAll('span.rounded-pill')).filter(
    (s) => s.textContent?.trim().toLowerCase() === testo.toLowerCase(),
  ) as HTMLElement[];
}

describe('CassaPanel — badge «storno» e contrasti AA su Badge/StatCard/TH (RC5/RC6)', () => {
  it('la riga contro-movimento (storno_di valorizzato) espone un badge «storno»', async () => {
    state.ruolo = 'admin';
    const stornoRow = {
      ...RIGA_CASSA, id: 'm2', tipo: 'uscita', importo: -20, storno_di: 'm1',
      descrizione: null, categoria_nome: 'Pulizie e igiene', creato_il: '2026-07-20T11:00:00Z',
    };
    installFetch({ movimenti: [stornoRow] });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Pulizie e igiene');
    // Un badge «storno» compare (desktop + mobile → almeno uno).
    expect(badgeConTesto(container, 'storno').length).toBeGreaterThan(0);
    // e l'importo è la restituzione «+ € 20,00», non il doppio segno.
    expect(screen.getAllByText('+ € 20,00').length).toBeGreaterThan(0);
  });

  it('il badge di stato «Uscita» (error) usa il token -strong per il contrasto AA', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    const badges = badgeConTesto(container, 'Uscita');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].className).toContain('text-kidville-error-strong');
  });

  it('il badge «stornato» (neutral) usa text-kidville-sub, non muted/neutral', async () => {
    state.ruolo = 'admin';
    const rowStornato = { ...RIGA_CASSA, stornato_il: '2026-07-20T12:00:00Z' };
    installFetch({ movimenti: [rowStornato] });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    const badges = badgeConTesto(container, 'stornato');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].className).toContain('text-kidville-sub');
    expect(badges[0].className).not.toContain('text-kidville-neutral');
  });

  it('le intestazioni di tabella (TH) e le etichette StatCard usano text-kidville-sub (AA)', async () => {
    state.ruolo = 'admin';
    installFetch({
      movimenti: [RIGA_CASSA],
      totali: { entrate: 0, uscite_contanti: 20, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
      saldo: { disponibile: true, fondo: 100, saldo_atteso: 130, entrate_contanti: 50, uscite_contanti: 20, prelievi: 0, rettifiche: 0, entrato_oggi: [] },
    });
    const { container } = render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByText(/Saldo atteso/i);
    // TH «Data» della tabella movimenti.
    const th = Array.from(container.querySelectorAll('th')).find((t) => t.textContent === 'Data');
    expect(th?.className).toContain('text-kidville-sub');
    expect(th).toHaveAttribute('scope', 'col');
    // Etichetta StatCard.
    const label = Array.from(container.querySelectorAll('div')).find((d) => d.textContent === 'Saldo atteso in cassa');
    expect(label?.className).toContain('text-kidville-sub');
  });

  it('lo storno con motivo troppo corto marca il campo motivo come non valido (P8)', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    fireEvent.click(screen.getAllByRole('button', { name: /Storna/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Conferma storno/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.id).toBe('cassa-storno-errore');
    const motivo = screen.getByLabelText(/Motivo dello storno/);
    expect(motivo).toHaveAttribute('aria-invalid', 'true');
    expect(motivo.getAttribute('aria-describedby')).toBe(alert.id);
  });
});
