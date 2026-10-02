import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  BYTE_CASUALI_TOKEN_RINNOVO,
  INTESTAZIONE_TOKEN_RINNOVO,
  PREFISSO_TOKEN_RINNOVO,
  schemaTokenRinnovoVideo,
} from './contratto'

/**
 * IL TOKEN DI RINNOVO DEL CARICAMENTO NATIVO — chi lo conia, come lo si conserva, come lo si
 * legge. Solo SERVER: usa `node:crypto`, ed è il motivo per cui sta qui e non in `contratto.ts`
 * (che lo importano anche i client, e il lock `video-contratto` lo vuole privo di moduli di
 * server). La FORMA del token — il prefisso, i byte, l'intestazione — è del contratto; qui c'è
 * ciò che si fa con quella forma.
 *
 * ─── A CHE COSA SERVE ───────────────────────────────────────────────────────────────────────
 * L'app 1.2 manda l'originale con UNA `PUT` su un URL firmato, dal sistema operativo e anche ad
 * app chiusa. Quell'URL scade (due ore) e la sessione dell'insegnante, a quell'ora, può non
 * esserci più: il token è l'unica cosa che l'app tiene per tornare a chiedere un URL nuovo senza
 * una sessione (`POST /api/video-uploads/rinnovo`). Non è una credenziale di accesso: apre UNA
 * cosa sola, un URL di caricamento per QUEL percorso, finché l'originale non è arrivato.
 *
 * ─── COME SI CONSERVA ───────────────────────────────────────────────────────────────────────
 * Si conia con 256 bit casuali e al database va SOLO il suo SHA-256 (`video_jobs.rinnovo_token_hash`,
 * 32 byte, indice unico): chi legge la tabella non ricava un token con cui chiedere un URL. Il
 * database lo vede come `bytea`, e PostgREST lo vuole scritto `\x<hex>` (`hashTokenRinnovoPerPostgres`).
 *
 * Vale 48 ore (`ORE_VALIDITA_TOKEN_RINNOVO`) e il rinnovo NON le allunga: l'orizzonte è quello
 * dell'upload abbandonato, dopo il quale la retention chiude comunque il job.
 *
 * ─── DOVE NON DEVE MAI COMPARIRE ────────────────────────────────────────────────────────────
 * Viaggia solo nell'intestazione `x-kidville-rinnovo`, mai in un URL, mai nel corpo — e MAI in un
 * log. Non è un'avvertenza: il logger lo lascerebbe passare. `redact` ammette in chiaro ogni
 * valore che abbia la forma di un enumerato sotto una chiave in lista bianca, e un token (47
 * caratteri senza spazi, alfabeto base64url) HA quella forma. Chi scrive un log vicino a questo
 * modulo non passa mai il token, e nemmeno il suo hash: l'hash è il solo dato che serve a un
 * attaccante per sapere se un token «esiste». Lo fa rispettare un test che esegue la route col
 * logger vero (`video-uploads-rinnovo.test.ts`).
 */

/** Quanto vive un token: 48 ore dall'apertura, lo stesso orizzonte dell'upload abbandonato. */
export const ORE_VALIDITA_TOKEN_RINNOVO = 48

/**
 * I TETTI DI FREQUENZA DEL RINNOVO — la porta che non ha una sessione, e quindi si difende con due.
 *
 * Per IP: 30 richieste ogni 10 minuti. Il rinnovo lo chiede un telefono che ha appena avuto un
 * 400/403 dalla PUT o ha trovato scaduto l'URL, con un backoff: un solo upload ne usa pochissimi, e
 * dietro il NAT di una sede ci sono al più i telefoni del personale. Per token: 20 ogni 10 minuti,
 * sull'impronta del token (mai sul token): il tetto che ferma chi martella UN token noto, e che si
 * applica a ogni token ben formato — esistente o no — così il 429 non dice nulla sul fatto che quel
 * token esista.
 *
 * Stanno qui, accanto alla forma del token, e non scritti dentro la route: il lock
 * `upload-pubblico-con-tetto` pretende che il numero di una porta senza sessione arrivi da un
 * modulo condiviso, dove sta accanto alla misura che lo giustifica.
 */
export const FINESTRA_TETTO_RINNOVO_MS = 10 * 60 * 1000
export const TETTO_RINNOVO_PER_IP = 30
export const TETTO_RINNOVO_PER_TOKEN = 20

/** Un token nuovo: `kvr_` più 32 byte casuali in base64url (43 caratteri, senza padding). */
export function generaTokenRinnovo(): string {
  return `${PREFISSO_TOKEN_RINNOVO}${randomBytes(BYTE_CASUALI_TOKEN_RINNOVO).toString('base64url')}`
}

/** Lo SHA-256 del token: 32 byte, ciò che il database conserva al posto del token. */
export function hashTokenRinnovo(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** Lo stesso hash in esadecimale minuscolo (64 caratteri): serve a comporre la chiave di un tetto. */
export function hashTokenRinnovoEsadecimale(token: string): string {
  return hashTokenRinnovo(token).toString('hex')
}

/** L'hash nella forma con cui PostgREST riceve un `bytea`: `\x<hex>`. */
export function hashTokenRinnovoPerPostgres(token: string): string {
  return `\\x${hashTokenRinnovoEsadecimale(token)}`
}

/** Il token corrisponde a questo hash? Confronto a tempo costante, e `false` per un hash della lunghezza sbagliata. */
export function tokenCorrispondeAlHash(token: string, hash: Uint8Array): boolean {
  const atteso = hashTokenRinnovo(token)
  if (hash.byteLength !== atteso.byteLength) return false
  return timingSafeEqual(atteso, Buffer.from(hash))
}

/** L'istante oltre il quale il token non vale più: 48 ore dopo `adesso`. */
export function scadenzaTokenRinnovo(adesso: number = Date.now()): Date {
  return new Date(adesso + ORE_VALIDITA_TOKEN_RINNOVO * 60 * 60 * 1000)
}

/**
 * Che cosa c'è nell'intestazione del token. Tre esiti e non un `string | null`: «assente» e
 * «malformato» si distinguono nel log (un client che non manda l'intestazione e uno che sonda),
 * ma a chi chiama escono uguali — il 404 uniforme — e il valore sbagliato non viene mai
 * restituito: non c'è un modo di rimetterlo in un log per distrazione.
 */
export type TokenDaRichiesta =
  | { esito: 'ok'; token: string }
  | { esito: 'assente' }
  | { esito: 'malformato' }

/**
 * Legge il token dall'intestazione `x-kidville-rinnovo`, e solo da lì.
 *
 * NON passa da `parseData`: quel helper deposita il valore nel contesto di log PRIMA di
 * validarlo, perché lo scopo è poter diagnosticare un 400 — e il token non si diagnostica, non si
 * deposita da nessuna parte. La forma si controlla con lo schema del contratto, direttamente.
 */
export function tokenRinnovoDaRichiesta(request: Request): TokenDaRichiesta {
  const grezzo = request.headers.get(INTESTAZIONE_TOKEN_RINNOVO)
  if (grezzo === null || grezzo === '') return { esito: 'assente' }
  const letto = schemaTokenRinnovoVideo.safeParse(grezzo)
  return letto.success ? { esito: 'ok', token: letto.data } : { esito: 'malformato' }
}
