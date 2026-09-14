// =============================================================================
// Validazione generica dei campi di un form a partire dal suo SCHEMA.
//
// Perché esiste: il "Modulo d'iscrizione standard" dichiara nei suoi campi la
// validazione (`FormField.validation`: pattern/min_length/max_length + il
// `required` del campo) — ma finora NESSUNA superficie di compilazione la
// applicava. In produzione è così arrivata una provincia scritta per esteso
// (7 caratteri) che ha rotto l'import a valle (colonne `varchar(2)`).
//
// Questo modulo è la sorgente unica della regola di validazione, RIUSABILE sia
// dal client (wizard) sia dal server (POST /api/iscrizione): stesse regole,
// stessi messaggi, un solo posto da mantenere.
//
// I messaggi sono in ITALIANO, chiari e non tecnici: l'utente che compila il
// modulo non deve leggere una regex.
//
// NB: questo modulo NON normalizza (non converte "Napoli" → "NA"): valida e
// basta. La normalizzazione delle province è responsabilità del chiamante
// (`normalizzaProvincia` in `@/lib/anagrafiche/province`), che la esegue PRIMA
// di validare — così il valore normalizzato passa e quello irriconoscibile
// resta e fallisce il pattern.
//
// Le province, però, non si validano solo per FORMA: una sigla come "XY" o "ZZ"
// passa il pattern `^[A-Z]{2}$` ma NON è una provincia italiana reale. Perciò,
// oltre alla forma, si valida l'APPARTENENZA all'elenco reale (`isSiglaProvincia`),
// così un dato inesistente viene bloccato al primo controllo — nel wizard e nel
// POST — e non muore a valle, al pre-flight dell'import in segreteria (vicolo cieco).
//
// Lo stesso vale per il CODICE FISCALE (dal 14/09/2026): la forma non dice se il
// carattere di controllo torna, e un refuso di una lettera — a valle — faceva nascere
// un secondo alunno, perché la deduplica per codice fiscale non lo riconosceva più.
// Il campo si riconosce dal significato (`id` o `db_mapping`), non dal pattern.
// =============================================================================

import type { FormField } from '@/types/database.types'
import { isSiglaProvincia } from '@/lib/anagrafiche/province'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'

/**
 * ── I DUE MESSAGGI DELL'OBBLIGO, ESPORTATI (25/08/2026) ──────────────────────
 *
 * Questa funzione gira su DUE lati e i suoi messaggi sono ITALIANI PER
 * COSTRUZIONE (vedi la testata): sul server il locale dell'interfaccia non
 * esiste. Ma il lato client la stessa frase la mostra A SCHERMO, e la porta
 * pubblica ha il catalogo inglese completo — cioè su `/lavora-con-noi` con
 * `KV_LOCALE=en` sotto un'etichetta «Curriculum» compariva «Allega un file per
 * proseguire», e sotto «Titolo di studio» «Campo obbligatorio».
 *
 * ⚠️ E NON ERA UNA STRINGA SOLA, che è il motivo per cui il rimedio non poteva
 * essere una chiave dedicata al campo file. MISURATO: `validateField` ritorna
 * italiano per OGNI predicato (email, data, numero, minimo, massimo, selezione,
 * pattern), e l'obbligo è quello che si legge per primo e su ogni campo. Tradurre
 * il solo messaggio del curriculum avrebbe lasciato una schermata inglese con
 * «Campo obbligatorio» sotto il menu e «Attach a file to continue» sotto il
 * riquadro: mezza traduzione è una voce in più, non una in meno.
 *
 * Perciò le due frasi dell'obbligo escono di qui come COSTANTI, e
 * `FieldRenderer` le usa come chiave per il catalogo (`campoObbligatorio`,
 * `allegaFile`, in it e in en). Il server continua a ricevere e a rispondere
 * l'italiano, che non si legge a schermo. Il residuo — i predicati di formato —
 * resta scoperto ed è debito dichiarato, non una svista: si chiude con la stessa
 * forma, una costante per messaggio, quando qualcuno lo affronterà.
 */
