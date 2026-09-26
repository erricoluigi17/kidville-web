import { describe, it, expect } from 'vitest'
import {
  validateField, validatePage, isProvinceField, MSG_SCEGLI_OPZIONE, MSG_SCEGLI_DA_ELENCO,
  MSG_CODICE_FISCALE_NON_VALIDO,
} from '@/lib/forms/validate-fields'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
import { carattereControllo } from '@/lib/fiscale/calcolo'
import { FORMA_CF, OMOCODIA_DA_CIFRA, POSIZIONI_NUMERICHE } from '@/lib/fiscale/tabelle'
import { CHILD_FIELDS, ADULT_FIELDS, CF_PATTERN_ISCRIZIONE } from '@/lib/forms/enrollment-template'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import { ANAGRAFICA_GROUPS } from '@/lib/forms/anagrafica-fields'
import type { FormField } from '@/types/database.types'

const f = (over: Partial<FormField> & { id: string; type: FormField['type'] }): FormField => ({
  label: over.label ?? over.id,
  ...over,
})

describe('isProvinceField', () => {
  it('riconosce i campi provincia dal suffisso _province', () => {
    expect(isProvinceField(f({ id: 'birth_province', type: 'text' }))).toBe(true)
    expect(isProvinceField(f({ id: 'residence_province', type: 'text' }))).toBe(true)
    expect(isProvinceField(f({ id: 'children.0.birth_province', type: 'text' }))).toBe(true)
  })
  it('NON considera provincia i campi normali', () => {
    expect(isProvinceField(f({ id: 'nome', type: 'text' }))).toBe(false)
    expect(isProvinceField(f({ id: 'birth_city', type: 'text' }))).toBe(false)
    expect(isProvinceField(f({ id: 'province_note', type: 'text' }))).toBe(false)
  })
})

describe('validateField — required', () => {
  it('campo obbligatorio vuoto → messaggio italiano', () => {
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), '')).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), '   ')).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), undefined)).toBe('Campo obbligatorio')
    expect(validateField(f({ id: 'nome', type: 'text', required: true }), null)).toBe('Campo obbligatorio')
  })
  it('campo facoltativo vuoto → nessun errore (niente pattern/min su vuoto)', () => {
    expect(validateField(f({ id: 'birth_province', type: 'text', validation: { pattern: '^[A-Z]{2}$', max_length: 2 } }), '')).toBeNull()
    expect(validateField(f({ id: 'note', type: 'textarea', validation: { min_length: 5 } }), '')).toBeNull()
  })
  it('checkbox obbligatorio senza selezioni → obbligatorio', () => {
    // ⚠️ NON PIÙ «Campo obbligatorio»: dal 25/08 un gruppo a spunta vuoto risponde
    // con la frase che il modulo usa già al passo «sede» per lo stesso predicato
    // («almeno uno di N»). Il ramo per tipo era arrivato al solo `file` il 24/08, e
    // lasciava la stessa schermata a parlare due dialetti.
    expect(validateField(f({ id: 'scelte', type: 'checkbox', required: true, options: [{ label: 'A', value: 'a' }] }), [])).toBe(MSG_SCEGLI_OPZIONE)
    expect(validateField(f({ id: 'menu', type: 'select', required: true, options: [{ label: 'A', value: 'a' }] }), '')).toBe(MSG_SCEGLI_DA_ELENCO)
    // ⚠️ IL TERZO TIPO, E STA COL MENU. `radio` è reso come `role="radiogroup"`,
    // che accetta ESATTAMENTE UNA opzione: fino al settimo giro condivideva il ramo
    // del gruppo a spunta e prometteva «almeno una». Senza questa riga i due rami
    // possono tornare a fondersi senza che niente diventi rosso — nessun template di
    // prodotto usa `radio` oggi, ma il costruttore della segreteria lo offre e quei
    // moduli li compilano i genitori.
    expect(validateField(f({ id: 'scelta_singola', type: 'radio', required: true, options: [{ label: 'A', value: 'a' }] }), '')).toBe(MSG_SCEGLI_DA_ELENCO)
    expect(validateField(f({ id: 'scelta_singola', type: 'radio', required: true, options: [{ label: 'A', value: 'a' }] }), undefined)).toBe(MSG_SCEGLI_DA_ELENCO)
    expect(validateField(f({ id: 'scelte', type: 'checkbox', required: true, options: [{ label: 'A', value: 'a' }] }), ['a'])).toBeNull()
  })
})

