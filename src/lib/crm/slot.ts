import { dataCivile } from '@/i18n/config'
import { istanteCivile, oraCivile } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import type { AppuntamentoRow, DisponibilitaRow, IndisponibilitaRow } from './tipi'

/**
 * CRM DELLA SEGRETERIA · GLI SLOT LIBERI.
 *
 *   slot libero = disponibilità settimanale − assenze (della persona e della sede) − visite in programma
 *
 * Funzioni PURE: niente database, niente orologio (`adesso` è un argomento), niente `Date` locale.
 * Le userà anche l'interfaccia per l'assistente AI (spec §8), dopo la prima versione.
 *
 * ── GLI ORARI SONO DI ROMA ──────────────────────────────────────────────────────
 * `ora_inizio`/`ora_fine` sono cifre su un orologio a muro italiano (`09:00`), non istanti. Ogni slot
 * nasce da `istanteCivile(giorno, ora)`, che conosce il cambio dell'ora legale: le 10:00 di domenica
 * 25/10/2026 sono le 09:00Z, le 10:00 del sabato prima le 08:00Z. Lo scarto fra i due giorni è di 25 ore
 * reali, ed è giusto così: la segretaria che ha «domenica alle 10» ce l'ha alle 10 tutto l'anno.
 *
 * ⚠️ NESSUN `new Date(anno, mese, giorno)` e nessun `getDay()`/`getHours()` locale: il processo gira in
 * UTC su Vercel e in Europe/Rome sul Mac, e la differenza si vedrebbe proprio nelle due notti l'anno in
 * cui conta. Il giorno della settimana di un GIORNO CIVILE non dipende dal fuso (si calcola a mezzogiorno
 * UTC); l'ora di un ISTANTE si legge con `oraCivile`/`dataCivile`, che dichiarano `Europe/Rome`.
 *
 * ── LA GRIGLIA ──────────────────────────────────────────────────────────────────
 * Si parte da `ora_inizio` e si tagliano slot consecutivi di `durata_slot_min` finché lo slot sta TUTTO
 * entro `ora_fine` (9:00–11:00 da 45 minuti → 9:00 e 9:45, non 10:30: sforerebbe di un quarto d'ora). La
 * fine di uno slot è `inizio + durata` in tempo reale, la stessa aritmetica del vincolo EXCLUDE del
 * database (`tstzrange(inizio, fine)`): due intervalli che si toccano soltanto (la fine dell'uno è
 * l'inizio dell'altro) NON si sovrappongono, né qui né là.
 */

export interface SlotLibero {
  utenteId: string
  /** ISO UTC */
  inizio: string
  /** ISO UTC */
  fine: string
}

const MINUTI_GIORNO = 1440
const MS_MINUTO = 60_000
/** Un intervallo da calcolare più lungo di così è un errore di chi chiama, non una richiesta: si taglia. */
const GIORNI_MAX = 400

const FORMA_YMD = /^\d{4}-\d{2}-\d{2}$/

