import { dataCivile } from '@/i18n/config'
import { fineGiornoCivile, inizioGiornoCivile } from '@/lib/format/confini-giorno'
import type { AppuntamentoRow, AzioneRow, BambinoRow, SchedaRow } from './tipi'

/**
 * CRM DELLA SEGRETERIA · LE STATISTICHE.
 *
 * Calcolo PURO (niente database, niente orologio: «adesso» arriva dal chiamante), con le definizioni del
 * §10 della specifica alla lettera. È il file che decide chi prende il merito, quindi le regole stanno qui
 * e nessun'altra parte del CRM le ripete.
 *
 * ── DUE STATISTICHE SEPARATE, due persone diverse (decisione del titolare, 30/10/2026) ───────────
 *
 *  · TASSO DI PRESENTAZIONE → a chi ha FISSATO la visita (`fissato_da`; la riga `'ai'` se l'ha fissata
 *    l'assistente, `fissato_via = 'ai'`): visite svolte / (svolte + non presentate). Le annullate non
 *    entrano in nessun conto; le «in programma» contano fra le fissate ma non nel tasso.
 *  · TASSO DI CHIUSURA → a chi ha SVOLTO la visita (`svolto_da`, mai `segnato_da`): bambini iscritti /
 *    bambini delle schede con una visita svolta nel periodo.
 *
 * Il nome della persona è sempre un utente dell'app (un uuid), mai un testo scritto a mano: è il difetto
 * della mini-app di prima (24 grafie per circa 6 persone, 69 «Segreteria» generici).
 *
 * ── PERCHÉ IL TASSO DI CHIUSURA NON PUÒ SUPERARE IL 100% ──────────────────────────────────────────
 *
 * Ogni bambino della coorte va a UNA persona sola, e quella persona lo conta due volte allo stesso modo:
 * al denominatore (`bambiniVisitati`) e, se è iscritto, al numeratore. Quindi per ogni riga
 * `iscritti <= bambiniVisitati` per costruzione, e la somma delle righe non conta nessun bambino due
 * volte. Il merito è di chi ha svolto l'ULTIMA visita con `inizio` <= `esito_il` se il bambino è iscritto
 * (una visita fatta dopo l'iscrizione non l'ha convinto a iscriversi), altrimenti l'ultima fino a fine
 * periodo.
 *
 * ── LE COSE CHE NON SI POSSONO ASSEGNARE SI DICHIARANO ────────────────────────────────────────────
 *
 * Una visita senza chi l'ha fissata, un bambino iscritto prima di qualunque visita, una visita svolta
 * senza `svolto_da`: non hanno una persona a cui andare e NON se ne inventa una. Finiscono in
 * `nonAttribuiti`, che la schermata mostra quando è maggiore di zero: un numero che sparisce in silenzio
 * è esattamente il difetto che ha reso inaffidabili le statistiche di prima.
 *
 * ── GIORNI CIVILI DI ROMA ─────────────────────────────────────────────────────────────────────────
 *
 * Il periodo `dal`/`al` è in giorni `YYYY-MM-DD` di Roma. Ogni istante si porta al suo giorno civile con
 * `dataCivile` (mai `toISOString().slice(0, 10)`, che dà il giorno di Greenwich: le 00:30 del 1° febbraio
 * a Roma sono ancora il 31 gennaio in UTC).
 *
 * I rapporti sono `null` quando il denominatore è zero: mai `NaN`, mai `Infinity`. Un periodo senza
 * visite dice «—», non «0%».
 */

/** L'identificativo della riga dell'assistente AI al posto di un utente. */
export const PERSONA_AI = 'ai' as const

export interface RigaPersona {
  /** id utente, oppure `'ai'` per le visite fissate dall'assistente */
  persona: string | typeof PERSONA_AI
  // chi FISSA
  fissati: number
  svolti: number
  nonPresentati: number
  tassoPresentazione: number | null
  // chi SVOLGE
  bambiniVisitati: number
  iscrittiVerificati: number
  iscrittiAMano: number
  closeRate: number | null
  // chi è RESPONSABILE di un richiamo (attività, non merito)
  azioniDovute: number
  azioniInTempo: number
  followUpInTempo: number | null
}

export type TotaleStatistiche = Omit<RigaPersona, 'persona'>

export interface StatisticheCrm {
  righe: RigaPersona[]
  totale: TotaleStatistiche
  /** mediana, in giorni di calendario di Roma, fra la scheda creata e la prima visita svolta */
  ritardoMedianoGiorni: number | null
  /** ciò che non ha una persona a cui andare (vedi l'intestazione) e quindi non è in nessuna riga */
  nonAttribuiti: { visite: number; bambini: number }
}

export interface IngressoStatistiche {
  schede: Pick<SchedaRow, 'id' | 'creata_il'>[]
  bambini: Pick<BambinoRow, 'scheda_id' | 'esito' | 'esito_il' | 'domanda_id' | 'da_verificare'>[]
  appuntamenti: Pick<AppuntamentoRow, 'scheda_id' | 'inizio' | 'stato' | 'fissato_da' | 'fissato_via' | 'svolto_da'>[]
  azioni: Pick<AzioneRow, 'responsabile' | 'scadenza' | 'fatta_il' | 'cancellata_il'>[]
  /** primo giorno del periodo, `YYYY-MM-DD` di Roma, incluso */
  dal: string
  /** ultimo giorno del periodo, `YYYY-MM-DD` di Roma, incluso */
  al: string
  adesso: Date
}

