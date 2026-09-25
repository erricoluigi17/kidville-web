import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// `obiettiviDisponibili` (selettore docente, POST valutazioni) e
// `leggiObiettiviDisponibili` (PATCH valutazioni) devono usare LO STESSO filtro
// (DL-015): la prima è solo l'involucro «vuoto se fallisce» della seconda. E il
// vuoto da guasto non sparisce più: si logga.

const m = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: m.logEvento,
}))

import { obiettiviDisponibili, leggiObiettiviDisponibili } from '@/lib/primaria/obiettivi'

interface Chiamata { table: string; filtri: unknown[][] }

function client(risposte: Record<string, { data: unknown; error: unknown }>) {
  const chiamate: Chiamata[] = []
  const c = {
    from(table: string) {
      const ch: Chiamata = { table, filtri: [] }
      chiamate.push(ch)
      const qb: Record<string, unknown> = {}
      for (const f of ['select', 'eq', 'order']) qb[f] = (...a: unknown[]) => { ch.filtri.push([f, ...a]); return qb }
      const r = () => Promise.resolve(risposte[table] ?? { data: null, error: null })
      qb.maybeSingle = r
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => r().then(res, rej)
      return qb
    },
  }
  return { supabase: c as unknown as SupabaseClient, chiamate }
}

const MATERIA = { codice: 'matematica', scuola_id: 'sede-test' }
const RIGHE = [{ id: 'o-1', codice: 'M1', descrizione: 'x', livello: 3 }]

beforeEach(() => vi.clearAllMocks())

describe('obiettiviDisponibili — involucro del filtro unico', () => {
  it('applica lo stesso filtro di leggiObiettiviDisponibili (sede, materia, attivi, livello dalla classe)', async () => {
    const a = client({ sections: { data: { name: '3B' }, error: null }, obiettivi_apprendimento: { data: RIGHE, error: null } })
    const b = client({ sections: { data: { name: '3B' }, error: null }, obiettivi_apprendimento: { data: RIGHE, error: null } })
    const righe = await obiettiviDisponibili(a.supabase, MATERIA, 'sez-1')
    const lettura = await leggiObiettiviDisponibili(b.supabase, MATERIA, 'sez-1')
    expect(righe).toEqual(RIGHE)
    expect(lettura).toEqual({ ok: true, righe: RIGHE })
    expect(a.chiamate).toEqual(b.chiamate)
    const ob = a.chiamate.find((c) => c.table === 'obiettivi_apprendimento')!
    expect(ob.filtri).toEqual(expect.arrayContaining([
      ['eq', 'scuola_id', 'sede-test'], ['eq', 'materia_codice', 'matematica'], ['eq', 'attivo', true], ['eq', 'livello', 3],
    ]))
    expect(m.logEvento).not.toHaveBeenCalled()
  })

  it('lettura fallita: resta [] per i chiamanti di sempre, ma il guasto si logga a livello error', async () => {
    const guasto = { code: '57014', message: 'timeout' }
    const { supabase } = client({ obiettivi_apprendimento: { data: null, error: guasto } })
    expect(await obiettiviDisponibili(supabase, MATERIA)).toEqual([])
    expect(m.logEvento).toHaveBeenCalledWith('db', 'error',
      expect.objectContaining({ operazione: 'primaria/obiettivi-disponibili', esito: 'obiettivi-non-letti' }), guasto)
  })

  it('classe illeggibile: anche qui [] e log, non «tutti i livelli» in silenzio', async () => {
    const guasto = { code: '57014', message: 'timeout' }
    const { supabase, chiamate } = client({ sections: { data: null, error: guasto }, obiettivi_apprendimento: { data: RIGHE, error: null } })
    expect(await obiettiviDisponibili(supabase, MATERIA, 'sez-1')).toEqual([])
    expect(chiamate.some((c) => c.table === 'obiettivi_apprendimento')).toBe(false)
    expect(m.logEvento).toHaveBeenCalledWith('db', 'error', expect.objectContaining({ esito: 'obiettivi-non-letti' }), guasto)
  })
})
