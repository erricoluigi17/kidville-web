import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// T4 (ritocchi) — il tab "Report cucina" di /admin/mensa deve essere leggibile
// anche dalla SEGRETERIA (PRD §3: segreteria≈admin), così il flusso "inserisco
// il pasto fuori orario e controllo il report" si chiude. Il gate
// requireKitchenRead qui NON è mockato: si esercita la allowlist reale.

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }) }))
vi.mock('@/lib/mensa/server', () => ({ loadResolveOptions: async () => ({}) }))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuGiorno: () => ({ attivo: true, chiuso: false }) }))
vi.mock('@/lib/supabase/server-client', () => ({
  // nessuna sessione Supabase → resolveIdentity ricade sull'header x-user-id
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b
      // loadAppUser: utenti .single()
      b.single = async () => ({ data: h.utente, error: null })
      // report: prenotazioni del giorno (awaitata direttamente) → vuota
      b.then = (res: (v: unknown) => void) => res({ data: [], error: null })
      void table
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/report/route'

const req = (userId: string) =>
  new NextRequest('http://localhost/api/mensa/report', { headers: { 'x-user-id': userId } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
})

describe('GET /api/mensa/report — gate requireKitchenRead (reale)', () => {
  it('SEGRETERIA → 200: il report cucina è leggibile allo sportello', async () => {
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.totale).toBe(0)
  })

  it('cuoca → 200 (allowlist preesistente intatta)', async () => {
    h.utente = { ...h.utente, ruolo: 'cuoca', role: 'cuoca' }
    expect((await GET(req(SEGRETERIA))).status).toBe(200)
  })

  it('genitore → 403 (il gate resta chiuso ai non addetti)', async () => {
    h.utente = { ...h.utente, ruolo: 'genitore', role: 'genitore' }
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Accesso negato: operazione riservata a cucina/staff')
  })
})
