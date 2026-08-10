import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CausaliPanel, CausaliFatturaPanel } from '@/components/features/admin/pagamenti/CausaliPanel';
import { DEFAULT_CAUSALE_TEMPLATE, PLACEHOLDER_CAUSALE } from '@/lib/pagamenti/causale';
import { DEFAULT_CAUSALE_FATTURA_TEMPLATE, LIMITE_CAUSALE_FATTURAPA } from '@/lib/pagamenti/causale-fattura';
import { buildFatturaElettronicaXml } from '@/lib/aruba/fatturapa-xml';

/**
 * L’editor delle causali della FATTURA: la stessa cosa del pannello del bonifico,
 * su un’altra colonna. Il difetto che chiude: `admin_settings.fattura_causale_template`
 * era un campo unico per tutta la scuola, mostrato dall’interfaccia e SCARTATO
 * dall’emissione — chi lo compilava non otteneva niente. Il campo è stato TOLTO
 * (`SettingsPanel` + `ALLOWED_FIELDS`): finché restava a schermo, questo pannello non
 * chiudeva niente, aggiungeva una seconda verità.
 *
 * Il CF dell’anteprima è SINTETICO (vive in `DATI_ESEMPIO`, dentro il componente):
 * mai un codice fiscale reale di un minore, il repository è pubblico. «Sintetico» ha un
 * metro misurabile, ed è sotto forma di test in fondo a questo file.
 */
type Patched = Record<string, Record<string, string> | string | undefined>;

/**
 * L’avviso di lunghezza, cercato per FRAMMENTO e senza apostrofi tipografici: ricopiare
 * il testo del glossario dentro un test lo rende rosso al primo ’ cambiato in ' (lezione
 * già pagata su `glossario-sede`).
 */
const AVVISO_LIMITE = /Troppo lunga già con i dati/;

/** La riga del conteggio, che dichiara su quali dati è stato misurato. */
const CONTEGGIO_SU_ESEMPIO = /caratteri, misurati sui dati/;

interface OpzioniMock {
  /** Il JSONB già in archivio per la colonna delle FATTURE. */
  fattura?: Record<string, string>;
  /** Il JSONB già in archivio per la colonna dei BONIFICI. */
  bonifico?: Record<string, string>;
  /** `false` simula il DB E2E della CI: la colonna recente non esiste ancora. */
  colonnaFatturaPresente?: boolean;
  /** La GET delle impostazioni fallisce (rete giù): il salvato NON è noto. */
  impostazioniKo?: boolean;
  /** La GET delle categorie fallisce: l'elenco delle righe NON è noto. */
  categorieKo?: boolean;
}