export const MSG_CAMPO_OBBLIGATORIO = 'Campo obbligatorio'
export const MSG_ALLEGA_FILE = 'Allega un file per proseguire'
/**
 * ── E L'OBBLIGO NON PARLA DUE DIALETTI SULLA STESSA SCHERMATA (25/08/2026) ───
 *
 * MISURATO leggendo insieme i tre `[role=alert]` del passo «Il tuo profilo» dopo
 * un «Avanti» a passo vuoto, prima di questa aggiunta:
 *   ["Campo obbligatorio", "Campo obbligatorio", "Allega un file per proseguire"]
 *
 * «Campo obbligatorio» è la risposta di un database. Il lavoro del 24/08 l'aveva
 * riconosciuto e aveva dato la frase umana a UN TIPO SOLO — il che, in un aspetto,
 * è peggio del punto di partenza: a mezzo metro di distanza sulla stessa colonna
 * il prodotto dimostrava di saper parlare a una persona e sceglieva di non farlo
 * due volte su tre.
 *
 * ⚠️ E LA CADENZA NON SI INVENTA QUI: il modulo ce l'ha già scritta al passo 1,
 * `candSedeErrore` = «Scegli almeno una sede per proseguire». Stesso predicato
 * («almeno uno di N»), stesse parole, stessa chiusa. Queste due frasi la copiano.
 *
 * ⚠️ E NON NOMINANO IL CAMPO, per la stessa ragione per cui `MSG_ALLEGA_FILE` non
 * nomina il curriculum: `validateField` la chiamano anche il modulo d'iscrizione e
 * quello del personale, e una frase che nomina il caso che l'ha fatta nascere è un
 * difetto peggiore di quello che chiude.
 *
 * Resta fuori `consent`, e di proposito: il suo obbligo ha già una frase sua
 * («Devi accettare per proseguire»), che `FieldRenderer` applica nel ramo dedicato
 * e che non passa di qui.
 */
export const MSG_SCEGLI_OPZIONE = 'Scegli almeno un’opzione per proseguire'
export const MSG_SCEGLI_DA_ELENCO = 'Seleziona un’opzione per proseguire'
/**
 * ── IL CODICE FISCALE CHE HA LA FORMA GIUSTA E NON È DI NESSUNO (14/09/2026) ──
 *
 * MISURATO in produzione: nella stessa sede 7 coppie di alunni DOPPI, e in tutte i
 * due codici fiscali differiscono per un carattere solo e uno dei due ha il carattere
 * di controllo sbagliato. Il refuso della famiglia passava il modulo pubblico, perché
 * qui si guardava la sola FORMA (`pattern`); la deduplica per codice fiscale non
 * riconosceva il bambino e ne nasceva un secondo, con le rette doppie ai genitori.
 *
 * È una COSTANTE, e non una frase ribattuta nella funzione, per la ragione scritta
 * sopra per l'obbligo: il client la mostra a schermo e `useMessaggioCampo` la scambia
 * con la voce `codiceFiscaleNonValido` del catalogo, in italiano e in inglese.
 */
export const MSG_CODICE_FISCALE_NON_VALIDO = 'Il codice fiscale non è valido: controlla lettere e numeri'

/** Tipi decorativi: non raccolgono un valore, non si validano mai. */
const TIPI_DECORATIVI = new Set(['section_header', 'paragraph', 'signature'])

/** Email "plausibile": non una validazione RFC completa, solo forma di base. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Data ISO `YYYY-MM-DD` (quella prodotta da `<input type="date">`). */
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Un campo è "provincia" se il suo id (eventualmente namespacizzato dal wizard,
 * es. `children.0.birth_province`) termina con `_province`.
 */
export function isProvinceField(field: FormField): boolean {
  return /_province$/i.test(field.id)
}

/** Ultimo segmento dell'id, senza il namespace `children.0.` / `adults.1.`. */
function idSemplice(id: string): string {
  const parti = id.split('.')
  return parti[parti.length - 1] ?? id
}

/** I due nomi di colonna con cui questo schema chiama un codice fiscale. */
const NOMI_CODICE_FISCALE = new Set(['codice_fiscale', 'fiscal_code'])

/**
 * Un campo è un CODICE FISCALE se lo dice il suo significato, non il suo pattern.
 *
 * ⚠️ IL PATTERN NON È UN SEGNALE AFFIDABILE: il modello del modulo arriva anche dal
 * database (il costruttore della segreteria), dove il pattern può mancare o essere
 * diverso — e i due template in codice ne hanno già due diversi, con e senza omocodia.
 * Il significato sta in due posti: l'`id` (anche sotto il namespace del wizard,
 * `children.0.codice_fiscale`) e il `db_mapping` (`alunni.codice_fiscale`), che è
 * l'unico segnale dei campi preimpostati di `anagrafica-fields.ts`, il cui `id` è un uuid.
 */
function isCodiceFiscaleField(field: FormField): boolean {
  if (NOMI_CODICE_FISCALE.has(idSemplice(field.id).toLowerCase())) return true
  return /\.(codice_fiscale|fiscal_code)$/i.test(field.db_mapping ?? '')
}

