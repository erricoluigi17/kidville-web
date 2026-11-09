import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GeneratoreRette } from '@/components/features/admin/pagamenti/GeneratoreRette';
import itContabilita from '../../messages/it/adminContabilita.json';

// =============================================================================
// PR 4.6 · compito 4.6.7 · «Genera rette» dice di che anno parla, per chi no, e da dove vengono gli importi.
// L'anteprima porta lo stato dell'anno, i bambini senza una retta, gli esenti e l'origine degli importi; la conferma scrive
// sull'anno che l'anteprima ha contato. Una risposta di PRIMA (senza questi campi) si legge come sempre.
// Solo uuid finti e importi inventati.
// =============================================================================

const ANNO_SEDE = 'b0000000-0000-4000-8000-000000000001';

let posted: Array<Record<string, unknown>> = [];
let anteprima: Record<string, unknown> = {};

const mese = (extra: Record<string, unknown> = {}) => ({
  periodo: '2026-10-01', candidati: [{ id: 'a1', nome: 'Anna', cognome: 'Prova', classe_sezione: 'A', importo_previsto: 250 }],
  gia_generati: 0, totale_previsto: 250, retta_default: 250, generazione_attiva: true, ...extra,
});

beforeEach(() => {
  posted = [];
  anteprima = mese();
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true, data: { periodo: '2026-10', generati: 1, visibile_alle_famiglie: false } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: anteprima }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function anteprimaMensile() {
  render(<GeneratoreRette userId="u1" scuolaId="sede-1" />);
  fireEvent.click(screen.getByRole('button', { name: itContabilita.genrMeseSingolo }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(itContabilita.genrAnteprima) }));
  await screen.findByText(/Anna Prova/);
}

describe('GeneratoreRette — l’anteprima dell’anno', () => {
  it('una risposta di prima, senza i campi dell’anno, non disegna niente in più e non inventa un 150', async () => {
    anteprima = mese({ retta_default: null });
    await anteprimaMensile();
    expect(screen.queryByText(/^Anno scolastico .*\.$/)).toBeNull();
    expect(screen.queryByText(/Nessuna notifica/)).toBeNull();
    expect(screen.queryByText(new RegExp(itContabilita.genrRettaDefault))).toBeNull();
    expect(screen.queryByText(/150/)).toBeNull();
    expect(screen.getByRole('button', { name: /Genera 1 rette/ })).toBeInTheDocument();
  });

  it('dice lo stato dell’anno e, se non è quello in corso, che le famiglie non lo vedono e non ricevono avvisi', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'in_preparazione', visibile_alle_famiglie: false });
    await anteprimaMensile();
    expect(screen.getByText('Anno scolastico in preparazione.')).toBeInTheDocument();
    expect(screen.getByText(itContabilita.genrNonVisibile)).toBeInTheDocument();
  });

  it('per l’anno in corso non porta l’avviso di non visibilità', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'corrente', visibile_alle_famiglie: true });
    await anteprimaMensile();
    expect(screen.getByText('Anno scolastico in corso.')).toBeInTheDocument();
    expect(screen.queryByText(itContabilita.genrNonVisibile)).toBeNull();
  });

  it('i bambini senza una retta si contano e rimandano alla scheda Rette con un vero collegamento', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'in_preparazione', senza_importo: 4, visibile_alle_famiglie: false });
    await anteprimaMensile();
    expect(screen.getByText(/Bambini senza una retta: 4\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: itContabilita.genrSenzaRettaLink });
    expect(link.getAttribute('href')).toBe('/admin/impostazioni?userId=u1&sezione=anno');
  });

  it('esenti e a carico di un fratello non iscritto, e l’origine degli importi (solo quelle presenti)', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'corrente', esenti: 2, pagante_assente: 1, per_origine: { listino: 5, frequenza: 1 } });
    await anteprimaMensile();
    expect(screen.getByText('Esenti: 2. A carico di un fratello non iscritto: 1.')).toBeInTheDocument();
    expect(screen.getByText(/dal listino: 5 · dalla scheda del bambino: 1/)).toBeInTheDocument();
    expect(screen.queryByText(/dal listino della fascia/)).toBeNull();
  });

  it('con soli bambini senza retta non c’è nessuna conferma da premere', async () => {
    render(<GeneratoreRette userId="u1" scuolaId="sede-1" />);
    anteprima = mese({ candidati: [], senza_importo: 3, anno_sede_id: ANNO_SEDE, anno_stato: 'in_preparazione', visibile_alle_famiglie: false, totale_previsto: 0 });
    fireEvent.click(screen.getByRole('button', { name: itContabilita.genrMeseSingolo }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContabilita.genrAnteprima) }));
    expect(await screen.findByText(/Bambini senza una retta: 3\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Genera/ })).toBeNull();
  });

  it('la conferma scrive sull’anno che l’anteprima ha contato, e a cose fatte dice che nessuno è stato avvisato', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'iscrizioni_aperte', visibile_alle_famiglie: false });
    await anteprimaMensile();
    fireEvent.click(screen.getByRole('button', { name: /Genera 1 rette/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ anno_sede_id: ANNO_SEDE, scuola_id: 'sede-1' });
    expect(await screen.findByText(new RegExp(itContabilita.genrNessunaNotificaFatto))).toBeInTheDocument();
  });

  it.each([
    ['in_preparazione', itContabilita.genrNonGenerabileInPreparazione],
    ['chiuso', itContabilita.genrNonGenerabileChiuso],
  ])('anno %s: il server rifiuterebbe la conferma, quindi «Genera» è spento e dice perché', async (stato, frase) => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: stato, visibile_alle_famiglie: false });
    await anteprimaMensile();
    const genera = screen.getByRole('button', { name: /Genera 1 rette/ });
    expect(genera).toBeDisabled();
    expect(screen.getByText(frase)).toBeInTheDocument();
    expect(genera).toHaveAccessibleDescription(frase);
  });

  it('anno in chiusura: si genera come nell\'anno in corso (nessun avviso di non visibilità, bottone attivo)', async () => {
    anteprima = mese({ anno_sede_id: ANNO_SEDE, anno_stato: 'in_chiusura', visibile_alle_famiglie: true });
    await anteprimaMensile();
    expect(screen.getByRole('button', { name: /Genera 1 rette/ })).not.toBeDisabled();
    expect(screen.queryByText(itContabilita.genrNonVisibile)).toBeNull();
  });

  it('un\'anteprima rifiutata dal server dice perché, con le parole del server', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Nessun anno scolastico di questa sede contiene quel mese: scegli un mese dentro un anno.', codice: 'MESE_FUORI_DAGLI_ANNI' }) }));
    vi.stubGlobal('fetch', f);
    render(<GeneratoreRette userId="u1" scuolaId="sede-1" />);
    fireEvent.click(screen.getByRole('button', { name: itContabilita.genrMeseSingolo }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContabilita.genrAnteprima) }));
    expect(await screen.findByText(/Nessun anno scolastico di questa sede contiene quel mese/)).toBeInTheDocument();
  });

  it('una risposta di prima non manda anno_sede_id nella conferma', async () => {
    await anteprimaMensile();
    fireEvent.click(screen.getByRole('button', { name: /Genera 1 rette/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty('anno_sede_id');
  });
});
