import { describe, it, expect } from 'vitest'

import { buildParentRecord } from '@/lib/anagrafiche/parents'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL GIRO CHE NESSUNO MISURAVA: payload del form → record da scrivere.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `ScrollableAdultForm.validate()` produce un payload, `POST /api/admin/students`
 * e l'azione `create_parent` lo passano a `linkOrCreateParent`, che lo traduce in
 * colonne con `buildParentRecord`. In mezzo c'è un elenco di colonne SCRITTO A
 * MANO — e finora nessun test copriva il giro completo, quindi un campo nuovo
 * poteva sparire lì dentro con tutto il gate verde.
 *
 * È esattamente ciò che è successo a `codice_belfiore_nascita`: il form lo
 * produceva, il corpo della richiesta lo portava, e `buildParentRecord` non lo
 * nominava. Il difetto era invisibile perché la colonna in produzione è NULL su
 * 50 righe su 50 (misurato l'11 agosto): un campo che non arriva mai in archivio
 * si distingue da un campo che nessuno ha mai compilato solo se qualcuno guarda.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona, nessun codice fiscale con checksum
 * valida. `H501` e `NA` sono dati aperti dell'Agenzia, non dati di qualcuno.
 */

/** La forma esatta che esce da `ScrollableAdultForm.validate()`. */
const PAYLOAD_DAL_FORM = {
  first_name: 'Prova',
  last_name: 'Esempio',
  role: 'mother',
  gender: 'F',
  birth_date: '1985-03-07',
  citizenship: 'Italiana',
  birth_nation: 'Italia',
  birth_province: 'NA',
  birth_place: 'NAPOLI',
  codice_belfiore_nascita: 'H501',
  fiscal_code: 'AAAAAA00A00A000A',
  address: 'Via di Prova',
  civico: '12',
  residence_city: 'Giugliano in Campania',
  residence_province: 'na',
  zip_code: '80014',
  emails: ['segreteria@example.test'],
  phones: ['+39 333 000 0000'],
}

describe('buildParentRecord · il payload del form arriva in colonna', () => {
  it('il codice catastale sopravvive al giro: è il dato-cardine della cascata', () => {
    const record = buildParentRecord(PAYLOAD_DAL_FORM)
    // ⚠️ La riga che mancava. Senza, il Belfiore usciva dal form, viaggiava nel
    // corpo della richiesta e finiva nel nulla — su una colonna che ESISTE in
    // produzione (nullable, `character varying`, misurata l'11 agosto).
    expect(record.codice_belfiore_nascita).toBe('H501')
  })

  it('ogni campo del form trova la propria colonna, coi nomi che cambiano per strada', () => {
    const record = buildParentRecord(PAYLOAD_DAL_FORM)
    // Il form dice `birth_place`, la colonna si chiama `birth_city`. Il form dice
    // `address`/`civico`, le colonne `residence_address`/`residence_street_number`.
    // Mescolarli significa scrivere in una colonna che non esiste.
    expect(record).toMatchObject({
      first_name: 'Prova',
      last_name: 'Esempio',
      gender: 'F',
      birth_date: '1985-03-07',
      citizenship: 'Italiana',
      birth_nation: 'Italia',
      birth_city: 'NAPOLI',
      birth_province: 'NA',
      codice_belfiore_nascita: 'H501',
      fiscal_code: 'AAAAAA00A00A000A',
      residence_address: 'Via di Prova',
      residence_street_number: '12',
      residence_city: 'Giugliano in Campania',
      // La sigla si normalizza in maiuscolo: è una sigla, non un testo libero.
      residence_province: 'NA',
      zip_code: '80014',
    })
    expect(record.emails).toEqual(['segreteria@example.test'])
    expect(record.phone_numbers).toEqual(['+39 333 000 0000'])
  })

  it('il vuoto diventa `null`, non la stringa vuota — su UNIQUE è la differenza che conta', () => {
    const record = buildParentRecord({
      ...PAYLOAD_DAL_FORM,
      fiscal_code: '',
      codice_belfiore_nascita: null,
      birth_place: '',
      birth_date: '',
    })
    /**
     * `parents.fiscal_code` è UNIQUE (`parents_fiscal_code_key`): due righe possono
     * essere entrambe `NULL`, non entrambe `''`. In produzione, l'11 agosto, 26
     * genitori su 50 hanno `NULL` e **uno ha già la stringa vuota** — quindi il
     * secondo `''` sarebbe un `23505` su un dato ASSENTE.
     */
    expect(record.fiscal_code).toBeNull()
    // E il Belfiore: la colonna accetta solo `^[A-Z][0-9]{3}$`, quindi `''` sarebbe
    // un valore che non esiste scritto al posto dell'assenza.
    expect(record.codice_belfiore_nascita).toBeNull()
    expect(record.birth_city).toBeNull()
    expect(record.birth_date).toBeNull()
  })

  it('un codice fatto di soli spazi è un’assenza, non un valore', () => {
    const record = buildParentRecord({ ...PAYLOAD_DAL_FORM, fiscal_code: '   ', codice_belfiore_nascita: '  ' })
    expect(record.fiscal_code).toBeNull()
    expect(record.codice_belfiore_nascita).toBeNull()
  })

  it('per lo STAFF la cittadinanza porta il ruolo, e il resto non cambia', () => {
    // Workaround storico della tab Staff: `citizenship` = ruolo per
    // educator/coordinator/admin. Resta, e il Belfiore viaggia comunque.
    const record = buildParentRecord({ ...PAYLOAD_DAL_FORM, role: 'educator' })
    expect(record.citizenship).toBe('educator')
    expect(record.codice_belfiore_nascita).toBe('H501')
  })
})
