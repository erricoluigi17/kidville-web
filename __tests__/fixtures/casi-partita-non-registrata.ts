// I 9 casi condivisi del predicato «partita non registrata» (CR1, contratto C0.3).
//
// Dati SINTETICI: uuid finti, nomi file finti, nessun dato personale. Li usa il
// test del modulo TS e del suo gemello SQL
// (`__tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts`) e, nella
// PR-A, il test di parità della funzione SQL della coda (R2A-4.4): chi aggiunge
// un caso lo aggiunge qui, e lo vedono tutti e tre i lati.
//
// Ogni caso ha uno o più pagamenti con le PROPRIE righe di `fatture_emesse`
// (tutte, in qualunque stato SdI). `atteso` vale per ogni pagamento del caso.
// Il caso 9 ne ha tre, uno per stato diverso da `in_attesa`.

export interface RigaDelCaso {
  /** uuid della riga di `fatture_emesse`. */
  id: string
  /** Quota dell'adulto pagante: righe di quote diverse dello stesso pagamento. */
  quota_adult_id: string | null
  sdi_stato: number | null
  aruba_filename: string | null
}

export interface PagamentoDelCaso {
  /** uuid del pagamento. */
  id: string
  fattura_stato: string
  fattura_aruba_id: string | null
  righe: readonly RigaDelCaso[]
}

export interface CasoPartitaNonRegistrata {
  numero: number
  descrizione: string
  pagamenti: readonly PagamentoDelCaso[]
  atteso: boolean
}

/** Nomi file finti: X è il file scritto sul pagamento, Y quello di un'altra quota. */
export const FILE_X = 'finto-caso-file-x.xml.p7m'
export const FILE_Y = 'finto-caso-file-y.xml.p7m'

const QUOTA_A = 'a0000000-0000-4000-8000-00000000000a'
const QUOTA_B = 'b0000000-0000-4000-8000-00000000000b'

// Stati SdI usati: 2 = scarto («Errore di elaborazione»), 7 = consegnata (viva).
// Non sono la lista degli scarti: quella la ricava il modulo da `mapStatoAruba`.
const SCARTO = 2
const VIVA = 7

const pag = (n: number, k = 0) => `c0000000-0000-4000-8000-${String(n * 10 + k).padStart(12, '0')}`
const riga = (n: number, k: number) => `f0000000-0000-4000-8000-${String(n * 10 + k).padStart(12, '0')}`

export const CASI_PARTITA_NON_REGISTRATA: readonly CasoPartitaNonRegistrata[] = [
  {
    numero: 1,
    descrizione: 'file X, nessuna riga',
    pagamenti: [{ id: pag(1), fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X, righe: [] }],
    atteso: true,
  },
  {
    numero: 2,
    descrizione: 'file X, sola riga scartata col file Y',
    pagamenti: [
      {
        id: pag(2),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: FILE_X,
        righe: [{ id: riga(2, 1), quota_adult_id: null, sdi_stato: SCARTO, aruba_filename: FILE_Y }],
      },
    ],
    atteso: true,
  },
  {
    numero: 3,
    descrizione: 'file X, riga scartata col file X (ritrasmissione legittima)',
    pagamenti: [
      {
        id: pag(3),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: FILE_X,
        righe: [{ id: riga(3, 1), quota_adult_id: null, sdi_stato: SCARTO, aruba_filename: FILE_X }],
      },
    ],
    atteso: false,
  },
  {
    numero: 4,
    descrizione: 'file X, riga viva col file X',
    pagamenti: [
      {
        id: pag(4),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: FILE_X,
        righe: [{ id: riga(4, 1), quota_adult_id: null, sdi_stato: VIVA, aruba_filename: FILE_X }],
      },
    ],
    atteso: false,
  },
  {
    numero: 5,
    descrizione: 'file X (quota A), riga viva della quota B col file Y e nessuna riga col file X',
    pagamenti: [
      {
        id: pag(5),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: FILE_X,
        righe: [{ id: riga(5, 1), quota_adult_id: QUOTA_B, sdi_stato: VIVA, aruba_filename: FILE_Y }],
      },
    ],
    atteso: true,
  },
  {
    numero: 6,
    descrizione: 'file nullo, nessuna riga',
    pagamenti: [{ id: pag(6), fattura_stato: 'in_attesa', fattura_aruba_id: null, righe: [] }],
    atteso: true,
  },
  {
    numero: 7,
    descrizione: 'file nullo, sola riga scartata con filename nullo',
    pagamenti: [
      {
        id: pag(7),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: null,
        righe: [{ id: riga(7, 1), quota_adult_id: QUOTA_A, sdi_stato: SCARTO, aruba_filename: null }],
      },
    ],
    atteso: true,
  },
  {
    numero: 8,
    descrizione: 'file nullo, riga con sdi_stato nullo (rifiuto di trasporto: resta viva)',
    pagamenti: [
      {
        id: pag(8),
        fattura_stato: 'in_attesa',
        fattura_aruba_id: null,
        righe: [{ id: riga(8, 1), quota_adult_id: null, sdi_stato: null, aruba_filename: null }],
      },
    ],
    atteso: false,
  },
  {
    numero: 9,
    descrizione: 'non_richiesta, scartata o emessa, senza righe',
    pagamenti: [
      { id: pag(9, 1), fattura_stato: 'non_richiesta', fattura_aruba_id: null, righe: [] },
      { id: pag(9, 2), fattura_stato: 'scartata', fattura_aruba_id: FILE_X, righe: [] },
      { id: pag(9, 3), fattura_stato: 'emessa', fattura_aruba_id: FILE_X, righe: [] },
    ],
    atteso: false,
  },
]

/** I pagamenti di tutti i casi in fila, ciascuno col numero del suo caso e l'esito atteso. */
export const PAGAMENTI_DEI_CASI: readonly (PagamentoDelCaso & { caso: number; atteso: boolean })[] =
  CASI_PARTITA_NON_REGISTRATA.flatMap((c) =>
    c.pagamenti.map((p) => ({ ...p, caso: c.numero, atteso: c.atteso })),
  )
