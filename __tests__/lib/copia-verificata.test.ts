// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { copiaNelBucket, destinazioneGiaPresente, oggettoAssente } from '@/lib/storage/copia-verificata'

type EsitoFinto = { error: unknown } | 'lancia'

const NON_TROVATO = { message: 'Object not found', statusCode: '404', status: 400 }
const BUCKET_ASSENTE = { message: 'Bucket not found', statusCode: '404', status: 400 }
const GIA_LI = { message: 'The resource already exists', statusCode: '409', status: 400 }
const GUASTO = { message: 'internal error', statusCode: '500', status: 500 }

function archivioFinto(esitiPerSorgente: Record<string, EsitoFinto> = {}) {
  const chiamate: { bucket: string; da: string; a: string }[] = []
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        copy: async (da: string, a: string) => {
          chiamate.push({ bucket, da, a })
          const e = esitiPerSorgente[da]
          if (e === 'lancia') throw new Error('rete giù')
          return e ? { data: null, error: e.error } : { data: { path: a }, error: null }
        },
      }),
    },
  }
  return { supabase: supabase as never, chiamate }
}

const A = { da: 'S/A.pdf', a: 'ritirate/S/A-1.pdf' }
const B = { da: 'S/B.pdf', a: 'ritirate/S/B-1.pdf' }

beforeEach(() => vi.clearAllMocks())

describe('copiaNelBucket — prima la copia, e sapere se c\'è', () => {
  it('copia ogni coppia, nell\'ordine, e non logga errori', async () => {
    const { supabase, chiamate } = archivioFinto()
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(chiamate).toEqual([{ bucket: 'pagelle', ...A }, { bucket: 'pagelle', ...B }])
    expect(e.copiati).toEqual([A, B])
    expect(e.falliti).toEqual([])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('409: la copia c\'è già, non è un guasto', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: GIA_LI } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.giaPresenti).toEqual([A])
    expect(e.falliti).toEqual([])
  })

  it('404 «Object not found»: non c\'è niente da conservare, e lo si dice a livello info', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: NON_TROVATO } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(e.sorgentiAssenti).toEqual([A])
    expect(e.copiati).toEqual([B])
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'info', expect.objectContaining({ esito: 'copie-sorgente-assente', n_sorgenti_assenti: 1 }))
  })

  it('«Bucket not found» porta 404 ma è un guasto', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: BUCKET_ASSENTE } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.falliti).toEqual([A])
    expect(e.primoErrore).toBe(BUCKET_ASSENTE)
  })

  it('un 500 non ferma le copie dopo, e si logga a livello error con l\'errore vero', async () => {
    const { supabase, chiamate } = archivioFinto({ [A.da]: { error: GUASTO } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(chiamate).toHaveLength(2)
    expect(e.falliti).toEqual([A])
    expect(e.copiati).toEqual([B])
    expect(h.logEvento).toHaveBeenCalledWith(
      'storage', 'error',
      expect.objectContaining({ esito: 'copie-non-riuscite', bucket: 'pagelle', n_file: 2, n_copiati: 1, n_falliti: 1 }),
      GUASTO,
    )
  })

  it('un\'eccezione di trasporto è un fallimento come gli altri', async () => {
    const { supabase } = archivioFinto({ [A.da]: 'lancia' })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.falliti).toEqual([A])
    expect(e.primoErrore).toBeInstanceOf(Error)
  })

  it('elenco vuoto, coppie vuote, uguali o doppie: nessuna chiamata in più', async () => {
    const { supabase, chiamate } = archivioFinto()
    await copiaNelBucket(supabase, 'pagelle', [], 'test')
    expect(chiamate).toEqual([])
    await copiaNelBucket(supabase, 'pagelle', [{ da: ' ', a: 'x' }, { da: 'S/A.pdf', a: 'S/A.pdf' }, A, { ...A }], 'test')
    expect(chiamate).toEqual([{ bucket: 'pagelle', ...A }])
  })

  it('nei log mai un percorso', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: GUASTO }, [B.da]: { error: NON_TROVATO } })
    await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('S/')
  })
})

describe('i due riconoscitori', () => {
  it('oggettoAssente', () => {
    expect(oggettoAssente(NON_TROVATO)).toBe(true)
    expect(oggettoAssente({ message: 'Object not found' })).toBe(true)
    expect(oggettoAssente(BUCKET_ASSENTE)).toBe(false)
    expect(oggettoAssente(GUASTO)).toBe(false)
    expect(oggettoAssente(null)).toBe(false)
  })
  it('destinazioneGiaPresente', () => {
    expect(destinazioneGiaPresente(GIA_LI)).toBe(true)
    expect(destinazioneGiaPresente({ message: 'The resource already exists' })).toBe(true)
    expect(destinazioneGiaPresente(NON_TROVATO)).toBe(false)
    expect(destinazioneGiaPresente(undefined)).toBe(false)
  })
})
