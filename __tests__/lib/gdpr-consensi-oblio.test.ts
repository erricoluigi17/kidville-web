import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// W5 — la PROVA DEL CONSENSO non è un pretesto per tenere un IP per sempre.
//
// `consensi_accettazioni` conserva `ip` e `user_agent` dell'accettazione di
// privacy e Termini. Un indirizzo IP è un dato personale (art. 4 §1 GDPR): serve
// a rendere credibile la prova, non a restare in tabella a tempo indefinito.
// La tabella nasce senza FK su `parent_id` proprio per sopravvivere
// all'anonimizzazione del genitore — scelta giusta per il valore probatorio, che
// però la lasciava FUORI dall'oblio: dopo la cancellazione dell'account l'IP
// restava lì, agganciato a un `parent_id` ancora unico.
//
// La regola: l'oblio azzera `ip`/`user_agent` e LASCIA il resto (tipo, versione,
// data). La prova continua a dire *cosa* è stato accettato e *quando* — che è
// ciò che serve all'art. 7 §1 e all'art. 1341 c.c. — senza portarsi dietro
// l'identificativo di rete di una famiglia.
//
// Oggi la tabella ha 0 righe in produzione: il problema nasce alla prima
// onboarding. Questo è il momento giusto per chiuderlo.
// =============================================================================

const h = vi.hoisted(() => ({ logErrore: vi.fn(), logEvento: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: h.logOk,
}))

import { scrubProvaConsensi } from '@/lib/gdpr/consensi-oblio'

const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'

interface Traccia {
  table: string
  patch: Record<string, unknown> | null
  filtri: Array<{ col: string; val: unknown }>
}

function fakeAdmin(opts: {
  righe?: Array<{ id: string }>
  errore?: { code?: string; message?: string } | null
  tracce?: Traccia[]
  esplode?: boolean
}): SupabaseClient {
  return {
    from(table: string) {
      if (opts.esplode) throw new Error('client esploso')
      const traccia: Traccia = { table, patch: null, filtri: [] }
      opts.tracce?.push(traccia)
      const b: Record<string, unknown> = {}
      b.update = (v: Record<string, unknown>) => { traccia.patch = v; return b }
      b.eq = (col: string, val: unknown) => { traccia.filtri.push({ col, val }); return b }
      b.select = () => b
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          opts.errore ? { data: null, error: opts.errore } : { data: opts.righe ?? [], error: null },
        ).then(res)
      return b
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scrubProvaConsensi', () => {
  it('azzera SOLO ip e user_agent: tipo, versione e data restano la prova', async () => {
    const tracce: Traccia[] = []
    await scrubProvaConsensi(fakeAdmin({ righe: [{ id: 'c-1' }], tracce }), PARENT_ID, 'test')
    const t = tracce.find((x) => x.table === 'consensi_accettazioni')
    expect(t).toBeTruthy()
    expect(t!.patch).toEqual({ ip: null, user_agent: null })
    expect(Object.keys(t!.patch!)).not.toContain('versione')
    expect(Object.keys(t!.patch!)).not.toContain('accettato_il')
    expect(Object.keys(t!.patch!)).not.toContain('tipo')
  })

  it('tocca solo le righe di QUEL genitore', async () => {
    const tracce: Traccia[] = []
    await scrubProvaConsensi(fakeAdmin({ righe: [{ id: 'c-1' }], tracce }), PARENT_ID, 'test')
    const t = tracce.find((x) => x.table === 'consensi_accettazioni')
    expect(t!.filtri).toEqual([{ col: 'parent_id', val: PARENT_ID }])
  })

  it('ritorna quante prove ha bonificato', async () => {
    const n = await scrubProvaConsensi(
      fakeAdmin({ righe: [{ id: 'c-1' }, { id: 'c-2' }] }),
      PARENT_ID,
      'test',
    )
    expect(n).toBe(2)
  })

  it('nessuna riga → 0, senza errori', async () => {
    const n = await scrubProvaConsensi(fakeAdmin({ righe: [] }), PARENT_ID, 'test')
    expect(n).toBe(0)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('parentId vuoto → 0 senza toccare il database', async () => {
    const tracce: Traccia[] = []
    const n = await scrubProvaConsensi(fakeAdmin({ righe: [{ id: 'c-1' }], tracce }), '', 'test')
    expect(n).toBe(0)
    expect(tracce).toHaveLength(0)
  })

  it('schema assente (DB E2E CI non migrato) → 0 in silenzio, nessun falso allarme', async () => {
    const n = await scrubProvaConsensi(fakeAdmin({ errore: { code: '42P01' } }), PARENT_ID, 'test')
    expect(n).toBe(0)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('errore INATTESO → si logga (un catch muto qui è un IP che resta)', async () => {
    const n = await scrubProvaConsensi(
      fakeAdmin({ errore: { code: '08006', message: 'connessione persa' } }),
      PARENT_ID,
      'test',
    )
    expect(n).toBe(0)
    expect(h.logErrore).toHaveBeenCalledTimes(1)
  })

  it('non lancia mai: un client che esplode non rompe l’oblio a metà', async () => {
    const n = await scrubProvaConsensi(fakeAdmin({ esplode: true }), PARENT_ID, 'test')
    expect(n).toBe(0)
    expect(h.logErrore).toHaveBeenCalledTimes(1)
  })
})
