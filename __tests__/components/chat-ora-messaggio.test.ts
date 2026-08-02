import { describe, it, expect } from 'vitest'
import { formatMessageTime } from '@/components/features/chat/ChatMessageArea'

/**
 * L'ora della bolla di chat, misurata invece che ispezionata.
 *
 * Il collaudo del 2026-08-01 ha trovato `ChatMessageArea.tsx` con la riga 72 già
 * corretta e la 36 no: stesso file, stesso difetto, una sola delle due sanata.
 * Il lock di forma (`__tests__/architecture/date-senza-fuso.test.ts`) vieta la
 * SCRITTURA sbagliata; qui si verifica il RISULTATO, che è l'unica cosa che una
 * famiglia legge.
 *
 * L'istante scelto — `2026-07-30T22:30:00Z` — è mezzanotte e mezza a Roma: è il
 * caso in cui il giorno del server (UTC) e quello del genitore non coincidono.
 * Sotto il difetto questo test è rosso in ENTRAMBE le direzioni:
 *   · con `TZ=UTC`         → «22:30» (o «10:30 PM» in inglese), giorno prima;
 *   · con `TZ=Europe/Rome` → «12:30 AM» in inglese, perché `'en'` è en-US.
 * Verificato eseguendolo con la riga 36 rimessa com'era.
 */
const MEZZANOTTE_E_MEZZA_A_ROMA = '2026-07-30T22:30:00Z'

describe('formatMessageTime — l\'ora è quella della scuola, in formato europeo', () => {
  it('italiano: rende l\'ora di Roma, non quella del processo', () => {
    expect(formatMessageTime(MEZZANOTTE_E_MEZZA_A_ROMA, 'it')).toBe('00:30')
  })

  it('inglese: 24 ore (en-GB), non «12:30 AM» (en-US)', () => {
    expect(formatMessageTime(MEZZANOTTE_E_MEZZA_A_ROMA, 'en')).toBe('00:30')
    // Asserzione negativa col suo controllo positivo: se la formattazione
    // smettesse di produrre qualunque cosa, il `not.toContain` sarebbe verde a
    // vuoto. Il `toMatch` qui sotto dice che un'ora c'è per davvero.
    expect(formatMessageTime(MEZZANOTTE_E_MEZZA_A_ROMA, 'en')).not.toContain('AM')
    expect(formatMessageTime(MEZZANOTTE_E_MEZZA_A_ROMA, 'en')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('un pomeriggio d\'inverno resta uguale nelle due lingue (ora solare, +1)', () => {
    // Controllo positivo su un istante che NON è a cavallo della mezzanotte: se
    // il test qui sopra passasse per un motivo sbagliato (una funzione che
    // ritorna sempre «00:30»), questo diventerebbe rosso.
    expect(formatMessageTime('2026-01-15T13:05:00Z', 'it')).toBe('14:05')
    expect(formatMessageTime('2026-01-15T13:05:00Z', 'en')).toBe('14:05')
  })

  it('e in ora legale lo scarto è di due ore, non di una', () => {
    expect(formatMessageTime('2026-07-15T13:05:00Z', 'it')).toBe('15:05')
  })
})
