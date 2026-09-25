import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

/**
 * Note di PRIMARIA — «Modifica» ed «Elimina» (spec 2026-09-24, compito NO2).
 *
 * Che cosa lega questo file, misurato su ciò che parte verso il server e su ciò
 * che si legge a schermo (non su quale funzione è stata chiamata):
 *  (a) nota di gruppo → prima di salvare O eliminare si chiede SEMPRE «solo
 *      questo alunno / tutti», anche la seconda volta; niente parte prima della
 *      scelta, e la scelta finisce in `ambito`;
 *  (b) la PATCH porta SOLO i campi cambiati (con «Tutti» un campo rimandato
 *      uguale sovrascriverebbe gli altri alunni), e senza cambi non parte;
 *  (c) nota firmata → le modali avvisano che la firma si azzera / sparisce;
 *  (d) «Tutti» non si offre se il gruppo intero non si può toccare;
 *  (e) nota bloccata → niente bottoni, il messaggio, e «Sblocca» solo per la Direzione;
 *  (f) un rifiuto motivato (423) si mostra tradotto e fa rileggere l'elenco;
 *  (g) senza permessi calcolati (`statoVociDisponibile: false`) nessun bottone;
 *  (h) una modale chiusa da un rifiuto non si riapre da sola quando la nota torna
 *      modificabile (sblocco), e l'avviso vecchio sopra l'elenco sparisce;
 *  (i) il messaggio «serve lo sblocco» solo a chi, sbloccata, potrebbe agire;
 *  (j) i nomi accessibili distinguono due note dello stesso alunno (data e ora).
 *
 * Nomi di fantasia: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));

const DOCENTE = 'd0c00000-0000-4000-8000-000000000001';
const SEZIONE = '11111111-1111-4111-8111-111111111111';
const GRUPPO = '99999999-0000-4000-8000-000000000009';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`userId=${DOCENTE}`),
  useParams: () => ({ sectionId: SEZIONE }),
  usePathname: () => `/teacher/primaria/${SEZIONE}/note`,
}));

import NotePage from '@/app/(dashboard)/teacher/primaria/[sectionId]/note/page';
import { AzioniNota, campiCambiati, serveSceltaAmbito, type NotaElenco } from '@/components/features/primaria/AzioniNota';

const A = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const B = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Anna', cognome: 'Bianchi' };

function nota(extra: Record<string, unknown> = {}) {
  return {
    id: 'n0000001-0000-4000-8000-000000000001',
    alunno_id: A.id,
    maestra_id: DOCENTE,
    categoria: 'disciplinare',
    testo: 'Disturba la lezione',
    richiede_firma: true,
    firmata_il: null,
    oscurata_ad_altri: true,
    nota_gruppo_id: null,
    creato_il: '2026-09-24T08:00:00Z',
    alunni: { nome: A.nome, cognome: A.cognome },
    modificabile: true,
    bloccata: false,
    giorni_limite: 2,
    n_alunni_gruppo: 1,
    gruppo_modificabile: true,
    ...extra,
  };
}

const fetchMock = vi.fn();
let elenco: Array<Record<string, unknown>> = [];
let statoVociDisponibile = true;
let ruolo = 'educator';
let rispostaMutazione: { status: number; corpo: unknown } = { status: 200, corpo: { success: true } };

const chiamate = (metodo: string, frammento: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) =>
      String(u).includes(frammento) && ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
  );

const risposta = (status: number, corpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

beforeEach(() => {
  vi.clearAllMocks();
  elenco = [nota()];
  statoVociDisponibile = true;
  ruolo = 'educator';
  rispostaMutazione = { status: 200, corpo: { success: true, modificate: 1, firme_azzerate: 0, eliminate: 1, firme_rimosse: 0 } };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    if (url.startsWith('/api/primaria/classe/')) return risposta(200, { success: true, data: { alunni: [A, B] } });
    if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo } });
    if (url.startsWith('/api/primaria/sblocca') && metodo === 'POST') return risposta(200, { success: true });
    if (url.startsWith('/api/primaria/note') && metodo === 'GET') {
      return risposta(200, { success: true, data: elenco, statoVociDisponibile });
    }
    if (url.startsWith('/api/primaria/note')) return risposta(rispostaMutazione.status, rispostaMutazione.corpo);
    throw new Error(`fetch inattesa: ${metodo} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

/** Lascia finire le promesse in volo (`r.json()` e `setState` di `/me`), non solo partire la fetch. */
async function svuotaCoda() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function montaEApri(bottone: RegExp) {
  render(<NotePage />);
  const b = await screen.findByRole('button', { name: bottone });
  fireEvent.click(b);
  return screen.findByRole('dialog');
}

