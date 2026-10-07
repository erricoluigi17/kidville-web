import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// «Genera rette» + servizi mensili: generando le rette di un mese (o dell'anno)
// si generano anche le voci dei servizi dei bambini iscritti nel periodo.
//
// Le rpc dei servizi si registrano in `h.servizi`, un array SEPARATO da quello
// delle rette (`genera-rette-sede-scrittura.test.ts` si aspetta una sola rpc
// di rette): qui si guarda l'ORDINE fra le due con un contatore comune.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const CAT_GLOBALE = 'c0000000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  notificaEvento: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Record<string, unknown>[],
  rette: [] as { nome: string; args: Record<string, unknown>; n: number }[],
  servizi: [] as { nome: string; args: Record<string, unknown>; n: number }[],
  contatore: 0,
  errori: {} as Record<string, { code: string; message?: string }>,
  rpcRette: 'ok' as 'ok' | 'errore',
  rpcServizi: 'ok' as 'ok' | 'errore' | 'lancia' | 'assente',
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))

const rette = (nome: string) => (args: Riga) => {
  h.rette.push({ nome, args, n: ++h.contatore })
  if (h.rpcRette === 'errore') return { data: null, error: { code: 'XX000', message: 'guasto rette' } }
  return { data: 1, error: null }
}
const servizi = (nome: string) => (args: Riga) => {
  h.servizi.push({ nome, args, n: ++h.contatore })
  if (h.rpcServizi === 'lancia') throw new Error('rpc non emulata')
  if (h.rpcServizi === 'errore') return { data: null, error: { code: 'XX000', message: 'guasto servizi' } }
  if (h.rpcServizi === 'assente') return { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
  return { data: 4, error: null }
}

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        scritture: h.scritture as unknown as Scrittura[],
        rpc: {
          genera_rette_mensili: rette('genera_rette_mensili'),
          genera_rette_anno: rette('genera_rette_anno'),
          genera_servizi_mensili: servizi('genera_servizi_mensili'),
          genera_servizi_anno: servizi('genera_servizi_anno'),
        },
      }) as never,
  }
})

import { POST } from '@/app/api/pagamenti/genera-rette/route'

const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/genera-rette', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
    { utente_id: ADMIN, scuola_id: SEDE_E2E },
  ],
  payment_categories: [{ id: CAT_GLOBALE, slug: 'retta', scuola_id: null, nome: 'Retta' }],
  admin_settings: [{ scuola_id: SEDE_B, retta_default_importo: 120 }],
  alunni: [],
  pagamenti: [],
  registro_modifiche: [],
})

const audit = () => h.db.registro_modifiche as Riga[]

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.rette = []
  h.servizi = []
  h.contatore = 0
  h.errori = {}
  h.log = []
  h.rpcRette = 'ok'
  h.rpcServizi = 'ok'
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/genera-rette — i servizi mensili seguono le rette', () => {
  it('mensile: genera_servizi_mensili DOPO le rette, con periodo, sede e alunno_ids null', async () => {
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.servizi).toHaveLength(1)
    expect(h.servizi[0]).toMatchObject({
      nome: 'genera_servizi_mensili',
      args: { p_periodo: '2026-10-01', p_scuola_id: SEDE_B, p_alunno_ids: null },
    })
    expect(h.servizi[0].n).toBeGreaterThan(h.rette[0].n)
    const j = await res.json()
    expect(j.data).toMatchObject({ periodo: '2026-10-01', generati: 1, servizi: { generati: 4 } })
    expect(audit().map((a) => a.azione)).toEqual(['genera_rette', 'genera_servizi'])
  })

  it('annuale: genera_servizi_anno con p_anno_inizio', async () => {
    const res = await POST(post({ anno: 2026, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.servizi).toHaveLength(1)
    expect(h.servizi[0]).toMatchObject({
      nome: 'genera_servizi_anno',
      args: { p_anno_inizio: 2026, p_scuola_id: SEDE_B, p_alunno_ids: null },
    })
    expect(h.servizi[0].n).toBeGreaterThan(h.rette[0].n)
    const j = await res.json()
    expect(j.data.servizi).toEqual({ generati: 4 })
    expect(audit().map((a) => a.azione)).toEqual(['genera_rette_anno', 'genera_servizi_anno'])
  })

  it('alunno_ids è inoltrato ai servizi, mensile e annuale', async () => {
    await POST(post({ periodo: '2026-10', scuola_id: SEDE_B, alunno_ids: [ALU_B] }))
    await POST(post({ anno: 2026, scuola_id: SEDE_B, alunno_ids: [ALU_B] }))
    expect(h.servizi.map((s) => s.args.p_alunno_ids)).toEqual([[ALU_B], [ALU_B]])
  })

  it.each([
    ['errore', 'SERVIZI_NON_GENERATI'],
    ['lancia', 'SERVIZI_NON_GENERATI'],
    ['assente', 'SERVIZI_NON_DISPONIBILI'],
  ] as const)('servizi %s: 200, rette e audit intatti, data.servizi = errore %s', async (modo, codice) => {
    h.rpcServizi = modo
    for (const body of [{ periodo: '2026-10', scuola_id: SEDE_B }, { anno: 2026, scuola_id: SEDE_B }]) {
      h.db.registro_modifiche = []
      const res = await POST(post(body))
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.success).toBe(true)
      expect(j.data.generati).toBe(1)
      expect(j.data.servizi).toEqual({ errore: true, codice })
      // L'audit delle rette c'è; quello dei servizi no (non sono stati generati).
      expect(audit().map((a) => a.azione)).toEqual([body.anno ? 'genera_rette_anno' : 'genera_rette'])
    }
    // Il guasto è loggato a error, non solo restituito.
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('servizi-'))).toBe(true)
  })

  it('rette che falliscono: 500 e i servizi NON partono (mensile e annuale)', async () => {
    h.rpcRette = 'errore'
    expect((await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))).status).toBe(500)
    expect((await POST(post({ anno: 2026, scuola_id: SEDE_B }))).status).toBe(500)
    expect(h.servizi).toEqual([])
    expect(audit()).toEqual([])
  })

  it('sede di collaudo: 400 con codice SEDE_DI_COLLAUDO, né rette né servizi', async () => {
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_E2E }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DI_COLLAUDO')
    expect(h.rette).toEqual([])
    expect(h.servizi).toEqual([])
  })

  it('senza sede dichiarata (admin multi-sede): 400 e nessun servizio', async () => {
    const res = await POST(post({ periodo: '2026-10' }))
    expect(res.status).toBe(400)
    expect(h.servizi).toEqual([])
  })
})