/** `HH:MM` o `HH:MM:SS` (come Postgres restituisce un `time`) → minuti dalla mezzanotte. */
function minutiDaOra(ora: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(ora ?? '')
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function oraDaMinuti(minuti: number): string {
  const h = Math.floor(minuti / 60)
  const m = minuti % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Giorno della settimana ISO (1 = lunedì … 7 = domenica) di un giorno civile `YYYY-MM-DD`.
 * A mezzogiorno UTC: il giorno non cambia in nessun fuso, quindi il risultato non dipende da dove gira.
 */
function giornoSettimanaIso(ymd: string): number {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** La disponibilità vale in questo giorno civile? (`valida_dal` e `valida_al` sono entrambi INCLUSI.) */
function valeIl(d: DisponibilitaRow, ymd: string): boolean {
  if (d.valida_dal && ymd < d.valida_dal) return false
  if (d.valida_al && ymd > d.valida_al) return false
  return d.giorno_settimana === giornoSettimanaIso(ymd)
}

interface Intervallo {
  da: number
  a: number
}

const siSovrappongono = (x: Intervallo, y: Intervallo) => x.da < y.a && x.a > y.da

function intervalloDi(inizio: string, fine: string): Intervallo | null {
  const da = Date.parse(inizio)
  const a = Date.parse(fine)
  return Number.isNaN(da) || Number.isNaN(a) ? null : { da, a }
}

/** Le assenze che toccano `utenteId`: le sue e quelle di tutta la sede (`utente_id` nullo). */
function assenzeDi(indisponibilita: IndisponibilitaRow[], utenteId: string): Intervallo[] {
  const out: Intervallo[] = []
  for (const i of indisponibilita) {
    if (i.utente_id !== null && i.utente_id !== utenteId) continue
    const iv = intervalloDi(i.dal, i.al)
    if (iv) out.push(iv)
  }
  return out
}

/**
 * Gli slot liberi nell'intervallo di giorni civili `dal`…`al` (estremi compresi), ordinati per inizio e, a
 * parità, per persona. Tolti: quelli che toccano un'assenza della persona o della sede, quelli che si
 * sovrappongono a una visita `in_programma` della stessa persona (annullate, svolte e non presentate non
 * occupano niente: lo dice anche l'EXCLUDE del database) e quelli che iniziano prima di `adesso`.
 */
export function calcolaSlotLiberi(i: {
  disponibilita: DisponibilitaRow[]
  indisponibilita: IndisponibilitaRow[]
  appuntamenti: Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine' | 'stato'>[]
  dal: string
  al: string
  adesso: Date
}): SlotLibero[] {
  if (!FORMA_YMD.test(i.dal ?? '') || !FORMA_YMD.test(i.al ?? '')) return []
  if (istanteCivile(i.dal, '00:00') === null || istanteCivile(i.al, '00:00') === null) return []

  const adessoMs = i.adesso.getTime()
  const assenze = new Map<string, Intervallo[]>()
  const visite = new Map<string, Intervallo[]>()
  const intervalliAssenze = (utenteId: string) => {
    let v = assenze.get(utenteId)
    if (!v) assenze.set(utenteId, (v = assenzeDi(i.indisponibilita, utenteId)))
    return v
  }
  const intervalliVisite = (utenteId: string) => {
    let v = visite.get(utenteId)
    if (!v) {
      v = []
      for (const a of i.appuntamenti) {
        if (a.stato !== 'in_programma' || a.assegnata_a !== utenteId) continue
        const iv = intervalloDi(a.inizio, a.fine)
        if (iv) v.push(iv)
      }
      visite.set(utenteId, v)
    }
    return v
  }

  const visti = new Set<string>()
  const out: SlotLibero[] = []

  let giorno = i.dal
  for (let n = 0; giorno <= i.al && n < GIORNI_MAX; n++, giorno = addGiorni(giorno, 1)) {
    for (const d of i.disponibilita) {
      if (!valeIl(d, giorno)) continue
      const da = minutiDaOra(d.ora_inizio)
      const fino = minutiDaOra(d.ora_fine)
      const durata = d.durata_slot_min
      if (da === null || fino === null || !(durata > 0)) continue

      for (let inizioMin = da; inizioMin + durata <= fino && inizioMin < MINUTI_GIORNO; inizioMin += durata) {
        const inizio = istanteCivile(giorno, oraDaMinuti(inizioMin))
        if (inizio === null) continue
        const inizioMs = Date.parse(inizio)
        if (inizioMs < adessoMs) continue

        const slot: Intervallo = { da: inizioMs, a: inizioMs + durata * MS_MINUTO }
        if (intervalliAssenze(d.utente_id).some((x) => siSovrappongono(slot, x))) continue
        if (intervalliVisite(d.utente_id).some((x) => siSovrappongono(slot, x))) continue

        // Due righe di disponibilità che si coprono non devono offrire lo stesso orario due volte.
        const chiave = `${d.utente_id}|${inizio}`
        if (visti.has(chiave)) continue
        visti.add(chiave)
        out.push({ utenteId: d.utente_id, inizio, fine: new Date(slot.a).toISOString() })
      }
    }
  }

  return out.sort((x, y) => (x.inizio < y.inizio ? -1 : x.inizio > y.inizio ? 1 : x.utenteId < y.utenteId ? -1 : x.utenteId > y.utenteId ? 1 : 0))
}

/**
 * Questa visita cade FUORI dalla disponibilità della sua persona? `true` se non sta per intero dentro una
 * fascia di disponibilità valida in quel giorno (non serve che sia allineata alla griglia degli slot:
 * la segretaria può fissare a qualsiasi ora, spec §9) oppure se tocca un'assenza della persona o della
 * sede. L'agenda la mostra come avviso «fuori disponibilità»; non blocca niente.
 *
 * Il giorno e l'ora si leggono a Roma. Una visita che attraversa la mezzanotte non sta mai in una fascia.
 */
export function fuoriDisponibilita(
  a: Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine'>,
  disponibilita: DisponibilitaRow[],
  indisponibilita: IndisponibilitaRow[],
): boolean {
  const iv = intervalloDi(a.inizio, a.fine)
  if (!iv) return true

  if (assenzeDi(indisponibilita, a.assegnata_a).some((x) => siSovrappongono(iv, x))) return true

  const giorno = dataCivile(new Date(iv.da))
  const inizioMin = minutiDaOra(oraCivile(a.inizio))
  const fineMin = minutiDaOra(oraCivile(a.fine))
  if (inizioMin === null || fineMin === null) return true
  const stessoGiorno = dataCivile(new Date(iv.a)) === giorno
  const fineEffettiva = stessoGiorno ? fineMin : MINUTI_GIORNO + fineMin

  return !disponibilita.some((d) => {
    if (d.utente_id !== a.assegnata_a || !valeIl(d, giorno)) return false
    const da = minutiDaOra(d.ora_inizio)
    const fino = minutiDaOra(d.ora_fine)
    return da !== null && fino !== null && da <= inizioMin && fineEffettiva <= fino
  })
}
