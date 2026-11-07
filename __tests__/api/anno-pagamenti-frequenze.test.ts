import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// PR 3 · COMPITO 3.7-2a · i siti dei PAGAMENTI collegati a `scriviFrequenza` (fase A, §4.19):
//   · POST admin/pagamenti/sospensione (sospendi / riattiva)
//   · verificaRevocaSospensioneMorosita (revoca automatica)
//   · ricordaIntestatarioSullaScheda e ricordaPersonaSullaScheda
//
// Per ognuno: `alunni` scritto con successo → UNA chiamata coi campi tradotti e l'anno della sede dell'alunno;
// `alunni` in errore → ZERO chiamate. Un `{ ok: false }` di scriviFrequenza non cambia l'esito di chi chiama.
// =============================================================================

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALU = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const ALU2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const ANNO = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logScrittura: vi.fn(),
  scriviFrequenza: vi.fn(),
  annoAttivoDiSede: vi.fn(),
  updates: [] as { row: Record<string, unknown>; id: unknown }[],
  erroreUpdate: null as { code: string; message: string } | null,
  righeSede: [] as { id: string; scuola_id: string | null }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope, scuoleDiUtente: async () => [SEDE], formaConfronto: (s: string) => s.toLowerCase() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => ({
      update: (row: Record<string, unknown>) => ({
        eq: async (_c: string, id: unknown) => { h.updates.push({ row, id }); return { error: h.erroreUpdate } },
      }),
      select: () => ({ in: () => ({ in: async () => ({ data: h.righeSede, error: null }) }) }),
    }),
  }),
}))

import { POST } from '@/app/api/admin/pagamenti/sospensione/route'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { ricordaIntestatarioSullaScheda, ricordaPersonaSullaScheda } from '@/lib/pagamenti/intestatari'

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/pagamenti/sospensione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.updates.length = 0
  h.erroreUpdate = null
  h.righeSede = [{ id: ALU, scuola_id: SEDE }]
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? ANNO : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
})

