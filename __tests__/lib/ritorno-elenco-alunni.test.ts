import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { leggiRitornoElenco, ripulisciRitorno, salvaRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('ripulisciRitorno', () => {
  it('toglie la ricerca per nome e tiene gli altri filtri', () => {
    expect(ripulisciRitorno('?sezione=S1&q=rossi&bes=1')).toBe('?sezione=S1&bes=1')
  })
  it('vuoto, solo `q`, troppo lungo o non stringa ⇒ nessun ritorno', () => {
    expect(ripulisciRitorno('')).toBe('')
    expect(ripulisciRitorno('?q=rossi')).toBe('')
    expect(ripulisciRitorno(`?sezione=${'x'.repeat(700)}`)).toBe('')
    expect(ripulisciRitorno(undefined as unknown as string)).toBe('')
  })
})

describe('salva / leggi', () => {
  it('andata e ritorno, già ripulita', () => {
    salvaRitornoElenco('?anno=2021&q=rossi')
    expect(leggiRitornoElenco()).toBe('?anno=2021')
  })
  it('un valore scritto a mano con un nome dentro esce ripulito anche in lettura', () => {
    window.sessionStorage.setItem('kv-teacher-alunni-ritorno', '?q=rossi')
    expect(leggiRitornoElenco()).toBe('')
  })
  it('sessionStorage che lancia: nessun ritorno, un solo warn per sessione', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloccato')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloccato')
    })
    salvaRitornoElenco('?anno=2021')
    expect(leggiRitornoElenco()).toBe('')
    expect(leggiRitornoElenco()).toBe('')
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn' })
  })
})
