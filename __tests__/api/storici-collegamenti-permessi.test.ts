import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const h = vi.hoisted(() => ({ from: vi.fn() }))
const SEDE = '11111111-1111-4111-8111-111111111111'
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ({ user: { id: 'staff', role: 'genitore', ruoli: ['coordinator', 'genitore'] } }) }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => [SEDE] }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({ from: h.from }) }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
import { GET, POST } from '@/app/api/admin/storici/collegamenti/route'
beforeEach(() => { h.from.mockReset().mockImplementation(() => { throw new Error('I protocolli non devono essere letti') }) })
describe('permessi reali sui collegamenti protocollati', () => {
  it('la veste genitore di un coordinatore non permette di elencare i protocolli', async () => {
    const r = await GET(new NextRequest(`http://test/api/admin/storici/collegamenti?scuolaId=${SEDE}&tipo=protocollo`))
    expect(r.status).toBe(403)
    expect(h.from).not.toHaveBeenCalled()
  })
  it('la stessa veste non permette di collegare un protocollo', async () => {
    const r = await POST(new NextRequest('http://test/api/admin/storici/collegamenti', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scuolaId: SEDE, tipo: 'protocollo', alunnoId: '22222222-2222-4222-8222-222222222222', entitaId: '33333333-3333-4333-8333-333333333333' }) }))
    expect(r.status).toBe(403)
    expect(h.from).not.toHaveBeenCalled()
  })
})
