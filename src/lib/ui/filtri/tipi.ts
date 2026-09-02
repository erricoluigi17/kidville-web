import type { BadgeTone } from '@/components/ui/Badge';

/**
 * ─── I TIPI DEL MOTORE DEI FILTRI ────────────────────────────────────────────
 *
 * Zero React, zero DOM: qui si dichiara *che cosa* è un filtro, non come si
 * disegna. Il motore (`motore.ts`) è una funzione di questi tipi; l'hook
 * (`use-filtri.ts`) e la barra (`components/ui/BarraFiltri.tsx`) ci si
 * appoggiano sopra.
 *
 * ── PERCHÉ `dove` È NEL TIPO E NON UNA CONVENZIONE ──────────────────────────
 *
 * Un filtro può vivere in due posti, e sbagliare posto non fa rumore:
 *
 *  · `dove: 'server'` → il valore parte nella query dell'API. Se per sbaglio lo
 *    si filtra anche a schermo, si applica due volte lo stesso criterio su dati
 *    già scremati — e su un campo che nella riga non c'è, l'elenco si svuota.
 *  · `dove: 'client'` → il valore filtra le righe già in memoria. Se per sbaglio
 *    parte verso l'API, o produce un 400, o viene ignorato e l'elenco torna
 *    intero: venti righe su quattrocento, chiamate «tutte».
 *
 * Per questo un campo `dove: 'client'` **deve** portare il proprio estrattore
 * (`testiDi`, `valoreDi`, `valoriDi`, `dataDi`/`intervalloDi`, `predicato`) e un
 * campo `dove: 'server'` **non può** portarlo: non è una raccomandazione, è la
 * forma del tipo, e `tsc` la fa rispettare. Un filtro client senza estrattore
 * sarebbe un filtro che non filtra, col gate verde.
 *
 * ── PERCHÉ CIASCUN TIPO È UNA COPPIA DI MEMBRI E NON UN'INTERSEZIONE ────────
 * `Base & { tipo } & ({dove:'client', estrattore} | {dove:'server'})` si scrive
 * in meno righe ma TypeScript non la restringe in modo affidabile su `dove`, e
 * dentro il motore servirebbero cast. Due membri per tipo si narrowano da soli.
 */

/** Estremi di un periodo, in `YYYY-MM-DD`. Stringa vuota = estremo non indicato. */
export interface Periodo {
  da: string;
  a: string;
}

/** I valori che un filtro può assumere. Uno per `tipo`, e nient'altro. */
export type ValoreFiltro = string | string[] | boolean | Periodo;

/** Lo stato completo di una barra: `chiave del campo` → valore. */
export type ValoriFiltri = Record<string, ValoreFiltro>;

/**
 * Una voce di scelta.
 *
 * `tono` è la ragione per cui questo tipo esiste invece di una coppia
 * `{value,label}`: il chip del filtro «In attesa» deve avere lo STESSO arancione
 * del badge «In attesa» che si legge nella riga dell'elenco. Il tono si prende
 * dai toni del `Badge`, non si risceglie a occhio — altrimenti la stessa parola
 * ha due colori nella stessa schermata.
 *
 * `conteggio` è quante righe porterebbe quella scelta: lo riempie
 * `opzioniDerivate` quando le opzioni nascono dai dati.
 */
export interface OpzioneFiltro {
  valore: string;
  etichetta: string;
  tono?: BadgeTone;
  conteggio?: number;
}

/** Ciò che ogni campo ha, qualunque sia il suo `tipo`. */
interface Comune {
  /**
   * Il nome del campo. È ANCHE il nome del parametro nell'URL e verso l'API:
   * uno solo, così un indirizzo incollato a un collega e la query che parte
   * dicono la stessa cosa. (Per un `periodo` diventa `<chiave>Da`/`<chiave>A`.)
   */
  chiave: string;
  /** L'etichetta VISIBILE sopra il controllo. Mai solo `aria-label`. */
  etichetta: string;
  /**
   * Il campo fa SEMPRE parte della richiesta (tipicamente l'anno o la sede), e
   * per questo non è un «filtro» nel senso della barra:
   *  · non entra mai nel conteggio della pastiglia «Filtri»;
   *  · non compare mai fra i chip removibili;
   *  · «Pulisci filtri» non lo tocca — resta dov'è.
   * È la CORNICE dell'elenco, non una restrizione che l'utente ha aggiunto.
   */
  obbligatorio?: boolean;
  /** Sta nella prima riga della barra; gli altri vivono nel pannello «Filtri». */
  primario?: boolean;
  /** Con zero opzioni il controllo non si disegna (elenco derivato dai dati). */
  nascondiSeVuoto?: boolean;
}

