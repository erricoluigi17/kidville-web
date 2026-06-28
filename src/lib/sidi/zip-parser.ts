import JSZip from 'jszip'

/**
 * Parser del flusso SIDI di nuovi iscritti (file `.zip` ministeriale).
 *
 * ⚠️ Lo schema reale del tracciato SIDI non è noto finché non si dispone di un
 * campione/accreditamento. Questo parser implementa uno **schema assunto e
 * documentato** (manifest `domande.csv`/`domande.json` con colonne UPPER_SNAKE)
 * ed è **sostituibile**: l'unico punto da adattare al tracciato vero è
 * `normalizeSidiRow` (remap dei nomi colonna). La firma pubblica resta stabile.
 */

export interface SidiGenitore {
  codice_fiscale?: string
  nome?: string
  cognome?: string
  relazione?: string
  email?: string
  telefono?: string
}

export interface SidiDomandaRecord {
  numero_domanda: string
  alunno: {
    nome?: string
    cognome?: string
    codice_fiscale?: string
    data_nascita?: string
    sesso?: string
    comune_nascita?: string
    provincia_nascita?: string
  }
  genitori: SidiGenitore[]
  classe_richiesta?: string | null
  raw?: unknown
}

export interface SidiZipParseResult {
  records: SidiDomandaRecord[]
  byNumeroDomanda: Map<string, SidiDomandaRecord>
  warnings: string[]
}

// Lookup case-insensitive sulle chiavi del record grezzo.
function ci(raw: Record<string, unknown>): (key: string) => string | undefined {
  const map = new Map<string, unknown>()
  for (const [k, v] of Object.entries(raw)) map.set(k.toLowerCase(), v)
  return (key: string) => {
    const v = map.get(key.toLowerCase())
    if (v === undefined || v === null) return undefined
    const s = String(v).trim()
    return s.length ? s : undefined
  }
}

function readGenitore(get: (k: string) => string | undefined, n: number): SidiGenitore | null {
  const cf = get(`GENITORE${n}_CF`)
  const nome = get(`GENITORE${n}_NOME`)
  const cognome = get(`GENITORE${n}_COGNOME`)
  if (!cf && !nome && !cognome) return null
  return {
    codice_fiscale: cf,
    nome,
    cognome,
    relazione: get(`GENITORE${n}_RELAZIONE`),
    email: get(`GENITORE${n}_EMAIL`),
    telefono: get(`GENITORE${n}_TELEFONO`),
  }
}

/**
 * Normalizza UNA riga grezza del manifest in un `SidiDomandaRecord`.
 * **Unico punto sostituibile** quando arriverà il tracciato SIDI reale.
 * Ritorna `null` se manca il numero domanda (riga scartata + warning a monte).
 */
export function normalizeSidiRow(raw: Record<string, unknown>): SidiDomandaRecord | null {
  const get = ci(raw)
  const numero = get('NUMERO_DOMANDA')
  if (!numero) return null
  const genitori: SidiGenitore[] = []
  for (let n = 1; n <= 4; n++) {
    const g = readGenitore(get, n)
    if (g) genitori.push(g)
  }
  return {
    numero_domanda: numero,
    alunno: {
      nome: get('ALUNNO_NOME'),
      cognome: get('ALUNNO_COGNOME'),
      codice_fiscale: get('ALUNNO_CF'),
      data_nascita: get('ALUNNO_DATA_NASCITA'),
      sesso: get('ALUNNO_SESSO'),
      comune_nascita: get('ALUNNO_COMUNE_NASCITA'),
      provincia_nascita: get('ALUNNO_PROVINCIA_NASCITA'),
    },
    genitori,
    classe_richiesta: get('CLASSE_RICHIESTA') ?? null,
    raw,
  }
}

// Parser CSV minimale: rileva il delimitatore (',' o ';'), niente quoting nel
// tracciato assunto. Ritorna oggetti header→valore.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return []
  const delim = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const headers = lines[0].split(delim).map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(delim)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim()
    })
    return obj
  })
}

/** Estrae i record dal `.zip` SIDI (manifest `domande.csv` o `domande.json`). */
export async function parseSidiZip(zip: Buffer): Promise<SidiZipParseResult> {
  const warnings: string[] = []
  const records: SidiDomandaRecord[] = []

  let rawRows: Record<string, unknown>[] = []
  try {
    const archive = await JSZip.loadAsync(zip)
    const names = Object.keys(archive.files)
    const jsonName = names.find((n) => /domande\.json$/i.test(n)) ?? names.find((n) => /\.json$/i.test(n))
    const csvName = names.find((n) => /domande\.csv$/i.test(n)) ?? names.find((n) => /\.csv$/i.test(n))
    if (jsonName) {
      const content = await archive.files[jsonName].async('string')
      const parsed = JSON.parse(content)
      rawRows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.domande) ? parsed.domande : []
    } else if (csvName) {
      const content = await archive.files[csvName].async('string')
      rawRows = parseCsv(content)
    } else {
      warnings.push('Nessun manifest domande.csv/domande.json trovato nel pacchetto SIDI')
    }
  } catch (err) {
    warnings.push(`ZIP non leggibile: ${err instanceof Error ? err.message : 'errore'}`)
  }

  for (let i = 0; i < rawRows.length; i++) {
    const rec = normalizeSidiRow(rawRows[i])
    if (!rec) {
      warnings.push(`Riga ${i + 1}: numero domanda mancante, scartata`)
      continue
    }
    records.push(rec)
  }

  const byNumeroDomanda = new Map<string, SidiDomandaRecord>()
  for (const r of records) byNumeroDomanda.set(r.numero_domanda, r)

  return { records, byNumeroDomanda, warnings }
}
