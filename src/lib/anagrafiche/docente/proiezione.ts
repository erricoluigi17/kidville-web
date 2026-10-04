import {
  allergeniAlunno,
  chiaviAllergeni,
  haAllergiaOperativa,
  testoResiduoAllergie,
} from '@/lib/mensa/allergeni'
import type {
  DelegatoScheda,
  GenitoreScheda,
  Grado,
  Parentela,
  SchedaAlunnoDocente,
  SezioneElenco,
  VoceElencoAlunno,
} from './tipi'

/**
 * RIGA DEL DATABASE → RISPOSTA, campo per campo.
 *
 * Qui non si copia mai una riga intera: ogni campo in uscita è scritto a mano.
 * È la seconda metà della lista bianca (la prima sono le colonne di `colonne.ts`):
 * se un giorno la `select` si allargasse, anche a `*`, retta, intestatari e
 * documenti resterebbero comunque fuori. Le funzioni sono pure: niente database,
 * niente React, si provano da sole.
 */

/** Una riga come arriva da PostgREST: di nessun campo si dà per scontato il tipo. */
export type RigaDb = Record<string, unknown>

function testo(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function testi(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map(testo).filter((t): t is string => t !== null)
}

const vero = (v: unknown): boolean => v === true
const booleanoONull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const sesso = (v: unknown): 'M' | 'F' | null => (v === 'M' || v === 'F' ? v : null)

function dataIso(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

export function grado(v: unknown): Grado | null {
  return v === 'nido' || v === 'infanzia' || v === 'primaria' ? v : null
}

/**
 * Le allergie con la STESSA regola della home docente: le chiavi come stanno in
 * archivio (anche fuori dai 14 UE) più quelle dedotte dal testo libero, e del testo
 * solo ciò che le chiavi non dicono già. «Ha allergie» è il criterio OPERATIVO del
 * motore unico: in classe un «fragole» fuori dai 14 non si nasconde.
 */
function allergieDi(riga: RigaDb) {
  const opts = { allergeni: testi(riga.allergeni), allergies: testo(riga.allergies) }
  const chiavi = Array.from(new Set([...chiaviAllergeni(opts), ...allergeniAlunno(opts)]))
  return {
    chiavi,
    residuo: testoResiduoAllergie(opts.allergies, chiavi),
    operativa: haAllergiaOperativa(opts),
  }
}

export function proiettaSezione(riga: RigaDb): SezioneElenco {
  return { id: String(riga.id), nome: testo(riga.name) ?? '', grado: grado(riga.school_type) }
}

export function proiettaVoceElenco(riga: RigaDb, gradoSezione: Grado | null): VoceElencoAlunno {
  const allergie = allergieDi(riga)
  const nascita = dataIso(riga.data_nascita)
  return {
    id: String(riga.id),
    nome: testo(riga.nome) ?? '',
    cognome: testo(riga.cognome) ?? '',
    sectionId: testo(riga.section_id),
    grado: gradoSezione,
    dataNascita: nascita,
    annoNascita: nascita ? Number(nascita.slice(0, 4)) : null,
    sesso: sesso(riga.gender),
    allergeni: allergie.chiavi,
    haAllergie: allergie.operativa,
    besDsa: vero(riga.is_bes_dsa),
    usaPannolino: vero(riga.usa_pannolino),
    consensoFotoSito: booleanoONull(riga.consenso_foto_sito),
    consensoFotoSocial: booleanoONull(riga.consenso_foto_social),
  }
}

const ORDINE_PARENTELA: Record<Parentela, number> = { madre: 0, padre: 1, altro: 2 }

function parentela(v: unknown): Parentela | null {
  const r = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (r === '') return null
  if (r === 'mother' || r === 'madre') return 'madre'
  if (r === 'father' || r === 'padre') return 'padre'
  return 'altro'
}

/**
 * I genitori dai legami `student_parents` con `parents` incorporato (oggetto o
 * array, secondo come PostgREST risolve la relazione). Un genitore anonimizzato
 * (diritto all'oblio) non compare. Prima il referente principale, poi madre, padre,
 * altri.
 */
export function proiettaGenitori(legami: readonly RigaDb[]): GenitoreScheda[] {
  const genitori: GenitoreScheda[] = []
  for (const legame of legami) {
    const grezzo = Array.isArray(legame.parents) ? legame.parents[0] : legame.parents
    if (!grezzo || typeof grezzo !== 'object') continue
    const p = grezzo as RigaDb
    if (p.anonimizzato_il) continue
    genitori.push({
      nome: testo(p.first_name) ?? '',
      cognome: testo(p.last_name) ?? '',
      parentela: parentela(legame.relation_type),
      principale: vero(legame.is_primary),
      telefoni: testi(p.phone_numbers),
      email: testi(p.emails),
      codiceFiscale: testo(p.fiscal_code)?.toUpperCase() ?? null,
    })
  }
  return genitori.sort(
    (a, b) =>
      Number(b.principale) - Number(a.principale) ||
      ORDINE_PARENTELA[a.parentela ?? 'altro'] - ORDINE_PARENTELA[b.parentela ?? 'altro'],
  )
}

export function proiettaDelegati(righe: readonly RigaDb[]): DelegatoScheda[] {
  return righe.map((r) => ({
    nome: testo(r.first_name) ?? '',
    cognome: testo(r.last_name) ?? '',
    parentela: testo(r.relation),
  }))
}

export function proiettaScheda(
  riga: RigaDb,
  contorno: { sezione: SezioneElenco | null; genitori: GenitoreScheda[]; delegati: DelegatoScheda[] },
): SchedaAlunnoDocente {
  const allergie = allergieDi(riga)
  return {
    id: String(riga.id),
    nome: testo(riga.nome) ?? '',
    cognome: testo(riga.cognome) ?? '',
    sesso: sesso(riga.gender),
    dataNascita: dataIso(riga.data_nascita),
    luogoNascita: {
      comune: testo(riga.birth_city),
      provincia: testo(riga.birth_province),
      nazione: testo(riga.birth_nation),
    },
    cittadinanza: testo(riga.citizenship),
    codiceFiscale: testo(riga.codice_fiscale)?.toUpperCase() ?? null,
    residenza: {
      indirizzo: testo(riga.residence_address),
      civico: testo(riga.residence_street_number),
      cap: testo(riga.zip_code),
      comune: testo(riga.residence_city),
      provincia: testo(riga.residence_province),
    },
    sezione: contorno.sezione,
    dataIscrizione: dataIso(riga.data_iscrizione),
    salute: {
      allergeni: allergie.chiavi,
      allergieAltro: allergie.residuo === '' ? null : allergie.residuo,
      haAllergie: allergie.operativa,
      noteMediche: testo(riga.note_mediche),
      besDsa: vero(riga.is_bes_dsa),
      usaPannolino: vero(riga.usa_pannolino),
    },
    consensi: {
      privacy: booleanoONull(riga.consenso_privacy),
      fotoSito: booleanoONull(riga.consenso_foto_sito),
      fotoSocial: booleanoONull(riga.consenso_foto_social),
    },
    genitori: contorno.genitori,
    delegati: contorno.delegati,
  }
}