describe('validateField — pattern provincia', () => {
  const prov = f({ id: 'residence_province', type: 'text', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } })
  it('sigla valida → nessun errore', () => {
    expect(validateField(prov, 'NA')).toBeNull()
  })
  it('nome per esteso (non normalizzato) → messaggio provincia chiaro', () => {
    const msg = validateField(prov, 'Napoli')
    expect(msg).toContain('sigla della provincia')
  })
  it('sigla minuscola → fallisce il pattern (case sensitive)', () => {
    expect(validateField(prov, 'na')).toContain('sigla della provincia')
  })
  it('usa il placeholder come esempio nel messaggio', () => {
    expect(validateField(prov, 'XYZ')).toBe('Inserisci la sigla della provincia (es. RM)')
  })
})

describe('validateField — provincia INESISTENTE (appartenenza all\'elenco reale)', () => {
  // Regressione della CAUSA RADICE 1: una sigla FORMALMENTE valida (2 lettere
  // maiuscole → passa il pattern ^[A-Z]{2}$) ma che NON è una provincia italiana
  // reale ('XY', 'ZZ', 'QQ') passava wizard e POST e moriva solo al pre-flight
  // dell'import in segreteria, dove l'operatore non può più correggerla. Ora
  // `validateField` valida l'APPARTENENZA all'elenco reale delle province.
  const prov = f({ id: 'residence_province', type: 'text', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } })

  it('sigla formalmente valida ma inesistente → errore (non passa più il solo pattern)', () => {
    expect(validateField(prov, 'XY')).toContain('inesistente')
    expect(validateField(prov, 'ZZ')).toContain('inesistente')
    expect(validateField(prov, 'QQ')).toContain('inesistente')
  })
  it('sigla reale → nessun errore', () => {
    expect(validateField(prov, 'NA')).toBeNull()
    expect(validateField(prov, 'MI')).toBeNull()
    expect(validateField(prov, 'RM')).toBeNull()
  })

  // Su un campo provincia SENZA pattern maiuscolo la sigla reale passa anche
  // minuscola (appartenenza case-insensitive), mentre un nome per esteso resta
  // NON valido: la semantica è che il valore finale valido è una SIGLA.
  const provSenzaPattern = f({ id: 'birth_province', type: 'text', required: true, placeholder: 'Es. NA' })
  it('sigla reale minuscola → ok (appartenenza case-insensitive)', () => {
    expect(validateField(provSenzaPattern, 'na')).toBeNull()
    expect(validateField(provSenzaPattern, 'NA')).toBeNull()
  })
  it('nome per esteso → resta non valido (il valore finale valido è una sigla)', () => {
    expect(validateField(provSenzaPattern, 'Napoli')).not.toBeNull()
  })
  it('sigla inesistente anche senza pattern → errore', () => {
    expect(validateField(provSenzaPattern, 'XY')).toContain('inesistente')
  })
})

describe('validateField — pattern CAP e codice fiscale', () => {
  it('CAP non valido → messaggio dedicato', () => {
    const cap = f({ id: 'zip_code', type: 'text', validation: { pattern: '^[0-9]{5}$', min_length: 5, max_length: 5 } })
    expect(validateField(cap, '00100')).toBeNull()
    expect(validateField(cap, '12')).toContain('CAP')
  })
  it('codice fiscale non valido → messaggio dedicato', () => {
    const cf = f({ id: 'codice_fiscale', type: 'text', validation: { pattern: '^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$', min_length: 16, max_length: 16 } })
    // ⚠️ Fino al 2026-09-14 qui c'era un codice con la FORMA giusta e il carattere di
    // controllo sbagliato, e il test lo dava per valido: era la stessa cecità che ha
    // fatto nascere i doppioni (vedi il blocco sul carattere di controllo qui sotto).
    // `Z999` non è il codice catastale di nessun comune: il codice non è di nessuno.
    expect(validateField(cf, 'XQQYKV19C07Z999T')).toBeNull()
    expect(validateField(cf, 'ABC')).toContain('codice fiscale')
  })
})