describe('pure: campi cambiati e scelta del gruppo', () => {
  it('manda solo ciò che cambia; il testo si confronta rifilato', () => {
    const n = { categoria: 'didattica', testo: 'Ciao', richiede_firma: false };
    expect(campiCambiati(n, { categoria: 'didattica', testo: 'Ciao\n', richiedeFirma: false })).toEqual({});
    expect(campiCambiati(n, { categoria: 'disciplinare', testo: 'Ciao', richiedeFirma: true })).toEqual({
      categoria: 'disciplinare',
      richiedeFirma: true,
    });
    expect(campiCambiati(n, { categoria: 'didattica', testo: 'Nuovo', richiedeFirma: false })).toEqual({ testo: 'Nuovo' });
  });

  it('la scelta serve solo con un gruppo di più alunni', () => {
    expect(serveSceltaAmbito({ nota_gruppo_id: GRUPPO, n_alunni_gruppo: 2 })).toBe(true);
    expect(serveSceltaAmbito({ nota_gruppo_id: GRUPPO, n_alunni_gruppo: 1 })).toBe(false);
    expect(serveSceltaAmbito({ nota_gruppo_id: null, n_alunni_gruppo: 3 })).toBe(false);
  });
});

describe('nota di gruppo: la scelta si chiede OGNI volta', () => {
  beforeEach(() => {
    elenco = [nota({ nota_gruppo_id: GRUPPO, n_alunni_gruppo: 3 })];
  });

  it('modifica: niente PATCH prima della scelta; «Solo questo alunno» → ambito alunno, solo il testo', async () => {
    const dialogo = await montaEApri(/Modifica la nota di Rossi Mario/);
    fireEvent.change(within(dialogo).getByLabelText('Testo'), { target: { value: 'Testo corretto' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));

    // La domanda c'è, e la PATCH non è ancora partita.
    expect(await within(dialogo).findByText(/Questa nota è stata data a 3 alunni/)).toBeTruthy();
    expect(chiamate('PATCH', '/api/primaria/note')).toHaveLength(0);

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Solo questo alunno' }));
    await waitFor(() => expect(chiamate('PATCH', '/api/primaria/note')).toHaveLength(1));
    const [url, init] = chiamate('PATCH', '/api/primaria/note')[0];
    expect(String(url)).toContain(`userId=${DOCENTE}`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      id: elenco[0].id,
      ambito: 'alunno',
      testo: 'Testo corretto',
    });
    expect(await screen.findByText('Nota modificata ✓')).toBeTruthy();
  });

  it('la seconda volta si chiede di nuovo; «Tutti» → ambito gruppo', async () => {
    const dialogo = await montaEApri(/Modifica la nota di Rossi Mario/);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Didattica' }));
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    fireEvent.click(await within(dialogo).findByRole('button', { name: 'Tutti gli alunni della nota (3)' }));
    await waitFor(() => expect(chiamate('PATCH', '/api/primaria/note')).toHaveLength(1));
    expect(JSON.parse(String((chiamate('PATCH', '/api/primaria/note')[0][1] as RequestInit).body))).toEqual({
      id: elenco[0].id,
      ambito: 'gruppo',
      categoria: 'didattica',
    });

    // Riaperta: si torna al modulo, e la domanda si ripresenta.
    fireEvent.click(await screen.findByRole('button', { name: /Modifica la nota di Rossi Mario/ }));
    const secondo = await screen.findByRole('dialog');
    fireEvent.click(within(secondo).getByRole('button', { name: 'Compiti non svolti' }));
    fireEvent.click(within(secondo).getByRole('button', { name: 'Salva' }));
    expect(await within(secondo).findByTestId('nota-scelta-ambito')).toBeTruthy();
    expect(chiamate('PATCH', '/api/primaria/note')).toHaveLength(1);
  });

  it('elimina: niente DELETE prima della scelta; «Tutti» → DELETE con ambito=gruppo', async () => {
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    expect(within(dialogo).getByTestId('nota-scelta-ambito')).toBeTruthy();
    // Nessun bottone «Elimina» secco: si passa solo dalla scelta.
    expect(within(dialogo).queryByRole('button', { name: 'Elimina' })).toBeNull();
    expect(chiamate('DELETE', '/api/primaria/note')).toHaveLength(0);

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Tutti gli alunni della nota (3)' }));
    await waitFor(() => expect(chiamate('DELETE', '/api/primaria/note')).toHaveLength(1));
    const q = new URL(String(chiamate('DELETE', '/api/primaria/note')[0][0]), 'http://x').searchParams;
    expect(q.get('id')).toBe(elenco[0].id);
    expect(q.get('ambito')).toBe('gruppo');
    expect(q.get('userId')).toBe(DOCENTE);
  });

  it('«Tutti» non si offre se il gruppo intero non si può toccare', async () => {
    elenco = [nota({ nota_gruppo_id: GRUPPO, n_alunni_gruppo: 3, gruppo_modificabile: false })];
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    const tutti = within(dialogo).getByRole('button', { name: 'Tutti gli alunni della nota (3)' });
    expect(tutti.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialogo).getByText(/puoi agire solo su questo alunno/)).toBeTruthy();
    fireEvent.click(tutti);
    await new Promise((r) => setTimeout(r, 20));
    expect(chiamate('DELETE', '/api/primaria/note')).toHaveLength(0);
  });
});

