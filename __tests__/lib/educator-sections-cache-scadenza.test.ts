import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchEducatorSections, invalidaEducatorSectionsCache, scadiEducatorSections,
} from '@/lib/sezioni/educator-sections-cache'

// Lotto 6 · rilievo 7 (e 1) — la cache delle sezioni del docente SCADE come quella dei figli (L6-4).
// Un docente con l'app aperta a cavallo del passaggio d'anno non vedeva la classe nuova finché non ricaricava.
// Senza rete, alla ripresa, resta l'elenco di PRIMA: il vecchio si sostituisce solo con una lettura riuscita.

const DOCENTE = 'd0000000-0000-4000-8000-000000000001'
const PRIMA = { sections: [{ id: 'a', name: 'Vecchia', school_type: null }] }
const DOPO = { sections: [{ id: 'b', name: 'Nuova', school_type: null }] }

let risposta: unknown
let rete: boolean
const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-09-10T08:00:00Z'))
  invalidaEducatorSectionsCache()
  risposta = PRIMA
  rete = true
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => (rete
    ? Promise.resolve({ ok: true, status: 200, json: async () => risposta })
    : Promise.reject(new TypeError('Failed to fetch'))))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('cache delle sezioni del docente', () => {
  it('dentro i 30 secondi la richiesta è UNA (deduplica)', async () => {
    await fetchEducatorSections(DOCENTE, { passati: true })
    await fetchEducatorSections(DOCENTE, { passati: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('🔴 dopo i 30 secondi si rilegge dal server e vede la classe nuova', async () => {
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toEqual(PRIMA)
    risposta = DOPO
    vi.setSystemTime(new Date('2027-09-10T08:00:31Z'))
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toEqual(DOPO)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('🔴 alla ripresa (scadi) si rilegge subito, anche dentro i 30 secondi', async () => {
    await fetchEducatorSections(DOCENTE, { passati: true })
    risposta = DOPO
    scadiEducatorSections()
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toEqual(DOPO)
  })

  it('🔴 alla ripresa SENZA RETE resta l’elenco di prima, non «nessuna classe»', async () => {
    await fetchEducatorSections(DOCENTE, { passati: true })
    rete = false
    scadiEducatorSections()
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toEqual(PRIMA)
  })

  it('senza una lettura precedente riuscita e senza rete: `null` (non determinabile)', async () => {
    rete = false
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toBeNull()
  })

  it('il cambio di identità butta anche l’ultima lettura riuscita (mai le classi di un altro)', async () => {
    await fetchEducatorSections(DOCENTE, { passati: true })
    invalidaEducatorSectionsCache(DOCENTE)
    rete = false
    expect(await fetchEducatorSections(DOCENTE, { passati: true })).toBeNull()
  })

  it('«con passati» e «senza» sono letture distinte', async () => {
    await fetchEducatorSections(DOCENTE)
    await fetchEducatorSections(DOCENTE, { passati: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('passati=1')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('passati')
  })
})
