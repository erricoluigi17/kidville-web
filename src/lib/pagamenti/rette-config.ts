// Configurazione rette (sconto fratelli + pro-rata iscrizione) — slice S6, Contabilità v2.
//
// Fonte unica della SHAPE `admin_settings.rette_config`, con:
//  • tipi TS della shape;
//  • `normalizzaRetteConfig` (default SPENTI + sanificazione scaglioni);
//  • funzioni pure di ANTEPRIMA `scontoFratelli` / `proRata` / `calcolaScontoRetta`
//    che replicano ESATTAMENTE le regole applicate in SQL da
//    `genera_rette_mensili` v2 (arrotondamento half-away-from-zero a 2 decimali,
//    come `round(numeric, 2)` di Postgres).
//
// Regole (identiche in SQL):
//  – fratelli: la posizione ≥2 prende lo scaglione con posizione più alta ≤ della
//    propria; modo 'percentuale' → round(importo*valore/100, 2), modo 'importo' →
//    valore; motivo «Sconto fratelli».
//  – pro-rata: SOLO sulla retta del mese di iscrizione; percentuale dovuta = scaglione
//    con dal_giorno più alto ≤ giorno di iscrizione (100% se nessuno matcha);
//    sconto = round(importo*(100−percentuale)/100, 2); motivo «Pro-rata iscrizione».
//  – i due sconti sulla stessa retta si SOMMANO (clamp a ≤ importo), motivo concatenato.
//  – config assente o `enabled=false` → sconto 0 = comportamento odierno.

export type ModoScontoFratelli = 'percentuale' | 'importo'

export interface ScaglioneFratelli {
  /** Posizione del figlio nella famiglia (≥2: il 1° non ha mai sconto). */
  posizione: number
  /** Percentuale (0-100) o importo fisso in euro, secondo `modo`. */
  valore: number
}

export interface ScaglioneProRata {
  /** Giorno del mese di iscrizione dal quale scatta questa percentuale dovuta. */
  dal_giorno: number
  /** Percentuale di retta effettivamente dovuta (0-100). */
  percentuale: number
}

export interface ScontoFratelliConfig {
  enabled: boolean
  modo: ModoScontoFratelli
  scaglioni: ScaglioneFratelli[]
}

export interface ProRataConfig {
  enabled: boolean
  scaglioni: ScaglioneProRata[]
}

export interface RetteConfig {
  sconto_fratelli: ScontoFratelliConfig
  pro_rata_iscrizione: ProRataConfig
}

/** Motivo standard degli sconti (identico in SQL). */
export const MOTIVO_FRATELLI = 'Sconto fratelli'
export const MOTIVO_PRORATA = 'Pro-rata iscrizione'

/** Scaglioni suggeriti quando non c'è ancora nulla di salvato (solo per il pannello;
 *  la generazione resta spenta finché `enabled` non è true). */
export const DEFAULT_SCAGLIONI_FRATELLI: ScaglioneFratelli[] = [
  { posizione: 2, valore: 10 },
  { posizione: 3, valore: 20 },
]
export const DEFAULT_SCAGLIONI_PRORATA: ScaglioneProRata[] = [
  { dal_giorno: 1, percentuale: 100 },
  { dal_giorno: 11, percentuale: 66 },
  { dal_giorno: 21, percentuale: 33 },
]

/**
 * Arrotondamento a 2 decimali **half-away-from-zero**, come `round(numeric, 2)` di
 * Postgres. L'epsilon compensa l'errore di rappresentazione binaria dei float JS
 * (es. 50.025*… → 5002.4999… che senza correzione scenderebbe a 50.02).
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  const sign = n < 0 ? -1 : 1
  const cents = Math.round(Math.abs(n) * 100 + 1e-6)
  return (sign * cents) / 100
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function sanScaglioniFratelli(raw: unknown, modo: ModoScontoFratelli): ScaglioneFratelli[] {
  if (!Array.isArray(raw)) return DEFAULT_SCAGLIONI_FRATELLI.map((s) => ({ ...s }))
  const out: ScaglioneFratelli[] = []
  for (const item of raw) {
    if (!isObj(item)) continue
    const posizione = toNum(item.posizione)
    let valore = toNum(item.valore)
    if (!Number.isInteger(posizione) || posizione < 2) continue
    if (!Number.isFinite(valore) || valore < 0) continue
    if (modo === 'percentuale' && valore > 100) valore = 100
    const esistente = out.findIndex((s) => s.posizione === posizione)
    if (esistente >= 0) out[esistente] = { posizione, valore } // duplicato → l'ultimo vince
    else out.push({ posizione, valore })
  }
  out.sort((a, b) => a.posizione - b.posizione)
  return out
}

function sanScaglioniProRata(raw: unknown): ScaglioneProRata[] {
  if (!Array.isArray(raw)) return DEFAULT_SCAGLIONI_PRORATA.map((s) => ({ ...s }))
  const out: ScaglioneProRata[] = []
  for (const item of raw) {
    if (!isObj(item)) continue
    const dal_giorno = toNum(item.dal_giorno)
    let percentuale = toNum(item.percentuale)
    if (!Number.isInteger(dal_giorno) || dal_giorno < 1 || dal_giorno > 31) continue
    if (!Number.isFinite(percentuale) || percentuale < 0) continue
    if (percentuale > 100) percentuale = 100
    const esistente = out.findIndex((s) => s.dal_giorno === dal_giorno)
    if (esistente >= 0) out[esistente] = { dal_giorno, percentuale } // duplicato → l'ultimo vince
    else out.push({ dal_giorno, percentuale })
  }
  out.sort((a, b) => a.dal_giorno - b.dal_giorno)
  return out
}

/**
 * Normalizza una `rette_config` grezza (jsonb da DB o body utente) nella shape
 * canonica: default SPENTI, scaglioni sanificati (interi/positivi, percentuali
 * clampate 0-100, ordinati, deduplicati). Config assente/mal formata → spenti.
 */