/**
 * ── IL CARATTERE DI CONTROLLO, ALLA FONTE (2026-09-14) ──────────────────────────
 *
 * MISURATO in produzione: nella stessa sede 7 coppie di alunni DOPPI, e in tutte i due
 * codici fiscali differiscono per un carattere solo, e uno dei due ha il carattere di
 * controllo sbagliato. Il refuso della famiglia nel modulo pubblico passava, perché la
 * regola guardava la sola FORMA (`pattern`): la deduplica per codice fiscale non
 * riconosceva il bambino, e ne nasceva un secondo — con le rette doppie ai genitori.
 *
 * Il campo si riconosce dal SIGNIFICATO, non dal pattern: il modello del modulo arriva
 * anche dal database (costruttore della segreteria), dove il pattern può mancare o
 * essere diverso, e l'`id` di un campo preimpostato è un uuid.
 *
 * I codici qui sotto usano `Z999`, che non è il codice catastale di nessun luogo: sono
 * aritmeticamente validi e non appartengono a nessuno (il repository è pubblico).
 */
describe('validateField — codice fiscale: il carattere di controllo, non solo la forma', () => {
  const CF_VALIDO = 'XQQYKV19C07Z999T'
  const CF_CONTROLLO_SBAGLIATO = 'XQQYKV19C07Z999A'
  const CF_OMOCODICO = 'XQQYKV19CLTZ999B'
  /**
   * La forma del modulo d'iscrizione. Fino al 26/09/2026 era una copia a sole cifre
   * (senza omocodia) scritta qui a mano; ora è la costante del template, così questo
   * blocco prova il pattern che il modulo usa davvero.
   */
  const PATTERN_ISCRIZIONE = CF_PATTERN_ISCRIZIONE

  it('i codici di prova sono davvero quello che dicono di essere', () => {
    // Se uno di questi cadesse, i test sotto proverebbero un ramo diverso da quello
    // che nominano, e resterebbero verdi senza dirlo.
    expect(validaCodiceFiscale(CF_VALIDO).valido).toBe(true)
    expect(validaCodiceFiscale(CF_CONTROLLO_SBAGLIATO).motivi).toEqual(['checksum'])
    expect(validaCodiceFiscale(CF_OMOCODICO)).toMatchObject({ valido: true, omocodia: true })
    // ⚠️ PRIMA CHE LA COSTANTE ESISTA `undefined === undefined` è vero: senza questa
    // riga un confronto con la costante approverebbe un messaggio mai scritto.
    expect(MSG_CODICE_FISCALE_NON_VALIDO).toBe('Il codice fiscale non è valido: controlla lettere e numeri')
  })

  it('carattere di controllo sbagliato → respinto, anche se la FORMA combacia col pattern', () => {
    const cf = f({ id: 'codice_fiscale', type: 'text', required: true, db_mapping: 'alunni.codice_fiscale', validation: { pattern: PATTERN_ISCRIZIONE, min_length: 16, max_length: 16 } })
    expect(validateField(cf, CF_CONTROLLO_SBAGLIATO)).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
  })

  it('codice valido → nessun errore', () => {
    const cf = f({ id: 'codice_fiscale', type: 'text', required: true, db_mapping: 'alunni.codice_fiscale', validation: { pattern: PATTERN_ISCRIZIONE, min_length: 16, max_length: 16 } })
    expect(validateField(cf, CF_VALIDO)).toBeNull()
  })

  it('omocodico valido → nessun errore: è un codice vero, assegnato dall’Agenzia', () => {
    // ⚠️ Questo caso usa un campo SENZA pattern, e per questo fino al 26/09/2026 non
    // vedeva che il pattern del modulo d'iscrizione respingeva l'omocodico. Il caso con
    // i campi veri del modulo sta nel blocco «OMOCODICO con il pattern del modulo».
    const senzaPattern = f({ id: 'fiscal_code', type: 'text', required: true, db_mapping: 'pratiche_personale.fiscal_code' })
    expect(validateField(senzaPattern, CF_OMOCODICO)).toBeNull()
    expect(validateField(senzaPattern, 'XQQYKVMVCLTZVVVV')).toBeNull()
  })

  it('campo vuoto: facoltativo passa, obbligatorio resta «Campo obbligatorio»', () => {
    // Mancante non è sbagliato: dire «non è valido» a chi non ha scritto niente
    // direbbe che quello che non c'è è scritto male.
    const facoltativo = f({ id: 'fiscal_code', type: 'text', db_mapping: 'adults.fiscal_code' })
    expect(validateField(facoltativo, '')).toBeNull()
    expect(validateField(facoltativo, '   ')).toBeNull()
    expect(validateField(facoltativo, undefined)).toBeNull()
    const obbligatorio = f({ id: 'fiscal_code', type: 'text', required: true, db_mapping: 'adults.fiscal_code' })
    expect(validateField(obbligatorio, '')).toBe('Campo obbligatorio')
  })

  it('riconosciuto dal `db_mapping`, SENZA pattern e con un id qualunque (costruttore di moduli)', () => {
    // È la forma dei campi preimpostati di `anagrafica-fields.ts`: id = uuid.
    for (const db_mapping of ['alunni.codice_fiscale', 'adults.fiscal_code', 'parents.fiscal_code']) {
      const campo = f({ id: '3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0d', type: 'text', db_mapping })
      expect(validateField(campo, CF_CONTROLLO_SBAGLIATO), db_mapping).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
      expect(validateField(campo, CF_VALIDO), db_mapping).toBeNull()
    }
  })

  it('riconosciuto dall’`id`, anche quando il wizard lo mette sotto un gruppo ripetuto', () => {
    for (const id of ['codice_fiscale', 'fiscal_code', 'children.0.codice_fiscale', 'adults.1.fiscal_code']) {
      const campo = f({ id, type: 'text' })
      expect(validateField(campo, CF_CONTROLLO_SBAGLIATO), id).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
      expect(validateField(campo, CF_VALIDO), id).toBeNull()
    }
  })

  it('senza pattern respinge anche ciò che non ha nemmeno la forma di un codice fiscale', () => {
    const campo = f({ id: 'fiscal_code', type: 'text' })
    expect(validateField(campo, 'ABC')).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
    expect(validateField(campo, '1234567890123456')).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
  })

  it('CONTROLLO NEGATIVO: un campo che non è un codice fiscale non passa da questo controllo', () => {
    // Senza queste righe il riconoscimento potrebbe allargarsi a qualunque testo di
    // sedici caratteri e questo blocco resterebbe verde.
    const nonCf = [
      f({ id: 'document_number', type: 'text', db_mapping: 'parents.document_number' }),
      f({ id: 'nome', type: 'text', db_mapping: 'alunni.nome' }),
      f({ id: 'codice_fiscale_intestatario', type: 'text', db_mapping: 'fatture.codice_fiscale_intestatario' }),
    ]
    for (const campo of nonCf) expect(validateField(campo, CF_CONTROLLO_SBAGLIATO), campo.id).toBeNull()
  })

  it('i template VERI respingono il refuso: iscrizione (bambino e adulto), personale, preimpostati', () => {
    // Se un template cambiasse `id` o `db_mapping`, il suo codice fiscale tornerebbe a
    // essere controllato per la sola forma — e questo test lo direbbe per nome.
    const preimpostati = ANAGRAFICA_GROUPS.flatMap((g) => g.fields)
      .filter((p) => /\.(codice_fiscale|fiscal_code)$/.test(p.presetId))
      .map((p) => p.toFormField())
    const campi: [string, FormField | undefined][] = [
      ['CHILD_FIELDS', CHILD_FIELDS.find((c) => c.id === 'codice_fiscale')],
      ['ADULT_FIELDS', ADULT_FIELDS.find((c) => c.id === 'fiscal_code')],
      ['PERSONALE_FIELDS', PERSONALE_FIELDS.find((c) => c.id === 'fiscal_code')],
      ...preimpostati.map((c, i): [string, FormField] => [`preimpostato ${i}`, c]),
    ]
    // Bambino + tre adulti preimpostati: se il filtro non trovasse niente, il ciclo
    // sotto approverebbe un elenco vuoto.
    expect(preimpostati).toHaveLength(4)
    for (const [nome, campo] of campi) {
      expect(campo, `${nome}: il campo del codice fiscale non c'è più`).toBeDefined()
      expect(validateField(campo!, CF_CONTROLLO_SBAGLIATO), nome).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
      expect(validateField(campo!, CF_VALIDO), nome).toBeNull()
    }
  })

  it('validatePage riporta il codice fiscale sotto il SUO id: è ciò che il 400 del server manda al modulo', () => {
    const campi = [
      f({ id: 'nome', type: 'text', required: true }),
      f({ id: 'codice_fiscale', type: 'text', required: true, db_mapping: 'alunni.codice_fiscale' }),
    ]
    // Le CHIAVI prima del testo: `toEqual` tratta `{}` e `{ codice_fiscale: undefined }`
    // come uguali, e un confronto sul solo oggetto approverebbe un campo mai segnalato.
    const errori = validatePage(campi, { nome: 'Prova', codice_fiscale: CF_CONTROLLO_SBAGLIATO })
    expect(Object.keys(errori)).toEqual(['codice_fiscale'])
    expect(errori.codice_fiscale).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
    expect(validatePage(campi, { nome: 'Prova', codice_fiscale: CF_VALIDO })).toEqual({})
  })
})