function mockFetch(patched: Patched[], opz: OpzioniMock = {}) {
  const {
    fattura = {}, bonifico = {}, colonnaFatturaPresente = true,
    impostazioniKo = false, categorieKo = false,
  } = opz;
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/admin/settings/categorie')) {
      if (categorieKo) throw new Error('rete');
      return { ok: true, json: async () => ({ success: true, data: [
        { id: 'c1', nome: 'Gita', slug: 'gita', icona: '🎒', is_sistema: false, ordine: 1 },
        { id: 'c2', nome: 'Mensa', slug: 'mensa', icona: '🍝', is_sistema: true, ordine: 2 },
      ] }) };
    }
    if (impostazioniKo && init?.method !== 'PATCH' && u.startsWith('/api/admin/settings')) {
      throw new Error('rete');
    }
    if (init?.method === 'PATCH' && u.startsWith('/api/admin/settings')) {
      patched.push(JSON.parse(String(init.body)) as Patched);
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    }
    if (u.startsWith('/api/admin/settings')) {
      const data: Record<string, unknown> = { causali_config: bonifico };
      if (colonnaFatturaPresente) data.fattura_causali_config = fattura;
      return { ok: true, json: async () => ({ success: true, data }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('CausaliFatturaPanel — un modello di causale per ogni tipologia di pagamento', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('apre col modello di fabbrica delle FATTURE e una riga per categoria', async () => {
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(screen.getByLabelText('Predefinito')).toBeInTheDocument());
    expect((screen.getByLabelText('Predefinito') as HTMLInputElement).value).toBe(DEFAULT_CAUSALE_FATTURA_TEMPLATE);
    // …che NON è quello del bonifico: sono due documenti diversi.
    expect(DEFAULT_CAUSALE_FATTURA_TEMPLATE).not.toBe(DEFAULT_CAUSALE_TEMPLATE);
    expect(screen.getByLabelText(/Gita/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mensa/)).toBeInTheDocument();
    expect((screen.getByLabelText(/Mensa/) as HTMLInputElement).value).toBe('');
  });

  it('l’anteprima mostra «a favore del minore», col genere letto dal codice fiscale', async () => {
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    // Una per riga: le categorie vuote mostrano l’anteprima del «Predefinito» vivo,
    // cioè quella che il server userà davvero per loro.
    expect(screen.getAllByText(/a favore del minore Mario Rossi/).length).toBeGreaterThan(0);
  });

  it('legge la configurazione GIÀ SALVATA dalla colonna delle fatture', async () => {
    vi.stubGlobal('fetch', mockFetch(patched, {
      fattura: { default: 'FATTURA {descrizione}', gita: 'Uscita didattica {descrizione}' },
      bonifico: { default: 'BONIFICO {descrizione}' },
    }));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect((screen.getByLabelText('Predefinito') as HTMLInputElement).value).toBe('FATTURA {descrizione}'));
    expect((screen.getByLabelText(/Gita/) as HTMLInputElement).value).toBe('Uscita didattica {descrizione}');
  });

  it('salva su `fattura_causali_config`, MAI su quella del bonifico', async () => {
    // È il punto di tutto il lavoro: due configurazioni indipendenti. Scrivere sulla
    // chiave sbagliata cambierebbe la causale che il genitore ricopia nel bonifico.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Uscita didattica {descrizione}' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    await waitFor(() => expect(patched).toHaveLength(1));
    const corpo = patched[0];
    expect(corpo.fattura_causali_config).toBeDefined();
    expect(corpo.causali_config).toBeUndefined();
    expect((corpo.fattura_causali_config as Record<string, string>).gita).toBe('Uscita didattica {descrizione}');
    expect((corpo.fattura_causali_config as Record<string, string>).default).toBe(DEFAULT_CAUSALE_FATTURA_TEMPLATE);
    // riga vuota → inviata come '' così il server la rimuove e torna al Predefinito
    expect((corpo.fattura_causali_config as Record<string, string>).mensa).toBe('');
    expect(corpo.scuola_id).toBe('sc-1');
  });

  it('la colonna assente (DB E2E della CI) non rompe il pannello: si apre sul modello di fabbrica', async () => {
    vi.stubGlobal('fetch', mockFetch(patched, { colonnaFatturaPresente: false }));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect((screen.getByLabelText('Predefinito') as HTMLInputElement).value).toBe(DEFAULT_CAUSALE_FATTURA_TEMPLATE));
  });

  it('AVVISA quando la causale resa supera i 200 caratteri del campo 2.1.1.11', async () => {
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;

    // Sotto il limite: nessun avviso, ma il conteggio si vede lo stesso.
    fireEvent.change(campo, { target: { value: 'x'.repeat(LIMITE_CAUSALE_FATTURAPA) } });
    await waitFor(() => expect(screen.getByText(new RegExp('x{200}'))).toBeInTheDocument());
    expect(screen.queryByText(AVVISO_LIMITE)).toBeNull();
    expect(screen.getByText('200/200')).toBeInTheDocument();

    // Un carattere oltre: l’avviso compare, col conto esatto.
    fireEvent.change(campo, { target: { value: 'x'.repeat(LIMITE_CAUSALE_FATTURAPA + 10) } });
    await waitFor(() => expect(screen.getByText(AVVISO_LIMITE)).toBeInTheDocument());
    expect(screen.getByText('210/200')).toBeInTheDocument();
  });

  it('il limite si misura sulla causale RESA, non sul modello scritto', async () => {
    // `{descrizione}` sono 13 caratteri sullo schermo: se il pannello contasse quelli,
    // avviserebbe sempre troppo tardi. Qui il modello è corto e l’anteprima lunga.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    const modello = `${'y'.repeat(180)} {descrizione}`;
    expect(modello.length).toBe(194); // sotto il limite: 180 + spazio + «{descrizione}»
    fireEvent.change(campo, { target: { value: modello } });
    // …e sopra una volta reso: 180 + spazio + «Retta Settembre 2026» (20) = 201
    await waitFor(() => expect(screen.getByText(AVVISO_LIMITE)).toBeInTheDocument());
    expect(screen.getByText('201/200')).toBeInTheDocument();
  });

  it('il pannello del BONIFICO non avvisa mai sulla lunghezza (limite solo fiscale)', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'z'.repeat(400) } });
    await waitFor(() => expect(screen.getByText(new RegExp('z{400}'))).toBeInTheDocument());
    expect(screen.queryByText(AVVISO_LIMITE)).toBeNull();
    // …e nemmeno il conteggio: una causale di bonifico non ha un limite che valga
    // la pena mostrare, e un contatore senza limite è solo rumore.
    expect(screen.queryByText(CONTEGGIO_SU_ESEMPIO)).toBeNull();
  });

  it('il conteggio è SEMPRE a schermo, e DICHIARA di essere misurato sui dati d’esempio', async () => {
    // È la correzione di una promessa più grande della misura: «il limite si vede
    // mentre si scrive» valeva solo per l’esempio corto («Retta Settembre 2026», 20
    // caratteri). Con una descrizione reale il doppio più lunga, o col suffisso
    // « - quota <genitore>» che l’emissione aggiunge alle quote dei genitori separati,
    // un modello dato per 190/200 sfora. Il conteggio ora si vede sempre — così il
    // margine è leggibile — e il testo dice su cosa è stato misurato.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    const anteprima = screen.getAllByText(/a favore del minore Mario Rossi/)[0].textContent ?? '';
    expect(anteprima.length).toBeLessThan(LIMITE_CAUSALE_FATTURAPA); // molto sotto: nessun avviso
    expect(screen.queryByText(AVVISO_LIMITE)).toBeNull();
    expect(screen.getAllByText(`${anteprima.length}/${LIMITE_CAUSALE_FATTURAPA}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(CONTEGGIO_SU_ESEMPIO).length).toBeGreaterThan(0);
  });
});

/**
 * IL CONTEGGIO SI FA SULLA STRINGA CHE FINISCE NEL DOCUMENTO, non su quella resa.
 *
 * Difetto misurato il 2026-08-10: il pannello contava `anteprima.length`, ma `<Causale>`
 * riceve `testoLatin(causale, 200)` — che prima TRANSLITTERA e poi tronca. `€` diventa
 * `EUR` (1→3), e `€ 150,00` è l'esempio del chip `{importo}`, cioè un chip di questo
 * stesso pannello. Un modello di 200 caratteri con l'importo in coda mostrava «200/200»
 * in nero, nessun avviso, e usciva a stampa mozzato a «EUR 150,» su un documento
 * fiscale che si corregge solo con una nota di variazione. Il gate del log
 * (`causale-troncata`) misurava lo stesso sbaglio, quindi il taglio era anche muto.
 */
describe('il conteggio del pannello e il documento vero dicono la stessa cosa', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** La fattura tipo, con dati SINTETICI, per leggere cosa finisce in `<Causale>`. */
  function causaleNelDocumento(causale: string): string {
    const xml = buildFatturaElettronicaXml({
      progressivoInvio: '00001',
      numero: 'Asilo 1/2026',
      data: '2026-09-30',
      cedente: {
        piva: '03394870616',
        codiceFiscale: '03394870616',
        denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
        regimeFiscale: 'RF01',
        sede: { indirizzo: 'Via Silvio Pellico 7', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
      },
      cessionario: {
        codiceFiscale: 'XXXYYY20A15Z999X',
        nome: 'Mario',
        cognome: 'Rossi',
        sede: { indirizzo: 'Via delle Prove 12', cap: '81030', comune: 'Cesa', provincia: 'CE', nazione: 'IT' },
      },
      righe: [{ descrizione: 'Retta di frequenza', quantita: 1, prezzoUnitario: 150 }],
      causale,
    });
    return xml.match(/<Causale>([\s\S]*?)<\/Causale>/)?.[1] ?? '';
  }

  it('un modello di 200 caratteri col chip {importo} AVVISA, perché nel tracciato sono 202', async () => {
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    const modello = `${'y'.repeat(191)} {importo}`;
    // La causale RESA è lunga esattamente 200: contando questa, «sta dentro».
    const resa = `${'y'.repeat(191)} € 150,00`;
    expect(resa.length).toBe(LIMITE_CAUSALE_FATTURAPA);

    fireEvent.change(campo, { target: { value: modello } });
    await waitFor(() => expect(screen.getByText(AVVISO_LIMITE)).toBeInTheDocument());
    expect(screen.getByText('202/200')).toBeInTheDocument();

    // L'anteprima mostra il testo COM'È SCRITTO NEL DOCUMENTO (€ → EUR), e il
    // conteggio è la lunghezza di ciò che si vede: una misura sola.
    const anteprima = screen.getByText(new RegExp('y{191} EUR 150,00')).textContent ?? '';
    expect(anteprima.length).toBe(202);
    // …e la prova che non è un'opinione del pannello: il documento contiene i primi
    // 200 caratteri di quell'anteprima, cioè l'importo tagliato a metà.
    expect(causaleNelDocumento(resa)).toBe(anteprima.slice(0, LIMITE_CAUSALE_FATTURAPA));
    expect(causaleNelDocumento(resa).endsWith('EUR 150,')).toBe(true);
  });

  it('e quando il pannello NON avvisa, il documento non perde un carattere', async () => {
    // L'altra metà dell'equivalenza: senza questo caso basterebbe un pannello che
    // avvisa sempre. 196 «y» + spazio + «€» → 200 esatti nel tracciato.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: `${'y'.repeat(196)} €` } });
    await waitFor(() => expect(screen.getByText('200/200')).toBeInTheDocument());
    expect(screen.queryByText(AVVISO_LIMITE)).toBeNull();
    expect(causaleNelDocumento(`${'y'.repeat(196)} €`)).toBe(`${'y'.repeat(196)} EUR`);
  });
});

describe('la misura è leggibile anche da chi non vede lo schermo', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('il campo DICHIARA il proprio conteggio e il proprio avviso (aria-describedby)', async () => {
    // Senza il legame, chi naviga da tastiera con uno screen reader sente l'etichetta
    // («Predefinito») e nient'altro: la misura che è il senso del pannello resta
    // invisibile proprio a chi non può vederla.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText('Predefinito')) as HTMLInputElement;
    const ids = (campo.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids).toHaveLength(2);
    const descrittori = ids.map((id) => document.getElementById(id));
    expect(descrittori.every((el) => el !== null)).toBe(true); // nessun id penzolante
    expect(descrittori[0]?.textContent ?? '').toMatch(/\/200/);
  });

  it('il live region ESISTE PRIMA di avere qualcosa da dire, e si riempie senza rinascere', async () => {
    // Un `role="status"` inserito nel DOM INSIEME al suo testo spesso non viene
    // annunciato (NVDA/JAWS osservano le mutazioni dei live region già presenti).
    // Fino al 2026-08-10 il paragrafo era montato col contenuto dentro: il commento
    // prometteva «annuncia una volta sola» e non annunciava affatto.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    const idAvviso = (campo.getAttribute('aria-describedby') ?? '').split(' ')[1];
    const avviso = document.getElementById(idAvviso);
    expect(avviso?.getAttribute('role')).toBe('status');
    expect(avviso?.textContent).toBe(''); // presente e vuoto, prima dell'avviso

    fireEvent.change(campo, { target: { value: 'x'.repeat(LIMITE_CAUSALE_FATTURAPA + 1) } });
    await waitFor(() => expect(avviso?.textContent ?? '').toMatch(AVVISO_LIMITE));
    // …ed è lo STESSO nodo di prima: si è riempito, non è stato rimontato.
    expect(document.getElementById(idAvviso)).toBe(avviso);
  });

  it('il pannello del BONIFICO non promette descrittori che non esistono', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText('Predefinito')) as HTMLInputElement;
    expect(campo.getAttribute('aria-describedby')).toBeNull();
  });

  it('le etichette dei chip vengono dai cataloghi, non dall’italiano cablato in src/lib', async () => {
    // `PLACEHOLDER_CAUSALE` vive in `src/lib` con le etichette in italiano dentro il
    // codice, mentre tutto il resto del pannello passa da next-intl e il catalogo
    // inglese è tradotto: un utente con l'interfaccia in inglese leggeva «Del/della
    // minore» in mezzo a testi inglesi.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    for (const p of PLACEHOLDER_CAUSALE) {
      const chip = screen.getByRole('button', { name: new RegExp(`\\{${p.chiave}\\}`) });
      // Il mock di next-intl risolve sui messaggi ITALIANI reali: se la chiave
      // mancasse dal catalogo, qui comparirebbe «adminContabilita.caus_ph_…».
      expect(chip.textContent ?? '').not.toMatch(/adminContabilita\./);
      expect(chip.getAttribute('title') ?? '').not.toMatch(/adminContabilita\./);
    }
  });
});

describe('ciò che il pannello NON sa, non lo dà per buono', () => {
  const patched: Patched[] = [];
  beforeEach(() => { patched.length = 0; });
  afterEach(() => vi.unstubAllGlobals());

  it('se la configurazione salvata non arriva, lo DICE e impedisce di salvare', async () => {
    // Prima: la fetch fallita veniva solo loggata e il pannello si apriva sul modello
    // di fabbrica, identico a una scuola che non ha mai configurato niente. Chi
    // salvava in quel momento credeva di partire dal salvato e partiva dal vuoto.
    vi.stubGlobal('fetch', mockFetch(patched, { impostazioniKo: true }));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.getByText(/valori di fabbrica, non quelli in archivio/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Salva/ })).toBeDisabled();
  });

  it('se l’elenco delle categorie non arriva, non cancella la configurazione di nessuno', async () => {
    // Il salvataggio azzera le chiavi orfane: senza l'elenco delle categorie OGNI
    // slug sembrerebbe orfano, e il primo «Salva» spazzerebbe via la configurazione
    // dell'intera scuola. Il pulsante è bloccato proprio per questo.
    vi.stubGlobal('fetch', mockFetch(patched, {
      categorieKo: true,
      fattura: { default: 'FATTURA {descrizione}', gita: 'Uscita {descrizione}' },
    }));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.getByRole('button', { name: /Salva/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    expect(patched).toHaveLength(0);
  });

  it('a caricamento riuscito non c’è nessun allarme e si salva', async () => {
    // Il controllo negativo dei due casi qui sopra: se l'avviso comparisse sempre,
    // i due test precedenti sarebbero verdi per il motivo sbagliato.
    vi.stubGlobal('fetch', mockFetch(patched));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.queryByText(/valori di fabbrica, non quelli in archivio/)).toBeNull();
    expect(screen.getByRole('button', { name: /Salva/ })).not.toBeDisabled();
  });

  it('un modello di una categoria CANCELLATA viene azzerato, non lasciato in eredità', async () => {
    // La categoria «laboratorio» non esiste più: la sua chiave resterebbe nel JSONB
    // per sempre, invisibile a schermo, pronta a tornare in vita — su una fattura
    // elettronica — se un giorno quello slug venisse riusato.
    vi.stubGlobal('fetch', mockFetch(patched, {
      fattura: { default: 'FATTURA {descrizione}', gita: 'Uscita {descrizione}', laboratorio: 'Laboratorio {descrizione}' },
    }));
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.queryByLabelText(/laboratorio/i)).toBeNull(); // non è a schermo
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    await waitFor(() => expect(patched).toHaveLength(1));
    const config = patched[0].fattura_causali_config as Record<string, string>;
    expect(config.laboratorio).toBe(''); // '' = il server rimuove la chiave
    expect(config.gita).toBe('Uscita {descrizione}'); // le righe vive restano
  });
});

/**
 * Carattere di controllo del codice fiscale (algoritmo dell’Agenzia delle Entrate).
 * Sta QUI e non in `src/` di proposito: `@/lib/fiscale/codice-fiscale` non lo verifica —
 * è una scelta motivata in fondo a quel file — e il test non deve poter passare grazie a
 * una funzione del prodotto che non esiste.
 */
const DISPARI: Record<string, number> = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function carattereDiControllo(primi15: string): string {
  let totale = 0;
  for (let i = 0; i < 15; i++) {
    const c = primi15[i];
    totale += i % 2 === 0 ? DISPARI[c] : (/\d/.test(c) ? Number(c) : ALFABETO.indexOf(c));
  }
  return ALFABETO[totale % 26];
}

describe('il codice fiscale dell’anteprima è SINTETICO, e la misura è questa', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ha il carattere di controllo INVALIDO: non può appartenere a nessuno', async () => {
    // Fino al 2026-08-10 l’esempio era `RSSMRA85T10A562S`: checksum VALIDA e codice
    // catastale reale (A562 = Ferrara), cioè un codice pienamente assegnabile a una
    // persona esistente, reso a schermo due volte per pagina in un repository PUBBLICO.
    // Il metro è scritto in fondo a `@/lib/fiscale/codice-fiscale`.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    const anteprima = screen.getAllByText(/a favore del minore Mario Rossi/)[0].textContent ?? '';
    const cf = anteprima.match(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/)?.[0];
    expect(cf, 'l’anteprima deve contenere il codice fiscale d’esempio').toBeDefined();
    expect(carattereDiControllo((cf as string).slice(0, 15))).not.toBe((cf as string)[15]);
  });

  it('il genere resta MASCHILE: cambiare il CF non deve cambiare in silenzio «{minore}»', async () => {
    // Il giorno di nascita ≤ 40 è ciò da cui `articoloMinore` ricava «del minore».
    // Sostituendo il CF d’esempio è facile scivolare al femminile senza accorgersene.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.getAllByText(/a favore del minore /).length).toBeGreaterThan(0);
    expect(screen.queryByText(/a favore della minore /)).toBeNull();
  });
});

describe('i due editor convivono sulla stessa schermata', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched, {
      bonifico: { default: 'BONIFICO {descrizione}' },
      fattura: { default: 'FATTURA {descrizione}' },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ogni campo ha il SUO id: le etichette non puntano al pannello sbagliato', async () => {
    // Con gli id cablati («causale-default») il secondo pannello ne duplicava gli id
    // del primo: `<label for>` risolve al PRIMO elemento con quell’id, quindi metà dei
    // campi diventava irraggiungibile da tastiera e da screen reader.
    render(<><CausaliPanel userId="u1" scuolaId="sc-1" /><CausaliFatturaPanel userId="u1" scuolaId="sc-1" /></>);
    await waitFor(() => expect(screen.getAllByLabelText('Predefinito')).toHaveLength(2));
    const [uno, due] = screen.getAllByLabelText('Predefinito') as HTMLInputElement[];
    expect(uno).not.toBe(due);
    expect(uno.id).not.toBe(due.id);
    expect([uno.value, due.value]).toEqual(['BONIFICO {descrizione}', 'FATTURA {descrizione}']);
  });

  it('le due sezioni hanno titoli distinti e ognuna dichiara il proprio nome', async () => {
    render(<><CausaliPanel userId="u1" scuolaId="sc-1" /><CausaliFatturaPanel userId="u1" scuolaId="sc-1" /></>);
    await waitFor(() => expect(screen.getAllByLabelText('Predefinito')).toHaveLength(2));
    const sezioni = screen.getAllByRole('region');
    expect(sezioni.map((s) => s.getAttribute('aria-label') ?? within(s).getByRole('heading').textContent?.trim()))
      .toEqual(['Causali bonifico', 'Causali fattura']);
  });

  it('salvare le fatture non tocca la configurazione dei bonifici', async () => {
    render(<><CausaliPanel userId="u1" scuolaId="sc-1" /><CausaliFatturaPanel userId="u1" scuolaId="sc-1" /></>);
    await waitFor(() => expect(screen.getAllByLabelText('Predefinito')).toHaveLength(2));
    // Il secondo «Salva» è quello del pannello fatture (l’ordine di resa è quello).
    fireEvent.click(screen.getAllByRole('button', { name: /Salva/ })[1]);
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(Object.keys(patched[0]).sort()).toEqual(['fattura_causali_config', 'scuola_id']);
  });
});
