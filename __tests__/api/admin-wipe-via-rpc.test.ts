import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// PR 3, 3.6 — `admin/wipe` non scrive più `.from(t).delete()`: ogni tabella passa da
// `anno_oblio_svuota`, e la lista della route è la STESSA della funzione (23 + alunni,
// parents, adults = 26). Se una delle due cresce da sola, questo test diventa rosso.
// =============================================================================

const h = vi.hoisted(() => ({
  chiamate: [] as { nome: string; args: Record<string, unknown> }[],
  dirette: [] as string[],
  rpcRisposta: { data: 3, error: null } as { data: unknown; error: unknown },
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (nome: string, args: Record<string, unknown>) => {
      h.chiamate.push({ nome, args })
      return h.rpcRisposta
    },
    from: (t: string) => {
      h.dirette.push(t)
      throw new Error(`scrittura diretta su ${t}`)
    },
  }),
}))
vi.mock('@/lib/security/seal', () => ({ sealDangerous: vi.fn(async () => null) }))
vi.mock('@/lib/security/require-env', () => ({ requireEnv: vi.fn(() => null) }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

import { POST } from '@/app/api/admin/wipe/route'

const chiama = () => POST(new Request('http://localhost/api/admin/wipe', { method: 'POST' }))

beforeEach(() => {
  h.chiamate = []
  h.dirette = []
  h.rpcRisposta = { data: 3, error: null }
})

describe('admin/wipe · via anno_oblio_svuota', () => {
  it('chiama l’RPC una volta per tabella, con l’op, e non scrive mai in diretta', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.dirette, 'nessuna scrittura diretta sul registro').toEqual([])
    expect(h.chiamate.every((c) => c.nome === 'anno_oblio_svuota')).toBe(true)
    expect(h.chiamate.every((c) => c.args.p_op === 'admin/wipe:POST')).toBe(true)
    expect(h.chiamate).toHaveLength(26)
  })

  it('la lista della route è ESATTAMENTE quella della funzione SQL (M3)', async () => {
    await chiama()
    const dallaRoute = h.chiamate.map((c) => String(c.args.p_tabella)).sort()
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261107165503_anno_scrittura.sql'), 'utf8')
    const inizio = sql.indexOf('FUNCTION public.anno_oblio_svuota(')
    const corpo = sql.slice(inizio, sql.indexOf('ELSE false', inizio))
    const dalSql = [...corpo.matchAll(/WHEN '([a-z_]+)' THEN true/g)].map((m) => m[1]).sort()
    expect(dalSql.length, 'il test deve aver letto la lista').toBe(26)
    expect(dallaRoute).toEqual(dalSql)
  })

  it('una tabella che l’RPC non riesce a svuotare → 500 con il suo nome', async () => {
    h.rpcRisposta = { data: null, error: { code: 'XX000', message: 'guasto' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRITTURA_FALLITA')
    expect(corpo.tabelle).toHaveLength(26)
  })
})
