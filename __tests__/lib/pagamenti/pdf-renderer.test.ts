import { beforeEach, describe, expect, it, vi } from 'vitest'

const stato = vi.hoisted(() => ({
  ordine: [] as string[],
  fallimentiUnpdf: 0,
  getDocumentProxy: vi.fn(),
}))

vi.mock('core-js/modules/web.structured-clone.js', () => {
  stato.ordine.push('structured-clone')
  return {}
})
vi.mock('core-js/modules/es.math.sum-precise.js', () => {
  stato.ordine.push('sum-precise')
  return {}
})
vi.mock('core-js/modules/web.url.parse.js', () => {
  stato.ordine.push('url-parse')
  return {}
})
vi.mock('core-js/modules/es.object.has-own.js', () => {
  stato.ordine.push('has-own')
  return {}
})
vi.mock('core-js/modules/es.array.at.js', () => {
  stato.ordine.push('array-at')
  return {}
})
vi.mock('core-js/modules/es.typed-array.at.js', () => {
  stato.ordine.push('typed-array-at')
  return {}
})
async function adattatoreNuovo(fallimentiUnpdf = 0) {
  vi.resetModules()
  stato.fallimentiUnpdf = fallimentiUnpdf
  vi.doMock('unpdf', () => {
    stato.ordine.push('unpdf')
    if (stato.fallimentiUnpdf > 0) {
      stato.fallimentiUnpdf -= 1
      throw new Error('chunk unpdf non disponibile')
    }
    return { getDocumentProxy: stato.getDocumentProxy }
  })
  return await import('@/lib/pagamenti/pdf-renderer')
}

describe('caricaMotorePdf', () => {
  beforeEach(() => {
    stato.ordine.length = 0
    stato.fallimentiUnpdf = 0
    stato.getDocumentProxy.mockReset()
  })

  it('completa tutti i polyfill nell’ordine dichiarato prima di importare unpdf', async () => {
    const { caricaMotorePdf } = await adattatoreNuovo()

    const motore: typeof import('unpdf')['getDocumentProxy'] = await caricaMotorePdf()

    expect(motore).toBe(stato.getDocumentProxy)
    expect(stato.ordine).toEqual([
      'structured-clone',
      'sum-precise',
      'url-parse',
      'has-own',
      'array-at',
      'typed-array-at',
      'unpdf',
    ])
  })

  it('non conserva per sempre una promessa rifiutata e consente un retry reale', async () => {
    const { caricaMotorePdf } = await adattatoreNuovo(1)

    // Vitest avvolge l'eccezione lanciata dalla factory del modulo; qui conta
    // che il primo import fallisca e che il secondo rivaluti davvero `unpdf`.
    await expect(caricaMotorePdf()).rejects.toThrow()
    await expect(caricaMotorePdf()).resolves.toBe(stato.getDocumentProxy)

    expect(stato.ordine.filter((passo) => passo === 'unpdf')).toHaveLength(2)
  })
})
