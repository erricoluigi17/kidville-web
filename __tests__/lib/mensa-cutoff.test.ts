import { describe, it, expect } from 'vitest'
import { entroCutoff, oggi } from '@/lib/mensa/server'

// T4 (ritocchi) — entroCutoff è la funzione PURA che decide se una data è
// prenotabile/disdicibile rispetto all'orario limite. Nessun mock: le date
// sono costruite relative al "now" reale (oggi() usa la data UTC, il confronto
// orario è locale — i casi qui valgono in entrambi i fusi).

const giorno = 24 * 60 * 60 * 1000
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10)

describe('entroCutoff (src/lib/mensa/server.ts)', () => {
  it('data passata → false, qualunque sia il cutoff', () => {
    const ieri = ymd(Date.now() - giorno)
    expect(entroCutoff(ieri, '09:30')).toBe(false)
    expect(entroCutoff(ieri, '23:59')).toBe(false)
  })

  it('data futura → true, anche con cutoff già superato oggi', () => {
    const domani = ymd(Date.now() + giorno)
    expect(entroCutoff(domani, '00:00')).toBe(true)
    expect(entroCutoff(domani, '09:30')).toBe(true)
  })

  it('oggi entro l\'orario limite → true (cutoff a fine giornata)', () => {
    // '23:59' è sempre ≥ dell'ora corrente, salvo l'ultimissimo minuto del giorno
    expect(entroCutoff(oggi(), '23:59')).toBe(true)
  })

  it('oggi oltre l\'orario limite → false (cutoff a inizio giornata)', () => {
    // '00:00' è sempre già passato rispetto all'ora corrente
    expect(entroCutoff(oggi(), '00:00')).toBe(false)
  })
})