/** I testi della riga da cui la ricerca pesca. Vuoti e assenti sono ammessi. */
export type LettureTesto = readonly (string | null | undefined)[];

interface RicercaBase extends Comune {
  tipo: 'ricerca';
  /** Segnaposto del campo. Se manca, la barra usa il proprio testo generico. */
  segnaposto?: string;
}
export type CampoRicerca<R> =
  | (RicercaBase & { dove: 'client'; testiDi: (riga: R) => LettureTesto })
  | (RicercaBase & { dove: 'server'; testiDi?: never });

interface SceltaBase extends Comune {
  opzioni: readonly OpzioneFiltro[];
  /** Il valore di partenza. Per un campo `obbligatorio` è anche il suo riposo. */
  predefinito?: string;
}
export type CampoScelta<R> =
  | (SceltaBase & { tipo: 'scelta'; dove: 'client'; valoreDi: (riga: R) => string | null | undefined })
  | (SceltaBase & { tipo: 'scelta'; dove: 'server'; valoreDi?: never });

/** Come `scelta`, ma disegnato a pastiglie invece che a tendina. */
export type CampoChip<R> =
  | (SceltaBase & { tipo: 'chip'; dove: 'client'; valoreDi: (riga: R) => string | null | undefined })
  | (SceltaBase & { tipo: 'chip'; dove: 'server'; valoreDi?: never });

interface MultiBase extends Comune {
  tipo: 'multi';
  opzioni: readonly OpzioneFiltro[];
  predefinito?: string[];
}
export type CampoMulti<R> =
  | (MultiBase & { dove: 'client'; valoriDi: (riga: R) => LettureTesto })
  | (MultiBase & { dove: 'server'; valoriDi?: never });

interface PeriodoBase extends Comune {
  tipo: 'periodo';
  /**
   * Come si legge il periodo a schermo. Il motore, da solo, sa scrivere solo
   * `2026-01-01 → 2026-03-31`: neutro di lingua e leggibile, ma non è italiano.
   * La pagina che conosce il proprio formattatore di date lo sostituisce qui.
   */
  descrivi?: (periodo: Periodo) => string;
}
export type CampoPeriodo<R> =
  | (PeriodoBase & { dove: 'client'; dataDi: (riga: R) => string | null | undefined; intervalloDi?: never })
  | (PeriodoBase & {
      dove: 'client';
      dataDi?: never;
      /** La riga occupa essa stessa un intervallo: si tiene se SI SOVRAPPONE. */
      intervalloDi: (riga: R) => { da?: string | null; a?: string | null } | null | undefined;
    })
  | (PeriodoBase & { dove: 'server'; dataDi?: never; intervalloDi?: never });

interface InterruttoreBase extends Comune {
  tipo: 'interruttore';
  predefinito?: boolean;
}
export type CampoInterruttore<R> =
  | (InterruttoreBase & { dove: 'client'; predicato: (riga: R) => boolean })
  | (InterruttoreBase & { dove: 'server'; predicato?: never });

export type CampoFiltro<R> =
  | CampoRicerca<R>
  | CampoScelta<R>
  | CampoChip<R>
  | CampoMulti<R>
  | CampoPeriodo<R>
  | CampoInterruttore<R>;

/** Un filtro attivo, pronto a diventare un chip removibile. */
export interface FiltroAttivo {
  /** Il campo da cui viene. */
  chiave: string;
  /** Per un `multi`, il valore singolo che questo chip rappresenta. */
  valore?: string;
  /** L'etichetta del campo («Stato»): serve al nome accessibile del ✕. */
  etichetta: string;
  /** Il valore leggibile («In attesa»). */
  testo: string;
  /** Lo stesso tono del badge di quello stato nell'elenco. */
  tono?: BadgeTone;
}

