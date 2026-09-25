/**
 * FASCICOLO — le regole che l'INTERFACCIA usa per decidere cosa mostrare
 * (spec 2026-09-24, compito F2). Il gate vero resta sul server
 * (`src/lib/primaria/fascicolo-gestione.ts`): qui si decide soltanto quali
 * bottoni NON promettere, così che nessuno clicchi un «Elimina» che risponderebbe 403.
 *
 * Perché un modulo a parte e non un import da `fascicolo-gestione.ts`: quel modulo
 * importa `next/server` e il logger del server, che in un componente client non
 * devono entrare. Le due liste qui sotto sono COPIE, e il test
 * `__tests__/pages/teacher-primaria-fascicolo-gestione.test.tsx` le confronta con quelle
 * del server: se divergono, diventa rosso.
 */

import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * Limite pratico dell'upload (caricamento E sostituzione): è il body massimo della
 * funzione serverless, non `MAX_SIZE_FASCICOLO` della route (più alto, e non è il
 * vincolo che scatta). Uno solo, perché la pagina e la modale non divergano.
 */
export const LIMITE_UPLOAD_FASCICOLO_BYTE = 4 * 1024 * 1024

/** I tipi che si scelgono dal fascicolo (copia di `TIPI_FASCICOLO`). */
export const TIPI_DOCUMENTO_FASCICOLO = ['diagnosi', 'pei', 'pdp', '104'] as const

/** Chi gestisce anche i documenti ALTRUI (copia di `RUOLI_GESTIONE_FASCICOLO`). */
export const RUOLI_GESTORE_FASCICOLO = ['admin', 'coordinator', 'segreteria'] as const

/**
 * Il documento è del fascicolo (PEI, PDP, diagnosi, 104)? I prestampati firmati o
 * protocollati stanno nella stessa tabella: il server li lascia solo ELIMINARE
 * (409 `FASCICOLO_DOCUMENTO_NON_MODIFICABILE` su modifica e sostituzione).
 */
export function eTipoDelFascicolo(documentType: string | null | undefined): boolean {
  return !!documentType && (TIPI_DOCUMENTO_FASCICOLO as readonly string[]).includes(documentType)
}

/** Segreteria o Direzione: gestiscono qualunque documento del fascicolo della sede. */
export function eGestoreFascicoloUi(ruolo: string | null | undefined): boolean {
  return !!ruolo && (RUOLI_GESTORE_FASCICOLO as readonly string[]).includes(ruolo)
}

/**
 * Si mostrano «Modifica», «Sostituisci file» ed «Elimina» su questo documento?
 * Autore (`caricato_da`) oppure Segreteria/Direzione. Fail-closed: senza utente
 * risolto, nessun bottone.
 */
export function puoGestireDocumentoUi(input: {
  ruolo: string | null | undefined
  caricatoDa: string | null | undefined
  utenteId: string | null | undefined
}): boolean {
  if (!input.utenteId) return false
  if (eGestoreFascicoloUi(input.ruolo)) return true
  return !!input.caricatoDa && input.caricatoDa === input.utenteId
}

/** Ciò che l'utente ha scritto nella modale «Modifica» (stringhe dei campi). */
export interface BozzaDocumentoFascicolo {
  documentType: string
  descrizione: string
  expiryDate: string
}

/** Il documento come lo restituisce `GET /api/primaria/fascicolo`. */
export interface DocumentoFascicoloUi {
  id: string
  document_type: string
  descrizione: string | null
  file_name: string | null
  expiry_date: string | null
  created_at: string
  caricato_da?: string | null
}

/**
 * Il corpo della PATCH: SOLO i campi cambiati. Descrizione e scadenza vuote
 * diventano `null` (il server le svuota); un campo uguale a prima non parte.
 * `null` = niente da inviare.
 */
export function corpoModificaFascicolo(
  prima: Pick<DocumentoFascicoloUi, 'document_type' | 'descrizione' | 'expiry_date'>,
  bozza: BozzaDocumentoFascicolo,
): { documentType?: string; descrizione?: string | null; expiryDate?: string | null } | null {
  const corpo: { documentType?: string; descrizione?: string | null; expiryDate?: string | null } = {}
  if (bozza.documentType && bozza.documentType !== prima.document_type) corpo.documentType = bozza.documentType
  const descr = bozza.descrizione.trim() === '' ? null : bozza.descrizione.trim()
  if (descr !== (prima.descrizione ?? null)) corpo.descrizione = descr
  const scad = bozza.expiryDate === '' ? null : bozza.expiryDate
  if (scad !== (prima.expiry_date ?? null)) corpo.expiryDate = scad
  return Object.keys(corpo).length === 0 ? null : corpo
}