/**
 * ── L'OMOCODICO NEL MODULO D'ISCRIZIONE VERO (2026-09-26) ───────────────────────
 *
 * Il blocco sopra provava l'omocodia su un campo SENZA pattern (`fiscal_code` nudo), e
 * lì passava. Ma i campi veri del modulo d'iscrizione — `CHILD_FIELDS`, `ADULT_FIELDS`
 * e i preimpostati di `anagrafica-fields.ts` — dichiaravano
 * `^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$`: il pattern respingeva
 * l'omocodico con «Inserisci un codice fiscale valido (16 caratteri)» PRIMA che il
 * carattere di controllo venisse guardato. Una famiglia con un codice vero, assegnato
 * dall'Agenzia, non poteva inviare la domanda.
 *
 * Regola decisa dal titolare: un codice con il carattere di controllo giusto si accetta
 * SEMPRE. Qui si prova sui campi dei template, non su un campo costruito a mano.
 *
 * Gli omocodici si COSTRUISCONO da un codice che non è di nessuno (`Z999` non è il
 * codice catastale di nessun luogo): si sostituiscono le cifre con le lettere
 * dell'Agenzia partendo da destra, e il carattere di controllo lo calcola
 * `carattereControllo`. Nessun codice di persona reale (il repository è pubblico).
 */
