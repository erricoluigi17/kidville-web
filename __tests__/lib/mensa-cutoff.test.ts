import { describe, it, expect, vi, afterEach } from 'vitest'
import { entroCutoff, oggiRoma } from '@/lib/mensa/cutoff'
import { entroCutoff as entroCutoffServer, oggi } from '@/lib/mensa/server'

// M1 — il cutoff della mensa si decide in ORA ITALIANA. La versione precedente
// prendeva la data da `toISOString()` (UTC) e l'ora da `setHours()` (fuso del
// processo, UTC su Vercel): col cutoff alle 09:30 il blocco scattava alle 11:30
// italiane d'estate e alle 10:30 d'inverno, e fra mezzanotte e le 2 italiane
// «ieri» era ancora prenotabile. Ogni istante qui sotto è scritto in UTC (`Z`),
// così il test non dipende dal fuso della macchina che lo esegue.

describe('oggiRoma — la data nel calendario di Roma', () => {
  it('ora legale (UTC+2): alle 22:30 UTC a Roma è già il giorno dopo', () => {
    expect(oggiRoma(new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25')
    expect(oggiRoma(new Date('2026-09-24T21:59:00Z'))).toBe('2026-09-24')
  })

  it('ora solare (UTC+1): alle 23:30 UTC a Roma è già il giorno dopo', () => {
    expect(oggiRoma(new Date('2026-01-14T23:30:00Z'))).toBe('2026-01-15')
    expect(oggiRoma(new Date('2026-01-14T22:59:00Z'))).toBe('2026-01-14')
  })
})

describe('entroCutoff — ora legale (UTC+2)', () => {
  const OGGI = '2026-07-15'

  it('09:29 italiane (07:29 UTC) → ancora dentro', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-07-15T07:29:00Z'))).toBe(true)
  })

  it('09:31 italiane (07:31 UTC) → fuori', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-07-15T07:31:00Z'))).toBe(false)
  })

  it('10:00 italiane (08:00 UTC) → fuori: col vecchio calcolo in UTC erano le 08:00, cioè «dentro»', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-07-15T08:00:00Z'))).toBe(false)
  })

  it('il cutoff stesso è ancora dentro, il secondo dopo no', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-07-15T07:30:00.000Z'))).toBe(true)
    expect(entroCutoff(OGGI, '09:30', new Date('2026-07-15T07:30:01.000Z'))).toBe(false)
  })

  it('accetta il formato `time` di Postgres (HH:MM:SS)', () => {
    expect(entroCutoff(OGGI, '09:30:00', new Date('2026-07-15T07:29:00Z'))).toBe(true)
    expect(entroCutoff(OGGI, '09:30:00', new Date('2026-07-15T07:31:00Z'))).toBe(false)
  })
})

describe('entroCutoff — ora solare (UTC+1)', () => {
  const OGGI = '2026-01-15'

  it('09:29 italiane (08:29 UTC) → ancora dentro', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-01-15T08:29:00Z'))).toBe(true)
  })

  it('09:31 italiane (08:31 UTC) → fuori', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-01-15T08:31:00Z'))).toBe(false)
  })

  it('10:00 italiane (09:00 UTC) → fuori: in UTC erano le 09:00, «dentro» per il vecchio calcolo', () => {
    expect(entroCutoff(OGGI, '09:30', new Date('2026-01-15T09:00:00Z'))).toBe(false)
  })
})

describe('entroCutoff — fra mezzanotte e le 2 italiane', () => {
  it('00:30 italiane del 25/09 (22:30 UTC del 24): il 24 NON è più prenotabile', () => {
    const adesso = new Date('2026-09-24T22:30:00Z')
    // in UTC è ancora il 24 prima del cutoff: il vecchio calcolo diceva «dentro»
    expect(entroCutoff('2026-09-24', '09:30', adesso)).toBe(false)
    expect(entroCutoff('2026-09-24', '23:59', adesso)).toBe(false)
    // il 25 è «oggi» a Roma, e alle 00:30 il cutoff delle 09:30 non è ancora passato
    expect(entroCutoff('2026-09-25', '09:30', adesso)).toBe(true)
  })

  it('01:30 italiane del 15/01 in ora solare (00:30 UTC dello stesso giorno): il 14 è passato', () => {
    const adesso = new Date('2026-01-15T00:30:00Z')
    expect(entroCutoff('2026-01-14', '09:30', adesso)).toBe(false)
    expect(entroCutoff('2026-01-15', '09:30', adesso)).toBe(true)
  })
})

describe('entroCutoff — date passate e future, cutoff per sede', () => {
  const adesso = new Date('2026-07-15T07:45:00Z') // 09:45 italiane

  it('data passata → false, qualunque sia il cutoff', () => {
    expect(entroCutoff('2026-07-14', '23:59', adesso)).toBe(false)
  })

  it('data futura → true, anche con un cutoff già superato oggi', () => {
    expect(entroCutoff('2026-07-16', '00:00', adesso)).toBe(true)
  })

  it('stesso istante, due sedi: cutoff 09:30 → fuori, cutoff 10:00 → dentro', () => {
    expect(entroCutoff('2026-07-15', '09:30', adesso)).toBe(false)
    expect(entroCutoff('2026-07-15', '10:00', adesso)).toBe(true)
  })

  it('cutoff illeggibile → per oggi si blocca (nessun ticket si muove)', () => {
    expect(entroCutoff('2026-07-15', 'boh', adesso)).toBe(false)
    expect(entroCutoff('2026-07-16', 'boh', adesso)).toBe(true)
  })
})

describe('src/lib/mensa/server delega a cutoff.ts (senza istante: usa l’orologio)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('oggi() e entroCutoff() di server.ts seguono il calendario e l’ora di Roma', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 00:30 italiane del 25/09 (ora legale): in UTC è ancora il 24
    vi.setSystemTime(new Date('2026-09-24T22:30:00Z'))
    expect(oggi()).toBe('2026-09-25')
    expect(entroCutoffServer('2026-09-24', '09:30')).toBe(false)
    expect(entroCutoffServer('2026-09-25', '09:30')).toBe(true)

    // 10:00 italiane: oltre il cutoff delle 09:30 (in UTC sarebbero le 08:00)
    vi.setSystemTime(new Date('2026-09-25T08:00:00Z'))
    expect(entroCutoffServer('2026-09-25', '09:30')).toBe(false)
    expect(entroCutoffServer('2026-09-25', '10:30')).toBe(true)
  })
})