/**
 * La chiave di `teacherPrimaria` per il rifiuto del server. Si traduce dal `codice`,
 * mai dalla prosa del server (che è italiana anche con l'interfaccia inglese).
 * Il 413 della piattaforma arriva senza corpo JSON: lo si riconosce dallo stato.
 */
export function chiaveErroreFascicolo(stato: number, codice: string | null | undefined): string {
  if (stato === 413) return 'fascicoloMsgFileTroppoGrande'
  switch (codice) {
    case 'FASCICOLO_GESTIONE_NEGATA':
      return 'fascicoloErroreGestioneNegata'
    case 'DOCUMENTO_SANITARIO_NEGATO':
      return 'fascicoloNonAutorizzato'
    case 'DOCUMENTO_NON_TROVATO':
    case 'FASCICOLO_DOCUMENTO_CAMBIATO':
      return 'fascicoloErroreDocumentoCambiato'
    case 'FASCICOLO_DOCUMENTO_NON_MODIFICABILE':
      return 'fascicoloErroreNonModificabile'
    case 'FASCICOLO_NIENTE_DA_MODIFICARE':
      return 'fascicoloNienteDaModificare'
    case 'FASCICOLO_FORMATO_NON_AMMESSO':
      return 'fascicoloErroreFormato'
    case 'FASCICOLO_FILE_TROPPO_GRANDE':
      return 'fascicoloMsgFileTroppoGrande'
    case 'FASCICOLO_NON_NEL_CESTINO':
      return 'fascicoloErroreNonNelCestino'
    case 'FASCICOLO_CESTINO_SCADUTO':
      return 'fascicoloErroreCestinoScaduto'
    case 'FASCICOLO_NON_AUTENTICATO':
      return 'comuneIdentitaNonRisolta'
    default:
      return 'fascicoloErroreGenerico'
  }
}

/**
 * Codici dopo i quali l'elenco sullo schermo è VECCHIO (qualcuno ha eliminato,
 * sostituito o ripristinato nel frattempo): si rilegge, invece di lasciare a
 * schermo una riga su cui ogni bottone risponderebbe di nuovo 404/409.
 */
export function rifiutoRichiedeRilettura(codice: string | null | undefined): boolean {
  return (
    codice === 'DOCUMENTO_NON_TROVATO' ||
    codice === 'FASCICOLO_DOCUMENTO_CAMBIATO' ||
    codice === 'FASCICOLO_NON_NEL_CESTINO' ||
    codice === 'FASCICOLO_CESTINO_SCADUTO'
  )
}

/** L'esito di una richiesta del fascicolo, già ridotto a ciò che serve alla UI. */
export interface EsitoFascicolo<T = unknown> {
  ok: boolean
  stato: number
  codice: string | null
  dati: T | null
}

/**
 * Legge la risposta senza mai lanciare: un 413 della piattaforma risponde HTML, e
 * `r.json()` lancerebbe lasciando lo spinner appeso (vedi `carica` nella pagina).
 */
export async function leggiEsitoFascicolo<T = unknown>(r: Response): Promise<EsitoFascicolo<T>> {
  let corpo: { data?: T; codice?: unknown } | null = null
  try {
    corpo = (await r.json()) as { data?: T; codice?: unknown }
  } catch (e) {
    // Corpo non JSON (413 HTML, risposta vuota): resta lo stato, che basta a scegliere il
    // testo. Si registra il FATTO (stato e classe dell'errore), mai il corpo.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `fascicolo-risposta-non-json: ${nomeErrore(e)}`,
      stato: r.status,
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
    })
    corpo = null
  }
  return {
    ok: r.ok,
    stato: r.status,
    codice: typeof corpo?.codice === 'string' ? corpo.codice : null,
    dati: (corpo?.data ?? null) as T | null,
  }
}
