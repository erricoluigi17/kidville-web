/**
 * Modello statutario del Certificato delle Competenze al termine della scuola
 * primaria (classe quinta), conforme al **D.M. 14 del 30/1/2024** (modello
 * nazionale, già allegato B al D.M. 742/2017).
 *
 * Costanti pure (nessun accesso DB): le 8 **competenze chiave europee**
 * (Raccomandazione UE 22/05/2018) e la scala a **4 livelli** A/B/C/D con i
 * relativi descrittori. NB: il 4° livello del *certificato* è «Iniziale»,
 * distinto dalla scala della pagella O.M. 172/2020 («In via di prima
 * acquisizione»); la conversione fra le due scale vive in `livello-mapping.ts`.
 */

export interface CompetenzaChiave {
  /** Chiave stabile usata come riga su `certificato_competenza_livelli`. */
  codice: string
  /** Denominazione della competenza chiave europea. */
  etichetta: string
  /** Discipline/ambiti che concorrono (dal modello nazionale). */
  descrizione: string
}

export interface Livello {
  codice: 'A' | 'B' | 'C' | 'D'
  etichetta: string
  descrittore: string
}

/** Codice della riga libera (competenze significative extra). Non è una delle 8. */
export const COMPETENZE_SIGNIFICATIVE_CODICE = 'competenze_significative'

/** Le 8 competenze chiave europee, in ordine canonico del modello nazionale. */
export const COMPETENZE_CHIAVE: CompetenzaChiave[] = [
  {
    codice: 'comunicazione_alfabetica_funzionale',
    etichetta: 'Competenza alfabetica funzionale',
    descrizione: 'Lingua italiana; tutte le discipline.',
  },
  {
    codice: 'comunicazione_multilinguistica',
    etichetta: 'Competenza multilinguistica',
    descrizione: 'Lingua inglese ed eventuale seconda lingua comunitaria.',
  },
  {
    codice: 'competenza_matematica_scienze_tecnologia',
    etichetta: 'Competenza matematica e competenze in scienze, tecnologie e ingegneria',
    descrizione: 'Matematica; scienze; tecnologia.',
  },
  {
    codice: 'competenza_digitale',
    etichetta: 'Competenza digitale',
    descrizione: 'Tutte le discipline.',
  },
  {
    codice: 'competenza_personale_sociale_imparare',
    etichetta: 'Competenza personale, sociale e capacità di imparare a imparare',
    descrizione: 'Tutte le discipline.',
  },
  {
    codice: 'competenza_cittadinanza',
    etichetta: 'Competenza in materia di cittadinanza',
    descrizione: 'Storia; geografia; educazione civica; tutte le discipline.',
  },
  {
    codice: 'competenza_imprenditoriale',
    etichetta: 'Competenza imprenditoriale',
    descrizione: 'Tutte le discipline.',
  },
  {
    codice: 'consapevolezza_espressione_culturali',
    etichetta: 'Competenza in materia di consapevolezza ed espressione culturali',
    descrizione: 'Arte e immagine; musica; educazione fisica; tutte le discipline.',
  },
]

/** Scala a 4 livelli del certificato (D.M. 14/2024), con descrittori canonici. */
export const LIVELLI: Livello[] = [
  {
    codice: 'A',
    etichetta: 'Avanzato',
    descrittore:
      "L'alunno/a svolge compiti e risolve problemi complessi, mostrando padronanza nell'uso delle conoscenze e delle abilità; propone e sostiene le proprie opinioni e assume in modo responsabile decisioni consapevoli.",
  },
  {
    codice: 'B',
    etichetta: 'Intermedio',
    descrittore:
      "L'alunno/a svolge compiti e risolve problemi in situazioni nuove, compie scelte consapevoli, mostrando di saper utilizzare le conoscenze e le abilità acquisite.",
  },
  {
    codice: 'C',
    etichetta: 'Base',
    descrittore:
      "L'alunno/a svolge compiti semplici anche in situazioni nuove, mostrando di possedere conoscenze e abilità fondamentali e di saper applicare basilari regole e procedure apprese.",
  },
  {
    codice: 'D',
    etichetta: 'Iniziale',
    descrittore:
      "L'alunno/a, se opportunamente guidato/a, svolge compiti semplici in situazioni note.",
  },
]

const LIVELLO_ETICHETTE = new Map<string, string>(LIVELLI.map((l) => [l.codice, l.etichetta]))
const COMPETENZA_ETICHETTE = new Map<string, string>(COMPETENZE_CHIAVE.map((c) => [c.codice, c.etichetta]))

/** Etichetta del livello da codice A/B/C/D; `—` per codice assente/ignoto. */
export function livelloEtichetta(codice?: string | null): string {
  if (!codice) return '—'
  return LIVELLO_ETICHETTE.get(codice) ?? '—'
}

/** Etichetta della competenza da codice; fallback sul codice stesso se ignoto. */
export function competenzaEtichetta(codice: string): string {
  return COMPETENZA_ETICHETTE.get(codice) ?? codice
}
