import { dataCivile } from '@/i18n/config'
import type { StatoAnno } from '@/lib/anno/tipi'

// ─────────────────────────────────────────────────────────────────────────────
// IL CALENDARIO DELL'ANNO: «che anno è questo giorno, per questa sede?»
//
// Una sola risposta, qui. La soglia predefinita è il 1° SETTEMBRE per decisione del
// titolare: luglio e agosto, centro estivo compreso, appartengono all'anno che si
// chiude (fino al compito 4.1.S4b esisteva anche una funzione con la soglia al 1°
// agosto, ora tolta: nessun altro file di `src/` ricava l'anno con una regola
// propria). Il calendario della sede (`anni_sede`) vince sempre sul predefinito:
// una sede che comincia il 15 settembre ha il 10 settembre ancora nell'anno vecchio.
//
// Modulo PURO: nessun database, nessun log, nessun import di server, così lo
// usano anche i componenti client. Non legge mai la data di oggi: dipende solo
// dagli argomenti. Per passare da un `Date` a un anno c'è `annoDiIstante`, che
// conta il giorno a Roma qualunque sia il fuso del processo.
//
// I letterali della soglia (`-09-01`, `-08-31`, `-07-31`, il mese 9) vivono SOLO
// in questo file.
// ─────────────────────────────────────────────────────────────────────────────

export interface RigaCalendario {
  annoId: string // anni_scolastici.id
  annoSedeId: string // anni_sede.id
  annoInizio: number // 2026 per il 2026/27
  inizio: string // 'AAAA-MM-GG'
  fine: string
  ultimoGiornoAperto: string
  preparaSuccessivoDal: string
  stato: StatoAnno
  domandeAperte: boolean
}
export type Calendario = readonly RigaCalendario[]

export interface AnnoDelGiorno {
  annoInizio: number
  etichetta: string // '2026/2027'
  etichettaBreve: string // '2026/27'
  fonte: 'sede' | 'predefinito'
  riga?: RigaCalendario // presente solo con fonte 'sede'
}

const MESE_INIZIO_PREDEFINITO = 9

/** `true` solo per una stringa `AAAA-MM-GG` che è una data vera. */
export function giornoValido(giorno: string): boolean {
  if (typeof giorno !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(giorno)) return false
  const [a, m, g] = giorno.split('-').map(Number)
  const d = new Date(Date.UTC(2000, 0, 1))
  d.setUTCFullYear(a, m - 1, g) // setUTCFullYear: Date.UTC mappa gli anni < 100 al 1900
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === g
}

export function etichettaAnno(annoInizio: number, forma: 'estesa' | 'breve'): string {
  const fine = annoInizio + 1
  return forma === 'estesa'
    ? `${annoInizio}/${fine}`
    : `${annoInizio}/${String(fine % 100).padStart(2, '0')}`
}

function costruisci(annoInizio: number, riga?: RigaCalendario): AnnoDelGiorno {
  return {
    annoInizio,
    etichetta: etichettaAnno(annoInizio, 'estesa'),
    etichettaBreve: etichettaAnno(annoInizio, 'breve'),
    fonte: riga ? 'sede' : 'predefinito',
    ...(riga ? { riga } : {}),
  }
}

/**
 * L'anno di un giorno civile. Errore di programma se `giorno` non è `AAAA-MM-GG`:
 * chi passa un input dell'utente lo controlla prima con `giornoValido`.
 */
export function annoDelGiorno(giorno: string, calendario?: Calendario | null): AnnoDelGiorno {
  if (!giornoValido(giorno)) throw new RangeError('giorno non valido: atteso AAAA-MM-GG')
  const riga = calendario?.find((r) => r.inizio <= giorno && giorno <= r.fine)
  if (riga) return costruisci(riga.annoInizio, riga)
  const [y, m] = giorno.split('-').map(Number)
  return costruisci(m >= MESE_INIZIO_PREDEFINITO ? y : y - 1)
}

/** Da un istante a un anno: il giorno è sempre quello di Roma. */
export function annoDiIstante(istante: Date, calendario?: Calendario | null): AnnoDelGiorno {
  return annoDelGiorno(dataCivile(istante), calendario)
}

/**
 * L'anno ATTIVO di una sede: fra le righe `corrente`, `in_chiusura` e `chiuso`, quella con
 * l'`inizio` più recente. È la stessa regola di `anno_attivo()` in SQL: un anno in preparazione
 * o con le iscrizioni aperte non è ancora quello in cui si lavora. `null` se non ce n'è.
 */
export function annoAttivoDelCalendario(calendario: Calendario | null | undefined): RigaCalendario | null {
  let attivo: RigaCalendario | null = null
  for (const r of calendario ?? []) {
    if (r.stato !== 'corrente' && r.stato !== 'in_chiusura' && r.stato !== 'chiuso') continue
    if (!attivo || r.inizio > attivo.inizio) attivo = r
  }
  return attivo
}

function rigaDellAnno(annoInizio: number, calendario?: Calendario | null) {
  return calendario?.find((r) => r.annoInizio === annoInizio)
}

export function inizioAnno(annoInizio: number, calendario?: Calendario | null): string {
  return rigaDellAnno(annoInizio, calendario)?.inizio ?? `${annoInizio}-09-01`
}

export function fineAnno(annoInizio: number, calendario?: Calendario | null): string {
  return rigaDellAnno(annoInizio, calendario)?.fine ?? `${annoInizio + 1}-08-31`
}

export function ultimoGiornoApertoAnno(annoInizio: number, calendario?: Calendario | null): string {
  return rigaDellAnno(annoInizio, calendario)?.ultimoGiornoAperto ?? `${annoInizio + 1}-07-31`
}

/**
 * I primi del mese `'AAAA-MM-01'` dal mese `da` (dell'anno `annoInizio`) al mese `a`
 * (stesso anno se `a >= da`, altrimenti l'anno dopo). Il predefinito 9→6 sono le
 * dieci mensilità della retta.
 */
export function mesiDelAnno(annoInizio: number, opzioni?: { da?: number; a?: number }): string[] {
  const da = opzioni?.da ?? MESE_INIZIO_PREDEFINITO
  const a = opzioni?.a ?? 6
  for (const v of [da, a]) {
    if (!Number.isInteger(v) || v < 1 || v > 12) {
      throw new RangeError('mese non valido: atteso un intero da 1 a 12')
    }
  }
  const fine = a >= da ? a : a + 12
  const out: string[] = []
  for (let k = da; k <= fine; k++) {
    const anno = k > 12 ? annoInizio + 1 : annoInizio
    out.push(`${anno}-${String(((k - 1) % 12) + 1).padStart(2, '0')}-01`)
  }
  return out
}