describe('validateField — codice fiscale OMOCODICO con il pattern del modulo d’iscrizione', () => {
  const PRIMI_15 = 'XQQYKV19C07Z999'

  /** Sostituisce le ultime `quante` posizioni numeriche (da destra) e ricalcola il controllo. */
  const omocodico = (quante: number): string => {
    const c = PRIMI_15.split('')
    for (const pos of [...POSIZIONI_NUMERICHE].reverse().slice(0, quante)) {
      c[pos] = OMOCODIA_DA_CIFRA[c[pos]]!
    }
    const primi = c.join('')
    return primi + carattereControllo(primi)
  }
  /** Stesso codice con il carattere di controllo SBAGLIATO (il successivo nell'alfabeto). */
  const conControlloSbagliato = (cf: string): string => {
    const giusto = cf.charCodeAt(15) - 65
    return cf.slice(0, 15) + String.fromCharCode(65 + ((giusto + 1) % 26))
  }

  const OMOCODICI = [1, 2, 3, 7].map(omocodico)
  const OMOCODICI_SBAGLIATI = OMOCODICI.map(conControlloSbagliato)

  const preimpostati = () => ANAGRAFICA_GROUPS.flatMap((g) => g.fields)
    .filter((p) => /\.(codice_fiscale|fiscal_code)$/.test(p.presetId))
    .map((p): [string, FormField] => [`preimpostato ${p.presetId}`, p.toFormField()])
  const campiDelModulo = (): [string, FormField][] => [
    ['CHILD_FIELDS.codice_fiscale', CHILD_FIELDS.find((c) => c.id === 'codice_fiscale')!],
    ['ADULT_FIELDS.fiscal_code', ADULT_FIELDS.find((c) => c.id === 'fiscal_code')!],
    ...preimpostati(),
  ]

  it('i codici costruiti sono davvero omocodici validi, e quelli «sbagliati» falliscono SOLO il controllo', () => {
    // Se la costruzione sbagliasse, i test sotto proverebbero un'altra cosa restando verdi.
    expect(new Set(OMOCODICI).size).toBe(4)
    for (const cf of OMOCODICI) {
      expect(validaCodiceFiscale(cf), cf).toMatchObject({ valido: true, omocodia: true })
    }
    for (const cf of OMOCODICI_SBAGLIATI) {
      expect(validaCodiceFiscale(cf).motivi, cf).toEqual(['checksum'])
    }
    // Tutte e sette le posizioni numeriche sono lettere nell'ultimo.
    expect(OMOCODICI[3]).toMatch(/^[A-Z]{16}$/)
  })

  it('ogni campo codice fiscale del modulo dichiara un pattern (altrimenti il test sotto non proverebbe il pattern)', () => {
    const campi = campiDelModulo()
    // Bambino + adulto del template + quattro preimpostati (bambino, madre, padre, delegato).
    expect(campi).toHaveLength(6)
    for (const [nome, campo] of campi) {
      expect(campo, nome).toBeDefined()
      expect(campo.validation?.pattern, `${nome}: nessun pattern`).toBeTruthy()
    }
  })

  it('omocodico con controllo GIUSTO → accettato da ogni campo del modulo', () => {
    for (const [nome, campo] of campiDelModulo()) {
      for (const cf of OMOCODICI) expect(validateField(campo, cf), `${nome} · ${cf}`).toBeNull()
    }
  })

  it('omocodico con controllo SBAGLIATO → respinto per il CONTROLLO, non per la forma', () => {
    // Il messaggio è quello del carattere di controllo: vuol dire che il pattern l'ha
    // lasciato passare e che il rifiuto viene da `validaCodiceFiscale`. Con il pattern
    // vecchio il messaggio sarebbe «Inserisci un codice fiscale valido (16 caratteri)».
    for (const [nome, campo] of campiDelModulo()) {
      for (const cf of OMOCODICI_SBAGLIATI) {
        expect(validateField(campo, cf), `${nome} · ${cf}`).toBe(MSG_CODICE_FISCALE_NON_VALIDO)
      }
    }
  })

  it('CONTROLLO NEGATIVO: la forma resta stretta — mese inesistente o lettera fuori tabella respinti dal pattern', () => {
    const campo = CHILD_FIELDS.find((c) => c.id === 'codice_fiscale')!
    // Mese `Z` (non è fra le dodici lettere): il carattere di controllo è ricalcolato
    // apposta, così il rifiuto non può venire dal controllo.
    const meseZ = 'XQQYKV19Z07Z999'
    expect(validateField(campo, meseZ + carattereControllo(meseZ))).toBe('Inserisci un codice fiscale valido (16 caratteri)')
    // `A` in una posizione numerica non è una lettera d'omocodia.
    const letteraFuori = 'XQQYKV19C07Z99A'
    expect(validateField(campo, letteraFuori + carattereControllo(letteraFuori))).toBe('Inserisci un codice fiscale valido (16 caratteri)')
    // Minuscole: il pattern del modulo è a maiuscole, come lo era quello vecchio — questo
    // intervento allarga le sole posizioni numeriche, non la classe delle lettere.
    expect(validateField(campo, OMOCODICI[0].toLowerCase())).toBe('Inserisci un codice fiscale valido (16 caratteri)')
  })
})

