import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/ticket/morosi — OGNI RIGA DICE DI QUALE SEDE È (K5, 2026-09-26).
 *
 * Con tre plessi, un elenco di bambini col saldo ticket negativo che non dice la sede
 * costringe la segreteria multi-sede a indovinare a quale cassa mandare la famiglia. Ogni
 * riga porta ora `scuola_id` (dall'alunno, che è la sede vera: `ticket_mensa` non ne ha una)
 * e `scuola_nome`.
 *
 * Gli uuid e i nomi sono INVENTATI.
 */

const SEDE_A = '11111111-2222-4333-8444-5555555555a1'
const SEDE_B = '11111111-2222-4333-8444-5555555555b2'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  sediAttive: [] as string[],
  righe: [] as Record<string, unknown>[],
  righeErrore: null as { code: string; message: string } | null,
  scuole: [] as { id: string; nome: string }[],
  scuoleErrore: null as { code: string; message: string } | null,
  chiamate: [] as { table: string; metodo: string; args: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.sediAttive }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'lt', 'in', 'order', 'eq']) {
        b[m] = (...args: unknown[]) => { h.chiamate.push({ table, metodo: m, args }); return b }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'ticket_mensa') return resolve({ data: h.righeErrore ? null : h.righe, error: h.righeErrore })
        if (table === 'scuole') {
          // Il finto rispetta il filtro `.in('id', …)`: restituisce solo le sedi chieste.
          const filtro = h.chiamate.filter((c) => c.table === 'scuole' && c.metodo === 'in').at(-1)
          const chieste = new Set((filtro?.args[1] as string[] | undefined) ?? [])
          return resolve({
            data: h.scuoleErrore ? null : h.scuole.filter((s) => chieste.has(s.id)),
            error: h.scuoleErrore,
          })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ticket/morosi/route'
import { NextRequest } from 'next/server'

const get = () => GET(new NextRequest('http://localhost/api/pagamenti/ticket/morosi'))

const riga = (id: string, scuola_id: string, saldo: number) => ({
  saldo_ticket: saldo,
  ultimo_carico: null,
  alunni: { id, nome: 'Nome', cognome: `Cognome-${id}`, classe_sezione: 'A', scuola_id },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.sediAttive = [SEDE_A, SEDE_B]
  h.righe = [riga('al-1', SEDE_A, -3), riga('al-2', SEDE_B, -1)]
  h.righeErrore = null
  h.scuole = [{ id: SEDE_A, nome: 'Sede Alfa' }, { id: SEDE_B, nome: 'Sede Beta' }, { id: 'altra', nome: 'Altra' }]
  h.scuoleErrore = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('ogni riga porta la sua sede', () => {
  it('`scuola_id` e `scuola_nome` di OGNI riga, ciascuna col suo plesso', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toHaveLength(2)
    expect(data[0]).toMatchObject({ alunno_id: 'al-1', scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', saldo_ticket: -3 })
    expect(data[1]).toMatchObject({ alunno_id: 'al-2', scuola_id: SEDE_B, scuola_nome: 'Sede Beta', saldo_ticket: -1 })
  })

  it('la sede si legge dall’ALUNNO, nella stessa query scopata (`alunni!inner … scuola_id`)', async () => {
    await get()
    const sel = h.chiamate.find((c) => c.table === 'ticket_mensa' && c.metodo === 'select')
    expect(String(sel?.args[0])).toMatch(/alunni!inner \(.*scuola_id.*\)/)
    const filtro = h.chiamate.find((c) => c.table === 'ticket_mensa' && c.metodo === 'in')
    expect(filtro?.args).toEqual(['alunni.scuola_id', [SEDE_A, SEDE_B]])
  })

  it('i nomi si leggono con UNA query sulle sole sedi presenti nelle righe', async () => {
    h.righe = [riga('al-1', SEDE_A, -3), riga('al-3', SEDE_A, -2)]
    const res = await get()
    const { data } = await res.json()
    expect(data.every((r: { scuola_nome: string }) => r.scuola_nome === 'Sede Alfa')).toBe(true)
    const letture = h.chiamate.filter((c) => c.table === 'scuole' && c.metodo === 'in')
    expect(letture).toHaveLength(1)
    expect(letture[0].args).toEqual(['id', [SEDE_A]])
  })

  it('nessun moroso → nessuna lettura dei nomi', async () => {
    h.righe = []
    const res = await get()
    expect((await res.json()).data).toEqual([])
    expect(h.chiamate.some((c) => c.table === 'scuole')).toBe(false)
  })

  it('nomi non leggibili → righe con `scuola_nome` null (la sede resta), e un `warn`', async () => {
    h.scuoleErrore = { code: 'XX000', message: 'boom' }
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data[0]).toMatchObject({ scuola_id: SEDE_A, scuola_nome: null })
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'warn' && (c as { esito?: string }).esito === 'nomi_sede_non_letti')).toBe(true)
  })
})

describe('perimetro ed errori', () => {
  it('nessuna sede attiva → elenco vuoto, niente letto', async () => {
    h.sediAttive = []
    const res = await get()
    expect((await res.json()).data).toEqual([])
    expect(h.chiamate).toHaveLength(0)
  })

  it('errore sulla SELECT dei morosi → 500 LOGGATO', async () => {
    h.righeErrore = { code: 'XX000', message: 'boom' }
    const res = await get()
    expect(res.status).toBe(500)
    // Stesso guasto, stessa risposta della route gemella GET /api/pagamenti/ticket:
    // il client traduce `codice`, non la frase italiana.
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalled()
  })
})
