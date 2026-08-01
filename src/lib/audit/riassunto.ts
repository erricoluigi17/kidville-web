// =============================================================================
// Che cosa può entrare nel registro delle scritture — funzioni PURE.
//
// Vivono separate da `./scrittura.ts` (che parla col database) per una ragione
// pratica: decine di test mockano `@/lib/audit/scrittura` per intero, e una
// funzione esportata di lì sarebbe `undefined` dentro ogni route che la usa —
// cioè un guasto che nasce dai test invece che dal codice. Da qui, invece, si
// importa sempre l'implementazione vera.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// IL REGISTRO NON È UNA SECONDA COPIA DELL'ANAGRAFICA
//
// Fino al 2026-08-01 `valore_prima`/`valore_dopo` ricopiavano l'oggetto che il
// chiamante passava, qualunque cosa fosse. `admin/iscrizioni` ci metteva dentro
// il record INTEGRALE del bambino appena creato — nome, codice fiscale,
// indirizzo, allergie, note mediche — e in produzione erano 11 righe. Il solo
// rimedio era il job di retention a 12 mesi; ma una richiesta di cancellazione
// non può aspettare un anno (art. 17 GDPR, «senza ingiustificato ritardo»), e
// soprattutto quel dato in audit non serviva a nessuno: chi contesta una
// modifica vuole sapere CHI ha toccato COSA e QUANDO, non rileggere la scheda.
//
// La riduzione qui sotto è una LISTA NERA, non una lista bianca — al contrario
// di `@/lib/logging/redact`, e la differenza è voluta. `app_log` riceve oggetti
// di forma ignota e va difeso da tutto ciò che non è stato previsto; questa
// tabella riceve DIFF APPLICATIVI (voti, presenze, orari, importi) il cui valore
// è il motivo per cui il registro esiste. Una lista bianca lo svuoterebbe.
// Quindi si toglie ciò che identifica una persona o ne descrive la salute, e si
// lascia il resto — compreso il NOME DEL CAMPO, che resta sempre leggibile.
//
// Chi aggiunge un campo personale a una tabella lo aggiunga anche qui. Il lock
// `__tests__/lib/audit-senza-dati-personali.test.ts` verifica che i campi noti
// non escano in chiaro; per quelli nuovi resta la regola scritta.
// ─────────────────────────────────────────────────────────────────────────────

/** Marcatore che sostituisce il valore: il campo resta visibile, il dato no. */
export const VALORE_NON_REGISTRATO = '[non registrato]'

const norm = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** Campi il cui VALORE non entra nel registro. Le chiavi sono normalizzate. */
const CAMPI_RIDOTTI = new Set(
  [
    // identificativi diretti
    'nome', 'cognome', 'nome_completo', 'first_name', 'last_name', 'full_name',
    'codice_fiscale', 'fiscal_code', 'cf', 'denominazione',
    // contatti
    'email', 'mail', 'emails', 'telefono', 'cellulare', 'phone', 'phone_numbers',
    // nascita e residenza: da soli non identificano, insieme sì — ed è insieme
    // che compaiono in un diff di anagrafica
    'data_nascita', 'datanascita', 'birth_date', 'birthdate', 'date_of_birth',
    'birth_city', 'birth_province', 'birth_nation', 'birth_place',
    'comune_nascita', 'provincia_nascita', 'nazione_nascita', 'luogo_nascita',
    'residence_address', 'residence_street_number', 'residence_city',
    'residence_province', 'zip_code', 'indirizzo_residenza', 'civico',
    'comune_residenza', 'provincia_residenza', 'cap', 'indirizzo', 'address',
    // categorie particolari (art. 9): salute
    'allergies', 'allergie', 'allergeni', 'note_mediche', 'note_bes', 'bes',
    'is_bes_dsa', 'diagnosi', 'certificato', 'terapia', 'patologie',
    // documenti d'identità
    'documento_path', 'document_number', 'document_type', 'documento',
    // credenziali e firme
    'password', 'token', 'otp', 'firma', 'signature', 'iban',
  ].map(norm),
)

/** Profondità massima: i diff arrivano dai chiamanti, non si ricorre all'infinito. */
const PROFONDITA_MAX = 12

/**
 * Sostituisce con `[non registrato]` i valori dei campi personali, a qualunque
 * profondità. Il resto passa invariato.
 */
export function riduciValoreAudit(v: unknown, prof = 0): unknown {
  if (prof > PROFONDITA_MAX || v === null || v === undefined) return v
  if (Array.isArray(v)) return v.map((x) => riduciValoreAudit(x, prof + 1))
  if (typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = CAMPI_RIDOTTI.has(norm(k)) ? VALORE_NON_REGISTRATO : riduciValoreAudit(val, prof + 1)
  }
  return out
}

/**
 * L'elenco dei campi VALORIZZATI di un record, senza i valori.
 *
 * È ciò che va messo in `valoreDopo` quando si registra la CREAZIONE di
 * un'entità: «è stato creato un bambino, e sono stati compilati questi campi».
 * Il record intero non serve a nessuno — e in `admin/iscrizioni` era il modo in
 * cui 11 schede di minori sono finite nel registro.
 */
export function riassuntoCampi(record: Record<string, unknown>): { campi: string[] } {
  return {
    campi: Object.entries(record ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k]) => k)
      .sort(),
  }
}
