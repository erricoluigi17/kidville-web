/**
 * LE FORME CHE L'ANAGRAFICA DOCENTE RESTITUISCE — e nient'altro.
 *
 * Sono la lista bianca scritta come tipo: un campo che non sta qui non può uscire
 * dalle due route `/api/teacher/alunni`, perché la proiezione (`proiezione.ts`)
 * costruisce questi oggetti campo per campo e non copia mai una riga intera.
 * Restano fuori per decisione del titolare (2026-10-04): retta, fatturazione,
 * intestatari, sospensioni, documenti d'identità, nascita e residenza dei genitori.
 */

export type Grado = 'nido' | 'infanzia' | 'primaria'

export interface SezioneElenco {
  id: string
  nome: string
  grado: Grado | null
}

/** Una riga dell'elenco: quanto basta a riconoscere il bambino e a filtrare. */
export interface VoceElencoAlunno {
  id: string
  nome: string
  cognome: string
  sectionId: string | null
  grado: Grado | null
  dataNascita: string | null
  annoNascita: number | null
  sesso: 'M' | 'F' | null
  /** Chiavi degli allergeni (anche fuori dai 14 UE): MAI il testo libero. */
  allergeni: string[]
  haAllergie: boolean
  besDsa: boolean
  usaPannolino: boolean
  /** `null` = consenso non registrato, che per chi pubblica vale «senza consenso». */
  consensoFotoSito: boolean | null
  consensoFotoSocial: boolean | null
}

export interface ElencoAlunniRisposta {
  sezioni: SezioneElenco[]
  alunni: VoceElencoAlunno[]
}

export type Parentela = 'madre' | 'padre' | 'altro'

export interface GenitoreScheda {
  nome: string
  cognome: string
  parentela: Parentela | null
  principale: boolean
  telefoni: string[]
  email: string[]
  codiceFiscale: string | null
}

export interface DelegatoScheda {
  nome: string
  cognome: string
  parentela: string | null
}

export interface SchedaAlunnoDocente {
  id: string
  nome: string
  cognome: string
  sesso: 'M' | 'F' | null
  dataNascita: string | null
  luogoNascita: { comune: string | null; provincia: string | null; nazione: string | null }
  cittadinanza: string | null
  codiceFiscale: string | null
  residenza: {
    indirizzo: string | null
    civico: string | null
    cap: string | null
    comune: string | null
    provincia: string | null
  }
  sezione: SezioneElenco | null
  dataIscrizione: string | null
  salute: {
    allergeni: string[]
    /** Solo il testo che le chiavi non dicono già (`testoResiduoAllergie`). */
    allergieAltro: string | null
    haAllergie: boolean
    noteMediche: string | null
    besDsa: boolean
    usaPannolino: boolean
  }
  consensi: { privacy: boolean | null; fotoSito: boolean | null; fotoSocial: boolean | null }
  genitori: GenitoreScheda[]
  delegati: DelegatoScheda[]
}
