import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M9 — regression-lock sui gap auth PRE-esistenti segnalati in M3 e chiusi in M9:
// forms/export (pdf+xlsx), admin/forms, admin/parents/[id], admin/adults,
// admin/pre-inscriptions (GET/PATCH; il POST è il portale pubblico), chat
// (config/contacts/threads), notes/sign, teacher/modulistica GET.
// Verifica: (a) ogni handler propaga la response del gate (401 in anonimo);
// (b) chat usa l'identità del GATE e ignora il ?userId= legacy (anti-spoof);
// (c) threads POST rifiuta i non-partecipanti; (d) notes/sign esige il legame
// genitore↔alunno e firma con l'identità del gate (niente fallback demo).

const h = vi.hoisted(() => {
  const denied = () => ({
    response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
  })
  return {
    denied,
    // ogni gate è riconfigurabile per-test; default: negato
    requireStaff: vi.fn(async () => denied() as { user?: { id: string; role: string }; response?: Response }),
    requireDocente: vi.fn(async () => denied() as { user?: { id: string; role: string }; response?: Response }),
    requireUser: vi.fn(async () => denied() as { user?: { id: string; role: string }; response?: Response }),
    // registro delle query: [table, metodo, argomenti...]
    calls: [] as Array<[string, string, ...unknown[]]>,
    rows: {} as Record<string, unknown>, // risposta per-tabella (maybeSingle)
    lists: {} as Record<string, unknown[]>, // risposta per-tabella (await lista)
  }
})

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))

vi.mock('@/lib/settings/module-config', () => ({
  getModuleConfig: vi.fn(async () => ({})),
}))

vi.mock('@/lib/supabase/server-client', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = (m: string) =>
      (...args: unknown[]) => {
        h.calls.push([table, m, ...args])
        return b
      }
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'update', 'insert', 'delete', 'range']) {
      b[m] = chain(m)
    }
    b.maybeSingle = async () => ({ data: h.rows[table] ?? null, error: null })
    b.single = async () => ({ data: h.rows[table] ?? null, error: h.rows[table] ? null : { message: 'not found' } })
    // await su builder-lista
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: h.lists[table] ?? [], error: null, count: 0 })
    return b
  }
  return {
    createAdminClient: async () => ({ from: builder }),
    createClient: async () => ({ from: builder, auth: { getUser: async () => ({ data: { user: null } }) } }),
  }
})

import { GET as xlsxGET } from '@/app/api/forms/export/xlsx/route'
import { GET as pdfGET } from '@/app/api/forms/export/pdf/route'
import { GET as formsGET, POST as formsPOST } from '@/app/api/admin/forms/route'
import { GET as parentByIdGET } from '@/app/api/admin/parents/[id]/route'
import { GET as adultsGET, POST as adultsPOST } from '@/app/api/admin/adults/route'
import { GET as preInsGET, PATCH as preInsPATCH } from '@/app/api/admin/pre-inscriptions/route'
import { GET as chatConfigGET } from '@/app/api/chat/config/route'
import { GET as chatContactsGET } from '@/app/api/chat/contacts/route'
import { GET as chatThreadsGET, POST as chatThreadsPOST } from '@/app/api/chat/threads/route'
import { POST as notesSignPOST } from '@/app/api/notes/sign/route'
import { GET as teacherModGET } from '@/app/api/teacher/modulistica/route'

const req = (url: string, init?: RequestInit) => new Request(url, init)
const jsonReq = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  h.calls.length = 0
  h.rows = {}
  h.lists = {}
  h.requireStaff.mockImplementation(async () => h.denied())
  h.requireDocente.mockImplementation(async () => h.denied())
  h.requireUser.mockImplementation(async () => h.denied())
})

