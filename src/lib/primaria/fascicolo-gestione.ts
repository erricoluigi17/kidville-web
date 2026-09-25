import { NextResponse } from 'next/server'
import type { AccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { logEvento } from '@/lib/logging/logger'

/**
 * FASCICOLO — le regole condivise dalle route che caricano, modificano,
 * sostituiscono, eliminano e ripristinano i documenti (spec 2026-09-24, F1).
 *
 * Vivono qui e non nei `route.ts` perché un file di route di Next accetta solo
 * gli export dei metodi HTTP: due route che ripetessero `ALLOWED` o `MAX_SIZE` a
 * mano divergerebbero al primo ritocco, e il file sostituito passerebbe controlli
 * diversi da quelli del file caricato. Lo stesso vale per i RIFIUTI (403 di
 * gestione, 409 del prestampato) e per la rimozione del file appena caricato:
 * erano scritti a mano in tre route, e il testo del 403 divergeva già.
 */

// Il BUCKET non sta qui di proposito: ogni route che lo usa ne dichiara il letterale
// (`const BUCKET = 'sensitive_documents'`). Lo pretendono le guardie dell'oblio
// (`__tests__/lib/gdpr-bucket-sensitive.test.ts`, `gdpr-oblio-completo.test.ts`): un
// consumatore che importasse la costante renderebbe la guardia auto-soddisfacente.

/** 15 MB: lo stesso tetto del caricamento e della sostituzione. */
export const MAX_SIZE_FASCICOLO = 15 * 1024 * 1024

/**
 * PDF o immagine, con l'estensione che il file prende nel bucket. L'estensione viene
 * dal MIME già validato, MAI dal nome del file: il nome è testo libero dell'utente
 * («Relazione dott.ssa Rossi» senza estensione darebbe «ssa Rossi», «referto.pdf/x»
 * darebbe una sottocartella), e il percorso finisce nei log dello Storage.
 */
export const ESTENSIONE_PER_MIME_FASCICOLO: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** PDF o immagine. */
export const MIME_FASCICOLO = Object.keys(ESTENSIONE_PER_MIME_FASCICOLO)

/** I tipi che si scelgono dal fascicolo (l'enumerato del DB ne ha di più: i prestampati). */
export const TIPI_FASCICOLO = ['diagnosi', 'pei', 'pdp', '104'] as const

/**
 * Il documento è DEL FASCICOLO? `student_documents` custodisce anche i prestampati —
 * firmati dal genitore (`caricato_da` = genitore, `document_type` = slug del modulo) o
 * protocollati (il numero di protocollo vive solo in `descrizione`). Quelli NON si
 * modificano e NON si sostituiscono dal fascicolo: una sostituzione farebbe nascere una
 * «firma» con un file scelto dallo staff e una data di oggi (che `teacher/uscite` conta
 * come autorizzazione per le uscite create dopo), e una PATCH della descrizione
 * cancellerebbe il protocollo. Dal fascicolo si possono solo mettere nel cestino.
 */
export function eDocumentoDelFascicolo(documentType: string | null | undefined): boolean {
  return !!documentType && (TIPI_FASCICOLO as readonly string[]).includes(documentType)
}

/** I ruoli che gestiscono QUALUNQUE documento del fascicolo della propria sede. */
export const RUOLI_GESTIONE_FASCICOLO = ['admin', 'coordinator', 'segreteria'] as const

/**
 * Chi può MODIFICARE, SOSTITUIRE, ELIMINARE o RIPRISTINARE un documento.
 *
 * Spec, «Fascicolo»: l'autore (`caricato_da`) più Segreteria e Direzione. Nessun
 * termine: a differenza del registro, il fascicolo non si «chiude».
 *
 * Due condizioni in AND, e la prima non è ridondante:
 *  1. `puoAccedereFascicolo` consentito — per lo staff vuol dire ANCHE «della
 *     propria sede» (il gate fa il controllo di plesso), per un docente vuol dire
 *     «contitolare della sezione, oggi». Un'insegnante che ha caricato un PEI e
 *     poi ha cambiato classe non lo gestisce più: non lo vede nemmeno.
 *  2. staff OPPURE autore del documento. «Staff» vuol dire motivo `staff` (il gate
 *     ha riconosciuto il plesso) E ruolo in `RUOLI_GESTIONE_FASCICOLO`: il motivo da
 *     solo dice «perché puoi leggere», non «chi sei». Se un giorno il gate desse il
 *     motivo `staff` a un ruolo nuovo (per esempio la cucina per le allergie), quel
 *     ruolo leggerebbe ma non gestirebbe i documenti altrui finché non lo si aggiunge
 *     qui apposta.
 */
export function puoGestireDocumentoFascicolo(
  accesso: AccessoFascicolo,
  caricatoDa: string | null | undefined,
  utenteId: string,
): boolean {
  if (!accesso.consentito) return false
  if (eGestoreFascicolo(accesso)) return true
  return !!caricatoDa && caricatoDa === utenteId
}

/**
 * Chi gestisce i documenti ALTRUI del fascicolo: motivo `staff` (il gate ha riconosciuto
 * il plesso) E ruolo in `RUOLI_GESTIONE_FASCICOLO`. È il predicato UNICO: lo usano la
 * gestione (`puoGestireDocumentoFascicolo`) e l'elenco del cestino, perché chi vede una
 * voce nel cestino deve poterla ripristinare — un elenco su cui ogni «Ripristina»
 * risponde 403 mostra diagnosi e PEI eliminati da altri a chi non li può gestire.
 */
export function eGestoreFascicolo(accesso: AccessoFascicolo): boolean {
  return (
    accesso.consentito &&
    accesso.motivo === 'staff' &&
    !!accesso.ruolo &&
    (RUOLI_GESTIONE_FASCICOLO as readonly string[]).includes(accesso.ruolo)
  )
}

/**
 * Il GATE di gestione, uguale per modifica, eliminazione, sostituzione e ripristino.
 * `null` = consentito. Altrimenti la risposta da restituire così com'è:
 *  · 403 `DOCUMENTO_SANITARIO_NEGATO` se il fascicolo non è accessibile (altra sede,
 *    non contitolare);
 *  · 403 `FASCICOLO_GESTIONE_NEGATA` se lo è, ma chi chiede non è l'autore né
 *    Segreteria/Direzione — con un `warn`, perché è un tentativo su un documento
 *    sanitario altrui.
 *
 * `puoAccedereFascicolo` NON si chiama qui: resta nell'handler, dove il lock
 * `isolamento-sede-coverage` la vuole vedere accanto alla query. Il testo è unico e
 * neutro: l'interfaccia traduce dal `codice`.
 */
export function rispostaGestioneNegata(
  accesso: AccessoFascicolo,
  caricatoDa: string | null | undefined,
  alunnoId: string,
  utenteId: string,
  operazione: string,
): NextResponse | null {
  if (!accesso.consentito) {
    return NextResponse.json({ error: 'Accesso al fascicolo non consentito', codice: 'DOCUMENTO_SANITARIO_NEGATO' }, { status: 403 })
  }
  if (!puoGestireDocumentoFascicolo(accesso, caricatoDa, utenteId)) {
    logEvento('fascicolo', 'warn', { operazione, esito: 'gestione-negata', alunno_id: alunnoId })
    return NextResponse.json(
      { error: 'Operazione riservata all’autore del documento, alla Segreteria e alla Direzione', codice: 'FASCICOLO_GESTIONE_NEGATA' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Un prestampato (firmato dal genitore o protocollato) sta in `student_documents` ma NON è
 * un documento del fascicolo (vedi `eDocumentoDelFascicolo`): la PATCH gli cancellerebbe il
 * protocollo, la sostituzione farebbe nascere una «firma» nuova. 409 prima di ogni
 * scrittura; `null` = è del fascicolo. Il DELETE non la usa: mettere nel cestino non
 * riscrive niente.
 */
export function rispostaNonDelFascicolo(
  documentType: string | null | undefined,
  alunnoId: string,
  operazione: string,
): NextResponse | null {
  if (eDocumentoDelFascicolo(documentType)) return null
  logEvento('fascicolo', 'warn', { operazione, esito: 'documento-non-del-fascicolo', alunno_id: alunnoId })
  return NextResponse.json(
    {
      error: 'È un modulo firmato o protocollato: dal fascicolo non si modifica né si sostituisce',
      codice: 'FASCICOLO_DOCUMENTO_NON_MODIFICABILE',
    },
    { status: 409 },
  )
}

/** Quanto serve del client Supabase per togliere un file: niente di più. */
type ClientRimozione = {
  storage: { from(bucket: string): { remove(percorsi: string[]): Promise<{ error: unknown }> } }
}

/**
 * Toglie dal bucket il file APPENA caricato da una scrittura che poi non è andata in
 * porto (insert fallito, corsa persa). Senza, il file resterebbe orfano: nessuna riga
 * lo cita, quindi non lo toglie nemmeno la purga del cestino — e nel bucket del
 * fascicolo è una diagnosi o un verbale della 104.
 *
 * Il BUCKET arriva dal chiamante (vedi sopra: il letterale sta nelle route). Un
 * fallimento non si inghiotte: si logga a livello `error`, perché qualcuno deve
 * andarlo a togliere a mano.
 */
export async function togliFileFascicoloCaricato(
  supabase: ClientRimozione,
  bucket: string,
  percorso: string,
  alunnoId: string,
  operazione: string,
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(bucket).remove([percorso])
    if (error) {
      logEvento('fascicolo', 'error', { operazione, esito: 'file-nuovo-orfano', alunno_id: alunnoId }, error)
    }
  } catch (e) {
    logEvento('fascicolo', 'error', { operazione, esito: 'file-nuovo-orfano', alunno_id: alunnoId }, e)
  }
}

/**
 * Il percorso nel bucket di un file nuovo dell'alunno. Sempre NUOVO: la
 * sostituzione non sovrascrive il file vecchio, che resta nel cestino con la
 * sua riga per i giorni di custodia.
 *
 * Riceve il MIME (già validato contro `MIME_FASCICOLO`), non il nome del file: il nome
 * non entra MAI nel percorso, nemmeno come estensione. Un MIME fuori dalla mappa dà un
 * percorso senza estensione, mai un pezzo di testo scelto dall'utente.
 */
export function percorsoNuovoFascicolo(alunnoId: string, mime: string): string {
  const ext = Object.prototype.hasOwnProperty.call(ESTENSIONE_PER_MIME_FASCICOLO, mime)
    ? ESTENSIONE_PER_MIME_FASCICOLO[mime]
    : ''
  return `${alunnoId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext ? `.${ext}` : ''}`
}
