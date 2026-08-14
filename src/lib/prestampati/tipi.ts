/**
 * Tipi del motore di impaginazione dei prestampati
 * (specifica: `docs/prestampati/00-impaginazione.md`).
 *
 * Puri di proposito: qui dentro non entra jsPDF. Un prestampato si descrive — e si
 * collauda — senza tirarsi dietro il generatore, e chi compone un modello ragiona su
 * blocchi di contenuto invece che su millimetri. I millimetri stanno tutti in
 * `impaginazione.ts`, in un posto solo: è ciò che impedisce a due prestampati scritti
 * a sei mesi di distanza di somigliarsi soltanto.
 */

/**
 * Una riga-campo del modulo: l'etichetta c'è sempre, il valore solo quando l'app lo
 * conosce davvero.
 *
 * Valore assente (o stringa vuota) = riga da compilare a penna: il motore stampa il
 * filetto grigio fino a fine colonna invece di inventare un dato. È la stessa
 * disciplina dell'intestazione di sede (§1 della specifica): mai una riga vuota che
 * sembri un valore, mai un valore che non viene dall'archivio.
 */
export interface CampoPrestampato {
  etichetta: string
  valore?: string | null
}

/** Una casella `☐` con la sua voce: spuntata quando il dato è già noto all'app. */
export interface CasellaPrestampato {
  testo: string
  spuntata?: boolean
}

/**
 * I blocchi di contenuto. Un prestampato è la loro sequenza, e l'ordine è quello di
 * stampa: il motore non riordina niente e non decide cosa mettere dove.
 */
export type BloccoPrestampato =
  /** Corpo del testo: le formule di rito, le dichiarazioni, le note di chiusura. */
  | { tipo: 'paragrafo'; testo: string; stile?: 'normale' | 'corsivo' | 'grassetto' }
  /** Titolo di sezione (`DATI DELL'ALUNNO/A`): il maiuscolo lo mette il motore. */
  | { tipo: 'sezione'; titolo: string }
  /**
   * Righe-campo. `colonne: 2` mette i campi brevi affiancati (data di nascita,
   * telefono, sezione); i campi lunghi (indirizzo, dinamica, note) stanno in un
   * blocco a una colonna. Sono due blocchi distinti proprio perché la specifica
   * vieta di mescolarli sulla stessa riga: la riga successiva riparte sempre da
   * sinistra, e con `colonne` per blocco non c'è modo di sbagliare.
   */
  | { tipo: 'campi'; campi: CampoPrestampato[]; colonne?: 1 | 2 }
  /** Caselle da spuntare, in fila e a capo automatico a fine larghezza utile. */
  | { tipo: 'caselle'; caselle: CasellaPrestampato[] }
  /** Elenco puntato. */
  | { tipo: 'elenco'; voci: string[] }
  /**
   * Tabella ripetibile (delegati, alimenti e sostituzioni, dosi somministrate,
   * periodi di servizio).
   *
   * `larghezze` sono PROPORZIONI, non millimetri: vengono riscalate sulla larghezza
   * utile, così `[2, 1, 1]` e `[80, 40, 40]` danno lo stesso risultato e nessuno deve
   * far tornare una somma a mano.
   *
   * `righeVuote` sono le righe lasciate libere in coda: la specifica ne chiede almeno
   * tre sulle tabelle ripetibili, perché un modulo consegnato deve poter essere
   * completato a penna. Sulle stampe di servizio (elenchi di sezione) vale 0 — che è
   * il valore predefinito, perché una riga vuota su un elenco di cucina è un bambino
   * che sembra mancare.
   */
  | {
      tipo: 'tabella'
      intestazioni: string[]
      righe: string[][]
      larghezze?: number[]
      righeVuote?: number
    }
  /**
   * Riquadro «RISERVATO A…»: il pezzo che la segreteria compila dopo la consegna.
   *
   * Quando i campi non ci stanno in una pagina la cornice si chiude, riparte sulla
   * successiva e il titoletto si ripete — come le testate di una tabella lunga. Nessun
   * numero massimo di campi, quindi, e soprattutto nessun campo che sparisce in silenzio.
   */
  | { tipo: 'riquadro'; titolo: string; campi: CampoPrestampato[] }
  /** Spazio verticale in millimetri, quando il ritmo non basta. */
  | { tipo: 'spazio'; mm: number }

/**
 * Il blocco di firma. La variante non è una scelta estetica: dice **chi risponde di
 * quel foglio** (§3 della specifica).
 */
export type FirmaPrestampato =
  /**
   * Documenti della famiglia (05…10): il foglio **è già firmato**, quindi niente riga
   * vuota da firmare a penna — solo il riquadro che attesta la firma elettronica.
   *
   * `riferimento` è l'identificativo della ricevuta FEA, non l'hash dell'OTP. Email e
   * indirizzo IP non entrano in questo tipo e non entrano nel PDF: stanno nella
   * ricevuta di `src/lib/fea/receipt-pdf.ts`, che è un altro documento e si scarica a
   * parte.
   */
  | {
      tipo: 'genitore'
      firmatario: string
      istante: string
      metodo: string
      riferimento: string
    }
  /**
   * Documenti della scuola (26·27, 28, 30, 31, 47): nome dalla configurazione di sede
   * (`scuole.config.anagrafica.legale_rappresentante`), **mai cablato nel codice** —
   * il repository è pubblico e il CdA cambia, e un nome scritto in un `.ts` è un nome
   * che un giorno sarà sbagliato in venti documenti nello stesso momento. La dicitura
   * del D.Lgs 39/93 invece è una costante di legge e sta in `impaginazione.ts`.
   */
  | { tipo: 'legaleRappresentante'; nome: string }
  /** Stampe di servizio (elenchi di sezione): non si firmano e non si archiviano. */
  | { tipo: 'nessuna' }

/**
 * Riquadro di verifica dei certificati in uscita (§4.3).
 *
 * Non c'è nessun campo per l'impronta SHA-256, e non è una dimenticanza: il perché sta
 * nel commento di `disegnaVerifica()` in `impaginazione.ts`.
 */
export interface VerificaPrestampato {
  numeroProtocollo: string
  dataProtocollo: string
  /** Pagina pubblica dove chi riceve il documento lo confronta col registro. */
  indirizzoVerifica: string
}

/** Il documento intero, così come il motore lo riceve e lo impagina. */
export interface DocumentoPrestampato {
  /**
   * Righe di intestazione della sede, già pronte e già filtrate: quelle che mancano
   * non arrivano qui. Il motore non inventa e non lascia buchi.
   */
  intestazione: string[]
  titolo: string
  /**
   * Riga sopra il titolo. Porta il protocollo quando il documento lo emette la
   * segreteria (`Prot. n. 0000123/2026 del 13/08/2026`) e la dicitura «Copia a uso
   * della famiglia — non protocollata» sulla copia che il genitore si scarica da sé.
   * Due fogli che si somigliano ma valgono cose diverse devono dirlo: assente, la
   * riga non compare affatto.
   */
  protocollo?: string | null
  blocchi: BloccoPrestampato[]
  luogoData: string
  firma: FirmaPrestampato
  verifica?: VerificaPrestampato | null
  /** Piede di pagina alternativo; assente vale quello del registro elettronico. */
  piePagina?: string
}
