// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...orig, logEvento: h.logEvento }
})
// Il PDF non serve qui: `persistPagella` riceve il buffer già fatto.
vi.mock('@/lib/primaria/pagella-pdf', () => ({ buildPagellaPdf: vi.fn() }))

import { pagelleInVigore, percorsoPagellaRitirata } from '@/lib/primaria/pagelle-ritirate'
import { persistPagella } from '@/lib/primaria/pagella-store'

type Esito = { data: unknown; error: unknown }

function clientLettura(esiti: Esito[]) {
  const letture: string[][] = []
  const coda = [...esiti]
  const client = {
    from: (tabella: string) => {
      const passi = [tabella]
      const qb: Record<string, unknown> = {}
      qb.select = (c: string) => { passi.push(`select:${c}`); return qb }
      qb.eq = (c: string, v: unknown) => { passi.push(`eq:${c}=${String(v)}`); return qb }
      qb.is = (c: string, v: unknown) => { passi.push(`is:${c}=${String(v)}`); return qb }
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        letture.push(passi)
        return Promise.resolve(coda.shift() ?? { data: [], error: null }).then(res, rej)
      }
      return qb
    },
  }
  return { client: client as never, letture }
}

function clientGenerazione(erroriUpsert: unknown[] = []) {
  const upsert: { tabella: string; riga: Record<string, unknown>; opzioni: unknown }[] = []
  const coda = [...erroriUpsert]
  const client = {
    storage: {
      listBuckets: async () => ({ data: [{ name: 'pagelle' }], error: null }),
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({ upload: async () => ({ data: { path: 'x' }, error: null }) }),
    },
    from: (tabella: string) => ({
      upsert: async (riga: Record<string, unknown>, opzioni: unknown) => {
        upsert.push({ tabella, riga, opzioni })
        return { data: null, error: coda.shift() ?? null }
      },
    }),
  }
  return { client: client as never, upsert }
}

const S = '50000000-0000-4000-8000-000000000001'
const A = '60000000-0000-4000-8000-000000000001'
const U = '70000000-0000-4000-8000-000000000001'
const DATI = { dirigente: null, chiusoIl: null } as never

beforeEach(() => vi.clearAllMocks())

describe('percorsoPagellaRitirata', () => {
  it('cartella dello scrutinio sotto ritirate/, alunno e istante al millesimo', () => {
    expect(percorsoPagellaRitirata(S, A, new Date('2026-11-03T10:00:00.123Z'))).toBe(`ritirate/${S}/${A}-20261103100000123.pdf`)
  })
})

describe('pagelleInVigore', () => {
  it('chiede solo le righe non ritirate dello scrutinio', async () => {
    const { client, letture } = clientLettura([{ data: [{ alunno_id: A }], error: null }])
    const r = await pagelleInVigore(client, S)
    expect(r).toEqual({ data: [{ alunno_id: A }], error: null })
    expect(letture).toEqual([['pagelle', 'select:alunno_id', `eq:scrutinio_id=${S}`, 'is:ritirata_il=null']])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('senza la colonna (42703) rilegge senza filtro e lo dice a livello info', async () => {
    const { client, letture } = clientLettura([
      { data: null, error: { code: '42703', message: 'column pagelle.ritirata_il does not exist' } },
      { data: [{ alunno_id: A }], error: null },
    ])
    const r = await pagelleInVigore(client, S)
    expect(r).toEqual({ data: [{ alunno_id: A }], error: null })
    expect(letture[1]).toEqual(['pagelle', 'select:alunno_id', `eq:scrutinio_id=${S}`])
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente', scrutinio_id: S }))
  })

  it('un guasto vero non si ripiega: torna al chiamante', async () => {
    const guasto = { code: '08006', message: 'connection reset' }
    const { client, letture } = clientLettura([{ data: null, error: guasto }])
    expect(await pagelleInVigore(client, S)).toEqual({ data: null, error: guasto })
    expect(letture).toHaveLength(1)
  })
})

describe('persistPagella — la pagella rigenerata torna in vigore', () => {
  it('l’upsert rimette ritirata_il a NULL e non tocca file_ritirati', async () => {
    const { client, upsert } = clientGenerazione()
    await persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)
    expect(upsert).toHaveLength(1)
    expect(upsert[0].riga).toMatchObject({ scrutinio_id: S, alunno_id: A, file_url: `${S}/${A}.pdf`, ritirata_il: null })
    expect(upsert[0].riga).not.toHaveProperty('file_ritirati')
    expect(upsert[0].opzioni).toEqual({ onConflict: 'scrutinio_id,alunno_id' })
  })

  it('senza la colonna (PGRST204) riprova senza, e lo dice', async () => {
    const { client, upsert } = clientGenerazione([{ code: 'PGRST204', message: "Could not find the 'ritirata_il' column" }])
    await persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)
    expect(upsert).toHaveLength(2)
    expect(upsert[1].riga).not.toHaveProperty('ritirata_il')
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente' }))
  })

  it('un guasto vero lancia, senza secondo tentativo', async () => {
    const { client, upsert } = clientGenerazione([{ code: 'XX000', message: 'guasto' }])
    await expect(persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)).rejects.toThrow('Registrazione della pagella archiviata non riuscita')
    expect(upsert).toHaveLength(1)
  })
})