/** Un rapporto, oppure `null` se il denominatore è zero. */
function rapporto(numeratore: number, denominatore: number): number | null {
  return denominatore > 0 ? numeratore / denominatore : null
}

/** Il giorno civile di Roma (`YYYY-MM-DD`) di un istante ISO, o `null` se l'istante non si legge. */
function giornoRoma(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : dataCivile(new Date(ms))
}

/** Giorni di calendario fra due `YYYY-MM-DD`: aritmetica UTC su date nude, quindi il cambio d'ora non c'entra. */
function giorniTra(da: string, a: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${da}T00:00:00Z`)) / 86_400_000)
}

function mediana(valori: number[]): number | null {
  if (valori.length === 0) return null
  const v = [...valori].sort((x, y) => x - y)
  const meta = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[meta] : (v[meta - 1] + v[meta]) / 2
}

type Contatori = Omit<RigaPersona, 'persona' | 'tassoPresentazione' | 'closeRate' | 'followUpInTempo'>

const nuoviContatori = (): Contatori => ({
  fissati: 0,
  svolti: 0,
  nonPresentati: 0,
  bambiniVisitati: 0,
  iscrittiVerificati: 0,
  iscrittiAMano: 0,
  azioniDovute: 0,
  azioniInTempo: 0,
})

function conRapporti(c: Contatori): TotaleStatistiche {
  return {
    ...c,
    tassoPresentazione: rapporto(c.svolti, c.svolti + c.nonPresentati),
    closeRate: rapporto(c.iscrittiVerificati + c.iscrittiAMano, c.bambiniVisitati),
    followUpInTempo: rapporto(c.azioniInTempo, c.azioniDovute),
  }
}

type VisitaSvolta = { ms: number; inizio: string; chi: string | null }

export function calcolaStatistiche(i: IngressoStatistiche): StatisticheCrm {
  const inizioPeriodo = inizioGiornoCivile(i.dal)
  const finePeriodo = fineGiornoCivile(i.al)
  if (inizioPeriodo === null || finePeriodo === null) {
    throw new RangeError('Il periodo delle statistiche non è fatto di due giorni YYYY-MM-DD validi.')
  }
  const fineMs = Date.parse(finePeriodo)
  const nelPeriodo = (giorno: string | null): giorno is string => giorno !== null && giorno >= i.dal && giorno <= i.al

  const persone = new Map<string, Contatori>()
  const di = (chi: string): Contatori => {
    let c = persone.get(chi)
    if (!c) {
      c = nuoviContatori()
      persone.set(chi, c)
    }
    return c
  }
  const nonAttribuiti = { visite: 0, bambini: 0 }

  // ── 1 · PRESENTAZIONE: a chi ha FISSATO ─────────────────────────────────────────────────────────
  for (const a of i.appuntamenti) {
    if (a.stato === 'annullato') continue
    if (!nelPeriodo(giornoRoma(a.inizio))) continue
    // L'assistente vince su `fissato_da`: la riga «ai» è sua, e una visita non ha mai due nomi.
    const chi = a.fissato_via === 'ai' ? PERSONA_AI : a.fissato_da
    if (!chi) {
      nonAttribuiti.visite++
      continue
    }
    const c = di(chi)
    c.fissati++
    if (a.stato === 'svolto') c.svolti++
    else if (a.stato === 'non_presentato') c.nonPresentati++
  }

  // ── 2 · CHIUSURA: a chi ha SVOLTO l'ultima visita prima dell'iscrizione ─────────────────────────
  const svoltePerScheda = new Map<string, VisitaSvolta[]>()
  const schedeInCoorte = new Set<string>()
  for (const a of i.appuntamenti) {
    if (a.stato !== 'svolto') continue
    const ms = Date.parse(a.inizio)
    if (Number.isNaN(ms)) continue
    const lista = svoltePerScheda.get(a.scheda_id) ?? []
    lista.push({ ms, inizio: a.inizio, chi: a.svolto_da })
    svoltePerScheda.set(a.scheda_id, lista)
    if (nelPeriodo(giornoRoma(a.inizio))) schedeInCoorte.add(a.scheda_id)
  }
  for (const lista of svoltePerScheda.values()) {
    // A parità di istante l'ordine non dipende da quello di arrivo delle righe.
    lista.sort((x, y) => x.ms - y.ms || (x.chi ?? '').localeCompare(y.chi ?? ''))
  }

  for (const b of i.bambini) {
    if (!schedeInCoorte.has(b.scheda_id)) continue
    const iscritto = b.esito === 'iscritto'
    // Il limite oltre il quale una visita non può aver convinto la famiglia. Un iscritto senza `esito_il`
    // (non dovrebbe esistere) si legge come un non iscritto: meglio l'ultima visita nota che nessuna.
    let limite = fineMs
    if (iscritto && b.esito_il) {
      const ms = Date.parse(b.esito_il)
      if (!Number.isNaN(ms)) limite = ms
    }
    let scelta: VisitaSvolta | null = null
    for (const v of svoltePerScheda.get(b.scheda_id) ?? []) {
      if (v.ms > limite) break
      scelta = v
    }
    if (!scelta || !scelta.chi) {
      nonAttribuiti.bambini++
      continue
    }
    const c = di(scelta.chi)
    c.bambiniVisitati++
    if (iscritto) {
      // Verificato = c'è una domanda e nessuno l'ha respinta; ogni altro iscritto è «a mano» (spec §7).
      if (b.domanda_id && !b.da_verificare) c.iscrittiVerificati++
      else c.iscrittiAMano++
    }
  }

  // ── 3 · FOLLOW-UP IN TEMPO: al RESPONSABILE (attività, non merito) ──────────────────────────────
  const adessoMs = i.adesso.getTime()
  for (const z of i.azioni) {
    if (z.cancellata_il != null) continue
    const giornoScadenza = giornoRoma(z.scadenza)
    if (!nelPeriodo(giornoScadenza)) continue
    if (!(Date.parse(z.scadenza) < adessoMs)) continue // non è ancora scaduta
    const c = di(z.responsabile)
    c.azioniDovute++
    const giornoFatta = giornoRoma(z.fatta_il)
    if (giornoFatta !== null && giornoFatta <= giornoScadenza) c.azioniInTempo++
  }

  // ── 4 · RITARDO contatto → visita ───────────────────────────────────────────────────────────────
  const creata = new Map(i.schede.map((s) => [s.id, s.creata_il]))
  const ritardi: number[] = []
  for (const [schedaId, visite] of svoltePerScheda) {
    const prima = visite[0]
    const giornoVisita = giornoRoma(prima.inizio)
    if (!nelPeriodo(giornoVisita)) continue // il periodo si legge sulla data della visita
    const giornoCreata = giornoRoma(creata.get(schedaId))
    if (giornoCreata === null) continue
    const giorni = giorniTra(giornoCreata, giornoVisita)
    // Una scheda scritta DOPO la visita (inserimento a posteriori) non dice quanto la famiglia abbia atteso.
    if (giorni >= 0) ritardi.push(giorni)
  }

  // ── L'esito ─────────────────────────────────────────────────────────────────────────────────────
  const righe: RigaPersona[] = [...persone.entries()]
    // L'assistente in fondo, gli utenti per id: l'ordine è deterministico; i nomi li mette la route.
    .sort(([x], [y]) => (x === PERSONA_AI ? 1 : y === PERSONA_AI ? -1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([persona, c]) => ({ persona, ...conRapporti(c) }))

  const somma = nuoviContatori()
  for (const c of persone.values()) {
    for (const k of Object.keys(somma) as (keyof Contatori)[]) somma[k] += c[k]
  }

  return {
    righe,
    totale: conRapporti(somma),
    ritardoMedianoGiorni: mediana(ritardi),
    nonAttribuiti,
  }
}

// ── Le scorciatoie del periodo ────────────────────────────────────────────────────────────────────

export interface PeriodoStatistiche {
  dal: string
  al: string
}

const due = (n: number) => String(n).padStart(2, '0')
const giornoYmd = (anno: number, mese: number, giorno: number) => `${anno}-${due(mese)}-${due(giorno)}`
/** L'ultimo giorno del mese (1 = gennaio): il giorno 0 del mese dopo, in UTC, dove il fuso non c'entra. */
const ultimoGiorno = (anno: number, mese: number) => new Date(Date.UTC(anno, mese, 0)).getUTCDate()

/** Anno e mese (1-12) di OGGI a Roma. */
function annoMeseRoma(adesso: Date): { anno: number; mese: number } {
  const [anno, mese] = dataCivile(adesso).split('-').map(Number)
  return { anno, mese }
}

function meseIntero(anno: number, mese: number): PeriodoStatistiche {
  return { dal: giornoYmd(anno, mese, 1), al: giornoYmd(anno, mese, ultimoGiorno(anno, mese)) }
}

/** Il mese in corso a Roma, dal primo all'ultimo giorno. */
export function periodoMeseCorrente(adesso: Date): PeriodoStatistiche {
  const { anno, mese } = annoMeseRoma(adesso)
  return meseIntero(anno, mese)
}

/** Il mese prima di quello in corso a Roma. */
export function periodoMeseScorso(adesso: Date): PeriodoStatistiche {
  const { anno, mese } = annoMeseRoma(adesso)
  return mese === 1 ? meseIntero(anno - 1, 12) : meseIntero(anno, mese - 1)
}

/** Dal 1° settembre dell'anno scolastico in corso (quello appena cominciato, o dell'anno prima) a fine mese. */
export function periodoDaSettembre(adesso: Date): PeriodoStatistiche {
  const { anno, mese } = annoMeseRoma(adesso)
  return { dal: giornoYmd(mese >= 9 ? anno : anno - 1, 9, 1), al: giornoYmd(anno, mese, ultimoGiorno(anno, mese)) }
}
