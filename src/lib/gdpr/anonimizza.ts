import { createHash } from 'crypto'

// Diritto all'oblio (DL-034). Helper PURI per l'anonimizzazione: producono i
// patch di update PII (nessuna DELETE) e la validazione della doppia conferma.

/** Placeholder deterministico per un campo identificativo sovrascritto. */
export function placeholderFor(id: string): string {
  const h = createHash('sha256').update(String(id)).digest('hex').slice(0, 8).toUpperCase()
  return `CANCELLATO-${h}`
}

/**
 * Patch di anonimizzazione per `alunni`: l'identità è sostituita con placeholder,
 * le PII sensibili azzerate, e si marca `anonimizzato_il`.
 */
export function patchAlunno(id: string, at: string): Record<string, unknown> {
  const ph = placeholderFor(id)
  return {
    nome: ph,
    cognome: ph,
    codice_fiscale: null,
    fiscal_code: null,
    note_mediche: null,
    allergies: null,
    allergeni: null,
    residence_address: null,
    residence_city: null,
    zip_code: null,
    birth_city: null,
    birth_province: null,
    birth_nation: null,
    documento_path: null,
    invoice_holder_details: null,
    intestatario_fatture: null,
    retta_split_config: null,
    anonimizzato_il: at,
  }
}

/** Patch di anonimizzazione per `parents`: PII azzerate + auth sganciato. */
export function patchParent(id: string, at: string): Record<string, unknown> {
  const ph = placeholderFor(id)
  return {
    first_name: ph,
    last_name: ph,
    fiscal_code: null,
    emails: null,
    phone_numbers: null,
    residence_address: null,
    residence_city: null,
    zip_code: null,
    birth_city: null,
    birth_province: null,
    birth_nation: null,
    document_number: null,
    documento_path: null,
    auth_user_id: null, // sgancia l'accesso del genitore cancellato
    anonimizzato_il: at,
  }
}

// ─── L'oblio dentro la DOMANDA DI ISCRIZIONE (privacy F2, 2026-07-31) ────────
//
// `enrollment_submissions.data` è la tabella di ORIGINE del dato: il modulo
// pubblico ci deposita, in un JSONB, tutto ciò che la famiglia ha scritto —
// nome, cognome, codice fiscale, data di nascita, residenza, ALLERGIE e NOTE
// MEDICHE del minore (categoria particolare, art. 9), identità completa, numero
// del documento, email e telefono degli adulti.
//
// L'oblio era stato costruito partendo dalle tabelle OPERATIVE (alunni, parents,
// pagamenti, incassi, cassa, diario, chat, segnalazioni) e questa non era mai
// entrata nell'elenco: dopo una cancellazione l'anagrafica risultava anonima e
// la domanda originale conservava tutto, in chiaro, per sempre.
//
// Gli helper qui sotto sono PURI: prendono il JSON, restituiscono il JSON
// ripulito e l'elenco dei `documento_path` incontrati (i file da togliere dallo
// storage — vedi `rimuoviFileOblio` in `./esegui.ts`). L'I/O sta altrove.

/**
 * Chiavi che SOPRAVVIVONO allo scrub di una persona dentro la domanda.
 *
 * ⚠️ Lista BIANCA, non lista nera, e la differenza non è di stile: una lista
 * nera dimentica per costruzione i campi che il modulo aggiungerà domani, e il
 * campo dimenticato resterebbe in chiaro senza che nessun test diventi rosso.
 * Stessa scelta — e stessa ragione — della redazione dei log
 * (`@/lib/logging/redact`). Qui dentro va SOLO ciò che non identifica nessuno:
 *  · `ruolo`  — «madre»/«padre»/«delegato»: dice come leggere la domanda, non chi è;
 *  · i due marcatori scritti da noi, che documentano l'intervento.
 */
export const CHIAVI_ISCRIZIONE_CONSERVATE = new Set([
  'ruolo',
  'anonimizzato_il',
  'sanitari_rimossi_il',
])

/** I due soli campi di categoria particolare (art. 9) presenti sul minore. */
export const CHIAVI_SANITARIE_ISCRIZIONE = ['allergies', 'note_mediche'] as const

/** Chiavi da cui si legge il codice fiscale: `children` e `adults` la chiamano diversamente. */
const CHIAVI_CF = ['codice_fiscale', 'fiscal_code'] as const

function normalizzaCf(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : ''
}

/**
 * Azzera i dati personali di UNA persona dentro `enrollment_submissions.data`,
 * conservando solo le chiavi della lista bianca e marcando `anonimizzato_il`.
 * Non rimuove chiavi (la forma del JSON resta leggibile): le porta a `null`.
 */
export function scrubPersonaIscrizione(
  persona: Record<string, unknown>,
  at: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(persona)) {
    out[k] = CHIAVI_ISCRIZIONE_CONSERVATE.has(k) ? persona[k] : null
  }
  out.anonimizzato_il = at
  return out
}

/** Un soggetto dell'oblio, riconoscibile dentro la domanda per CF o per allegato. */
export interface SoggettiIscrizione {
  /** Codici fiscali del soggetto (alunno e/o genitori). Confronto insensibile a maiuscole/spazi. */
  codiciFiscali?: (string | null | undefined)[]
  /** Percorsi di allegati già noti (`alunni.documento_path`, `parents.documento_path`). */
  documentoPaths?: (string | null | undefined)[]
}

