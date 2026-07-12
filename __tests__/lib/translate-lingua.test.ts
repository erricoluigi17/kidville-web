import { describe, it, expect } from 'vitest'
import { sembraItaliano } from '@/lib/translate/lingua'

// Il pulsante «Traduci» in chat compare solo se il messaggio NON sembra
// italiano (o se il dispositivo del lettore non è italiano). L'euristica deve
// riconoscere l'italiano quotidiano e NON scattare su emoji/messaggi brevissimi.

describe('sembraItaliano', () => {
  it('frasi italiane comuni → true', () => {
    expect(sembraItaliano('Buongiorno, domani porto i documenti a scuola')).toBe(true)
    expect(sembraItaliano('Va bene, grazie mille!')).toBe(true)
    expect(sembraItaliano('La bambina oggi ha mangiato tutto')).toBe(true)
    expect(sembraItaliano("C'è la riunione alle 17, ci sarà anche la maestra")).toBe(true)
    expect(sembraItaliano('Perfetto, ci vediamo domani alla recita di fine anno')).toBe(true)
  })

  it('inglese → false', () => {
    expect(sembraItaliano('Hello, how are you today?')).toBe(false)
    expect(sembraItaliano('My daughter will be absent tomorrow morning')).toBe(false)
  })

  it('francese/spagnolo → false', () => {
    expect(sembraItaliano('Bonjour, mon fils sera absent demain')).toBe(false)
    expect(sembraItaliano('Hola, mañana llevaré los documentos')).toBe(false)
  })

  it('alfabeti non latini (cirillico/arabo) → false', () => {
    expect(sembraItaliano('Доброго дня, дитина завтра не прийде')).toBe(false)
    expect(sembraItaliano('صباح الخير، ابني غائب غدا')).toBe(false)
  })

  it('emoji, vuoto o parolina corta → true (niente da tradurre)', () => {
    expect(sembraItaliano('')).toBe(true)
    expect(sembraItaliano('👍👍')).toBe(true)
    expect(sembraItaliano('Ok')).toBe(true)
    expect(sembraItaliano('Sì')).toBe(true)
  })
})
