import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Ultima occorrenza dello schema trovata dall'audit (`grep "eq('classe_sezione'"`):
// POST /api/pagamenti/genera. Qui non si LEGGE un'altra sede, ci si SCRIVE:
//
//  · `scuola_id` arrivava dal client e non veniva validato — assente, la query
//    sugli alunni restava del tutto SENZA filtro di sede;
//  · `alunno_ids` arrivava dal client e non veniva validato affatto.
//
// Cioè: una segreteria di Giugliano poteva generare pagamenti (e le notifiche
// che ne seguono) sui bambini di Aversa o di Cesa passandone gli id.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  inserite: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const client = creaFintoSupabase(h.db, h.tabelle) as unknown as {
        from: (t: string) => Record<string, unknown>
      }
      const originale = client.from.bind(client)
      // Intercetta le INSERT su `pagamenti`: quello che conta è che NON venga
      // creato nulla per gli alunni di un'altra sede.
      client.from = (tabella: string) => {
        const b = originale(tabella)
        b.insert = (righe: unknown) => {
          if (tabella === 'pagamenti') h.inserite.push(...(Array.isArray(righe) ? righe : [righe]))
          return {
            select: () => ({ single: async () => ({ data: { id: 'pag-1' }, error: null }) }),
            then: (ok: (v: unknown) => unknown) => ok({ data: [{ id: 'pag-1' }], error: null }),
          }
        }
        return b
      }
      return client as never
    },
  }
})

import { POST } from '@/app/api/pagamenti/genera/route'

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/pagamenti/genera', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  alunni: [
    { id: ALU_A, scuola_id: SEDE_A, classe_sezione: OMONIMA, section_id: 'sec-a', stato: 'iscritto' },
    { id: ALU_B, scuola_id: SEDE_B, classe_sezione: OMONIMA, section_id: 'sec-b', stato: 'iscritto' },
  ],
  pagamenti: [],
})

const BASE = { descrizione: 'Gita', importo: 10, scadenza: '2026-09-30' }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.inserite = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/genera — isolamento per sede', () => {
  it('403 se fra gli alunno_ids ce n\'è uno di un\'altra sede: nessun pagamento creato', async () => {
    const res = await POST(req({ ...BASE, alunno_ids: [ALU_A, ALU_B] }))
    expect(res.status).toBe(403)
    expect(h.inserite).toHaveLength(0)
  })

  it('201 sui propri alunni', async () => {
    const res = await POST(req({ ...BASE, alunno_ids: [ALU_A] }))
    expect(res.status).toBe(201)
    expect(h.inserite).toHaveLength(1)
    expect((h.inserite[0] as { alunno_id: string }).alunno_id).toBe(ALU_A)
  })

  it('classe OMONIMA senza scuola_id: genera solo per la propria sede', async () => {
    const res = await POST(req({ ...BASE, classe_sezione: OMONIMA }))
    expect(res.status).toBe(201)
    expect(h.inserite.map((r) => (r as { alunno_id: string }).alunno_id)).toEqual([ALU_A])
  })

  it('scuola_id del client di un\'altra sede: 403, e NESSUN pagamento generato', async () => {
    // ⚠️ Comportamento atteso CAMBIATO il 2026-07-31. Qui si asseriva 201: la
    // sede dichiarata dal client veniva IGNORATA e le rette si generavano
    // comunque, sulla propria sede. Su un modulo contabile è il ripiego più
    // costoso di tutti — l'operatore crede di aver emesso le rette della classe
    // omonima dell'altro plesso, il server gliele emette sul proprio, e i
    // duplicati si scoprono in riconciliazione. Ora si nega.
    const res = await POST(req({ ...BASE, classe_sezione: OMONIMA, scuola_id: SEDE_B }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile' })
    expect(h.inserite).toEqual([])
  })
})
