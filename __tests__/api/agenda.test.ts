import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M6.2 — /api/agenda: schemi zod (400 su input malformato) + gate role-aware
// (genitore via legame, educator solo proprie sezioni, DELETE creatore-o-direzione).

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  scuoleDiUtente: vi.fn(),
  sezioniDiUtente: vi.fn(),
  enqueue: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  inserted: [] as { table: string; payload: Record<string, unknown> }[],
  deleted: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: h.assertSezioneInScope,
  scuoleDiUtente: h.scuoleDiUtente,
}))
vi.mock('@/lib/sezioni/docenti', () => ({ sezioniDiUtente: h.sezioniDiUtente }))
vi.mock('@/lib/primaria/notifiche', () => ({ enqueueNotifichePerAlunni: h.enqueue }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => 'test',
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const rows = () => h.rows[table] ?? []
      let inserted: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({
          data: inserted ? { id: 'ev-new', ...inserted } : rows()[0] ?? null,
          error: null,
        }),
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows(), error: null }),
      }
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.or = chain; b.gte = chain
      b.order = chain; b.limit = chain
      b.insert = (payload: Record<string, unknown>) => {
        inserted = payload
        h.inserted.push({ table, payload })
        return b
      }
      b.delete = () => { h.deleted.push(table); return b }
      return b
    },
  }),
}))

import { GET, POST, DELETE } from '@/app/api/agenda/route'

const GUID = (n: string) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`
const ALUNNO = GUID('1')
const SEZIONE = GUID('2')
const EVENTO = GUID('3')

const req = (qs: string) =>
  ({ url: `http://test/api/agenda${qs ? `?${qs}` : ''}`, headers: new Headers() }) as never
const postReq = (body: unknown) =>
  ({ url: 'http://test/api/agenda', json: async () => body, headers: new Headers() }) as never

const bodyOk = {
  section_id: SEZIONE,
  titolo: 'Uscita al parco',
  tipo: 'uscita',
  data: '2026-07-10',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.inserted = []
  h.deleted = []
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
  h.requireDocente.mockResolvedValue({ user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' } })
  h.assertSezioneInScope.mockResolvedValue(null)
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.sezioniDiUtente.mockResolvedValue([SEZIONE])
})

describe('GET /api/agenda', () => {
  it('401 quando il gate nega', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req(''))).status).toBe(401)
  })

  it('genitore: 400 senza alunno_id', async () => {
    expect((await GET(req(''))).status).toBe(400)
  })

  it('genitore: 400 con alunno_id non UUID (schema zod)', async () => {
    expect((await GET(req('alunno_id=abc'))).status).toBe(400)
  })

  it('genitore: 403 senza legame runtime', async () => {
    h.rows['legame_genitori_alunni'] = []
    expect((await GET(req(`alunno_id=${ALUNNO}`))).status).toBe(403)
  })

  it('genitore: 200 con eventi plesso+sezione del figlio', async () => {
    h.rows['legame_genitori_alunni'] = [{ alunno_id: ALUNNO }]
    h.rows['alunni'] = [{ id: ALUNNO, section_id: SEZIONE, scuola_id: 'sc-1' }]
    h.rows['eventi_agenda'] = [{ id: EVENTO, titolo: 'Recita', tipo: 'evento', data: '2026-07-10' }]
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({ titolo: 'Recita' })
  })

  it('staff: 403 per ruolo cuoca', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'cu-1', role: 'cuoca' } })
    expect((await GET(req(''))).status).toBe(403)
  })

  it('educator: 200 sugli eventi delle proprie sezioni', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' } })
    h.rows['eventi_agenda'] = [{ id: EVENTO, titolo: 'Riunione', tipo: 'riunione', data: '2026-07-11' }]
    const res = await GET(req(''))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(1)
  })

  it('educator: 403 con filtro ?sezione= non assegnata', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' } })
    h.rows['sections'] = [{ id: GUID('9'), scuola_id: 'sc-1' }]
    h.sezioniDiUtente.mockResolvedValue([SEZIONE]) // non include GUID('9')
    expect((await GET(req('sezione=Tulipani'))).status).toBe(403)
  })
})

describe('POST /api/agenda', () => {
  it('403 quando il gate nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(postReq(bodyOk))).status).toBe(403)
  })

  it('400 senza titolo (schema zod)', async () => {
    expect((await POST(postReq({ ...bodyOk, titolo: '' }))).status).toBe(400)
  })

  it('400 con tipo non ammesso (schema zod)', async () => {
    expect((await POST(postReq({ ...bodyOk, tipo: 'festa' }))).status).toBe(400)
  })

  it('400 con data malformata (schema zod)', async () => {
    expect((await POST(postReq({ ...bodyOk, data: '10/07/2026' }))).status).toBe(400)
  })

  it('400 con orario malformato (schema zod)', async () => {
    expect((await POST(postReq({ ...bodyOk, orario_inizio: '25:99' }))).status).toBe(400)
  })

  it('educator: 403 su evento di plesso (senza sezione)', async () => {
    const res = await POST(postReq({ titolo: 'Chiusura', tipo: 'evento', data: '2026-07-10' }))
    expect(res.status).toBe(403)
  })

  it('201 su sezione in scope + notifiche best-effort ai genitori', async () => {
    h.rows['sections'] = [{ id: SEZIONE, scuola_id: 'sc-1' }]
    h.rows['alunni'] = [{ id: 'al-1' }, { id: 'al-2' }]
    const res = await POST(postReq(bodyOk))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(h.inserted[0]?.payload).toMatchObject({
      section_id: SEZIONE,
      scuola_id: 'sc-1',
      creato_da: 'doc-1',
      visibile_genitori: true,
    })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0][1]).toMatchObject({ alunnoIds: ['al-1', 'al-2'], tipo: 'agenda_evento' })
  })

  it('201 con visibile_genitori=false SENZA notifiche', async () => {
    h.rows['sections'] = [{ id: SEZIONE, scuola_id: 'sc-1' }]
    const res = await POST(postReq({ ...bodyOk, visibile_genitori: false }))
    expect(res.status).toBe(201)
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('403 quando assertSezioneInScope nega', async () => {
    h.assertSezioneInScope.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    expect((await POST(postReq(bodyOk))).status).toBe(403)
  })
})

describe('DELETE /api/agenda', () => {
  it('400 senza id (schema zod)', async () => {
    expect((await DELETE(req(''))).status).toBe(400)
  })

  it('404 su evento inesistente', async () => {
    h.rows['eventi_agenda'] = []
    expect((await DELETE(req(`id=${EVENTO}`))).status).toBe(404)
  })

  it('403 se non creatore né direzione', async () => {
    h.rows['eventi_agenda'] = [{ id: EVENTO, scuola_id: 'sc-1', creato_da: 'altro' }]
    expect((await DELETE(req(`id=${EVENTO}`))).status).toBe(403)
    expect(h.deleted).toHaveLength(0)
  })

  it('200 per il creatore', async () => {
    h.rows['eventi_agenda'] = [{ id: EVENTO, scuola_id: 'sc-1', creato_da: 'doc-1' }]
    expect((await DELETE(req(`id=${EVENTO}`))).status).toBe(200)
    expect(h.deleted).toContain('eventi_agenda')
  })

  it('200 per la direzione (admin) nel proprio plesso', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
    h.rows['eventi_agenda'] = [{ id: EVENTO, scuola_id: 'sc-1', creato_da: 'altro' }]
    expect((await DELETE(req(`id=${EVENTO}`))).status).toBe(200)
  })
})