/** I quattro stati di un elenco, più il quinto: «ci sono righe da mostrare». */
export type StatoElencoTipo = 'caricamento' | 'vuoto' | 'senzaRisultati' | 'errore' | 'pronto';

/**
 * I testi della barra, GIÀ RISOLTI nella lingua della pagina.
 *
 * Nessun default e nessun `useTranslations` dentro i componenti, per le stesse
 * due ragioni misurate di `TestiCombobox`:
 *  · il plurale di «12 risultati» lo decide il catalogo in ICU, non un ternario
 *    in TypeScript (lock `messaggi-plurali-e-glossario`, nato da un'interfaccia
 *    che scriveva «1 alunni» col gate verde) — per questo `risultati` e
 *    `mostraRisultati` sono FUNZIONI;
 *  · un default in italiano è il modo in cui un componente «riusabile» finisce
 *    per parlare italiano dentro la versione inglese, senza che nessun lock
 *    possa accorgersene.
 *
 * ⚠️ Sono STRINGHE, mai chiavi. Il namespace `adminModulistica` è sotto tutela in
 * `messaggi-chiavi-orfane` con la motivazione «nessuna chiave costruita da un
 * dato»: se questa barra risolvesse `t(campo.chiaveEtichetta)` quella tutela
 * cadrebbe, e con lei l'unico strumento che accorge di una chiave morta.
 * Il ponte col catalogo è `testiBarraFiltri(t)` in `components/ui/BarraFiltri`,
 * dove ogni chiave è scritta per esteso.
 */
/**
 * Il minimo che serve per tradurre: una chiave e dei valori.
 *
 * ⚠️ NON `ReturnType<typeof useTranslations>`. Quel tipo pretende anche `rich`,
 * `markup`, `raw` e `has`, e con esso un traduttore costruito a mano non sarebbe
 * accettato — a partire dal `createTranslator` di `use-intl` con cui il banco di
 * prova rende i testi VERI, che è l'unico modo di misurare che «1 risultato» non
 * sia «1 risultati». Il `t` di `useTranslations` resta assegnabile a questa
 * firma: la prova sta in `__tests__/components/barra-filtri.test.tsx` ed è di
 * TIPO, cioè fallisce a compilazione se un giorno smettesse di esserlo.
 */
export type Traduttore = (chiave: string, valori?: Record<string, string | number>) => string;

export interface TestiBarraFiltri {
  /** Etichetta VISIBILE del campo di ricerca. */
  ricerca: string;
  /** Segnaposto del campo di ricerca (un campo può darne uno più preciso). */
  ricercaSegnaposto: string;
  /** Nome accessibile della ✕ che svuota la ricerca. */
  pulisciRicerca: string;
  /** Etichetta del bottone «Filtri», e nome del pannello e del foglio. */
  filtri: string;
  /** Nome della regione che raccoglie i chip attivi. */
  filtriAttivi: string;
  /** Nome accessibile del ✕ di un chip. Riceve «Stato: In attesa». */
  rimuoviFiltro: (filtro: string) => string;
  /** «Pulisci filtri», per esteso. */
  pulisci: string;
  /** «Pulisci», dove lo spazio è quello di un telefono. */
  pulisciBreve: string;
  /** La voce «nessuna scelta» di una tendina. */
  tutti: string;
  /** I due estremi di un periodo. */
  dal: string;
  al: string;
  /** «12 risultati su 387». */
  risultati: (mostrati: number, totale: number) => string;
  /** «Mostra 12 risultati»: la CTA del foglio, col numero che cambia mentre si tocca. */
  mostraRisultati: (n: number) => string;
  /** Nome accessibile del ✕ del foglio. */
  chiudi: string;
}

/**
 * Ciò che serve per leggere i valori di partenza da un indirizzo.
 * È il minimo comune fra `URLSearchParams` e la `ReadonlyURLSearchParams` che
 * `useSearchParams()` restituisce: così il motore resta puro e non conosce Next.
 */
export interface LettoreParametri {
  get(nome: string): string | null;
}
