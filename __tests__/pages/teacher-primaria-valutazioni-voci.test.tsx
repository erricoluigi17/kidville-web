import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

/**
 * Valutazioni di PRIMARIA — impreparati tra i voti, Modifica, Elimina, Sblocca
 * (spec 2026-09-24, compito V3).
 *
 * Che cosa lega questo file, misurato su ciò che parte verso il server e su ciò
 * che si legge a schermo:
 *  (a) «Valutazioni recenti» legge valutazioni E impreparati dell'alunno (materia
 *      scelta + senza materia) e li mostra in UN elenco, in ordine di data, con
 *      l'etichetta del tipo per gli impreparati; la card del giorno non ne fa un
 *      secondo elenco;
 *  (b) «Segna impreparato» manda tipo scelto, motivo facoltativo, materia e la
 *      data di ROMA; controlla l'esito (prima non lo faceva) e lo dice;
 *  (c) Modifica dell'impreparato: partono solo i campi cambiati; quello del
 *      genitore non offre il tipo;
 *  (d) Modifica della valutazione: gli stessi campi della creazione, `tipoProva`
 *      solo se cambia;
 *  (e) Elimina: niente parte prima della conferma esplicita; un rifiuto motivato
 *      (423) si mostra sopra l'elenco e fa rileggere;
 *  (f) voce bloccata: niente bottoni, «Bloccata: superato il termine», e
 *      «Sblocca» solo per la Direzione; dopo lo sblocco si rilegge;
 *  (g) senza permessi calcolati nessun bottone;
 *  (h) cambiando alunno le voci del precedente spariscono SUBITO (niente
 *      Elimina sul voto di un altro bambino), anche se la lettura nuova resta in
 *      volo o fallisce; un guasto di una lettura superata non accende l'avviso;
 *  (i) modifica «per dimensioni»: il testo generato dalle dimensioni vecchie non
 *      riparte intatto quando le dimensioni cambiano.
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
const MATERIA = '22222222-2222-4222-8222-222222222222';
const MATERIA_2 = '33333333-3333-4333-8333-333333333333';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const ALUNNO_B = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Luca', cognome: 'Bianchi' };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`userId=${DOCENTE}`),
  useParams: () => ({ sectionId: SEZIONE }),
  usePathname: () => `/teacher/primaria/${SEZIONE}/valutazioni`,
}));

import ValutazioniPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/valutazioni/page';
import {
  bozzaDaImpreparato,
  bozzaDaValutazione,
  corpoModificaImpreparato,
  corpoModificaValutazione,
  conCambioDimensioni,
  dimensioniCambiate,
  tipoImpreparato,
  unisciVociRecenti,
  valutazioneCambiata,
  type ImpreparatoRecente,
  type ValutazioneRecente,
} from '@/components/features/primaria/VociValutazioni';

const VAL_ID = 'v0000001-0000-4000-8000-000000000001';
const IMP_DOC = 'g0000001-0000-4000-8000-000000000001';
const IMP_GEN = 'g0000002-0000-4000-8000-000000000002';

function valutazione(extra: Partial<ValutazioneRecente> = {}): ValutazioneRecente {
  return {
    id: VAL_ID,
    maestra_id: DOCENTE,
    tipo: 'orale',
    modalita: 'sintetico',
    argomento: 'Le tabelline',
    dim_autonomia: null,
    dim_continuita: null,
    dim_tipologia: null,
    dim_risorse: null,
    giudizio_sintetico: 'Buono',
    giudizio_testo: null,
    annotazione_numerica: null,
    creato_il: '2026-09-20T08:00:00Z',
    valutazione_obiettivi: [],
    modificabile: true,
    bloccata: false,
    giorniLimite: 2,
    ...extra,
  };
}

function impreparato(extra: Partial<ImpreparatoRecente> = {}): ImpreparatoRecente {
  return {
    id: IMP_DOC,
    alunno_id: ALUNNO.id,
    materia_id: MATERIA,
    data: '2026-09-22',
    motivo: null,
    origine: 'docente',
    tipo: 'impreparato',
    creato_il: '2026-09-22T07:00:00Z',
    modificabile: true,
    bloccata: false,
    giorniLimite: 2,
    ...extra,
  };
}

const fetchMock = vi.fn();
let valutazioni: ValutazioneRecente[] = [];
let impreparati: ImpreparatoRecente[] = [];
let statoVociDisponibile = true;
let ruolo = 'educator';
let rispostaMutazione: { status: number; corpo: unknown } = { status: 200, corpo: { success: true } };
/**
 * Le GET delle «recenti» dell'alunno B passano da qui quando è impostata: il test
 * decide se restano in volo, falliscono o rispondono, e quando.
 */
