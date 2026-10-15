import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { oggiRoma } from '@/lib/storici/retroattivita'

const h = vi.hoisted(() => ({ db: {} as DBFinto, audit: vi.fn(), log: vi.fn() }))
const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const RIGA = 'f0000000-0000-4000-8000-000000000001'
const ORDINE = 'c0000000-0000-4000-8000-000000000001'

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ({ user: { id: 'b0000000-0000-4000-8000-000000000001', role: 'segreteria' } }) }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => ['a0000000-0000-4000-8000-000000000001'] }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.audit }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunno: async () => ['d0000000-0000-4000-8000-000000000001'] }))
vi.mock('@/lib/merch/stati', async originale => ({ ...await originale<typeof import('@/lib/merch/stati')>(), sincronizzaTestata: async () => undefined }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db) }))

import { POST } from '@/app/api/admin/merch/consegna/route'
import { PATCH } from '@/app/api/admin/merch/righe/route'

const richiesta = (body: unknown, method = 'POST') => new Request('http://localhost/api/admin/merch/consegna', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const giorniFa = (delta: number) => new Date(Date.parse(`${oggiRoma()}T12:00:00Z`) - delta * 86_400_000).toISOString().slice(0, 10)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    divise_ordini_righe: [{ id: RIGA, stato: 'arrivato', ordine_id: ORDINE, articolo_nome: 'Materiale di prova',
      ordine: { id: ORDINE, scuola_id: SEDE, alunno_id: ALUNNO, creato_il: `${giorniFa(10)}T12:00:00Z`, pagamento: { stato: 'pagato' } } }],
    alunni: [{ id: ALUNNO, scuola_id: SEDE }], notifiche: [],
  }
})

describe('merch: conta la consegna reale, anche con ordini vecchi', () => {
  it.each([0, 1])('consegna di oggi meno %i giorni: persiste evento e governa la coda', async delta => {
    const giorno = giorniFa(delta)
    const res = await POST(richiesta({ righe_ids: [RIGA], giorno_competenza: giorno }))
    expect(res.status).toBe(200)
    expect(h.db.divise_ordini_righe[0].stato).toBe('consegnato')
    expect(oggiRoma(new Date(String(h.db.divise_ordini_righe[0].consegnato_il)))).toBe(giorno)
    expect(h.db.notifiche).toHaveLength(delta === 0 ? 1 : 0)
    if (delta === 0) expect(h.db.notifiche[0]).toMatchObject({ politica_operazione: { giornoCompetenza: giorno, sopprimiGenitori: false } })
  })

  it('rettifica la data di una consegna consolidata senza rifare la consegna né avvisare', async () => {
    h.db.divise_ordini_righe[0].stato = 'consegnato'
    h.db.divise_ordini_righe[0].consegnato_il = `${giorniFa(3)}T12:00:00Z`
    h.db.divise_ordini_righe[0].consegnato_da = 'b0000000-0000-4000-8000-000000000002'
    const res = await PATCH(richiesta({ riga_id: RIGA, stato: 'consegnato', giorno_competenza: giorniFa(2) }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(oggiRoma(new Date(String(h.db.divise_ordini_righe[0].consegnato_il)))).toBe(giorniFa(2))
    expect(h.db.divise_ordini_righe[0].consegnato_da).toBe('b0000000-0000-4000-8000-000000000002')
    expect(h.db.notifiche).toHaveLength(0)
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ valorePrima: expect.objectContaining({ stato: 'consegnato' }) }))
  })
})
