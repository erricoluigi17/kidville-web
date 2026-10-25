import { describe, it, expect } from 'vitest'
import { ATTESA_ESITO_1006_MS, MOTIVO_1006, decidiLogErroreCanale, decidiScadenza1006 } from '@/lib/chat/esito-1006'

describe('il 1006 aspetta il suo esito; ogni altro motivo si logga subito', () => {
  it('socket-chiuso-1006 → aspetta-esito', () => {
    expect(MOTIVO_1006).toBe('socket-chiuso-1006')
    expect(decidiLogErroreCanale(MOTIVO_1006)).toBe('aspetta-esito')
  })

  it.each(['trasporto', 'connessione-persa', 'socket-chiuso-1000', 'socket-chiuso-1011', 'join-rifiutato-token', 'nessun-motivo'])(
    '%s → subito',
    (motivo) => {
      expect(decidiLogErroreCanale(motivo)).toBe('subito')
    },
  )

  it('alla scadenza: nulla se l’interruzione è chiusa, logga se è aperta e la pagina si vede, riarma se è nascosta', () => {
    expect(decidiScadenza1006({ interruzioneAperta: false, paginaVisibile: true })).toBe('nulla')
    expect(decidiScadenza1006({ interruzioneAperta: false, paginaVisibile: false })).toBe('nulla')
    expect(decidiScadenza1006({ interruzioneAperta: true, paginaVisibile: true })).toBe('logga')
    expect(decidiScadenza1006({ interruzioneAperta: true, paginaVisibile: false })).toBe('riarma')
  })

  it('l’attesa è un minuto: oltre i rientri di realtime-js (1, 2, 5, 10 s, poi ogni 10 s)', () => {
    expect(ATTESA_ESITO_1006_MS).toBe(60_000)
  })
})