describe('M9 — gate propagati (401 in anonimo)', () => {
  it('GET /api/forms/export/xlsx → 401', async () => {
    expect((await xlsxGET(req('http://x/api/forms/export/xlsx') as never)).status).toBe(401)
  })
  it('GET /api/forms/export/pdf → 401', async () => {
    expect((await pdfGET(req(`http://x/api/forms/export/pdf?id=${UUID_A}`) as never)).status).toBe(401)
  })
  it('GET/POST /api/admin/forms → 401 (GET via requireDocente)', async () => {
    expect((await formsGET(req('http://x/api/admin/forms') as never)).status).toBe(401)
    expect(h.requireDocente).toHaveBeenCalled()
    expect((await formsPOST(jsonReq('http://x/api/admin/forms', 'POST', { title: 't', fields: [1] }) as never)).status).toBe(401)
    expect(h.requireStaff).toHaveBeenCalled()
  })
  it('GET /api/admin/parents/[id] → 401', async () => {
    const res = await parentByIdGET(req(`http://x/api/admin/parents/${UUID_A}`) as never, {
      params: Promise.resolve({ id: UUID_A }),
    })
    expect(res.status).toBe(401)
  })
  it('GET/POST /api/admin/adults → 401', async () => {
    expect((await adultsGET(req('http://x/api/admin/adults') as never)).status).toBe(401)
    expect((await adultsPOST(jsonReq('http://x/api/admin/adults', 'POST', { emails: ['a@b.it'] }) as never)).status).toBe(401)
  })
  it('GET/PATCH /api/admin/pre-inscriptions → 401 (il POST pubblico resta senza gate)', async () => {
    expect((await preInsGET(req('http://x/api/admin/pre-inscriptions') as never)).status).toBe(401)
    expect(
      (await preInsPATCH(jsonReq('http://x/api/admin/pre-inscriptions', 'PATCH', { id: UUID_A, status: 'rejected' }) as never)).status
    ).toBe(401)
  })
  it('GET /api/chat/config|contacts|threads → 401', async () => {
    expect((await chatConfigGET(req('http://x/api/chat/config'))).status).toBe(401)
    expect((await chatContactsGET(req('http://x/api/chat/contacts'))).status).toBe(401)
    expect((await chatThreadsGET(req('http://x/api/chat/threads'))).status).toBe(401)
  })
  it('POST /api/notes/sign → 401 (niente fallback demo)', async () => {
    expect((await notesSignPOST(jsonReq('http://x/api/notes/sign', 'POST', { notaId: UUID_A }))).status).toBe(401)
    // nessuna scrittura tentata senza identità
    expect(h.calls.filter(([, m]) => m === 'update')).toHaveLength(0)
  })
  it('GET /api/teacher/modulistica → 401', async () => {
    expect((await teacherModGET(req('http://x/api/teacher/modulistica?form_id=f&class_name=c') as never)).status).toBe(401)
  })
})

describe('M9 — identità dal gate, ?userId= legacy ignorato (anti-spoof)', () => {
  it('chat/contacts interroga con l\'id del gate, mai con quello in query', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    h.rows['utenti'] = { id: UUID_A, ruolo: 'genitore', role: 'genitore' }
    const res = await chatContactsGET(req(`http://x/api/chat/contacts?userId=${UUID_B}`))
    expect(res.status).toBe(200)
    const flat = JSON.stringify(h.calls)
    expect(flat).toContain(UUID_A)
    expect(flat).not.toContain(UUID_B)
  })
  it('chat/threads GET filtra i thread con l\'id del gate, mai con quello in query', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    const res = await chatThreadsGET(req(`http://x/api/chat/threads?userId=${UUID_B}`))
    expect(res.status).toBe(200)
    const orCall = h.calls.find(([t, m]) => t === 'chat_threads' && m === 'or')
    expect(String(orCall?.[2])).toContain(UUID_A)
    expect(String(orCall?.[2])).not.toContain(UUID_B)
  })
})

describe('M9 — chat/threads POST solo per i partecipanti', () => {
  it('403 se il chiamante non è né teacher_id né parent_id', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    const res = await chatThreadsPOST(
      jsonReq('http://x/api/chat/threads', 'POST', { teacher_id: UUID_B, parent_id: UUID_C, student_id: UUID_A })
    )
    expect(res.status).toBe(403)
  })
  it('200 se il chiamante è un partecipante (thread esistente restituito)', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_C, role: 'genitore' } }))
    h.rows['chat_threads'] = { id: UUID_A }
    const res = await chatThreadsPOST(
      jsonReq('http://x/api/chat/threads', 'POST', { teacher_id: UUID_B, parent_id: UUID_C, student_id: UUID_A })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(UUID_A)
  })
})

describe('M9 — notes/sign col legame genitore↔alunno', () => {
  it('404 se la nota non esiste', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    const res = await notesSignPOST(jsonReq('http://x/api/notes/sign', 'POST', { notaId: UUID_B }))
    expect(res.status).toBe(404)
  })
  it('403 senza legame con l\'alunno della nota', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    h.rows['note_disciplinari'] = { id: UUID_B, alunno_id: UUID_C }
    h.rows['legame_genitori_alunni'] = null as never
    const res = await notesSignPOST(jsonReq('http://x/api/notes/sign', 'POST', { notaId: UUID_B }))
    expect(res.status).toBe(403)
  })
  it('firma con l\'identità del gate quando il legame esiste', async () => {
    h.requireUser.mockImplementation(async () => ({ user: { id: UUID_A, role: 'genitore' } }))
    h.rows['note_disciplinari'] = { id: UUID_B, alunno_id: UUID_C }
    h.rows['legame_genitori_alunni'] = { alunno_id: UUID_C }
    const res = await notesSignPOST(jsonReq('http://x/api/notes/sign', 'POST', { notaId: UUID_B }))
    expect(res.status).toBe(200)
    const update = h.calls.find(([t, m]) => t === 'note_disciplinari' && m === 'update')
    expect((update?.[2] as { firmata_da: string }).firmata_da).toBe(UUID_A)
  })
})