/**
 * ── LA FORMA DEL CODICE FISCALE, UNA SOLA NEL MODULO D'ISCRIZIONE ────────────────
 *
 * Prima di oggi la stessa stringa viveva copiata in `enrollment-template.ts` e in
 * `anagrafica-fields.ts`; ora c'è UNA costante, `CF_PATTERN_ISCRIZIONE`. Ma il pattern
 * esiste anche fuori dal codice, e lì non si può importare: nello schema salvato in
 * `form_models`, riscritto dalla migrazione `20260926100200`. Se le due copie
 * divergessero, il modulo in produzione (che usa lo schema SALVATO) e il template in
 * codice direbbero cose diverse sullo stesso codice.
 */
describe('CF_PATTERN_ISCRIZIONE — una forma sola, confrontata con le sue copie', () => {
  const migrazione = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260926100200_form_models_cf_omocodia.sql'),
    'utf8',
  )

  it('è la costante usata da TUTTI i campi codice fiscale del modulo (template e preimpostati)', () => {
    expect(CF_PATTERN_ISCRIZIONE, 'la costante non è esportata').toBeTruthy()
    const preimpostati = ANAGRAFICA_GROUPS.flatMap((g) => g.fields)
      .filter((p) => /\.(codice_fiscale|fiscal_code)$/.test(p.presetId))
      .map((p) => p.toFormField())
    const campi = [
      CHILD_FIELDS.find((c) => c.id === 'codice_fiscale'),
      ADULT_FIELDS.find((c) => c.id === 'fiscal_code'),
      ...preimpostati,
    ]
    expect(campi).toHaveLength(6)
    for (const campo of campi) expect(campo?.validation?.pattern).toBe(CF_PATTERN_ISCRIZIONE)
  })

  it('coincide carattere per carattere con il pattern NUOVO scritto dalla migrazione in `form_models`', () => {
    // La `replace(schema::text, '<vecchio>', '<nuovo>')`: il secondo letterale è il nuovo.
    const m = /replace\(\s*schema::text,\s*'([^']+)',\s*'([^']+)'\s*\)/.exec(migrazione)
    expect(m, 'la replace() della migrazione non è più riconoscibile').not.toBeNull()
    expect(m![1]).toBe('^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$')
    expect(m![2]).toBe(CF_PATTERN_ISCRIZIONE)
  })

  it('è anche il pattern del modulo del personale (che lo importa, e i cui CHECK lo vincolano)', () => {
    const personale = PERSONALE_FIELDS.find((c) => c.id === 'fiscal_code')?.validation?.pattern
    expect(personale).toBe(CF_PATTERN_ISCRIZIONE)
  })

  it('dà lo stesso verdetto di `FORMA_CF` (la fonte in `@/lib/fiscale`) su ogni codice in MAIUSCOLO', () => {
    // Non si confrontano le `source`: `FORMA_CF` ammette le minuscole, il pattern del
    // modulo no. A dover coincidere è il verdetto su ciò che il campo lascia arrivare.
    const forma = new RegExp(CF_PATTERN_ISCRIZIONE)
    const sonde = [
      'XQQYKV19C07Z999T', // ordinario
      'XQQYKVM9C07Z999T', // omocodia sull'anno
      'XQQYKV19CLTZVVVT', // omocodia su giorno e catastale
      'XQQYKVMVCLTZVVVT', // omocodia su tutte le posizioni numeriche
      'XQQYKV19Z07Z999T', // mese `Z`: non esiste
      'XQQYKV19C07Z99AT', // `A` in posizione numerica: non è omocodia
      'XQQYKV19C07Z9991', // ultimo carattere numerico
      'XQQYKV19C07Z999', // quindici caratteri
      'XQQYKV19C07Z999TT', // diciassette
      '',
    ]
    // Ogni lettera (A-Z) e ogni cifra in ciascuna delle sette posizioni numeriche, e
    // ogni lettera in quella del mese: una classe che perdesse o guadagnasse anche un
    // solo carattere darebbe un verdetto diverso da `FORMA_CF` su almeno una sonda.
    const BASE = 'XQQYKV19C07Z999T'
    const caratteri = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
    for (const pos of [...POSIZIONI_NUMERICHE, 8]) {
      for (const ch of caratteri) sonde.push(BASE.slice(0, pos) + ch + BASE.slice(pos + 1))
    }
    expect(sonde.length).toBe(10 + 8 * 36)
    for (const s of sonde) expect(forma.test(s), `verdetti diversi su «${s}»`).toBe(FORMA_CF.test(s))
  })
})