/**
 * Scrubba dentro una domanda SOLO le persone che sono soggetto dell'oblio,
 * lasciando intatte le altre — un fratello, l'altro genitore, un delegato che
 * non ha chiesto nulla. Restituisce anche i `documento_path` incontrati: sono
 * l'unico posto da cui si ricava che nel bucket c'è un documento d'identità da
 * togliere (per gli ADULTI non esisteva NESSUN'altra strada: `patchParent`
 * azzera `parents.documento_path` e faceva *sembrare* che il file fosse sparito).
 */
export function scrubDomandaIscrizione(
  data: unknown,
  soggetti: SoggettiIscrizione,
  at: string,
): { data: Record<string, unknown>; personeScrubbate: number; documenti: string[] } {
  const originale = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const cfCercati = new Set(
    (soggetti.codiciFiscali ?? []).map(normalizzaCf).filter((v) => v.length > 0),
  )
  const pathCercati = new Set(
    (soggetti.documentoPaths ?? [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0),
  )
  if (cfCercati.size === 0 && pathCercati.size === 0) {
    return { data: originale, personeScrubbate: 0, documenti: [] }
  }

  let personeScrubbate = 0
  const documenti: string[] = []
  const out: Record<string, unknown> = { ...originale }

  for (const ramo of ['children', 'adults'] as const) {
    const lista = originale[ramo]
    if (!Array.isArray(lista)) continue
    out[ramo] = lista.map((voce) => {
      if (!voce || typeof voce !== 'object') return voce
      const persona = voce as Record<string, unknown>
      const cf = CHIAVI_CF.map((k) => normalizzaCf(persona[k])).find((v) => v.length > 0) ?? ''
      const docPath = typeof persona.documento_path === 'string' ? persona.documento_path.trim() : ''
      const coinvolta = (cf !== '' && cfCercati.has(cf)) || (docPath !== '' && pathCercati.has(docPath))
      if (!coinvolta) return persona
      personeScrubbate++
      if (docPath) documenti.push(docPath)
      return scrubPersonaIscrizione(persona, at)
    })
  }

  if (personeScrubbate === 0) return { data: originale, personeScrubbate: 0, documenti: [] }
  return { data: out, personeScrubbate, documenti: [...new Set(documenti)] }
}

/**
 * Toglie dalla domanda i SOLI campi sanitari dei minori, lasciando tutto il
 * resto. Serve alle domande già ACCOLTE: allergie e note mediche sono state
 * trasferite in anagrafica (`alunni.allergies` / `alunni.note_mediche`), che è
 * il posto da cui le legge la cucina e da cui l'oblio le cancella. La copia
 * dentro la domanda è ridondante — e usciva integra da `GET /api/admin/iscrizioni`
 * a ogni apertura di «Moduli ricevuti», per ogni ruolo di staff, per sempre.
 *
 * Non è una cancellazione: la domanda accolta resta un atto amministrativo, con
 * dentro chi ha chiesto cosa e quando.
 */
export function scrubSanitariDomanda(
  data: unknown,
  at: string,
): { data: Record<string, unknown>; minoriScrubbati: number } {
  const originale = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const lista = originale.children
  if (!Array.isArray(lista)) return { data: originale, minoriScrubbati: 0 }

  let minoriScrubbati = 0
  const children = lista.map((voce) => {
    if (!voce || typeof voce !== 'object') return voce
    const persona = voce as Record<string, unknown>
    const daPulire = CHIAVI_SANITARIE_ISCRIZIONE.filter(
      (k) => persona[k] !== null && persona[k] !== undefined && String(persona[k]).trim() !== '',
    )
    if (daPulire.length === 0) return persona
    minoriScrubbati++
    const copia: Record<string, unknown> = { ...persona, sanitari_rimossi_il: at }
    for (const k of CHIAVI_SANITARIE_ISCRIZIONE) copia[k] = null
    return copia
  })

  if (minoriScrubbati === 0) return { data: originale, minoriScrubbati: 0 }
  return { data: { ...originale, children }, minoriScrubbati }
}

/**
 * Bonifica dei `suggerimenti` di un movimento di riconciliazione: rimuove da ogni
 * elemento il campo `label` (= «Nome Cognome» dell'alunno, unico dato identificante
 * dentro il JSON), preservando i campi tecnici (pagamento_id, score, motivi, cf_match…).
 * Usato dal diritto all'oblio (DL-034) per bonificare i movimenti confermati collegati
 * all'alunno anonimizzato. Input non-array (null/oggetto) → `null` (niente da scrubbare).
 */
export function scrubSuggerimenti(suggerimenti: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(suggerimenti)) return null
  return suggerimenti.map((s) => {
    if (!s || typeof s !== 'object') return s as Record<string, unknown>
    const clone: Record<string, unknown> = { ...(s as Record<string, unknown>) }
    delete clone.label
    return clone
  })
}

/** Nominativo atteso per la doppia conferma: `COGNOME NOME` normalizzato. */
export function nomeConferma(alunno: { nome?: string | null; cognome?: string | null }): string {
  return `${(alunno.cognome ?? '').trim()} ${(alunno.nome ?? '').trim()}`.trim().toUpperCase()
}

/** Confronto della conferma digitata col nominativo, insensibile a maiuscole/spazi. */
export function confermaValida(input: unknown, alunno: { nome?: string | null; cognome?: string | null }): boolean {
  if (typeof input !== 'string' || input.trim().length === 0) return false
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase()
  return norm(input) === norm(nomeConferma(alunno))
}