export function normalizzaRetteConfig(raw: unknown): RetteConfig {
  const r = isObj(raw) ? raw : {}
  const sf = isObj(r.sconto_fratelli) ? r.sconto_fratelli : {}
  const pr = isObj(r.pro_rata_iscrizione) ? r.pro_rata_iscrizione : {}
  const modo: ModoScontoFratelli = sf.modo === 'importo' ? 'importo' : 'percentuale'
  return {
    sconto_fratelli: {
      enabled: sf.enabled === true,
      modo,
      scaglioni: sanScaglioniFratelli(sf.scaglioni, modo),
    },
    pro_rata_iscrizione: {
      enabled: pr.enabled === true,
      scaglioni: sanScaglioniProRata(pr.scaglioni),
    },
  }
}

/**
 * Sconto fratelli per un figlio in `posizione` (≥2) su una retta di `importo`.
 * `cfg` può essere grezza o già normalizzata (viene normalizzata internamente).
 * NON clampa a importo (lo fa `calcolaScontoRetta` sulla somma).
 */
export function scontoFratelli(posizione: number, importo: number, cfg: unknown): number {
  const c = normalizzaRetteConfig(cfg).sconto_fratelli
  if (!c.enabled) return 0
  const pos = toNum(posizione)
  const imp = toNum(importo)
  if (!Number.isFinite(pos) || pos < 2) return 0
  if (!Number.isFinite(imp) || imp <= 0) return 0
  // scaglioni ordinati asc → l'ultimo con posizione ≤ pos è quello «più alto ≤».
  let scelto: ScaglioneFratelli | null = null
  for (const s of c.scaglioni) {
    if (s.posizione <= pos) scelto = s
    else break
  }
  if (!scelto) return 0
  return c.modo === 'importo' ? round2(scelto.valore) : round2((imp * scelto.valore) / 100)
}

/**
 * Sconto pro-rata sulla retta del mese di iscrizione, dato il giorno del mese.
 * Percentuale dovuta = scaglione con dal_giorno più alto ≤ giorno (100% se nessuno).
 */
export function proRata(giornoIscrizione: number, importo: number, cfg: unknown): number {
  const c = normalizzaRetteConfig(cfg).pro_rata_iscrizione
  if (!c.enabled) return 0
  const g = toNum(giornoIscrizione)
  const imp = toNum(importo)
  if (!Number.isFinite(g) || !Number.isFinite(imp) || imp <= 0) return 0
  let percentuale = 100
  for (const s of c.scaglioni) {
    if (s.dal_giorno <= g) percentuale = s.percentuale
    else break
  }
  if (percentuale > 100) percentuale = 100
  if (percentuale < 0) percentuale = 0
  const sconto = round2((imp * (100 - percentuale)) / 100)
  return sconto < 0 ? 0 : sconto
}

export interface ScontoRetta {
  /** Sconto totale (fratelli + pro-rata) clampato a ≤ importo. */
  sconto: number
  /** Motivo concatenato (o null se sconto 0). */
  motivo: string | null
}

/**
 * Somma i due sconti sulla stessa retta (clamp a ≤ importo) e concatena i motivi.
 * Mirror esatto della combinazione in SQL. `applicaProRata` va passato true SOLO
 * per la retta del mese di iscrizione.
 */
export function calcolaScontoRetta(opts: {
  importo: number
  posizione?: number
  giornoIscrizione?: number | null
  applicaProRata?: boolean
  cfg: unknown
}): ScontoRetta {
  const cfg = normalizzaRetteConfig(opts.cfg)
  const imp = toNum(opts.importo)
  const importo = Number.isFinite(imp) ? imp : 0
  const sf = scontoFratelli(opts.posizione ?? 1, importo, cfg)
  const pr = opts.applicaProRata && opts.giornoIscrizione != null
    ? proRata(opts.giornoIscrizione, importo, cfg)
    : 0
  let tot = round2(sf + pr)
  if (tot > importo) tot = importo
  const motivi: string[] = []
  if (sf > 0) motivi.push(MOTIVO_FRATELLI)
  if (pr > 0) motivi.push(MOTIVO_PRORATA)
  return { sconto: tot, motivo: motivi.length ? motivi.join('; ') : null }
}
