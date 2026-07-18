import { describe, it, expect } from 'vitest'
import {
  normalizzaRetteConfig,
  scontoFratelli,
  proRata,
  calcolaScontoRetta,
  round2,
  type RetteConfig,
} from '@/lib/pagamenti/rette-config'

// Preview TS delle regole rette (slice S6 — Contabilità v2). Deve replicare
// ESATTAMENTE la SQL di genera_rette_mensili v2 (stesso arrotondamento
// round-half-away-from-zero a 2 decimali, stessi scaglioni, stessi motivi).

describe('round2 (half-away-from-zero, come round(numeric,2) di Postgres)', () => {
  it('arrotonda i mezzi verso l’alto', () => {
    expect(round2(50.025)).toBe(50.03)
    expect(round2(15)).toBe(15)
    expect(round2(51)).toBe(51)
    expect(round2(2.005)).toBe(2.01)
  })
})

describe('(a) sconto fratelli — 2° figlio percentuale 10% su retta 150 → 15', () => {
  const cfg: RetteConfig = normalizzaRetteConfig({
    sconto_fratelli: { enabled: true, modo: 'percentuale', scaglioni: [{ posizione: 2, valore: 10 }] },
  })
  it('scontoFratelli(2, 150) = 15', () => {
    expect(scontoFratelli(2, 150, cfg)).toBe(15)
  })
  it('il 1° figlio (posizione 1) non ha sconto', () => {
    expect(scontoFratelli(1, 150, cfg)).toBe(0)
  })
  it('calcolaScontoRetta → sconto 15, motivo "Sconto fratelli"', () => {
    expect(calcolaScontoRetta({ importo: 150, posizione: 2, cfg })).toEqual({ sconto: 15, motivo: 'Sconto fratelli' })
  })
  it('modo "importo": lo sconto è il valore fisso', () => {
    const c = normalizzaRetteConfig({ sconto_fratelli: { enabled: true, modo: 'importo', scaglioni: [{ posizione: 2, valore: 25 }] } })
    expect(scontoFratelli(2, 150, c)).toBe(25)
  })
  it('scaglione con posizione più alta ≤ della propria (3° figlio con scaglioni 2/3)', () => {
    const c = normalizzaRetteConfig({
      sconto_fratelli: { enabled: true, modo: 'percentuale', scaglioni: [{ posizione: 2, valore: 10 }, { posizione: 3, valore: 20 }] },
    })
    expect(scontoFratelli(2, 150, c)).toBe(15) // 10%
    expect(scontoFratelli(3, 150, c)).toBe(30) // 20%
    expect(scontoFratelli(4, 150, c)).toBe(30) // eredita lo scaglione 3 (il più alto ≤ 4)
  })
})

describe('(b) pro-rata iscrizione — iscritto il 15, scaglioni 1→100/11→66/21→33', () => {
  const cfg: RetteConfig = normalizzaRetteConfig({
    pro_rata_iscrizione: {
      enabled: true,
      scaglioni: [{ dal_giorno: 1, percentuale: 100 }, { dal_giorno: 11, percentuale: 66 }, { dal_giorno: 21, percentuale: 33 }],
    },
  })
  it('giorno 15 → percentuale dovuta 66 → sconto 51 su 150', () => {
    expect(proRata(15, 150, cfg)).toBe(51)
  })
  it('giorno 1 → 100% dovuto → sconto 0', () => {
    expect(proRata(1, 150, cfg)).toBe(0)
  })
  it('giorno 25 → percentuale dovuta 33 → sconto 100.5 su 150', () => {
    expect(proRata(25, 150, cfg)).toBe(100.5)
  })
  it('calcolaScontoRetta con pro-rata → motivo "Pro-rata iscrizione"', () => {
    expect(calcolaScontoRetta({ importo: 150, posizione: 1, giornoIscrizione: 15, applicaProRata: true, cfg })).toEqual({ sconto: 51, motivo: 'Pro-rata iscrizione' })
  })
})

