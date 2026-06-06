// Risoluzione del menu mensa per una data:
//   override (per data) -> altrimenti rotazione (settimana ISO mod N) -> null.
// Condiviso tra API /api/mensa/menu e la logica di prenotazione.

export interface Portate {
  primo?: string
  secondo?: string
  contorno?: string
  frutta?: string
}

// Ingredienti per portata (testo libero, mostrato a cucina/genitori).
export type Ingredienti = Portate
// Allergeni per portata: chiavi canoniche (vedi lib/mensa/allergeni).
export interface AllergeniPortate {
  primo?: string[]
  secondo?: string[]
  contorno?: string[]
  frutta?: string[]
}

export interface MenuGiorno {
  data: string            // YYYY-MM-DD
  attivo: boolean         // giorno mensa attivo (feriale configurato e non chiuso)
  chiuso: boolean         // chiusura esplicita via override
  portate: Portate | null
  ingredienti?: Ingredienti | null
  allergeni?: AllergeniPortate | null
  note?: string | null
}

export interface RotazioneRow {
  settimana: number
  giorno_settimana: number   // 1=lun … 7=dom
  portate: Portate
  ingredienti?: Ingredienti | null
  allergeni?: AllergeniPortate | null
  note?: string | null
}
export interface OverrideRow {
  data: string
  chiuso: boolean
  portate: Portate | null
  ingredienti?: Ingredienti | null
  allergeni?: AllergeniPortate | null
  note?: string | null
}

// Giorno della settimana 1=lun … 7=dom (da una data YYYY-MM-DD, in UTC-safe).
export function isoWeekday(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const js = d.getUTCDay() // 0=dom … 6=sab
  return js === 0 ? 7 : js
}

// Numero di settimana ISO-8601 (1..53) per la data.
export function isoWeekNumber(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`)
  // Spostarsi al giovedì della settimana corrente (ISO).
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

// Indice di rotazione 1..settimaneRotazione a partire dalla settimana ISO.
export function rotationWeekIndex(dateStr: string, settimaneRotazione: number): number {
  const n = Math.max(1, settimaneRotazione || 1)
  return ((isoWeekNumber(dateStr) - 1) % n) + 1
}

export interface ResolveOptions {
  giorniAttivi: number[]        // es. [1,2,3,4,5]
  settimaneRotazione: number
  rotazione: RotazioneRow[]
  override: OverrideRow[]
}

// Risolve il menu di una singola data.
export function resolveMenuGiorno(dateStr: string, opts: ResolveOptions): MenuGiorno {
  const ov = opts.override.find(o => o.data === dateStr)
  if (ov) {
    return {
      data: dateStr,
      attivo: !ov.chiuso,
      chiuso: ov.chiuso,
      portate: ov.chiuso ? null : (ov.portate ?? null),
      ingredienti: ov.chiuso ? null : (ov.ingredienti ?? null),
      allergeni: ov.chiuso ? null : (ov.allergeni ?? null),
      note: ov.note ?? null,
    }
  }

  const weekday = isoWeekday(dateStr)
  const attivo = opts.giorniAttivi.includes(weekday)
  if (!attivo) {
    return { data: dateStr, attivo: false, chiuso: false, portate: null, ingredienti: null, allergeni: null, note: null }
  }

  const settimana = rotationWeekIndex(dateStr, opts.settimaneRotazione)
  const row = opts.rotazione.find(r => r.settimana === settimana && r.giorno_settimana === weekday)
  return {
    data: dateStr,
    attivo: true,
    chiuso: false,
    portate: row?.portate ?? null,
    ingredienti: row?.ingredienti ?? null,
    allergeni: row?.allergeni ?? null,
    note: row?.note ?? null,
  }
}

// Elenca le date (YYYY-MM-DD) fra from e to inclusi.
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (let d = start; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// Risolve il menu per un intervallo.
export function resolveMenuRange(from: string, to: string, opts: ResolveOptions): MenuGiorno[] {
  return dateRange(from, to).map(d => resolveMenuGiorno(d, opts))
}
