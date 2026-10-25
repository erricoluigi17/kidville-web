// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import {
  TETTO_FILE_CESTINO,
  percorsoNelCestino,
  spostaNelCestino,
  svuotaCestinoScaduto,
} from '@/lib/storage/cestino-file'

type Opzioni = {
  moveFallisce?: Set<string>
  moveLancia?: Set<string>
  resistenti?: Set<string>
  erroreRemove?: boolean
  erroreList?: boolean
}

/**
 * Un bucket in memoria con la semantica che conta: `list` restituisce le CARTELLE con `id: null`
 * e i file con un id, ordinati per nome, paginati con `offset`/`limit` (100 se non indicato) e
 * filtrati per inizio del nome con `search`; `remove` tace sui percorsi che non esistono.
 */
function archivioFinto(iniziali: string[], o: Opzioni = {}) {
  const oggetti = new Set(iniziali)
  const chiamate: string[] = []
  const archivio = {
    move: async (da: string, a: string) => {
      chiamate.push(`move ${da}`)
      if (o.moveLancia?.has(da)) throw new Error('rete giù')
      if (o.moveFallisce?.has(da)) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      if (!oggetti.has(da)) return { data: null, error: { message: 'Object not found', statusCode: '404', status: 400 } }
      oggetti.delete(da)
      oggetti.add(a)
      return { data: { message: 'Successfully moved' }, error: null }
    },
    remove: async (percorsi: string[]) => {
      chiamate.push(`remove ${percorsi.length}`)
      if (o.erroreRemove) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      const tolti = percorsi.filter((p) => oggetti.has(p) && !o.resistenti?.has(p))
      tolti.forEach((p) => oggetti.delete(p))
      return { data: tolti.map((name) => ({ name })), error: null }
    },
    list: async (cartella: string, opz: { limit?: number; offset?: number; search?: string } = {}) => {
      chiamate.push(`list ${cartella}`)
      if (o.erroreList) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      const prefisso = cartella ? `${cartella}/` : ''
      const voci = new Map<string, string | null>()
      for (const p of oggetti) {
        if (!p.startsWith(prefisso)) continue
        const resto = p.slice(prefisso.length)
        const barra = resto.indexOf('/')
        if (barra < 0) voci.set(resto, 'oggetto')
        else voci.set(resto.slice(0, barra), null)
      }
      const nomi = [...voci.keys()].filter((n) => !opz.search || n.startsWith(opz.search)).sort()
      const offset = opz.offset ?? 0
      const limit = opz.limit ?? 100
      return { data: nomi.slice(offset, offset + limit).map((name) => ({ name, id: voci.get(name) ?? null })), error: null }
    },
  }
  const supabase = { storage: { from: () => archivio } }
  return { supabase: supabase as never, oggetti, chiamate }
}

const ADESSO = new Date('2026-11-03T10:00:00Z')
const BUCKET = 'documenti_personale'

beforeEach(() => vi.clearAllMocks())

describe('spostaNelCestino — il file esce dal suo posto ma non dall\'archivio', () => {
  it('il percorso nel cestino porta il giorno in UTC', () => {
    expect(percorsoNelCestino('P1/doc.pdf', ADESSO)).toBe('cestino/2026-11-03/P1/doc.pdf')
  })

  it('sposta i file invece di cancellarli, e lo dice anche quando va tutto bene', async () => {
    const { supabase, oggetti, chiamate } = archivioFinto(['P1/a.pdf', 'P1/b.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 2, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 })
    expect([...oggetti].sort()).toEqual(['cestino/2026-11-03/P1/a.pdf', 'cestino/2026-11-03/P1/b.pdf'])
    expect(chiamate.some((c) => c.startsWith('remove'))).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'info', expect.objectContaining({ esito: 'file-nel-cestino', n_file: 2, n_nel_cestino: 2 }))
  })

  it('un file che non c\'è più è un esito raggiunto, non un errore', async () => {
    const { supabase } = archivioFinto(['P1/a.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/sparito.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 1, giaAssenti: 1, rimossiSenzaCestino: 0, orfani: 0 })
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(false)
  })

  it('se lo spostamento fallisce il file si cancella, come prima, e lo si dice', async () => {
    const { supabase, oggetti } = archivioFinto(['P1/a.pdf', 'P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 1, giaAssenti: 0, rimossiSenzaCestino: 1, orfani: 0 })
    expect([...oggetti]).toEqual(['cestino/2026-11-03/P1/a.pdf'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'storage', 'warn',
      expect.objectContaining({ esito: 'cestino-non-raggiunto', n_file: 1 }),
      expect.objectContaining({ statusCode: '500' }),
    )
  })

  it('un file che non si sposta e non si cancella è un orfano, e si grida', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), resistenti: new Set(['P1/b.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(e.orfani).toBe(1)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', expect.objectContaining({ esito: 'file-orfani-fuori-cestino', n_file: 1 }))
  })

  it('un remove che risponde errore lascia orfani tutti i file che non si erano spostati', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), erroreRemove: true })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 1 })
  })

  it('uno spostamento che lancia segue la stessa strada di quello che fallisce', async () => {
    const { supabase, oggetti } = archivioFinto(['P1/a.pdf'], { moveLancia: new Set(['P1/a.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf'], 'test', ADESSO)
    expect(e.rimossiSenzaCestino).toBe(1)
    expect(oggetti.size).toBe(0)
  })

  it('vuoti, doppioni e percorsi già nel cestino non si toccano', async () => {
    const { supabase, chiamate } = archivioFinto(['P1/a.pdf', 'cestino/2026-11-01/P0/x.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['', '  ', null, '/P1/a.pdf', 'P1/a.pdf', 'cestino/2026-11-01/P0/x.pdf', 'cestino'], 'test', ADESSO)
    expect(chiamate).toEqual(['move P1/a.pdf'])
    expect(e.nelCestino).toBe(1)
  })

  it('nei log mai un percorso', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), resistenti: new Set(['P1/b.pdf']) })
    await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('P1/')
  })

  it('un file già assente non passa dalla cancellazione e non vale un avviso', async () => {
    const { supabase, chiamate } = archivioFinto([])
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/sparito.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 0, giaAssenti: 1, rimossiSenzaCestino: 0, orfani: 0 })
    expect(chiamate).toEqual(['move P1/sparito.pdf'])
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'warn')).toBe(false)
  })
})