describe('nota singola', () => {
  it('elimina: conferma semplice → DELETE con ambito=alunno, nessuna scelta', async () => {
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    expect(within(dialogo).queryByTestId('nota-scelta-ambito')).toBeNull();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(chiamate('DELETE', '/api/primaria/note')).toHaveLength(1));
    const q = new URL(String(chiamate('DELETE', '/api/primaria/note')[0][0]), 'http://x').searchParams;
    expect(q.get('ambito')).toBe('alunno');
    expect(await screen.findByText('Nota eliminata ✓')).toBeTruthy();
  });

  it('senza cambi la PATCH non parte', async () => {
    const dialogo = await montaEApri(/Modifica la nota di Rossi Mario/);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await within(dialogo).findByText('Non hai cambiato niente.')).toBeTruthy();
    expect(chiamate('PATCH', '/api/primaria/note')).toHaveLength(0);
  });
});

describe('nota firmata: le modali lo dicono prima', () => {
  it('modifica avvisa che la firma verrà azzerata; elimina che sparirà', async () => {
    elenco = [nota({ firmata_il: '2026-09-24T18:00:00Z' })];
    const dialogo = await montaEApri(/Modifica la nota di Rossi Mario/);
    expect(within(dialogo).getByTestId('nota-avviso-firma').textContent).toMatch(/la firma verrà azzerata/);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }));

    fireEvent.click(await screen.findByRole('button', { name: /Elimina la nota di Rossi Mario/ }));
    const elimina = await screen.findByRole('dialog');
    expect(within(elimina).getByTestId('nota-avviso-firma').textContent).toMatch(/sparirà anche la firma/);
  });

  it('una nota non firmata non porta l\'avviso', async () => {
    const dialogo = await montaEApri(/Modifica la nota di Rossi Mario/);
    expect(within(dialogo).queryByTestId('nota-avviso-firma')).toBeNull();
  });

  it('con «Tutti» si contano le firme del gruppo', async () => {
    elenco = [
      nota({ nota_gruppo_id: GRUPPO, n_alunni_gruppo: 2 }),
      nota({
        id: 'n0000002-0000-4000-8000-000000000002',
        alunno_id: B.id,
        alunni: { nome: B.nome, cognome: B.cognome },
        nota_gruppo_id: GRUPPO,
        n_alunni_gruppo: 2,
        firmata_il: '2026-09-24T18:00:00Z',
      }),
    ];
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    expect(within(dialogo).getByText(/Una nota del gruppo è già firmata/)).toBeTruthy();
  });
});