let letturaB: ((url: string) => Promise<unknown>) | null = null;

const risposta = (status: number, corpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

const chiamate = (metodo: string, frammento: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) =>
      String(u).includes(frammento) && ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
  );

const corpoDi = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  vi.clearAllMocks();
  valutazioni = [valutazione()];
  impreparati = [
    impreparato(),
    impreparato({
      id: IMP_GEN,
      materia_id: null,
      data: '2026-09-18',
      origine: 'genitore',
      tipo: 'giustificato',
      motivo: 'Febbre',
      creato_il: '2026-09-17T18:00:00Z',
    }),
  ];
  statoVociDisponibile = true;
  ruolo = 'educator';
  rispostaMutazione = { status: 200, corpo: { success: true } };
  letturaB = null;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    if (url.startsWith('/api/primaria/classe/')) {
      return risposta(200, {
        success: true,
        data: { alunni: [ALUNNO, ALUNNO_B], materie: [{ id: MATERIA, nome: 'Matematica' }, { id: MATERIA_2, nome: 'Italiano' }] },
      });
    }
    if (url.startsWith('/api/primaria/obiettivi')) {
      return risposta(200, { success: true, data: { scala: ['Ottimo', 'Buono', 'Sufficiente'], scalaValori: [], obiettivi: [] } });
    }
    if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo } });
    if (url.startsWith('/api/primaria/sblocca') && metodo === 'POST') return risposta(200, { success: true });
    if (metodo === 'GET' && letturaB && url.includes(`alunnoId=${ALUNNO_B.id}`)) return letturaB(url);
    if (url.startsWith('/api/primaria/valutazioni') && metodo === 'GET') {
      return risposta(200, { success: true, data: valutazioni, statoVociDisponibile });
    }
    if (url.startsWith('/api/primaria/giustifiche-didattiche') && metodo === 'GET') {
      return risposta(200, { success: true, data: impreparati, statoVociDisponibile });
    }
    if (url.startsWith('/api/primaria/valutazioni') || url.startsWith('/api/primaria/giustifiche-didattiche')) {
      return risposta(rispostaMutazione.status, rispostaMutazione.corpo);
    }
    throw new Error(`fetch inattesa: ${metodo} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

async function svuotaCoda() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Monta la pagina e sceglie alunno e materia: le «recenti» partono solo così. */
async function montaEScegli() {
  render(<ValutazioniPage />);
  await screen.findByRole('option', { name: 'Rossi Mario' });
  await screen.findByRole('option', { name: 'Matematica' });
  const [selAlunno, selMateria] = screen.getAllByRole('combobox');
  fireEvent.change(selAlunno!, { target: { value: ALUNNO.id } });
  fireEvent.change(selMateria!, { target: { value: MATERIA } });
  await screen.findByTestId(`voce-valutazione-${VAL_ID}`);
  await svuotaCoda();
}

describe('pure: elenco unito, tipo, corpi delle PATCH', () => {
  it('valutazioni e impreparati in un elenco solo, dal giorno più recente', () => {
    const voci = unisciVociRecenti(
      [valutazione()],
      [impreparato(), impreparato({ id: IMP_GEN, data: '2026-09-18', creato_il: '2026-09-17T18:00:00Z' })],
    );
    expect(voci.map((v) => `${v.genere}:${v.voce.id}`)).toEqual([
      `impreparato:${IMP_DOC}`,
      `valutazione:${VAL_ID}`,
      `impreparato:${IMP_GEN}`,
    ]);
  });

  it('il giorno di una valutazione è la data di ROMA di creato_il, non quella UTC', () => {
    // 22:30 UTC del 21 = 00:30 del 22 a Roma: deve stare DOPO l'impreparato del 21.
    const voci = unisciVociRecenti(
      [valutazione({ creato_il: '2026-09-21T22:30:00Z' })],
      [impreparato({ data: '2026-09-21', creato_il: '2026-09-21T23:00:00Z' })],
    );
    expect(voci[0]!.genere).toBe('valutazione');
    expect(voci[0]!.giorno).toBe('2026-09-22');
  });

  it('il tipo: la colonna se c’è, altrimenti l’origine', () => {
    expect(tipoImpreparato({ tipo: 'giustificato', origine: 'docente' })).toBe('giustificato');
    expect(tipoImpreparato({ tipo: null, origine: 'genitore' })).toBe('giustificato');
    expect(tipoImpreparato({ tipo: undefined, origine: 'docente' })).toBe('impreparato');
  });

  it('impreparato: solo i campi cambiati; il tipo di quello del genitore non parte mai', () => {
    const g = impreparato({ motivo: 'Libro dimenticato' });
    expect(corpoModificaImpreparato(g, bozzaDaImpreparato(g))).toEqual({});
    expect(corpoModificaImpreparato(g, { ...bozzaDaImpreparato(g), motivo: 'Libro dimenticato  ' })).toEqual({});
    expect(corpoModificaImpreparato(g, { ...bozzaDaImpreparato(g), tipo: 'giustificato', data: '2026-09-21' })).toEqual({
      tipo: 'giustificato',
      data: '2026-09-21',
    });
    expect(corpoModificaImpreparato(g, { ...bozzaDaImpreparato(g), motivo: '  ', materiaId: '' })).toEqual({
      motivo: null,
      materiaId: null,
    });
    const gen = impreparato({ origine: 'genitore', tipo: 'giustificato' });
    expect(corpoModificaImpreparato(gen, { ...bozzaDaImpreparato(gen), tipo: 'impreparato' })).toEqual({});
  });

  it('valutazione: tipoProva parte SOLO se cambia; il testo delle dimensioni cade passando a sintetico', () => {
    const v = valutazione({
      modalita: 'dimensioni',
      giudizio_sintetico: null,
      giudizio_testo: 'Testo delle dimensioni',
      dim_autonomia: true,
      dim_continuita: false,
      dim_tipologia: 'non_nota',
      dim_risorse: 'esterne',
      tipo: 'scritto',
    });
    const scala = ['Ottimo', 'Buono'];
    const b = bozzaDaValutazione(v, scala);
    expect(valutazioneCambiata(v, b, scala)).toBe(false);
    const corpo = corpoModificaValutazione(v, b);
    expect(corpo).not.toHaveProperty('tipoProva');
    expect(corpo).toMatchObject({
      id: VAL_ID,
      modalita: 'dimensioni',
      dims: { autonomia: true, continuita: false, tipologia: 'non_nota', risorse: 'esterne' },
      giudizioSintetico: null,
      giudizioTesto: 'Testo delle dimensioni',
      annotazioneNumerica: null,
      argomento: 'Le tabelline',
    });
    const sint = corpoModificaValutazione(v, { ...b, modalita: 'sintetico', giudizioSintetico: 'Ottimo', tipoProva: 'orale' });
    expect(sint).toMatchObject({ tipoProva: 'orale', giudizioSintetico: 'Ottimo', giudizioTesto: null });
    expect(sint.dims).toBeUndefined();
  });

  it('valutazione per dimensioni: dimensione cambiata e testo intatto → il testo si svuota e parte null', () => {
    const v = valutazione({
      modalita: 'dimensioni',
      giudizio_sintetico: null,
      giudizio_testo: 'Testo generato dalle dimensioni vecchie',
      dim_autonomia: true,
      dim_continuita: true,
      dim_tipologia: 'nota',
      dim_risorse: 'interne',
    });
    const b = bozzaDaValutazione(v, []);
    expect(dimensioniCambiate(v, b)).toBe(false);

    // La modale svuota il campo appena cambia una dimensione (il docente lo vede).
    const cambiata = conCambioDimensioni(v, b, { autonomia: false });
    expect(cambiata.autonomia).toBe(false);
    expect(cambiata.giudizioTesto).toBe('');
    expect(corpoModificaValutazione(v, cambiata)).toMatchObject({
      dims: { autonomia: false, continuita: true, tipologia: 'nota', risorse: 'interne' },
      giudizioTesto: null,
    });
    // Anche se la bozza arrivasse col testo intatto, la PATCH non lo rimanda.
    expect(corpoModificaValutazione(v, { ...b, risorse: 'esterne' }).giudizioTesto).toBeNull();
    // Senza cambi di dimensioni il testo salvato resta.
    expect(corpoModificaValutazione(v, { ...b, argomento: 'Altro' }).giudizioTesto).toBe(
      'Testo generato dalle dimensioni vecchie',
    );
  });

  it('valutazione per dimensioni: il testo scritto dal docente resta il suo, anche cambiando le dimensioni', () => {
    const v = valutazione({
      modalita: 'dimensioni',
      giudizio_sintetico: null,
      giudizio_testo: 'Testo salvato',
      dim_autonomia: true,
      dim_continuita: true,
      dim_tipologia: 'nota',
      dim_risorse: 'interne',
    });
    const b = { ...bozzaDaValutazione(v, []), giudizioTesto: 'Il mio testo' };
    const cambiata = conCambioDimensioni(v, b, { tipologia: 'non_nota' });
    expect(cambiata.giudizioTesto).toBe('Il mio testo');
    expect(corpoModificaValutazione(v, cambiata).giudizioTesto).toBe('Il mio testo');
    // Svuotato una volta, un cambio successivo non tocca ciò che il docente riscrive.
    const svuotata = conCambioDimensioni(v, bozzaDaValutazione(v, []), { continuita: false });
    const riscritta = conCambioDimensioni(v, { ...svuotata, giudizioTesto: 'Nuovo' }, { risorse: 'entrambe' });
    expect(riscritta.giudizioTesto).toBe('Nuovo');
  });

  it('valutazione per dimensioni con i dim_* null: la bozza di partenza NON è un cambio', () => {
    const v = valutazione({ modalita: 'dimensioni', giudizio_sintetico: null, giudizio_testo: 'Testo salvato' });
    const scala = ['Ottimo', 'Buono'];
    const b = bozzaDaValutazione(v, scala);
    // I predefiniti della bozza (true, 'nota', 'interne') valgono i null salvati.
    expect(valutazioneCambiata(v, b, scala)).toBe(false);
    expect(dimensioniCambiate(v, b)).toBe(false);
    // Un cambio vero resta un cambio, per ciascuna delle quattro dimensioni.
    expect(valutazioneCambiata(v, { ...b, autonomia: false }, scala)).toBe(true);
    expect(valutazioneCambiata(v, { ...b, continuita: false }, scala)).toBe(true);
    expect(valutazioneCambiata(v, { ...b, tipologia: 'non_nota' }, scala)).toBe(true);
    expect(valutazioneCambiata(v, { ...b, risorse: 'entrambe' }, scala)).toBe(true);
    // E le due funzioni dicono la stessa cosa sulla stessa voce.
    expect(dimensioniCambiate(v, { ...b, risorse: 'entrambe' })).toBe(true);
  });

  it('valutazione sintetica passata a «per dimensioni»: il testo salvato non riparte intatto', () => {
    const v = valutazione({ modalita: 'sintetico', giudizio_testo: 'Testo della sintetica' });
    const b = conCambioDimensioni(v, bozzaDaValutazione(v, ['Buono']), { modalita: 'dimensioni' });
    expect(b.giudizioTesto).toBe('');
    expect(corpoModificaValutazione(v, { ...bozzaDaValutazione(v, ['Buono']), modalita: 'dimensioni' }).giudizioTesto).toBeNull();
  });
});

describe('«Valutazioni recenti»: valutazioni e impreparati insieme', () => {
  it('legge i due elenchi dell’alunno con la materia e li mostra in ordine di data, col tipo', async () => {
    await montaEScegli();
    const letture = chiamate('GET', '/api/primaria/giustifiche-didattiche');
    const url = String(letture.at(-1)![0]);
    expect(url).toContain(`sectionId=${SEZIONE}`);
    expect(url).toContain(`alunnoId=${ALUNNO.id}`);
    expect(url).toContain(`materiaId=${MATERIA}`);
    // Nessuna lettura della classe intera «di oggi»: l'elenco vive solo qui.
    expect(letture.every(([u]) => !String(u).includes('data='))).toBe(true);

    const righe = screen.getAllByTestId(/^voce-(valutazione|impreparato)-/).map((el) => el.getAttribute('data-testid'));
    expect(righe).toEqual([`voce-impreparato-${IMP_DOC}`, `voce-valutazione-${VAL_ID}`, `voce-impreparato-${IMP_GEN}`]);
    const gen = screen.getByTestId(`voce-impreparato-${IMP_GEN}`);
    expect(within(gen).getByText('Impreparato giustificato')).toBeTruthy();
    expect(within(gen).getByText('dal genitore')).toBeTruthy();
    expect(within(screen.getByTestId(`voce-impreparato-${IMP_DOC}`)).getByText('Impreparato')).toBeTruthy();
  });

  it('cambiando alunno, con la lettura nuova IN VOLO, le voci del primo spariscono subito', async () => {
    letturaB = () => new Promise(() => {});
    await montaEScegli();
    expect(screen.getByRole('button', { name: /^Elimina la valutazione/ })).toBeTruthy();
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: ALUNNO_B.id } });
    await waitFor(() => expect(chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length).toBe(2));
    expect(screen.queryByTestId(`voce-valutazione-${VAL_ID}`)).toBeNull();
    expect(screen.queryByTestId(`voce-impreparato-${IMP_DOC}`)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Elimina/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Modifica/ })).toBeNull();
  });

  it('cambiando alunno, con la lettura nuova FALLITA, le voci del primo non tornano e l’avviso si accende', async () => {
    letturaB = () => Promise.reject(new TypeError('Failed to fetch'));
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina la valutazione del 20/09/2026 (Le tabelline)' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Valutazione eliminata ✓')).toBeTruthy();
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: ALUNNO_B.id } });
    expect(await screen.findByText(/caricare tutte le voci/)).toBeTruthy();
    expect(screen.queryByTestId(`voce-valutazione-${VAL_ID}`)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Elimina/ })).toBeNull();
    // L'esito dell'eliminazione era dell'alunno di prima.
    expect(screen.queryByText('Valutazione eliminata ✓')).toBeNull();
  });

  it('un guasto di una lettura SUPERATA non accende l’avviso sopra l’elenco nuovo', async () => {
    let rifiutaB: (e: unknown) => void = () => {};
    letturaB = () => new Promise((_, rej) => { rifiutaB = rej; });
    await montaEScegli();
    const [selAlunno] = screen.getAllByRole('combobox');
    fireEvent.change(selAlunno!, { target: { value: ALUNNO_B.id } });
    await waitFor(() => expect(chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length).toBe(2));
    fireEvent.change(selAlunno!, { target: { value: ALUNNO.id } });
    await screen.findByTestId(`voce-valutazione-${VAL_ID}`);
    await act(async () => { rifiutaB(new TypeError('Failed to fetch')); });
    await svuotaCoda();
    expect(screen.getByTestId(`voce-valutazione-${VAL_ID}`)).toBeTruthy();
    expect(screen.queryByText(/caricare tutte le voci/)).toBeNull();
    expect(
      h.logClient.mock.calls.some(([e]) => String((e as { messaggio?: string }).messaggio).includes('(superata)')),
    ).toBe(true);
  });

  it('senza permessi calcolati nessun bottone, e lo dice', async () => {
    statoVociDisponibile = false;
    await montaEScegli();
    expect(screen.queryByRole('button', { name: /^Modifica/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Elimina/ })).toBeNull();
    expect(screen.getByText(/Modifica ed eliminazione non sono disponibili/)).toBeTruthy();
  });
});

describe('«Segna impreparato»', () => {
  it('manda tipo, motivo, materia e la data di ROMA, e conferma', async () => {
    // 22:30 UTC del 24 = 00:30 del 25 a Roma: la data vecchia (UTC) avrebbe detto il 24.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T22:30:00Z'));
    rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuovo' } } };
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Impreparato giustificato' }));
    fireEvent.change(screen.getByLabelText('Motivo (facoltativo)'), { target: { value: '  Visita medica ' } });
    const primaDelleLetture = chiamate('GET', '/api/primaria/valutazioni').length;
    fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
    expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
    const post = chiamate('POST', '/api/primaria/giustifiche-didattiche');
    expect(post).toHaveLength(1);
    expect(corpoDi(post[0]!)).toEqual({
      sectionId: SEZIONE,
      alunnoId: ALUNNO.id,
      materiaId: MATERIA,
      data: '2026-09-25',
      tipo: 'giustificato',
      motivo: 'Visita medica',
    });
    await waitFor(() => expect(chiamate('GET', '/api/primaria/valutazioni').length).toBeGreaterThan(primaDelleLetture));
  });

  it('un rifiuto del server si mostra: non passa per un successo', async () => {
    rispostaMutazione = { status: 400, corpo: { error: 'Materia non valida per questa classe', codice: 'IMPREPARATO_MATERIA_NON_VALIDA' } };
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
    const avviso = await screen.findByRole('alert');
    // Il codice si traduce dal catalogo (`messaggioDaCorpo`), non si mostra la prosa del server.
    expect(avviso.textContent).toContain('Questa materia non è della classe');
    expect(screen.queryByText('Impreparato segnato ✓')).toBeNull();
    const post = chiamate('POST', '/api/primaria/giustifiche-didattiche');
    expect(corpoDi(post[0]!)).toMatchObject({ tipo: 'impreparato' });
    expect(corpoDi(post[0]!)).not.toHaveProperty('motivo');
  });

  it('la conferma arrivata DOPO il cambio di alunno non compare sotto l’altro bambino', async () => {
    const base = fetchMock.getMockImplementation()!;
    let rispondiPost: (r: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/primaria/giustifiche-didattiche') && init?.method === 'POST') {
        return new Promise((res) => { rispondiPost = res; });
      }
      return base(url, init);
    });
    await montaEScegli();
    const [selAlunno] = screen.getAllByRole('combobox');
    fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/giustifiche-didattiche')).toHaveLength(1));
    // La POST è partita per A; a schermo si passa a B mentre è in volo.
    expect(corpoDi(chiamate('POST', '/api/primaria/giustifiche-didattiche')[0]!)).toMatchObject({ alunnoId: ALUNNO.id });
    const letturePerAPrimaDelCambio = chiamate('GET', `alunnoId=${ALUNNO.id}`).length;
    fireEvent.change(selAlunno!, { target: { value: ALUNNO_B.id } });
    await waitFor(() => expect(chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length).toBe(2));
    await act(async () => { rispondiPost(risposta(201, { success: true, data: { id: 'nuovo' } })); });
    // Si aspetta una PRESENZA: il bottone torna libero, cioè la risposta è stata elaborata.
    expect(await screen.findByRole('button', { name: 'Segna impreparato' })).toBeTruthy();
    await svuotaCoda();
    expect(screen.queryByText('Impreparato segnato ✓')).toBeNull();
    // La rilettura dopo il successo è della selezione di ADESSO (B), non di quella
    // del clic: nessuna GET per A dopo il cambio, e l'elenco di B resta a schermo
    // (con la `ricaricaRecenti` catturata al clic comparirebbe «Nessuna valutazione»).
    expect(chiamate('GET', `alunnoId=${ALUNNO.id}`)).toHaveLength(letturePerAPrimaDelCambio);
    const lettureValutazioni = chiamate('GET', '/api/primaria/valutazioni?');
    expect(String(lettureValutazioni.at(-1)![0])).toContain(`alunnoId=${ALUNNO_B.id}`);
    expect(screen.getByTestId(`voce-valutazione-${VAL_ID}`)).toBeTruthy();
    expect(screen.queryByText(/^Nessuna valutazione/)).toBeNull();
    // Tornando ad A la conferma c'è: l'esito era stato scritto, ma per A.
    fireEvent.change(selAlunno!, { target: { value: ALUNNO.id } });
    expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
  });

  it('la valutazione salvata DOPO il cambio di alunno rilegge l’elenco dell’alunno a schermo', async () => {
    const base = fetchMock.getMockImplementation()!;
    let rispondiPost: (r: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/primaria/valutazioni') && init?.method === 'POST') {
        return new Promise((res) => { rispondiPost = res; });
      }
      return base(url, init);
    });
    await montaEScegli();
    const [selAlunno] = screen.getAllByRole('combobox');
    fireEvent.change(screen.getByPlaceholderText('Es. Le tabelline del 7, La comprensione del testo…'), {
      target: { value: 'Le frazioni' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/valutazioni')).toHaveLength(1));
    expect(corpoDi(chiamate('POST', '/api/primaria/valutazioni')[0]!)).toMatchObject({ alunnoId: ALUNNO.id });
    const letturePerAPrimaDelCambio = chiamate('GET', `alunnoId=${ALUNNO.id}`).length;
    fireEvent.change(selAlunno!, { target: { value: ALUNNO_B.id } });
    await waitFor(() => expect(chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length).toBe(2));
    await act(async () => { rispondiPost(risposta(201, { success: true, data: { id: 'nuova' } })); });
    // PRESENZA: la conferma della POST è stata elaborata.
    expect(await screen.findByText('Valutazione salvata ✓')).toBeTruthy();
    await svuotaCoda();
    expect(chiamate('GET', `alunnoId=${ALUNNO.id}`)).toHaveLength(letturePerAPrimaDelCambio);
    expect(String(chiamate('GET', '/api/primaria/valutazioni?').at(-1)![0])).toContain(`alunnoId=${ALUNNO_B.id}`);
    expect(screen.getByTestId(`voce-valutazione-${VAL_ID}`)).toBeTruthy();
    expect(screen.queryByText(/^Nessuna valutazione/)).toBeNull();
  });

  it('un successo su A sparisce passando a B, e sotto B non si vede mai', async () => {
    rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuovo' } } };
    await montaEScegli();
    const [selAlunno] = screen.getAllByRole('combobox');
    fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
    expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
    const primaDiB = chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length;
    fireEvent.change(selAlunno!, { target: { value: ALUNNO_B.id } });
    await waitFor(() => expect(chiamate('GET', `alunnoId=${ALUNNO_B.id}`).length).toBe(primaDiB + 2));
    await screen.findByTestId(`voce-valutazione-${VAL_ID}`);
    expect(screen.queryByText('Impreparato segnato ✓')).toBeNull();
    fireEvent.change(selAlunno!, { target: { value: ALUNNO.id } });
    expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
  });
});

describe('Modifica', () => {
  it('impreparato: tipo e data cambiati partono da soli', async () => {
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica l’impreparato del 22/09/2026' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Impreparato giustificato' }));
    fireEvent.change(within(dialogo).getByLabelText('Data'), { target: { value: '2026-09-21' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Impreparato modificato ✓')).toBeTruthy();
    const patch = chiamate('PATCH', '/api/primaria/giustifiche-didattiche');
    expect(patch).toHaveLength(1);
    expect(corpoDi(patch[0]!)).toEqual({ id: IMP_DOC, tipo: 'giustificato', data: '2026-09-21' });
  });

  it('impreparato del genitore: il tipo non si offre; senza cambi non parte niente', async () => {
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica l’impreparato del 18/09/2026' }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByTestId('impreparato-tipo-genitore')).toBeTruthy();
    expect(within(dialogo).queryByRole('button', { name: 'Impreparato' })).toBeNull();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await within(dialogo).findByText('Non hai cambiato niente.')).toBeTruthy();
    expect(chiamate('PATCH', '/api/primaria/giustifiche-didattiche')).toHaveLength(0);
  });

  it('valutazione: gli stessi campi della creazione, tipoProva solo se cambia', async () => {
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la valutazione del 20/09/2026 (Le tabelline)' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Giudizio sintetico'), { target: { value: 'Ottimo' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Valutazione modificata ✓')).toBeTruthy();
    const patch = chiamate('PATCH', '/api/primaria/valutazioni');
    expect(patch).toHaveLength(1);
    const corpo = corpoDi(patch[0]!);
    expect(corpo).toMatchObject({
      id: VAL_ID,
      modalita: 'sintetico',
      giudizioSintetico: 'Ottimo',
      argomento: 'Le tabelline',
      annotazioneNumerica: null,
      obiettiviIds: [],
    });
    expect(corpo).not.toHaveProperty('tipoProva');
  });

  it('valutazione per dimensioni: cambiando una dimensione il testo generato si svuota e la PATCH manda null', async () => {
    valutazioni = [
      valutazione({
        modalita: 'dimensioni',
        giudizio_sintetico: null,
        giudizio_testo: 'Testo generato dalle dimensioni vecchie',
        dim_autonomia: true,
        dim_continuita: true,
        dim_tipologia: 'nota',
        dim_risorse: 'interne',
      }),
    ];
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la valutazione del 20/09/2026 (Le tabelline)' }));
    const dialogo = await screen.findByRole('dialog');
    const testo = within(dialogo).getByLabelText('Giudizio descrittivo') as HTMLTextAreaElement;
    expect(testo.value).toBe('Testo generato dalle dimensioni vecchie');
    fireEvent.click(within(within(dialogo).getByRole('group', { name: 'Autonomia' })).getByRole('button', { name: 'no' }));
    expect(testo.value).toBe('');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Valutazione modificata ✓')).toBeTruthy();
    const corpo = corpoDi(chiamate('PATCH', '/api/primaria/valutazioni')[0]!);
    expect(corpo).toMatchObject({ dims: { autonomia: false }, giudizioTesto: null });
  });
});

describe('Elimina', () => {
  it('niente parte prima della conferma; poi la DELETE della voce giusta', async () => {
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Elimina la valutazione del 20/09/2026 (Le tabelline)' }));
    const dialogo = await screen.findByRole('dialog');
    expect(chiamate('DELETE', '/api/primaria/valutazioni')).toHaveLength(0);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    expect(await screen.findByText('Valutazione eliminata ✓')).toBeTruthy();
    const del = chiamate('DELETE', '/api/primaria/valutazioni');
    expect(del).toHaveLength(1);
    expect(String(del[0]![0])).toContain(`id=${VAL_ID}`);
  });

  it('un 423 si mostra sopra l’elenco, tradotto dal codice, e fa rileggere', async () => {
    // La prosa del server è volutamente diversa dal catalogo: il testo tradotto
    // comincia anch'esso con «Voce bloccata:», e un confronto su quelle parole non
    // distinguerebbe la traduzione dalla frase grezza.
    const prosaServer = 'Frase del server che non deve arrivare a schermo';
    rispostaMutazione = { status: 423, corpo: { error: prosaServer, codice: 'VOCE_BLOCCATA', giorniLimite: 2 } };
    await montaEScegli();
    const letturePrima = chiamate('GET', '/api/primaria/giustifiche-didattiche').length;
    fireEvent.click(screen.getByRole('button', { name: 'Elimina l’impreparato del 22/09/2026' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const avviso = screen.getByRole('alert');
    // `erroreVoceBloccata` di messages/it/shared.json, non la frase del server né il fallback generico.
    expect(avviso.textContent).toContain('è passato il termine per modificarla');
    expect(avviso.textContent).not.toContain(prosaServer);
    await waitFor(() =>
      expect(chiamate('GET', '/api/primaria/giustifiche-didattiche').length).toBeGreaterThan(letturePrima),
    );
    expect(chiamate('DELETE', '/api/primaria/giustifiche-didattiche')).toHaveLength(1);
  });
});

describe('voce bloccata', () => {
  beforeEach(() => {
    valutazioni = [valutazione({ modificabile: false, bloccata: true, giorniLimite: 2 })];
  });

  it('al docente: il messaggio, niente bottoni, niente «Sblocca»', async () => {
    await montaEScegli();
    const riga = screen.getByTestId(`voce-bloccata-${VAL_ID}`);
    expect(riga.textContent).toContain('Bloccata: superato il termine di 2 giorni.');
    expect(screen.queryByRole('button', { name: /Modifica la valutazione/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sblocca/ })).toBeNull();
  });

  it('alla Direzione: «Sblocca» in modo voce, e dopo lo sblocco si rilegge', async () => {
    ruolo = 'admin';
    await montaEScegli();
    const sblocca = await screen.findByRole('button', { name: 'Sblocca la valutazione del 20/09/2026 (Le tabelline)' });
    fireEvent.click(sblocca);
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Motivo dello sblocco'), { target: { value: 'Errore di trascrizione' } });
    const letturePrima = chiamate('GET', '/api/primaria/valutazioni').length;
    valutazioni = [valutazione()];
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Autorizza' }));
    await waitFor(() => expect(chiamate('GET', '/api/primaria/valutazioni').length).toBeGreaterThan(letturePrima));
    const post = chiamate('POST', '/api/primaria/sblocca');
    expect(corpoDi(post[0]!)).toEqual({ entitaTipo: 'valutazione', entitaId: VAL_ID, motivazione: 'Errore di trascrizione' });
    expect(await screen.findByRole('button', { name: 'Modifica la valutazione del 20/09/2026 (Le tabelline)' })).toBeTruthy();
  });
});
