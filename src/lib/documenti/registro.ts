/**
 * Registro dei documenti dell'alunno — logica PURA.
 *
 * Mette in fila, in un elenco solo, i documenti che oggi vivono in tre tabelle
 * diverse e non si sono mai visti insieme:
 *
 *   • `forms_submissions`   — moduli compilati dal genitore, firmati con OTP
 *   • `student_documents`   — fascicolo personale (diagnosi, PEI, PDP, 104)
 *   • `certificati_medici`  — certificati caricati dalla famiglia
 *
 * Nessuna tabella nuova, nessuna colonna nuova: la sezione è una lettura.
 *
 * ─── La categoria decide CHI vede il documento ────────────────────────────────
 * `sanitario` non è un'etichetta descrittiva: è il gate. Un documento sanitario
 * è visibile alla segreteria del proprio plesso e alle insegnanti della sezione
 * dell'alunno, e a nessun altro (`puoAccedereFascicolo`). Tutto il resto è
 * `amministrativo` e segue lo scope ordinario.
 *
 * La lista dei tipi sanitari sta QUI, in un posto solo, e per la stessa ragione
 * per cui la redazione dei log è a lista bianca: un tipo nuovo che nessuno ha
 * classificato deve risultare sanitario per difetto solo dove la fonte lo è già,
 * e non diventare visibile a tutti perché qualcuno si è dimenticato di aggiungerlo.
 */

export type FonteDocumento = 'modulo_firmato' | 'fascicolo' | 'certificato_medico'

export type CategoriaDocumento = 'sanitario' | 'amministrativo'

export interface DocumentoAlunno {
  /** Chiave stabile per la UI: `<fonte>:<id d'origine>`. */
  id: string
  fonte: FonteDocumento
  /** Id nella tabella d'origine, per il download. */
  rifId: string
  alunnoId: string
  titolo: string
  /** Tipo grezzo della fonte (document_type, slug del modello…), per i filtri. */
  tipo: string | null
  categoria: CategoriaDocumento
  firmato: boolean
  /** ISO della firma, se c'è. Per i documenti caricati resta null. */
  firmatoIl: string | null
  creatoIl: string
  scadeIl: string | null
  nota: string | null
}

/**
 * Tipi che valgono come SANITARI anche quando arrivano da una fonte che di per
 * sé non lo è (oggi: i moduli firmati dal genitore).
 *
 * I quattro slug in coda non esistono ancora in banca dati: sono i prestampati
 * previsti in `docs/prestampati/` (scheda sanitaria, farmaci, dieta, verbale di
 * infortunio). Sono elencati ORA perché il giorno in cui il primo verrà scritto
 * il gate deve già essere chiuso — non il giorno dopo, quando qualcuno se ne
 * accorge leggendo un elenco.
 */
export const TIPI_SANITARI: readonly string[] = [
  'diagnosi',
  'pei',
  'pdp',
  '104',
  'certificato_medico',
  'scheda_sanitaria',
  'autorizzazione_farmaci',
  'dieta_speciale',
  'verbale_infortunio',
] as const

/** Fonti che sono sanitarie per natura, qualunque tipo portino. */
const FONTI_SANITARIE: readonly FonteDocumento[] = ['fascicolo', 'certificato_medico'] as const

export function categoriaDocumento(fonte: FonteDocumento, tipo: string | null): CategoriaDocumento {
  if (FONTI_SANITARIE.includes(fonte)) return 'sanitario'
  const t = tipo?.trim().toLowerCase()
  if (t && TIPI_SANITARI.includes(t)) return 'sanitario'
  return 'amministrativo'
}

// ─── Etichette in italiano ────────────────────────────────────────────────────
// Un `document_type` grezzo in una tabella di segreteria non dice niente a chi
// legge: 'pdp' e '104' sono sigle, non titoli.
const ETICHETTE_TIPO: Record<string, string> = {
  diagnosi: 'Diagnosi',
  pei: 'PEI — Piano Educativo Individualizzato',
  pdp: 'PDP — Piano Didattico Personalizzato',
  '104': 'Verbale L. 104',
  certificato_medico: 'Certificato medico',
  scheda_sanitaria: 'Scheda sanitaria',
  autorizzazione_farmaci: 'Autorizzazione somministrazione farmaci',
  dieta_speciale: 'Richiesta dieta speciale',
  verbale_infortunio: 'Verbale di infortunio',
  delega_ritiro: 'Delega al ritiro',
  permesso_orario: 'Permesso di entrata/uscita',
  autorizzazione_uscita: 'Autorizzazione uscita didattica',
}

export function etichettaTipo(tipo: string | null | undefined): string | null {
  const t = tipo?.trim()
  if (!t) return null
  return ETICHETTE_TIPO[t.toLowerCase()] ?? t
}

// ─── Normalizzazione delle tre fonti ─────────────────────────────────────────

export interface RigaModuloFirmato {
  id: string
  student_id: string | null
  form_id: string | null
  is_signed: boolean | null
  signature_log: unknown
  created_at: string | null
  origine?: string | null
}