describe('nota bloccata', () => {
  beforeEach(() => {
    elenco = [nota({ modificabile: false, bloccata: true, giorni_limite: 2 })];
  });

  it('niente Modifica/Elimina, il messaggio col termine; «Sblocca» non per il docente', async () => {
    render(<NotePage />);
    expect(await screen.findByText(/Oltre il termine di 2 giorni/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Modifica la nota/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Elimina la nota/ })).toBeNull();
    await waitFor(() => expect(chiamate('GET', '/api/primaria/me')).toHaveLength(1));
    // La fetch è PARTITA: si aspetta che la risposta arrivi e diventi stato,
    // altrimenti l'assenza qui sotto sarebbe vera anche con il ruolo sbagliato.
    await svuotaCoda();
    expect(screen.queryByRole('button', { name: /Sblocca/ })).toBeNull();
  });

  it('nota bloccata di un ALTRO autore vista da un docente: né messaggio né bottoni', async () => {
    elenco = [nota({ maestra_id: 'e0e00000-0000-4000-8000-00000000000e', modificabile: false, bloccata: true })];
    render(<NotePage />);
    // Presenza prima dell'assenza: la nota è a schermo e il ruolo è arrivato.
    expect(await screen.findByText('Disturba la lezione')).toBeTruthy();
    await waitFor(() => expect(chiamate('GET', '/api/primaria/me')).toHaveLength(1));
    await svuotaCoda();
    expect(screen.queryByText(/Oltre il termine/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Sblocca|Modifica la nota|Elimina la nota/ })).toBeNull();
  });

  it('la stessa nota altrui, vista dalla Segreteria, porta il messaggio (lo staff agisce dopo lo sblocco)', async () => {
    ruolo = 'segreteria';
    elenco = [nota({ maestra_id: 'e0e00000-0000-4000-8000-00000000000e', modificabile: false, bloccata: true })];
    render(<NotePage />);
    expect(await screen.findByText(/Oltre il termine di 2 giorni/)).toBeTruthy();
    // La Segreteria non è la Direzione: il messaggio sì, «Sblocca» no.
    await svuotaCoda();
    expect(screen.queryByRole('button', { name: /Sblocca/ })).toBeNull();
  });

  it('la Direzione vede «Sblocca» sulla nota', async () => {
    ruolo = 'admin';
    render(<NotePage />);
    expect(await screen.findByRole('button', { name: /Sblocca la nota di Rossi Mario/ })).toBeTruthy();
  });
});