describe('validateField — lunghezze e tipi', () => {
  it('min_length', () => {
    expect(validateField(f({ id: 'nome', type: 'text', validation: { min_length: 2 } }), 'A')).toBe('Inserisci almeno 2 caratteri')
  })
  it('max_length', () => {
    expect(validateField(f({ id: 'civ', type: 'text', validation: { max_length: 3 } }), 'ABCD')).toBe('Inserisci al massimo 3 caratteri')
  })
  it('email non valida', () => {
    expect(validateField(f({ id: 'email', type: 'email' }), 'non-una-email')).toContain('email')
    expect(validateField(f({ id: 'email', type: 'email' }), 'a@b.it')).toBeNull()
  })
  it('numero non valido + min/max', () => {
    expect(validateField(f({ id: 'n', type: 'number' }), 'abc')).toContain('numero')
    expect(validateField(f({ id: 'n', type: 'number', validation: { min: 5 } }), '3')).toBe('Il valore minimo è 5')
    expect(validateField(f({ id: 'n', type: 'number', validation: { max: 5 } }), '9')).toBe('Il valore massimo è 5')
    expect(validateField(f({ id: 'n', type: 'number', validation: { min: 1, max: 10 } }), '5')).toBeNull()
  })
  it('data non valida', () => {
    expect(validateField(f({ id: 'd', type: 'date' }), 'non-data')).toContain('data')
    expect(validateField(f({ id: 'd', type: 'date' }), '2020-01-01')).toBeNull()
  })
  it('select fuori dalle opzioni', () => {
    const sel = f({ id: 'g', type: 'select', options: [{ label: 'M', value: 'M' }, { label: 'F', value: 'F' }] })
    expect(validateField(sel, 'X')).toBe('Selezione non valida')
    expect(validateField(sel, 'M')).toBeNull()
  })
  it('campi decorativi → mai errore', () => {
    expect(validateField(f({ id: 'h', type: 'section_header' }), undefined)).toBeNull()
    expect(validateField(f({ id: 'p', type: 'paragraph' }), undefined)).toBeNull()
    expect(validateField(f({ id: 's', type: 'signature' }), undefined)).toBeNull()
  })
})

describe('validatePage', () => {
  const fields: FormField[] = [
    f({ id: 'nome', type: 'text', required: true, validation: { min_length: 2 } }),
    f({ id: 'residence_province', type: 'text', required: true, validation: { pattern: '^[A-Z]{2}$', max_length: 2 } }),
    f({ id: 'note', type: 'textarea' }),
  ]
  it('ritorna solo i campi non validi, keyed per id', () => {
    const errs = validatePage(fields, { nome: 'A', residence_province: 'Napoli', note: '' })
    expect(Object.keys(errs).sort()).toEqual(['nome', 'residence_province'])
    expect(errs.nome).toBe('Inserisci almeno 2 caratteri')
    expect(errs.residence_province).toContain('sigla della provincia')
  })
  it('oggetto vuoto quando tutto è valido', () => {
    expect(validatePage(fields, { nome: 'Marco', residence_province: 'NA', note: 'ok' })).toEqual({})
  })
})