/**
 * Estrae l'istante della firma dal `signature_log`, che è un superset
 * retro-compatibile di tre flussi storici: `signed_at` è la forma canonica,
 * `timestamp` quella dei flussi pagella/giustifica. Vale il primo dei due che
 * c'è; se il log è malformato non si inventa una data.
 */
export function istanteFirma(signatureLog: unknown): string | null {
  if (!signatureLog || typeof signatureLog !== 'object') return null
  const log = signatureLog as Record<string, unknown>
  const candidato = log.signed_at ?? log.timestamp
  return typeof candidato === 'string' && candidato.trim() ? candidato : null
}

export function daModuloFirmato(
  riga: RigaModuloFirmato,
  titoloModello: string | null,
  tipoModello?: string | null,
): DocumentoAlunno | null {
  // Senza alunno il documento non appartiene a nessun fascicolo: è il caso
  // dell'onboarding (`student_id` nullo), che in questa sezione non esiste.
  if (!riga.student_id) return null
  const tipo = tipoModello?.trim() || null
  return {
    id: `modulo_firmato:${riga.id}`,
    fonte: 'modulo_firmato',
    rifId: riga.id,
    alunnoId: riga.student_id,
    titolo: titoloModello?.trim() || 'Modulo senza titolo',
    tipo,
    categoria: categoriaDocumento('modulo_firmato', tipo),
    firmato: riga.is_signed === true,
    firmatoIl: riga.is_signed === true ? istanteFirma(riga.signature_log) : null,
    creatoIl: riga.created_at ?? '',
    scadeIl: null,
    nota: riga.origine?.trim() || null,
  }
}

export interface RigaFascicolo {
  id: string
  student_id: string
  document_type: string | null
  descrizione: string | null
  file_name: string | null
  expiry_date: string | null
  created_at: string | null
}

export function daFascicolo(riga: RigaFascicolo): DocumentoAlunno {
  const tipo = riga.document_type?.trim() || null
  return {
    id: `fascicolo:${riga.id}`,
    fonte: 'fascicolo',
    rifId: riga.id,
    alunnoId: riga.student_id,
    titolo: etichettaTipo(tipo) ?? riga.file_name?.trim() ?? 'Documento del fascicolo',
    tipo,
    categoria: 'sanitario',
    // Un documento caricato non è firmato: dirlo è il punto della sezione.
    firmato: false,
    firmatoIl: null,
    creatoIl: riga.created_at ?? '',
    scadeIl: riga.expiry_date,
    nota: riga.descrizione?.trim() || null,
  }
}

export interface RigaCertificatoMedico {
  id: string
  alunno_id: string
  data_inizio: string | null
  data_fine: string | null
  stato: string | null
  creato_il: string | null
}

export function daCertificatoMedico(riga: RigaCertificatoMedico): DocumentoAlunno {
  return {
    id: `certificato_medico:${riga.id}`,
    fonte: 'certificato_medico',
    rifId: riga.id,
    alunnoId: riga.alunno_id,
    titolo: 'Certificato medico',
    tipo: 'certificato_medico',
    categoria: 'sanitario',
    firmato: false,
    firmatoIl: null,
    creatoIl: riga.creato_il ?? '',
    scadeIl: riga.data_fine,
    nota: riga.stato?.trim() || null,
  }
}

// ─── Ordinamento e filtri ────────────────────────────────────────────────────

/**
 * Dal più recente al più vecchio, guardando la firma se c'è e la creazione
 * altrimenti: in un elenco di documenti firmati la data che conta è quella
 * della firma. Le righe senza data finiscono in fondo, non in cima: una stringa
 * vuota, ordinata come tale, le manderebbe prime.
 */
export function ordinaDocumenti(documenti: DocumentoAlunno[]): DocumentoAlunno[] {
  return [...documenti].sort((a, b) => {
    const da = a.firmatoIl || a.creatoIl
    const db = b.firmatoIl || b.creatoIl
    if (!da && !db) return 0
    if (!da) return 1
    if (!db) return -1
    return db.localeCompare(da)
  })
}

/**
 * Toglie i documenti sanitari a chi non può vederli.
 *
 * Non è un filtro cosmetico: è l'ultima riga fra un'insegnante di un'altra
 * sezione e la diagnosi di un bambino che non è suo. Chi la chiama passa
 * l'esito di `puoAccedereFascicolo`, non il ruolo.
 */
export function filtraPerVisibilita(
  documenti: DocumentoAlunno[],
  alunniConAccessoSanitario: ReadonlySet<string>,
): DocumentoAlunno[] {
  return documenti.filter(
    (d) => d.categoria !== 'sanitario' || alunniConAccessoSanitario.has(d.alunnoId),
  )
}

/** Conteggi per la testata della sezione. */
export function riepilogo(documenti: DocumentoAlunno[]): {
  totale: number
  firmati: number
  sanitari: number
  inScadenza: number
} {
  return {
    totale: documenti.length,
    firmati: documenti.filter((d) => d.firmato).length,
    sanitari: documenti.filter((d) => d.categoria === 'sanitario').length,
    inScadenza: documenti.filter((d) => d.scadeIl !== null).length,
  }
}