describe('POST /api/admin/pagamenti/sospensione', () => {
  it('sospendi: una chiamata coi campi della sospensione e l’anno della sede', async () => {
    const res = await POST(post({ alunno_id: ALU, sospeso: true, motivo: 'morosità' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    const arg = h.scriviFrequenza.mock.calls[0][1]
    expect(arg).toMatchObject({ alunnoId: ALU, annoSedeId: ANNO })
    expect(arg.campi).toMatchObject({ sospeso: true, sospeso_motivo: 'morosità', sospeso_da: 'dir-1', sospeso_causa: 'morosita' })
    expect(typeof arg.campi.sospeso_il).toBe('string')
  })

  it('riattiva: sospeso false e campi azzerati', async () => {
    await POST(post({ alunno_id: ALU, sospeso: false }))
    expect(h.scriviFrequenza.mock.calls[0][1].campi).toMatchObject({
      sospeso: false, sospeso_motivo: null, sospeso_il: null, sospeso_causa: null,
    })
  })

  it('alunni in errore: 500 e zero chiamate', async () => {
    h.erroreUpdate = { code: '23514', message: 'no' }
    const res = await POST(post({ alunno_id: ALU, sospeso: true }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('sede senza anno attivo: nessuna chiamata, risposta 200', async () => {
    h.annoAttivoDiSede.mockResolvedValue(null)
    expect((await POST(post({ alunno_id: ALU, sospeso: true }))).status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('scriviFrequenza fallita: la risposta resta 200', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((await POST(post({ alunno_id: ALU, sospeso: true }))).status).toBe(200)
  })
})

// ── verificaRevocaSospensioneMorosita: client finto con le tabelle che la funzione legge ──
function clienteRevoca(opts: { erroreUpdate?: { code: string; message: string } | null } = {}) {
  const alunni = [{ id: ALU, scuola_id: SEDE, sospeso: true, sospeso_causa: 'morosita' }]
  const legami = [{ genitore_id: 'g1', alunno_id: ALU }, { genitore_id: 'g1', alunno_id: ALU2 }]
  const pagamenti = [
    { alunno_id: ALU, importo: 10, importo_pagato: 10, sconto: 0, scadenza: '2020-01-01', stato: 'pagato', tipo: 'singolo' },
  ]
  const righe: Record<string, Record<string, unknown>[]> = { alunni, legame_genitori_alunni: legami, pagamenti }
  return {
    from(tabella: string) {
      const ins: [string, unknown[]][] = []
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = (c: string, vs: unknown[]) => { ins.push([c, vs]); return b }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.update = () => ({ eq: async () => ({ error: opts.erroreUpdate ?? null }) })
      b.insert = async () => ({ error: null })
      b.then = (resolve: (r: unknown) => void) => {
        let data = (righe[tabella] ?? []).slice()
        for (const [c, vs] of ins) data = data.filter((r) => vs.includes(r[c]))
        resolve({ data, error: null })
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('verificaRevocaSospensioneMorosita', () => {
  it('revoca riuscita: una chiamata con sospeso false, e l’anno della sede dell’alunno', async () => {
    const out = await verificaRevocaSospensioneMorosita(clienteRevoca(), [ALU])
    expect(out.revocati).toEqual([ALU])
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU, annoSedeId: ANNO, campi: { sospeso: false, sospeso_motivo: null, sospeso_il: null },
    })
  })

  it('update di alunni in errore: nessuna revoca e zero chiamate', async () => {
    const out = await verificaRevocaSospensioneMorosita(clienteRevoca({ erroreUpdate: { code: '23514', message: 'no' } }), [ALU])
    expect(out.revocati).toEqual([])
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

// ── intestatari: client finto che restituisce la riga scritta ──
function clienteIntestatario(opts: { data?: unknown[]; error?: unknown; lettura?: unknown }) {
  const catena: Record<string, unknown> = {}
  catena.update = () => catena
  catena.eq = () => catena
  catena.is = () => catena
  catena.select = () => catena
  catena.maybeSingle = async () => ({ data: opts.lettura ?? null, error: null })
  catena.then = (resolve: (r: unknown) => void) => resolve({ data: opts.data ?? null, error: opts.error ?? null })
  return { from: () => catena } as unknown as SupabaseClient
}

describe('ricordaIntestatarioSullaScheda', () => {
  it('salvato: una chiamata con l’intestatario tradotto, anno della sede della riga scritta', async () => {
    const r = await ricordaIntestatarioSullaScheda(clienteIntestatario({ data: [{ id: ALU, scuola_id: SEDE }] }), ALU, 'ad-1')
    expect(r.esito).toBe('salvato')
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU, annoSedeId: ANNO, campi: { intestatario_fatture: { tipo: 'adult', adult_id: 'ad-1' } },
    })
  })

  it('scheda già compilata (zero righe): zero chiamate', async () => {
    const r = await ricordaIntestatarioSullaScheda(clienteIntestatario({ data: [] }), ALU, 'ad-1')
    expect(r.esito).toBe('gia_impostato')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('alunni in errore: zero chiamate', async () => {
    const r = await ricordaIntestatarioSullaScheda(clienteIntestatario({ error: { code: '42501', message: 'x' } }), ALU, 'ad-1')
    expect(r.esito).toBe('non_salvato')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('riga senza sede: nessuna chiamata, esito invariato', async () => {
    const r = await ricordaIntestatarioSullaScheda(clienteIntestatario({ data: [{ id: ALU }] }), ALU, 'ad-1')
    expect(r.esito).toBe('salvato')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

describe('ricordaPersonaSullaScheda', () => {
  const lettura = { intestatario_fatture: null, scuola_id: SEDE, section_id: null }

  it('salvato: una chiamata con la persona, anno della sede letta', async () => {
    const r = await ricordaPersonaSullaScheda(clienteIntestatario({ data: [{ id: ALU }], lettura }), ALU, { nome: 'X' }, [SEDE])
    expect(r.esito).toBe('salvato')
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU, annoSedeId: ANNO, campi: { intestatario_fatture: { tipo: 'altro', dati: { nome: 'X' } } },
    })
  })

  it('alunni in errore: zero chiamate', async () => {
    const r = await ricordaPersonaSullaScheda(clienteIntestatario({ error: { code: '42501' }, lettura }), ALU, { nome: 'X' }, [SEDE])
    expect(r.esito).toBe('non_salvato')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('bambino fuori sede: nessuna scrittura, zero chiamate', async () => {
    const r = await ricordaPersonaSullaScheda(clienteIntestatario({ data: [{ id: ALU }], lettura }), ALU, { nome: 'X' }, [])
    expect(r.esito).toBe('fuori_sede')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})