describe('svuotaCestinoScaduto — il giro notturno distrugge solo i giorni passati', () => {
  it('toglie le cartelle-giorno più vecchie della soglia e lascia le altre', async () => {
    const { supabase, oggetti } = archivioFinto([
      'cestino/2026-10-01/P1/a.pdf',
      'cestino/2026-10-01/P1/sotto/b.pdf',
      'cestino/2026-10-20/P2/c.pdf',
      'cestino/varie/d.pdf',
      'P3/e.pdf',
    ])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toEqual({ esito: 'ok', giorniScaduti: 1, fileRimossi: 2, fileGiaAssenti: 0, fileBloccanti: 0, lottoPieno: false })
    expect([...oggetti].sort()).toEqual(['P3/e.pdf', 'cestino/2026-10-20/P2/c.pdf', 'cestino/varie/d.pdf'])
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'cestino-file-svuotato', n_giorni: 1, n_file: 2, n_bloccanti: 0 }))
  })

  it('un cestino che non esiste è un giro a zero, non un errore', async () => {
    const { supabase } = archivioFinto(['P3/e.pdf'])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', giorniScaduti: 0, fileRimossi: 0 })
  })

  it('un file che resiste: file-non-rimossi, a livello error', async () => {
    const { supabase } = archivioFinto(
      ['cestino/2026-10-01/P1/a.pdf', 'cestino/2026-10-01/P1/b.pdf'],
      { resistenti: new Set(['cestino/2026-10-01/P1/a.pdf']) },
    )
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'file-non-rimossi', fileRimossi: 1, fileBloccanti: 1 })
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'cestino-file-svuotato', n_bloccanti: 1 }))
  })

  it('un elenco che non risponde: elenco-fallito, e niente si cancella', async () => {
    const { supabase, chiamate } = archivioFinto(['cestino/2026-10-01/P1/a.pdf'], { erroreList: true })
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e.esito).toBe('elenco-fallito')
    expect(chiamate.some((c) => c.startsWith('remove'))).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', expect.objectContaining({ esito: 'cestino-non-letto' }), expect.anything())
  })

  it('oltre il tetto ne toglie quanti il tetto ammette e dice che il lotto è pieno', async () => {
    const file = Array.from({ length: TETTO_FILE_CESTINO + 1 }, (_, i) => `cestino/2026-01-01/P/${String(i).padStart(4, '0')}.pdf`)
    const { supabase, oggetti } = archivioFinto(file)
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', fileRimossi: TETTO_FILE_CESTINO, lottoPieno: true })
    expect(oggetti.size).toBe(1)
  })

  it('più di mille cartelle-giorno: la radice del cestino si legge a pagine', async () => {
    const giorno = 86_400_000
    const file = Array.from({ length: 1001 }, (_, i) => `cestino/${new Date(Date.UTC(2020, 0, 1) + i * giorno).toISOString().slice(0, 10)}/f.pdf`)
    const { supabase } = archivioFinto(file)
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-01-01', 'test')
    expect(e).toMatchObject({ giorniScaduti: 1001, fileRimossi: TETTO_FILE_CESTINO, lottoPieno: true })
  })

  it('il giorno della soglia non è scaduto: resta', async () => {
    const { supabase, oggetti } = archivioFinto(['cestino/2026-10-10/P1/a.pdf'])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', giorniScaduti: 0, fileRimossi: 0 })
    expect([...oggetti]).toEqual(['cestino/2026-10-10/P1/a.pdf'])
  })

  it('una cartella che non ha la forma di un giorno non si svuota, anche se in ordine viene prima', async () => {
    const { supabase, oggetti } = archivioFinto(['cestino/1999/P1/a.pdf', 'cestino/2026-1/P1/b.pdf'])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', giorniScaduti: 0, fileRimossi: 0 })
    expect(oggetti.size).toBe(2)
  })
})