describe('(c) config vuota o spenta → sconto 0 (comportamento odierno)', () => {
  it('config totalmente assente', () => {
    expect(scontoFratelli(2, 150, undefined)).toBe(0)
    expect(proRata(15, 150, undefined)).toBe(0)
    expect(calcolaScontoRetta({ importo: 150, posizione: 2, giornoIscrizione: 15, applicaProRata: true, cfg: undefined })).toEqual({ sconto: 0, motivo: null })
  })
  it('config con sezioni presenti ma enabled=false', () => {
    const cfg = normalizzaRetteConfig({
      sconto_fratelli: { enabled: false, modo: 'percentuale', scaglioni: [{ posizione: 2, valore: 10 }] },
      pro_rata_iscrizione: { enabled: false, scaglioni: [{ dal_giorno: 11, percentuale: 66 }] },
    })
    expect(scontoFratelli(2, 150, cfg)).toBe(0)
    expect(proRata(15, 150, cfg)).toBe(0)
  })
  it('oggetto vuoto {} → default spenti', () => {
    const cfg = normalizzaRetteConfig({})
    expect(cfg.sconto_fratelli.enabled).toBe(false)
    expect(cfg.pro_rata_iscrizione.enabled).toBe(false)
  })
})

describe('(d) scaglioni disordinati/invalidi → normalizzazione senza crash', () => {
  it('ordina, scarta gli invalidi e non lancia', () => {
    const cfg = normalizzaRetteConfig({
      sconto_fratelli: {
        enabled: true,
        modo: 'percentuale',
        scaglioni: [
          { posizione: 3, valore: 20 },
          { posizione: 2, valore: 10 },
          { posizione: 'x', valore: 5 },   // posizione non numerica → scartato
          { posizione: 1, valore: 50 },    // posizione < 2 → scartato
          { posizione: 4, valore: -5 },    // valore negativo → scartato
          { posizione: 5, valore: 999 },   // percentuale > 100 → clampata a 100
          null,                            // spazzatura → scartata
        ],
      },
      pro_rata_iscrizione: {
        enabled: true,
        scaglioni: [
          { dal_giorno: 21, percentuale: 33 },
          { dal_giorno: 1, percentuale: 100 },
          { dal_giorno: 0, percentuale: 50 },   // giorno < 1 → scartato
          { dal_giorno: 40, percentuale: 50 },  // giorno > 31 → scartato
          { dal_giorno: 11, percentuale: 150 },  // percentuale > 100 → clampata a 100
        ],
      },
    })
    expect(cfg.sconto_fratelli.scaglioni).toEqual([
      { posizione: 2, valore: 10 },
      { posizione: 3, valore: 20 },
      { posizione: 5, valore: 100 },
    ])
    expect(cfg.pro_rata_iscrizione.scaglioni).toEqual([
      { dal_giorno: 1, percentuale: 100 },
      { dal_giorno: 11, percentuale: 100 },
      { dal_giorno: 21, percentuale: 33 },
    ])
  })
  it('scaglioni non-array → ricadono sui default', () => {
    const cfg = normalizzaRetteConfig({ sconto_fratelli: { enabled: true, modo: 'percentuale', scaglioni: 'boom' } })
    expect(cfg.sconto_fratelli.scaglioni.length).toBeGreaterThan(0)
  })
})

describe('(e) somma dei due sconti clampata a ≤ importo', () => {
  it('sconto fratelli + pro-rata non superano l’importo', () => {
    const cfg = normalizzaRetteConfig({
      sconto_fratelli: { enabled: true, modo: 'importo', scaglioni: [{ posizione: 2, valore: 120 }] },
      pro_rata_iscrizione: { enabled: true, scaglioni: [{ dal_giorno: 1, percentuale: 50 }] },
    })
    // sf = 120, pr = round(150*(100-50)/100) = 75, somma 195 → clamp a 150
    const res = calcolaScontoRetta({ importo: 150, posizione: 2, giornoIscrizione: 5, applicaProRata: true, cfg })
    expect(res.sconto).toBe(150)
    expect(res.motivo).toBe('Sconto fratelli; Pro-rata iscrizione')
  })
})
