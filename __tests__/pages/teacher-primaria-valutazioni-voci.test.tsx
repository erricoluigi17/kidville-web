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
import type { PeriodoScrutinio } from '@/lib/primaria/periodo';
import { SEDE_A } from '../fixtures/sedi';
import {
  bozzaDaImpreparato,
  bozzaDaValutazione,
  corpoModificaImpreparato,
  corpoModificaValutazione,
  conCambioDimensioni,
  dimensioniCambiate,
  filtraVociRecenti,
  tipoImpreparato,
  unisciVociRecenti,
  valutazioneCambiata,
  type ImpreparatoRecente,
  type ValutazioneRecente,
  type VoceRecente,
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
/** I periodi con le date che la GET dei voti restituisce (D16): `[]` = la sede non li ha. */
let periodiSede: PeriodoScrutinio[] = [];
let ruolo = 'educator';
let rispostaMutazione: { status: number; corpo: unknown } = { status: 200, corpo: { success: true } };
/** La lettura della classe: `null` = la risposta normale, con due materie. */
let rispostaClasse: (() => Promise<unknown>) | null = null;
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
  periodiSede = [];
  ruolo = 'educator';
  rispostaMutazione = { status: 200, corpo: { success: true } };
  letturaB = null;
  rispostaClasse = null;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    if (url.startsWith('/api/primaria/classe/') && rispostaClasse) return rispostaClasse();
    if (url.startsWith('/api/primaria/classe/')) {
      return risposta(200, {
        success: true,
        data: { alunni: [ALUNNO, ALUNNO_B], materie: [{ id: MATERIA, nome: 'Matematica' }, { id: MATERIA_2, nome: 'Italiano' }] },
      });
    }
    if (url.startsWith('/api/primaria/obiettivi')) {
      return risposta(200, {
        success: true,
        data: {
          scala: ['Ottimo', 'Buono', 'Sufficiente'],
          scalaValori: [
            { etichetta: 'Ottimo', valore_numerico: 10 },
            { etichetta: 'Buono', valore_numerico: 8 },
            { etichetta: 'Sufficiente', valore_numerico: 6 },
          ],
          obiettivi: [],
        },
      });
    }
    if (url.startsWith('/api/admin/sections/')) return risposta(200, { success: true, assigned: [{ id: DOCENTE, nome: 'Ada', cognome: 'Fittizia', ruolo: 'educator' }] });
    if (url.startsWith('/api/primaria/me')) return risposta(200, { success: true, data: { ruolo } });
    if (url.startsWith('/api/primaria/sblocca') && metodo === 'POST') return risposta(200, { success: true });
    if (metodo === 'GET' && letturaB && url.includes(`alunnoId=${ALUNNO_B.id}`)) return letturaB(url);
    if (url.startsWith('/api/primaria/valutazioni') && metodo === 'GET') {
      return risposta(200, { success: true, data: valutazioni, statoVociDisponibile, autoriDisponibili: true, periodi: periodiSede });
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

/**
 * I DUE campi «Data della prova» della pagina: quello del modulo di creazione del voto (il primo
 * nel DOM) e quello della card «Segna un impreparato». Condividono lo stesso stato.
 */
const campoDataModulo = () => screen.getAllByLabelText('Data della prova')[0] as HTMLInputElement;
const cardImpreparato = () => screen.getByRole('region', { name: 'Segna un impreparato' });
const campoDataImpreparato = () => within(cardImpreparato()).getByLabelText('Data della prova') as HTMLInputElement;

/** Il giudizio sintetico del modulo di creazione (fuori dalla modale). */
function scegliGiudizio(valore: string) {
  fireEvent.change(screen.getByLabelText('Giudizio sintetico'), { target: { value: valore } });
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
    const b = bozzaDaValutazione(v);
    expect(valutazioneCambiata(v, b)).toBe(false);
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
    const b = bozzaDaValutazione(v);
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
    const b = { ...bozzaDaValutazione(v), giudizioTesto: 'Il mio testo' };
    const cambiata = conCambioDimensioni(v, b, { tipologia: 'non_nota' });
    expect(cambiata.giudizioTesto).toBe('Il mio testo');
    expect(corpoModificaValutazione(v, cambiata).giudizioTesto).toBe('Il mio testo');
    // Svuotato una volta, un cambio successivo non tocca ciò che il docente riscrive.
    const svuotata = conCambioDimensioni(v, bozzaDaValutazione(v), { continuita: false });
    const riscritta = conCambioDimensioni(v, { ...svuotata, giudizioTesto: 'Nuovo' }, { risorse: 'entrambe' });
    expect(riscritta.giudizioTesto).toBe('Nuovo');
  });

  it('valutazione per dimensioni con i dim_* null: la bozza di partenza NON è un cambio', () => {
    const v = valutazione({ modalita: 'dimensioni', giudizio_sintetico: null, giudizio_testo: 'Testo salvato' });
    const b = bozzaDaValutazione(v);
    // I predefiniti della bozza (true, 'nota', 'interne') valgono i null salvati.
    expect(valutazioneCambiata(v, b)).toBe(false);
    expect(dimensioniCambiate(v, b)).toBe(false);
    // Un cambio vero resta un cambio, per ciascuna delle quattro dimensioni.
    expect(valutazioneCambiata(v, { ...b, autonomia: false })).toBe(true);
    expect(valutazioneCambiata(v, { ...b, continuita: false })).toBe(true);
    expect(valutazioneCambiata(v, { ...b, tipologia: 'non_nota' })).toBe(true);
    expect(valutazioneCambiata(v, { ...b, risorse: 'entrambe' })).toBe(true);
    // E le due funzioni dicono la stessa cosa sulla stessa voce.
    expect(dimensioniCambiate(v, { ...b, risorse: 'entrambe' })).toBe(true);
  });

  it('per dimensioni: la bozza storica senza giudizio parte vuota, e scegliere il giudizio è un cambio', () => {
    const v = valutazione({ modalita: 'dimensioni', giudizio_sintetico: null, giudizio_testo: 'Testo' });
    const b = bozzaDaValutazione(v);
    expect(b.giudizioSintetico).toBe('');
    expect(valutazioneCambiata(v, { ...b, giudizioSintetico: 'Buono' })).toBe(true);
    expect(corpoModificaValutazione(v, { ...b, giudizioSintetico: 'Buono' })).toMatchObject({
      modalita: 'dimensioni',
      giudizioSintetico: 'Buono',
    });
  });

  it('valutazione sintetica passata a «per dimensioni»: il testo salvato non riparte intatto', () => {
    const v = valutazione({ modalita: 'sintetico', giudizio_testo: 'Testo della sintetica' });
    const b = conCambioDimensioni(v, bozzaDaValutazione(v), { modalita: 'dimensioni' });
    expect(b.giudizioTesto).toBe('');
    expect(corpoModificaValutazione(v, { ...bozzaDaValutazione(v), modalita: 'dimensioni' }).giudizioTesto).toBeNull();
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
    // La modale chiusa dalla risposta di rete sparisce subito, ma lo sfondo torna
    // accessibile (inert tolto) solo nella pulizia dell'effetto, un giro dopo: un
    // getAllByRole qui, sotto carico, non vede le select. findAllByRole aspetta.
    fireEvent.change((await screen.findAllByRole('combobox'))[0]!, { target: { value: ALUNNO_B.id } });
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
    scegliGiudizio('Buono');
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
        // Dal 2026-10-04 anche «per dimensioni» ha il giudizio (la voce storica senza: test in fondo).
        giudizio_sintetico: 'Buono',
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

/**
 * (l) PERCHÉ NON SI PUÒ VALUTARE — detto a schermo e nei log (2026-09-30).
 *
 * Misurato in produzione: a Giugliano, nelle classi I-III, una maestra per classe
 * firma le lezioni senza avere materie assegnate. Per un docente la classe
 * restituisce SOLO le sue materie, e la tendina restava vuota: nessun messaggio,
 * nessun log. Nello stesso punto la lettura della classe non guardava `ok`, e un
 * salvataggio che lanciava lasciava il bottone su «Salvataggio…» per sempre.
 */
describe('classe senza materie, classe non letta, salvataggio che non va', () => {
  it('nessuna materia: al posto della tendina vuota la frase che dice cosa fare, più un warn', async () => {
    rispostaClasse = async () => risposta(200, { success: true, data: { alunni: [ALUNNO], materie: [] } });
    render(<ValutazioniPage />);
    // PRESENZA prima dell'assenza: la frase c'è, quindi la classe è stata letta.
    expect(await screen.findByText(/Non hai materie da valutare in questa classe/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Materia…' })).toBeNull();
    // L'alunno resta sceglibile: «Segna impreparato» funziona anche senza materia.
    expect(screen.getByRole('option', { name: 'Rossi Mario' })).toBeTruthy();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', messaggio: 'valutazioni-nessuna-materia' }));
  });

  it('classe non letta (500): lo dice, logga, e «Riprova» la rilegge', async () => {
    let tentativi = 0;
    rispostaClasse = async () => {
      tentativi += 1;
      return tentativi === 1
        ? risposta(500, { error: 'Errore interno' })
        : risposta(200, { success: true, data: { alunni: [ALUNNO], materie: [{ id: MATERIA, nome: 'Matematica' }] } });
    };
    render(<ValutazioniPage />);
    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent).toContain('Non è stato possibile caricare la classe');
    // Non è «nessuna materia»: sono due cose diverse, e dirle uguali manderebbe in segreteria per un guasto.
    expect(screen.queryByText(/Non hai materie da valutare/)).toBeNull();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'valutazioni-classe-non-caricata', stato: 500 }));
    fireEvent.click(within(avviso).getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('option', { name: 'Matematica' })).toBeTruthy();
    expect(tentativi).toBe(2);
  });

  it('salvataggio respinto (423): il motivo a schermo, una riga di log con lo stato, il bottone torna attivo', async () => {
    rispostaMutazione = { status: 423, corpo: { error: 'Inserimento bloccato: superato il termine di 2 giorni.', locked: true } };
    await montaEScegli();
    fireEvent.change(screen.getByPlaceholderText('Es. Le tabelline del 7, La comprensione del testo…'), { target: { value: 'Le frazioni' } });
    scegliGiudizio('Buono');
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    expect(await screen.findByText('Inserimento bloccato: superato il termine di 2 giorni.')).toBeTruthy();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'valutazione-salva-rifiutata', stato: 423 }));
    // Il corpo non entra nel log: può portare testo sul minore.
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('superato il termine');
    expect((screen.getByRole('button', { name: 'Salva valutazione' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('salvataggio che non parte (rete giù): la frase di rete e il bottone NON resta bloccato', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/primaria/valutazioni') && init?.method === 'POST') return Promise.reject(new TypeError('Failed to fetch'));
      return base(url, init);
    });
    await montaEScegli();
    fireEvent.change(screen.getByPlaceholderText('Es. Le tabelline del 7, La comprensione del testo…'), { target: { value: 'Le frazioni' } });
    scegliGiudizio('Buono');
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    expect(await screen.findByText('Operazione non inviata: controlla la connessione e riprova.')).toBeTruthy();
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: expect.stringContaining('valutazione-salva-non-inviata') }));
    expect((screen.getByRole('button', { name: 'Salva valutazione' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Il giudizio sintetico è il VOTO che vede la famiglia (2026-10-04). ──
// Il modulo partiva su «Per dimensioni», che salvava solo un testo: 33 voti di
// 32 alunni sono arrivati ai genitori senza voto (IV di Giugliano: lo stesso
// testo a 15 bambini, perché le dimensioni predefinite non erano state toccate).
// Ora il giudizio si sceglie SEMPRE, parte vuoto (un predefinito sarebbe la
// stessa trappola, con «Ottimo» a tutti), e il descrittivo è un'aggiunta.
describe('giudizio sintetico obbligatorio (2026-10-04)', () => {
  const ARGOMENTO = 'Es. Le tabelline del 7, La comprensione del testo…';
  const DESCRITTIVO = 'Aggiungi anche il giudizio descrittivo (per dimensioni)';

  it('il modulo parte senza giudizio e senza descrittivo; senza giudizio la POST non parte e lo dice', async () => {
    await montaEScegli();
    expect((screen.getByLabelText('Giudizio sintetico') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('checkbox', { name: DESCRITTIVO }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByPlaceholderText(ARGOMENTO), { target: { value: 'Le frazioni' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    expect(await screen.findByText('Scegli il giudizio sintetico: è il voto che vede la famiglia.')).toBeTruthy();
    expect(chiamate('POST', '/api/primaria/valutazioni')).toHaveLength(0);
  });

  it('col giudizio scelto parte la sintetica; dopo il salvataggio il giudizio torna vuoto per il bambino dopo', async () => {
    rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
    await montaEScegli();
    fireEvent.change(screen.getByPlaceholderText(ARGOMENTO), { target: { value: 'Le frazioni' } });
    scegliGiudizio('Buono');
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    expect(await screen.findByText('Valutazione salvata ✓')).toBeTruthy();
    const corpo = corpoDi(chiamate('POST', '/api/primaria/valutazioni')[0]!);
    expect(corpo).toMatchObject({ modalita: 'sintetico', giudizioSintetico: 'Buono' });
    expect(corpo.dims).toBeUndefined();
    expect((screen.getByLabelText('Giudizio sintetico') as HTMLSelectElement).value).toBe('');
  });

  it('col descrittivo: parte «per dimensioni» CON il giudizio, e il descrittivo resta acceso', async () => {
    rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
    await montaEScegli();
    fireEvent.click(screen.getByRole('checkbox', { name: DESCRITTIVO }));
    fireEvent.change(screen.getByPlaceholderText(ARGOMENTO), { target: { value: 'Le frazioni' } });
    scegliGiudizio('Sufficiente');
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    expect(await screen.findByText('Valutazione salvata ✓')).toBeTruthy();
    expect(corpoDi(chiamate('POST', '/api/primaria/valutazioni')[0]!)).toMatchObject({
      modalita: 'dimensioni',
      giudizioSintetico: 'Sufficiente',
      dims: { autonomia: true, continuita: true, tipologia: 'nota', risorse: 'interne' },
    });
    expect((screen.getByRole('checkbox', { name: DESCRITTIVO }) as HTMLInputElement).checked).toBe(true);
  });

  it('«Usa» del suggerimento sceglie il giudizio e non spegne il descrittivo', async () => {
    await montaEScegli();
    fireEvent.click(screen.getByRole('checkbox', { name: DESCRITTIVO }));
    fireEvent.change(screen.getByPlaceholderText('Es. 7.5'), { target: { value: '8' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Usa' }));
    expect((screen.getByLabelText('Giudizio sintetico') as HTMLSelectElement).value).toBe('Buono');
    expect((screen.getByRole('checkbox', { name: DESCRITTIVO }) as HTMLInputElement).checked).toBe(true);
  });

  it('modale: una voce storica per dimensioni SENZA giudizio lo chiede, poi la PATCH lo porta', async () => {
    valutazioni = [
      valutazione({
        modalita: 'dimensioni',
        giudizio_sintetico: null,
        giudizio_testo: 'Testo delle dimensioni',
        dim_autonomia: true,
        dim_continuita: true,
        dim_tipologia: 'nota',
        dim_risorse: 'interne',
      }),
    ];
    rispostaMutazione = { status: 200, corpo: { success: true } };
    await montaEScegli();
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la valutazione del 20/09/2026 (Le tabelline)' }));
    const dialogo = await screen.findByRole('dialog');
    const giudizio = within(dialogo).getByLabelText('Giudizio sintetico') as HTMLSelectElement;
    // Vuoto, non il primo della scala: niente «Ottimo» regalato a chi non l'ha scelto.
    expect(giudizio.value).toBe('');
    expect((within(dialogo).getByRole('checkbox', { name: DESCRITTIVO }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await within(dialogo).findByText('Scegli il giudizio sintetico: è il voto che vede la famiglia.')).toBeTruthy();
    expect(chiamate('PATCH', '/api/primaria/valutazioni')).toHaveLength(0);
    fireEvent.change(giudizio, { target: { value: 'Buono' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Valutazione modificata ✓')).toBeTruthy();
    expect(corpoDi(chiamate('PATCH', '/api/primaria/valutazioni')[0]!)).toMatchObject({
      modalita: 'dimensioni',
      giudizioSintetico: 'Buono',
      giudizioTesto: 'Testo delle dimensioni',
    });
  });
});


describe('nuova valutazione staff con competenza storica', () => {
  it('dal form condiviso parte la data scelta e il docente esplicito', async () => {
    ruolo = 'segreteria';
    await montaEScegli();
    await screen.findByRole('option', { name: 'Fittizia Ada' });
    fireEvent.change(campoDataModulo(), { target: { value: '2020-04-02' } });
    fireEvent.change(screen.getByLabelText('Docente titolare'), { target: { value: DOCENTE } });
    scegliGiudizio('Buono');
    fireEvent.change(screen.getByPlaceholderText('Es. Le tabelline del 7, La comprensione del testo…'), { target: { value: 'Argomento fittizio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/valutazioni')).toHaveLength(1));
    expect(corpoDi(chiamate('POST', '/api/primaria/valutazioni')[0]!)).toMatchObject({ data: '2020-04-02', docenteId: DOCENTE });
  });
  it('l’ordinamento usa la competenza anche per valutazioni inserite oggi', () => {
    const voci = unisciVociRecenti([valutazione({ data_evento: '2020-04-02', creato_il: '2026-10-15T10:00:00Z' })], [impreparato({ data: '2026-01-10' })]);
    expect(voci.map(v => v.giorno)).toEqual(['2026-01-10', '2020-04-02']);
  });
});


it('la modale staff può cambiare solo la data della valutazione', async () => {
  ruolo = 'segreteria';
  await montaEScegli();
  fireEvent.click(await screen.findByRole('button', { name: /^Modifica la valutazione/ }));
  const dialogo = await screen.findByRole('dialog');
  fireEvent.change(within(dialogo).getByLabelText('Data della prova'), { target: { value: '2020-04-02' } });
  fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
  await waitFor(() => expect(chiamate('PATCH', '/api/primaria/valutazioni')).toHaveLength(1));
  expect(corpoDi(chiamate('PATCH', '/api/primaria/valutazioni')[0]!)).toMatchObject({ data: '2020-04-02' });
});


/**
 * (j) LA DATA DELLA PROVA E LO STORICO DELL'ALUNNO NELLA MATERIA
 * (spec 2026-11-04, D1 · D15-D17).
 *
 * La docente registra oggi l'interrogazione di venerdì con la data di venerdì, poi apre lo
 * storico dell'alunno nella materia e vede ogni voto — il suo e quello della collega di prima —
 * in ordine di data, con chi l'ha messo. I voti della collega sono in sola lettura (nessun
 * Modifica/Elimina, anche se la GET li desse `modificabile`); l'appunto numerico resta
 * visibile. Filtri per tipo di prova e per quadrimestre (solo se la sede ha i periodi con le date).
 */
describe('(j) data della prova e storico', () => {
  const IO = { id: DOCENTE, nome: 'Ada', cognome: 'Fittizia' };
  const COLLEGA = { id: 'c0110000-0000-4000-8000-0000000000c1', nome: 'Bianca', cognome: 'Verdi' };
  const VAL_COLLEGA = 'v0000009-0000-4000-8000-000000000009';
  const VAL_SCRITTO = 'v0000002-0000-4000-8000-000000000002';
  const VAL_PRATICO = 'v0000003-0000-4000-8000-000000000003';
  const OGGI_ROMA = '2026-11-04';

  const periodo = (id: string, nome: string, ordine: number, data_inizio: string | null, data_fine: string | null): PeriodoScrutinio => ({
    id, scuola_id: SEDE_A, anno_scolastico: '2025/2026', nome, ordine, data_inizio, data_fine, attivo: true,
  });
  const P1 = periodo('p0000001-0000-4000-8000-000000000001', 'Primo quadrimestre', 1, '2025-09-01', '2026-01-31');
  const P2 = periodo('p0000002-0000-4000-8000-000000000002', 'Secondo quadrimestre', 2, '2026-02-01', '2026-06-30');

  /** I data-testid delle voci a schermo, nell'ordine. `query`: l'elenco può essere vuoto. */
  const vociASchermo = () =>
    screen.queryAllByTestId(/^voce-(valutazione|impreparato)-/).map((el) => el.getAttribute('data-testid'));

  beforeEach(() => {
    // 09:00 UTC del 4/11 = 10:00 a Roma: «oggi» è il 4 novembre. Solo Date è finto.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T09:00:00Z'));
  });

  async function salvaUnVoto() {
    fireEvent.change(screen.getByPlaceholderText('Es. Le tabelline del 7, La comprensione del testo…'), { target: { value: 'Le frazioni' } });
    scegliGiudizio('Buono');
    fireEvent.click(screen.getByRole('button', { name: 'Salva valutazione' }));
    await waitFor(() => expect(chiamate('POST', '/api/primaria/valutazioni')).toHaveLength(1));
    return corpoDi(chiamate('POST', '/api/primaria/valutazioni')[0]!);
  }

  describe('la data nel modulo', () => {
    it('la docente vede la data, già con oggi; la POST porta data e non docenteId', async () => {
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
      await montaEScegli();
      const campo = campoDataModulo();
      expect(campo.value).toBe(OGGI_ROMA);
      expect(campo.max).toBe(OGGI_ROMA);
      // La scelta del docente titolare è dello staff: alla docente non si offre.
      expect(screen.queryByLabelText('Docente titolare')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      fireEvent.change(campo, { target: { value: '2026-10-30' } });
      // Nemmeno per un giorno passato la docente vede l'avviso riservato allo staff.
      expect(screen.queryByText(/senza inviare avvisi alla famiglia/)).toBeNull();
      const corpo = await salvaUnVoto();
      expect(corpo).toMatchObject({ data: '2026-10-30', alunnoId: ALUNNO.id, materiaId: MATERIA });
      expect(corpo).not.toHaveProperty('docenteId');
    });

    it('senza toccare il campo, la POST porta la data di oggi a Roma', async () => {
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
      await montaEScegli();
      expect(await salvaUnVoto()).toMatchObject({ data: OGGI_ROMA });
    });

    it('la segreteria vede data e docente; la POST li porta tutti e due', async () => {
      ruolo = 'segreteria';
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
      await montaEScegli();
      // L'elenco dei docenti arriva solo a ruolo letto: è la PRESENZA che dice che lo staff è attivo.
      await screen.findByRole('option', { name: 'Fittizia Ada' });
      const campo = campoDataModulo();
      expect(campo.value).toBe(OGGI_ROMA);
      // Un campo data solo: quello di CompetenzaStorica è spento.
      expect(screen.queryByLabelText('Data di competenza')).toBeNull();
      fireEvent.change(campo, { target: { value: '2026-10-30' } });
      // L'avviso lo vede lo staff dove agisce: sul modulo del voto e sulla card dell'impreparato.
      const avvisi = screen.getAllByRole('status');
      expect(avvisi).toHaveLength(2);
      for (const avviso of avvisi) expect(avviso.textContent).toContain('senza inviare avvisi alla famiglia');
      expect(within(cardImpreparato()).getByRole('status').textContent).toContain('senza inviare avvisi alla famiglia');
      fireEvent.change(screen.getByLabelText('Docente titolare'), { target: { value: DOCENTE } });
      const corpo = await salvaUnVoto();
      expect(corpo).toMatchObject({ data: '2026-10-30', docenteId: DOCENTE });
    });

    it('l’impreparato parte con la stessa data scelta', async () => {
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuovo' } } };
      await montaEScegli();
      fireEvent.change(campoDataModulo(), { target: { value: '2026-10-30' } });
      fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
      expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
      const post = chiamate('POST', '/api/primaria/giustifiche-didattiche');
      expect(post).toHaveLength(1);
      expect(corpoDi(post[0]!)).toMatchObject({ data: '2026-10-30', alunnoId: ALUNNO.id, materiaId: MATERIA });
    });

    it('un rifiuto per la data (DATA_FUTURA) si mostra tradotto dal catalogo', async () => {
      rispostaMutazione = { status: 422, corpo: { error: 'Frase del server', codice: 'DATA_FUTURA' } };
      await montaEScegli();
      await salvaUnVoto();
      expect(await screen.findByText('La data non può essere nel futuro.')).toBeTruthy();
    });
  });

  /**
   * La card dell'impreparato non promette più «oggi»: registra la data del modulo, e il campo
   * è lì, dove si agisce (sul telefono il modulo del voto sta due card più su).
   */
  describe('la card «Segna un impreparato» mostra la data che parte', () => {
    it('titolo e spiegazione non dicono «oggi» né «valutazioni recenti»', async () => {
      await montaEScegli();
      expect(await screen.findByRole('heading', { name: 'Segna un impreparato' })).toBeTruthy();
      expect(screen.queryByText(/\(oggi\)/)).toBeNull();
      expect(within(cardImpreparato()).queryByText(/valutazioni recenti/i)).toBeNull();
      expect(within(cardImpreparato()).getByText(/Gli impreparati compaiono tra i voti dell’alunno/)).toBeTruthy();
    });

    it('il campo è quello del modulo: cambiandolo lì cambia anche il primo, e la POST dell’impreparato lo porta', async () => {
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuovo' } } };
      await montaEScegli();
      // Parte con la data del modulo (oggi), con lo stesso massimo.
      expect(campoDataImpreparato().value).toBe(OGGI_ROMA);
      expect(campoDataImpreparato().max).toBe(OGGI_ROMA);
      // Scelta nel modulo del voto → si vede nella card.
      fireEvent.change(campoDataModulo(), { target: { value: '2026-10-30' } });
      expect(campoDataImpreparato().value).toBe('2026-10-30');
      // Scelta nella card → si vede nel modulo, e la POST la porta.
      fireEvent.change(campoDataImpreparato(), { target: { value: '2026-10-28' } });
      expect(campoDataModulo().value).toBe('2026-10-28');
      fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
      expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
      expect(corpoDi(chiamate('POST', '/api/primaria/giustifiche-didattiche')[0]!)).toMatchObject({ data: '2026-10-28' });
    });

    it('la docente non vede l’avviso alla famiglia nemmeno sulla card, per un giorno passato', async () => {
      await montaEScegli();
      fireEvent.change(campoDataImpreparato(), { target: { value: '2026-10-28' } });
      expect(campoDataModulo().value).toBe('2026-10-28');
      expect(within(cardImpreparato()).queryByRole('status')).toBeNull();
    });
  });

  /**
   * La data proposta è «oggi» finché nessuno la sceglie: non quella del montaggio. Una pagina
   * aperta la sera e usata dopo la mezzanotte (o l'app riaperta dal background il mattino dopo)
   * non deve salvare sul giorno prima — il 31/1 → 1/2 sarebbe il quadrimestre sbagliato.
   * Orologio: 22:50 UTC del 4/11 = 23:50 a Roma; 23:10 UTC = 00:10 del 5/11.
   */
  describe('la data non resta ferma a ieri', () => {
    const PRIMA_DELLA_MEZZANOTTE = '2026-11-04T22:50:00Z';
    const DOPO_LA_MEZZANOTTE = '2026-11-04T23:10:00Z';

    beforeEach(() => {
      vi.setSystemTime(new Date(PRIMA_DELLA_MEZZANOTTE));
      rispostaMutazione = { status: 201, corpo: { success: true, data: { id: 'nuova' } } };
    });

    it('montata il 4/11 alle 23:50, salvata il 5/11 alle 00:10: la POST del voto porta il 5/11', async () => {
      await montaEScegli();
      expect(campoDataModulo().value).toBe('2026-11-04');
      vi.setSystemTime(new Date(DOPO_LA_MEZZANOTTE));
      expect(await salvaUnVoto()).toMatchObject({ data: '2026-11-05' });
      // Salvando, anche il campo si allinea a ciò che è partito: a schermo non resta «ieri».
      expect(campoDataModulo().value).toBe('2026-11-05');
    });

    it('lo stesso per l’impreparato', async () => {
      await montaEScegli();
      vi.setSystemTime(new Date(DOPO_LA_MEZZANOTTE));
      fireEvent.click(screen.getByRole('button', { name: 'Segna impreparato' }));
      expect(await screen.findByText('Impreparato segnato ✓')).toBeTruthy();
      expect(corpoDi(chiamate('POST', '/api/primaria/giustifiche-didattiche')[0]!)).toMatchObject({ data: '2026-11-05' });
    });

    it('data scelta a mano e poi mezzanotte passata: resta quella scelta, anche cambiando alunno', async () => {
      await montaEScegli();
      fireEvent.change(campoDataModulo(), { target: { value: '2026-10-30' } });
      vi.setSystemTime(new Date(DOPO_LA_MEZZANOTTE));
      fireEvent(document, new Event('visibilitychange'));
      fireEvent(window, new Event('focus'));
      expect(campoDataModulo().value).toBe('2026-10-30');
      // Cambiare alunno non azzera la scelta: la data vale per la sessione di lavoro.
      fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: ALUNNO_B.id } });
      await waitFor(() => expect(vociASchermo().length).toBeGreaterThan(0));
      expect(campoDataModulo().value).toBe('2026-10-30');
      expect(await salvaUnVoto()).toMatchObject({ data: '2026-10-30' });
    });

    it('visibilitychange dopo la mezzanotte: il campo mostra il giorno nuovo (in tutti e due i punti)', async () => {
      await montaEScegli();
      expect(campoDataImpreparato().value).toBe('2026-11-04');
      vi.setSystemTime(new Date(DOPO_LA_MEZZANOTTE));
      // Finché nessun evento lo dice, a schermo resta il giorno del montaggio.
      expect(campoDataModulo().value).toBe('2026-11-04');
      fireEvent(document, new Event('visibilitychange'));
      expect(campoDataModulo().value).toBe('2026-11-05');
      expect(campoDataImpreparato().value).toBe('2026-11-05');
      expect(campoDataModulo().max).toBe('2026-11-05');
    });

    it('anche il focus della finestra riallinea il campo', async () => {
      await montaEScegli();
      vi.setSystemTime(new Date(DOPO_LA_MEZZANOTTE));
      fireEvent(window, new Event('focus'));
      expect(campoDataModulo().value).toBe('2026-11-05');
    });

    it('uscendo dalla pagina gli ascoltatori vengono tolti', async () => {
      const daDocument = vi.spyOn(document, 'removeEventListener');
      const daWindow = vi.spyOn(window, 'removeEventListener');
      const { unmount } = render(<ValutazioniPage />);
      await screen.findByRole('option', { name: 'Rossi Mario' });
      const ascoltatore = (spia: typeof daDocument, evento: string) =>
        spia.mock.calls.filter(([e]) => e === evento).length;
      const prima = { visibilita: ascoltatore(daDocument, 'visibilitychange'), focus: ascoltatore(daWindow, 'focus') };
      unmount();
      expect(ascoltatore(daDocument, 'visibilitychange')).toBeGreaterThan(prima.visibilita);
      expect(ascoltatore(daWindow, 'focus')).toBeGreaterThan(prima.focus);
      daDocument.mockRestore();
      daWindow.mockRestore();
    });
  });

  describe('lo storico: titolo, autore, sola lettura', () => {
    it('titolo «Tutti i voti di <alunno> in <materia>»', async () => {
      await montaEScegli();
      expect(await screen.findByRole('heading', { name: 'Tutti i voti di Mario Rossi in Matematica' })).toBeTruthy();
      // Il vecchio titolo non c'è più.
      expect(screen.queryByText('Valutazioni recenti')).toBeNull();
    });

    it('senza alunno e materia non c’è titolo, solo l’invito a sceglierli', async () => {
      render(<ValutazioniPage />);
      await screen.findByRole('option', { name: 'Rossi Mario' });
      expect(screen.getByText('Seleziona alunno e materia.')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: /^Tutti i voti di/ })).toBeNull();
    });

    it('voto della collega: niente Modifica né Elimina, l’appunto numerico si vede, c’è «Messo da»', async () => {
      valutazioni = [
        // `modificabile: true` di proposito: la regola D17 della pagina vale anche se la GET sbagliasse.
        valutazione({ id: VAL_COLLEGA, maestra_id: COLLEGA.id, propria: false, autore: COLLEGA, annotazione_numerica: 7.5, argomento: 'Le frazioni', creato_il: '2026-09-21T08:00:00Z', modificabile: true }),
        valutazione({ propria: true, autore: IO }),
      ];
      impreparati = [];
      await montaEScegli();
      const collega = screen.getByTestId(`voce-valutazione-${VAL_COLLEGA}`);
      expect(within(collega).getByText('Messo da Bianca Verdi')).toBeTruthy();
      expect(within(collega).getByText('✎ 7,5')).toBeTruthy();
      expect(within(collega).queryByRole('button')).toBeNull();
      const mia = screen.getByTestId(`voce-valutazione-${VAL_ID}`);
      expect(within(mia).getByText('Messo da Ada Fittizia')).toBeTruthy();
      expect(within(mia).getByRole('button', { name: /^Modifica la valutazione/ })).toBeTruthy();
      expect(within(mia).getByRole('button', { name: /^Elimina la valutazione/ })).toBeTruthy();
    });

    it('lo staff vede Modifica ed Elimina anche sul voto della collega', async () => {
      ruolo = 'segreteria';
      valutazioni = [valutazione({ maestra_id: COLLEGA.id, propria: false, autore: COLLEGA })];
      impreparati = [];
      await montaEScegli();
      const riga = screen.getByTestId(`voce-valutazione-${VAL_ID}`);
      // Il ruolo arriva da /me, un giro dopo la lista: findBy, non getBy.
      expect(await within(riga).findByRole('button', { name: /^Modifica la valutazione/ })).toBeTruthy();
      expect(within(riga).getByRole('button', { name: /^Elimina la valutazione/ })).toBeTruthy();
      expect(within(riga).getByText('Messo da Bianca Verdi')).toBeTruthy();
    });

    it('impreparati: quello della collega è di sola lettura, quello del genitore resta azionabile', async () => {
      valutazioni = [valutazione({ propria: true, autore: IO })];
      impreparati = [
        impreparato({ propria: false, autore: COLLEGA }),
        impreparato({ id: IMP_GEN, materia_id: null, data: '2026-09-18', origine: 'genitore', tipo: 'giustificato', motivo: 'Febbre', creato_il: '2026-09-17T18:00:00Z', propria: false, autore: null }),
      ];
      await montaEScegli();
      const collega = screen.getByTestId(`voce-impreparato-${IMP_DOC}`);
      expect(within(collega).getByText('Messo da Bianca Verdi')).toBeTruthy();
      expect(within(collega).queryByRole('button')).toBeNull();
      const genitore = screen.getByTestId(`voce-impreparato-${IMP_GEN}`);
      expect(within(genitore).getByRole('button', { name: /^Modifica l’impreparato/ })).toBeTruthy();
      expect(within(genitore).getByRole('button', { name: /^Elimina l’impreparato/ })).toBeTruthy();
      expect(within(genitore).queryByText(/^Messo da/)).toBeNull();
    });
  });

  describe('voto congelato', () => {
    beforeEach(() => {
      valutazioni = [valutazione({ modificabile: false, bloccata: true, congelata: true, giorniLimite: 2, propria: true, autore: IO })];
    });

    it('alla docente: il messaggio dello scrutinio chiuso al posto di «bloccata», niente bottoni', async () => {
      await montaEScegli();
      const riga = screen.getByTestId(`voce-bloccata-${VAL_ID}`);
      expect(riga.textContent).toContain('Scrutinio chiuso: per modificarlo serve lo sblocco della Direzione.');
      expect(riga.textContent).not.toContain('Bloccata: superato il termine');
      expect(screen.queryByRole('button', { name: /Modifica la valutazione/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Sblocca/ })).toBeNull();
    });

    it('alla Direzione: lo stesso messaggio, e «Sblocca» resta', async () => {
      ruolo = 'admin';
      await montaEScegli();
      expect(await screen.findByRole('button', { name: 'Sblocca la valutazione del 20/09/2026 (Le tabelline)' })).toBeTruthy();
      expect(screen.getByTestId(`voce-bloccata-${VAL_ID}`).textContent).toContain('Scrutinio chiuso');
    });
  });

  describe('Modifica del proprio voto e data', () => {
    beforeEach(() => {
      valutazioni = [valutazione({ propria: true, autore: IO })];
    });

    async function apriModificaVoto() {
      await montaEScegli();
      fireEvent.click(screen.getByRole('button', { name: 'Modifica la valutazione del 20/09/2026 (Le tabelline)' }));
      return screen.findByRole('dialog');
    }

    it('modifica del proprio voto: la docente vede il campo data e la PATCH porta data solo se cambiata', async () => {
      const dialogo = await apriModificaVoto();
      const campo = within(dialogo).getByLabelText('Data della prova') as HTMLInputElement;
      expect(campo.value).toBe('2026-09-20');
      expect(campo.max).toBe(OGGI_ROMA);
      // Cambia solo il giudizio: la data non parte.
      fireEvent.change(within(dialogo).getByLabelText('Giudizio sintetico'), { target: { value: 'Ottimo' } });
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
      expect(await screen.findByText('Valutazione modificata ✓')).toBeTruthy();
      const corpo = corpoDi(chiamate('PATCH', '/api/primaria/valutazioni')[0]!);
      expect(corpo).toMatchObject({ id: VAL_ID, giudizioSintetico: 'Ottimo' });
      expect(corpo).not.toHaveProperty('data');
    });

    it('cambiando SOLO la data, la PATCH parte con la data (e basta quella)', async () => {
      const dialogo = await apriModificaVoto();
      fireEvent.change(within(dialogo).getByLabelText('Data della prova'), { target: { value: '2026-09-18' } });
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
      expect(await screen.findByText('Valutazione modificata ✓')).toBeTruthy();
      const patch = chiamate('PATCH', '/api/primaria/valutazioni');
      expect(patch).toHaveLength(1);
      expect(corpoDi(patch[0]!)).toMatchObject({ id: VAL_ID, data: '2026-09-18' });
    });

    it('senza cambi non parte niente', async () => {
      const dialogo = await apriModificaVoto();
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
      expect(await within(dialogo).findByText('Non hai cambiato niente.')).toBeTruthy();
      expect(chiamate('PATCH', '/api/primaria/valutazioni')).toHaveLength(0);
    });

    it('un rifiuto per il quadrimestre chiuso (423) si mostra tradotto, sopra l’elenco', async () => {
      rispostaMutazione = { status: 423, corpo: { error: 'Frase del server', codice: 'QUADRIMESTRE_CHIUSO' } };
      const dialogo = await apriModificaVoto();
      fireEvent.change(within(dialogo).getByLabelText('Data della prova'), { target: { value: '2025-10-01' } });
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }));
      const avviso = await screen.findByRole('alert');
      expect(avviso.textContent).toContain('Lo scrutinio del quadrimestre di questa data è chiuso');
    });

    it('la data dell’impreparato in modifica non supera oggi', async () => {
      await montaEScegli();
      fireEvent.click(screen.getByRole('button', { name: 'Modifica l’impreparato del 22/09/2026' }));
      const dialogo = await screen.findByRole('dialog');
      expect((within(dialogo).getByLabelText('Data') as HTMLInputElement).max).toBe(OGGI_ROMA);
    });
  });

  describe('filtri', () => {
    beforeEach(() => {
      valutazioni = [
        valutazione({ id: VAL_ID, tipo: 'orale', data_evento: '2026-09-20' }),
        valutazione({ id: VAL_SCRITTO, tipo: 'scritto', data_evento: '2026-09-19', creato_il: '2026-09-19T08:00:00Z' }),
        valutazione({ id: VAL_PRATICO, tipo: 'pratico', data_evento: '2026-09-17', creato_il: '2026-09-17T08:00:00Z' }),
      ];
    });

    it('filtro per tipo: solo gli scritti', async () => {
      await montaEScegli();
      const tipo = await screen.findByRole('combobox', { name: 'Tipo di prova' });
      expect(vociASchermo()).toHaveLength(5);
      fireEvent.change(tipo, { target: { value: 'scritto' } });
      expect(vociASchermo()).toEqual([`voce-valutazione-${VAL_SCRITTO}`]);
      fireEvent.change(tipo, { target: { value: 'impreparato' } });
      expect(vociASchermo()).toEqual([`voce-impreparato-${IMP_DOC}`, `voce-impreparato-${IMP_GEN}`]);
      fireEvent.change(tipo, { target: { value: 'tutti' } });
      expect(vociASchermo()).toHaveLength(5);
    });

    it('il filtro per tipo offre «Tutti», i tre tipi della prova e gli impreparati', async () => {
      await montaEScegli();
      const tipo = await screen.findByRole('combobox', { name: 'Tipo di prova' });
      expect(within(tipo).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tutti', 'Orale', 'Scritto', 'Pratico', 'Impreparati']);
    });

    it('un filtro che non lascia niente lo dice, e non nasconde i filtri', async () => {
      valutazioni = [valutazione({ id: VAL_ID, tipo: 'orale', data_evento: '2026-09-20' })];
      await montaEScegli();
      const tipo = await screen.findByRole('combobox', { name: 'Tipo di prova' });
      fireEvent.change(tipo, { target: { value: 'pratico' } });
      expect(screen.getByText('Nessuna valutazione.')).toBeTruthy();
      expect(vociASchermo()).toEqual([]);
      expect(screen.getByRole('combobox', { name: 'Tipo di prova' })).toBeTruthy();
    });

    it('cambiando alunno il filtro torna su «Tutti»', async () => {
      await montaEScegli();
      fireEvent.change(await screen.findByRole('combobox', { name: 'Tipo di prova' }), { target: { value: 'scritto' } });
      expect(vociASchermo()).toHaveLength(1);
      fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: ALUNNO_B.id } });
      // PRESENZA prima: le voci del secondo alunno sono tornate tutte.
      await waitFor(() => expect(vociASchermo()).toHaveLength(5));
      expect((screen.getByRole('combobox', { name: 'Tipo di prova' }) as HTMLSelectElement).value).toBe('tutti');
    });

    it('filtro quadrimestre: assente con periodi vuoti', async () => {
      periodiSede = [];
      await montaEScegli();
      // PRESENZA prima (il filtro per tipo c'è, quindi l'elenco è stato letto), poi l'assenza.
      expect(await screen.findByRole('combobox', { name: 'Tipo di prova' })).toBeTruthy();
      expect(screen.queryByRole('combobox', { name: 'Quadrimestre' })).toBeNull();
    });

    it('filtro quadrimestre: presente e funzionante con due periodi', async () => {
      periodiSede = [P1, P2];
      valutazioni = [
        valutazione({ id: VAL_ID, tipo: 'orale', data_evento: '2025-10-10' }),
        valutazione({ id: VAL_SCRITTO, tipo: 'scritto', data_evento: '2026-03-05', creato_il: '2026-03-05T09:00:00Z' }),
      ];
      impreparati = [impreparato({ data: '2026-03-10' })];
      await montaEScegli();
      const quadrimestre = await screen.findByRole('combobox', { name: 'Quadrimestre' });
      expect(within(quadrimestre).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tutti', 'Primo quadrimestre', 'Secondo quadrimestre']);
      expect(vociASchermo()).toHaveLength(3);
      fireEvent.change(quadrimestre, { target: { value: P1.id } });
      expect(vociASchermo()).toEqual([`voce-valutazione-${VAL_ID}`]);
      // L'impreparato (10/3) cade nel secondo periodo: il filtro vale anche per lui.
      fireEvent.change(quadrimestre, { target: { value: P2.id } });
      expect(vociASchermo()).toEqual([`voce-impreparato-${IMP_DOC}`, `voce-valutazione-${VAL_SCRITTO}`]);
      // Insieme al tipo.
      fireEvent.change(screen.getByRole('combobox', { name: 'Tipo di prova' }), { target: { value: 'scritto' } });
      expect(vociASchermo()).toEqual([`voce-valutazione-${VAL_SCRITTO}`]);
      fireEvent.change(quadrimestre, { target: { value: '' } });
      expect(vociASchermo()).toEqual([`voce-valutazione-${VAL_SCRITTO}`]);
    });
  });

  describe('filtraVociRecenti (puro)', () => {
    const voci = () => unisciVociRecenti(
      [
        valutazione({ id: 'a', tipo: 'orale', data_evento: '2025-10-10' }),
        valutazione({ id: 'b', tipo: 'scritto', data_evento: '2025-12-05' }),
        valutazione({ id: 'c', tipo: 'scritto', data_evento: '2026-03-05' }),
      ],
      [impreparato({ id: 'i', data: '2026-03-10' })],
    );
    const ids = (v: readonly VoceRecente[]) => v.map((x) => x.voce.id);
    const periodi = [P1, P2];

    it('senza filtri restituisce tutte le voci, nello stesso ordine', () => {
      expect(ids(filtraVociRecenti(voci(), { tipo: 'tutti', periodoId: null }, periodi))).toEqual(['i', 'c', 'b', 'a']);
    });

    it('per tipo', () => {
      expect(ids(filtraVociRecenti(voci(), { tipo: 'scritto', periodoId: null }, periodi))).toEqual(['c', 'b']);
      expect(ids(filtraVociRecenti(voci(), { tipo: 'orale', periodoId: null }, periodi))).toEqual(['a']);
      expect(ids(filtraVociRecenti(voci(), { tipo: 'pratico', periodoId: null }, periodi))).toEqual([]);
      expect(ids(filtraVociRecenti(voci(), { tipo: 'impreparato', periodoId: null }, periodi))).toEqual(['i']);
    });

    it('per periodo (il giorno della voce, non il momento in cui è stata scritta)', () => {
      expect(ids(filtraVociRecenti(voci(), { tipo: 'tutti', periodoId: P1.id }, periodi))).toEqual(['b', 'a']);
      expect(ids(filtraVociRecenti(voci(), { tipo: 'tutti', periodoId: P2.id }, periodi))).toEqual(['i', 'c']);
    });

    it('tipo e periodo insieme; un periodo sconosciuto non copre niente', () => {
      expect(ids(filtraVociRecenti(voci(), { tipo: 'scritto', periodoId: P2.id }, periodi))).toEqual(['c']);
      expect(ids(filtraVociRecenti(voci(), { tipo: 'tutti', periodoId: P1.id }, []))).toEqual([]);
    });

    it('non muta l’elenco ricevuto', () => {
      const elenco = voci();
      filtraVociRecenti(elenco, { tipo: 'scritto', periodoId: P1.id }, periodi);
      expect(ids(elenco)).toEqual(['i', 'c', 'b', 'a']);
    });
  });
});
