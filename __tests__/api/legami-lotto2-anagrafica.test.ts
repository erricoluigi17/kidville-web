import { describe, it, expect, vi, beforeEach } from 'vitest'

// A6 · LOTTO 2 — route che risolvono «genitore → figli» leggendo SOLO la tabella
// runtime `legame_genitori_alunni`. Un genitore arrivato dal form pubblico ha il
// legame SOLO in `student_parents` (spazio-id anagrafica, agganciato all'account
// dal ponte `parents.auth_user_id`): con la sola runtime queste route rispondono
// 403 sul PROPRIO figlio, oppure restituiscono liste vuote — moduli da firmare
// che spariscono, certificati medici invisibili, fatture non scaricabili.
//
// Qui il legame runtime è VUOTO di proposito: è la fotografia reale delle 10
// coppie che in produzione esistono solo in anagrafica.

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGAMENTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enqueueNotifiche: vi.fn(),
  docentiDiSezione: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.9',
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.or = chain; b.not = chain; b.is = chain
      b.gte = chain; b.lte = chain; b.order = chain; b.limit = chain
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.single = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: righe(), error: null })
      return b
    },
  }),
}))

import { GET as fattureList } from '@/app/api/pagamenti/fattura/list/route'
import { GET as parentForms } from '@/app/api/parent/forms/route'
import { GET as certificati } from '@/app/api/parent/medical-certificates/route'
import { POST as lockerNotify } from '@/app/api/locker/notify/route'

/** Solo anagrafica: nessuna riga runtime, ponte `parents.auth_user_id` = gen-1. */
const soloAnagrafica = () => ({
  legame_genitori_alunni: [] as Record<string, unknown>[],
  parents: [{ id: 'p1', auth_user_id: 'gen-1' }],
  student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
  h.docentiDiSezione.mockResolvedValue(['edu-1'])
  h.righe = soloAnagrafica()
})

describe('GET /api/pagamenti/fattura/list — legame solo anagrafico', () => {
  const req = () => new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PAGAMENTO}`)

  it('NON risponde 403 al genitore legato solo via student_parents', async () => {
    h.righe.pagamenti = [{ id: PAGAMENTO, alunno_id: ALUNNO }]
    h.righe.fatture_emesse = []
    const res = await fattureList(req())
    expect(res.status).toBe(200)
  })

  it('resta 403 quando il legame non esiste in NESSUNA delle due sorgenti', async () => {
    h.righe.pagamenti = [{ id: PAGAMENTO, alunno_id: ALUNNO }]
    h.righe.student_parents = []
    h.righe.fatture_emesse = []
    expect((await fattureList(req())).status).toBe(403)
  })
})

describe('GET /api/parent/forms — legame solo anagrafico', () => {
  const req = () => new Request('http://localhost/api/parent/forms') as never

  beforeEach(() => {
    h.righe.alunni = [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Rossi', classe_sezione: 'Girasoli' }]
    h.righe.forms_templates = [
      { id: 'f1', title: 'Uscita didattica', description: null, fields: [], expiration_date: null, target_scope: 'class', target_classes: ['Girasoli'] },
    ]
    h.righe.forms_submissions = []
  })

  it('elenca i moduli del figlio legato solo via student_parents', async () => {
    const res = await parentForms(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].student).toMatchObject({ id: ALUNNO })
  })

  it('lista vuota quando non c\'è alcun legame', async () => {
    h.righe.student_parents = []
    expect(await (await parentForms(req())).json()).toEqual([])
  })
})

describe('GET /api/parent/medical-certificates — legame solo anagrafico', () => {
  const req = () => new Request('http://localhost/api/parent/medical-certificates')

  it('elenca i certificati del figlio legato solo via student_parents', async () => {
    h.righe.certificati_medici = [
      { id: 'c1', alunno_id: ALUNNO, data_inizio: '2026-03-01', data_fine: '2026-03-05', stato: 'validato', file_path: `${ALUNNO}/x.pdf` },
    ]
    const res = await certificati(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: 'c1' })
    // Il path grezzo del dato sanitario resta fuori dalla risposta.
    expect(body.data[0].file_path).toBeUndefined()
  })

  it('lista vuota quando non c\'è alcun legame', async () => {
    h.righe.student_parents = []
    h.righe.certificati_medici = [{ id: 'c1', alunno_id: ALUNNO }]
    expect((await (await certificati(req())).json()).data).toEqual([])
  })
})

describe('POST /api/locker/notify — legame solo anagrafico', () => {
  const post = () =>
    lockerNotify(new Request('http://localhost/api/locker/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alunno_id: ALUNNO, materiale: 'Pannolini' }),
    }))

  beforeEach(() => {
    h.righe.alunni = [{ id: ALUNNO, nome: 'Bimbo', scuola_id: 'sc-1', section_id: 'sez-1' }]
    h.righe.utenti = [{ id: 'seg-1', role: null, ruolo: 'segreteria' }]
  })

  it('NON risponde 403 al genitore legato solo via student_parents', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
  })

  it('resta 403 quando il legame non esiste in NESSUNA delle due sorgenti', async () => {
    h.righe.student_parents = []
    expect((await post()).status).toBe(403)
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })
})
