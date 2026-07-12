/**
 * Auto-compilazione dei campi di registrazione (decisione #8 dello spec):
 * estrazione del testo dal PDF con unpdf + euristiche da lettera
 * amministrativa italiana ("OGGETTO:", "Prot. n. … del …", intestazione).
 * Nessun campo è garantito: le scansioni senza testo producono {} e la
 * segreteria compila a mano. Euristiche pure testate in
 * __tests__/lib/protocolli-estrai.test.ts.
 */

export type CampiSuggeriti = {
  oggetto?: string
  mittente?: string
  rifProtMittente?: string
  rifDataMittente?: string
}

/** gg/mm/aaaa (separatori / - .) → ISO aaaa-mm-gg; undefined se implausibile. */
export function parseDataItaliana(s: string): string | undefined {
  const m = s.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (!m) return undefined
  const giorno = Number(m[1])
  const mese = Number(m[2])
  let anno = Number(m[3])
  if (anno < 100) anno += 2000
  if (giorno < 1 || giorno > 31 || mese < 1 || mese > 12 || anno < 1900 || anno > 2200) {
    return undefined
  }
  return `${anno}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`
}

/** Righe che NON possono essere il mittente (destinatari, indirizzi, oggetto…). */
const RIGA_NON_MITTENTE =
  /^(spett|gent|egr|preg|al\s|alla\s|ai\s|all'|oggetto\b|prot\b|prot\.|via\s|viale\s|p\.?zza|piazza\s|c\.a\.|p\.?\s?iva|cod\.|tel\.|e-?mail|pec\b)/i

/** Euristiche sui campi: mai errori, al massimo suggerimenti vuoti. */
export function suggerisciCampi(testo: string): CampiSuggeriti {
  const campi: CampiSuggeriti = {}
  if (!testo || !testo.trim()) return campi

  const righe = testo.split(/\r?\n/).map((r) => r.trim())

  // Oggetto: prima riga "OGGETTO: …" / "Oggetto - …"
  for (const riga of righe) {
    const m = riga.match(/^oggetto\s*[:\-–]\s*(.+)$/i)
    if (m && m[1].trim()) {
      campi.oggetto = m[1].trim().slice(0, 300)
      break
    }
  }

  // Protocollo del mittente: "Prot. n. 12345/2026 del 03/07/2026"
  const mProt = testo.match(
    /prot(?:ocollo)?\.?\s*(?:n(?:um)?\.?\s*°?\s*)?([A-Za-z0-9][\w/.\-]*)(?:\s+del\s+(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}))?/i
  )
  if (mProt) {
    campi.rifProtMittente = mProt[1].slice(0, 60)
    if (mProt[2]) {
      const iso = parseDataItaliana(mProt[2])
      if (iso) campi.rifDataMittente = iso
    }
  }

  // Mittente: prima riga "da intestazione" tra le prime 8 significative
  // (non saluto/indirizzo, non frase di corpo che termina col punto).
  let esaminate = 0
  for (const riga of righe) {
    if (!riga) continue
    if (++esaminate > 8) break
    if (RIGA_NON_MITTENTE.test(riga)) continue
    if (riga.length < 3 || riga.length > 80) continue
    if (riga.endsWith('.')) continue
    if (!/[a-zA-Zà-ù]/.test(riga)) continue
    campi.mittente = riga
    break
  }

  return campi
}

/**
 * Testo integrale del PDF via unpdf (build serverless di PDF.js).
 * Import dinamico: le route che non analizzano non caricano la libreria.
 * Mai un errore: un PDF illeggibile/scansione restituisce stringa vuota.
 */
export async function estraiTesto(buf: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(buf)
    const { text } = await extractText(doc, { mergePages: true })
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}