/** True se il valore è "vuoto" ai fini della validazione. */
function eVuoto(field: FormField, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (field.type === 'checkbox') return !Array.isArray(value) || value.length === 0
  if (field.type === 'consent') return value !== true
  return String(value).trim() === ''
}

/** Esempio da mostrare all'utente per una provincia, ricavato dal placeholder. */
function esempioProvincia(field: FormField): string {
  // placeholder tipo "Es. RM" → "RM"; fallback "NA".
  const p = (field.placeholder ?? '').replace(/^es\.?\s*/i, '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(p) ? p : 'NA'
}

/** Messaggio per un pattern fallito, scelto in base alla semantica del campo. */
function messaggioPattern(field: FormField, pattern: string): string {
  if (isProvinceField(field)) {
    return `Inserisci la sigla della provincia (es. ${esempioProvincia(field)})`
  }
  const id = idSemplice(field.id).toLowerCase()
  if (pattern === '^[0-9]{5}$' || id.includes('zip') || id.includes('cap')) {
    return 'Inserisci un CAP valido (5 cifre)'
  }
  if (id.includes('fiscal') || id.includes('codice_fiscale') || id === 'cf') {
    return 'Inserisci un codice fiscale valido (16 caratteri)'
  }
  const esempio = (field.placeholder ?? '').replace(/^es\.?\s*/i, '').trim()
  return esempio ? `Formato non valido. Esempio: ${esempio}` : 'Formato non valido'
}

/** True se `str` combacia INTERAMENTE con `pattern` (match completo). */
function combaciaPattern(str: string, pattern: string): boolean {
  try {
    const m = new RegExp(pattern).exec(str)
    // Match completo: la porzione riconosciuta deve coprire tutta la stringa.
    return m !== null && m[0] === str
  } catch {
    // Pattern non compilabile (schema malformato): non blocchiamo la compilazione
    // su una regola che non sappiamo interpretare.
    return true
  }
}

/**
 * Valida un singolo campo contro il suo schema.
 * Ritorna un messaggio d'errore in italiano, oppure `null` se il valore è valido.
 */
export function validateField(field: FormField, value: unknown): string | null {
  if (TIPI_DECORATIVI.has(field.type)) return null

  const vuoto = eVuoto(field, value)

  // 1) Obbligatorietà.
  //
  // ── E QUANDO L'AZIONE NON È «SCRIVI», LA FRASE LO DICE (25/08/2026) ─────────
  //
  // «Campo obbligatorio» è la risposta di un database, e su un campo di testo passa
  // perché il gesto mancante è ovvio: c'è un cursore che lampeggia. Su un campo di
  // CARICAMENTO no. Dal 24/08 il curriculum di «Lavora con noi» è obbligatorio, e
  // chi preme «Avanti» senza allegato leggeva due parole che non dicono cosa fare,
  // non nominano l'allegato e non ricordano che va bene anche una fotografia —
  // sotto un riquadro che è l'unico attrito nuovo di tutto quel lavoro.
  //
  // Il repo aveva GIÀ preso questa decisione una volta, per l'altro campo in cui
  // l'azione non è digitare: la spunta di un consenso ha il suo messaggio dedicato
  // («Devi accettare per proseguire», `FieldRenderer` ramo `consent`). Il campo
  // file non l'aveva ereditata.
  //
  // ⚠️ NON È UNA SECONDA REGOLA — ed è l'obiezione a cui questo ramo risponde. La
  // regola resta una, questa, che gira identica sul client e sul server; a cambiare
  // è il MESSAGGIO, esattamente come già fa `messaggioPattern` qui sotto, che per
  // lo stesso predicato «pattern fallito» dice cose diverse a una provincia, a un
  // CAP e a un codice fiscale. Una frase diversa per lo stesso predicato non è una
  // strada che diverge: è la stessa strada che sa dove si trova.
  //
  // ⚠️ E LA FRASE NON NOMINA IL CURRICULUM, benché il caso che l'ha fatta nascere
  // sia quello: questa funzione la chiamano anche il documento d'identità del
  // minore (`enrollment-template`) e le due facce del documento del personale
  // (`personale-template`). «Allega il curriculum» sotto «Fronte del documento»
  // sarebbe un difetto peggiore di quello che si sta chiudendo.
  if (field.required && vuoto) {
    // Una frase diversa per lo stesso predicato non è una strada che diverge: è
    // la stessa strada che sa dove si trova (vedi il commento qui sopra e
    // `messaggioPattern` più in basso, che fa lo stesso per provincia, CAP e CF).
    if (field.type === 'file') return MSG_ALLEGA_FILE
    // ⚠️ `radio` STA COL MENU, NON COL GRUPPO A SPUNTA (25/08/2026, settimo giro).
    // Fino a stamattina i due gruppi condividevano il ramo e un `radio` vuoto
    // diceva «Scegli ALMENO UN'opzione»: «almeno una» promette che se ne possano
    // prendere più d'una, e `FieldRenderer` rende `radio` come `role="radiogroup"`,
    // che ne accetta esattamente una (il costruttore di moduli della segreteria lo
    // offre col nome `modInputSceltaSingola`, cioè «scelta singola»). Il predicato è
    // lo stesso del menu — uno e uno solo fra N — e la frase è quella.
    if (field.type === 'checkbox') return MSG_SCEGLI_OPZIONE
    if (field.type === 'select' || field.type === 'radio') return MSG_SCEGLI_DA_ELENCO
    return MSG_CAMPO_OBBLIGATORIO
  }

  // 2) Un campo facoltativo vuoto è valido: niente pattern/lunghezze sul vuoto.
  if (vuoto) return null

  // 3) Controlli per tipo (solo su valore presente).
  if (field.type === 'email' && !EMAIL_RE.test(String(value))) {
    return 'Inserisci un indirizzo email valido'
  }
  if (field.type === 'date' && !DATA_ISO_RE.test(String(value))) {
    return 'Inserisci una data valida'
  }
  if (field.type === 'number') {
    const n = Number(String(value).replace(',', '.'))
    if (!Number.isFinite(n)) return 'Inserisci un numero valido'
    if (field.validation?.min !== undefined && n < field.validation.min) {
      return `Il valore minimo è ${field.validation.min}`
    }
    if (field.validation?.max !== undefined && n > field.validation.max) {
      return `Il valore massimo è ${field.validation.max}`
    }
  }
  if ((field.type === 'select' || field.type === 'radio') && Array.isArray(field.options) && field.options.length > 0) {
    const ammessi = new Set(field.options.map((o) => o.value))
    if (!ammessi.has(String(value))) return 'Selezione non valida'
  }

  // 4) Regole dichiarate nello schema (`validation`).
  const str = String(value)
  const v = field.validation
  if (v?.pattern && !combaciaPattern(str, v.pattern)) {
    return messaggioPattern(field, v.pattern)
  }
  if (v?.min_length !== undefined && str.length < v.min_length) {
    return `Inserisci almeno ${v.min_length} caratteri`
  }
  if (v?.max_length !== undefined && str.length > v.max_length) {
    return `Inserisci al massimo ${v.max_length} caratteri`
  }

  // 5) Province: superata la FORMA, la sigla deve ESISTERE davvero. 'XY'/'ZZ'/'QQ'
  // passano il pattern ma non sono province reali → senza questo controllo
  // morirebbero solo al pre-flight dell'import, dove l'operatore non può correggere.
  // `isSiglaProvincia` è case-insensitive ('NA'/'na' → ok); un nome per esteso
  // ("Napoli") non è una sigla e resta non valido (il valore finale valido è una sigla;
  // sul client lo snap su blur e sul server la normalizzazione lo riducono PRIMA).
  if (isProvinceField(field) && !isSiglaProvincia(str)) {
    return `Sigla di provincia inesistente (es. ${esempioProvincia(field)})`
  }

  // 6) Codice fiscale: superata la FORMA, deve tornare il CARATTERE DI CONTROLLO (e
  // il giorno deve esistere sul calendario). È lo stesso ragionamento delle province:
  // una stringa che ha la forma giusta ma non è di nessuno passava il wizard e il
  // POST, e moriva a valle — qui come un secondo bambino nato da un refuso.
  // `validaCodiceFiscale` accetta l'omocodia (codici veri, assegnati dall'Agenzia) e
  // ripulisce spazi e minuscole: la FORMA stretta, se c'è, l'ha già detta il pattern.
  if (isCodiceFiscaleField(field) && !validaCodiceFiscale(str).valido) {
    return MSG_CODICE_FISCALE_NON_VALIDO
  }

  return null
}

/**
 * Valida un insieme di campi (una pagina/record) contro i valori forniti.
 * Ritorna una mappa `{ idCampo → messaggio }` con SOLO i campi non validi.
 *
 * Il chiamante decide quali campi passare: sul client si passano i soli campi
 * VISIBILI (logica condizionale); sul server si passa il template completo.
 */
export function validatePage(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    const msg = validateField(field, values[field.id])
    if (msg) out[field.id] = msg
  }
  return out
}