describe('rifiuti ed elenco senza permessi', () => {
  it('un 423 si mostra tradotto e fa rileggere l\'elenco', async () => {
    rispostaMutazione = {
      status: 423,
      corpo: { error: 'Voce bloccata: superato il termine di 2 giorni.', codice: 'VOCE_BLOCCATA', giorniLimite: 2 },
    };
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    const getPrima = chiamate('GET', '/api/primaria/note').length;
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(chiamate('GET', '/api/primaria/note').length).toBeGreaterThan(getPrima));
    // UN solo avviso, sopra l'elenco: la modale si è chiusa e non lo ripete.
    const avvisi = await screen.findAllByText(/Voce bloccata: è passato il termine/);
    expect(avvisi).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 423 }));
  });

  it('dopo un 423 e uno sblocco la modale NON si riapre da sola, e l\'avviso vecchio sparisce', async () => {
    ruolo = 'admin';
    rispostaMutazione = {
      status: 423,
      corpo: { error: 'Voce bloccata: superato il termine di 2 giorni.', codice: 'VOCE_BLOCCATA', giorniLimite: 2 },
    };
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    // Nel frattempo il termine è scaduto: la rilettura dopo il rifiuto la dà bloccata.
    elenco = [nota({ modificabile: false, bloccata: true })];
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText(/Oltre il termine di 2 giorni/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Voce bloccata: è passato il termine/)).toBeTruthy();

    // La Direzione sblocca: la rilettura dopo lo sblocco la dà di nuovo modificabile.
    elenco = [nota()];
    fireEvent.click(screen.getByRole('button', { name: /Sblocca la nota di Rossi Mario/ }));
    const sblocco = await screen.findByRole('dialog');
    fireEvent.change(within(sblocco).getByLabelText('Motivo dello sblocco'), { target: { value: 'Correzione richiesta' } });
    fireEvent.click(within(sblocco).getByRole('button', { name: 'Autorizza' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/sblocca')).toHaveLength(1));

    // Presenza prima delle assenze: la nota è tornata azionabile.
    expect(await screen.findByRole('button', { name: /Modifica la nota di Rossi Mario/ })).toBeTruthy();
    await svuotaCoda();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Voce bloccata/)).toBeNull();
  });

  it('aprire una modale toglie l\'esito vecchio sopra l\'elenco', async () => {
    const dialogo = await montaEApri(/Elimina la nota di Rossi Mario/);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Nota eliminata ✓')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Modifica la nota di Rossi Mario/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('Nota eliminata ✓')).toBeNull();
  });

  it('senza permessi calcolati: nessun bottone, e lo si dice', async () => {
    statoVociDisponibile = false;
    render(<NotePage />);
    expect(await screen.findByText(/Modifica ed eliminazione non sono disponibili/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Modifica la nota/ })).toBeNull();
  });
});

describe('nomi accessibili', () => {
  it('due note dello stesso alunno hanno nomi diversi (data e ora, fuso di Roma)', async () => {
    elenco = [
      nota(),
      nota({ id: 'n0000003-0000-4000-8000-000000000003', creato_il: '2026-09-22T07:30:00Z' }),
    ];
    render(<NotePage />);
    expect(
      await screen.findByRole('button', { name: 'Elimina la nota di Rossi Mario, 24/09/2026 10:00' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Elimina la nota di Rossi Mario, 22/09/2026 09:30' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Modifica la nota di Rossi Mario, 22/09/2026 09:30' })).toBeTruthy();
  });
});

describe('AzioniNota da sola: la modale non sopravvive alla nota non più azionabile', () => {
  // Difesa in profondità rispetto alla chiusura sul rifiuto: qui l'elenco cambia
  // SOTTO una modale aperta (una rilettura qualsiasi), senza passare dal rifiuto.
  const props = (n: Record<string, unknown>) => ({
    nota: n as unknown as NotaElenco,
    nomeAlunno: 'Rossi Mario',
    firmateNelGruppo: 0,
    userId: DOCENTE,
    ruolo: 'educator',
    permessiDisponibili: true,
    onCambiato: vi.fn(),
    onEsito: vi.fn(),
    onApri: vi.fn(),
    onSbloccato: vi.fn(),
  });

  it('aperta → bloccata → di nuovo modificabile: nessun dialog ricompare', async () => {
    const { rerender } = render(<AzioniNota {...props(nota())} />);
    fireEvent.click(screen.getByRole('button', { name: /Elimina la nota di Rossi Mario/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();

    rerender(<AzioniNota {...props(nota({ modificabile: false, bloccata: true }))} />);
    expect(screen.getByText(/Oltre il termine di 2 giorni/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<AzioniNota {...props(nota())} />);
    expect(screen.getByRole('button', { name: /Modifica la nota di Rossi Mario/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lo stesso con i permessi che spariscono e tornano', async () => {
    const { rerender } = render(<AzioniNota {...props(nota())} />);
    fireEvent.click(screen.getByRole('button', { name: /Modifica la nota di Rossi Mario/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    rerender(<AzioniNota {...props(nota())} permessiDisponibili={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<AzioniNota {...props(nota())} />);
    expect(screen.getByRole('button', { name: /Modifica la nota di Rossi Mario/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
