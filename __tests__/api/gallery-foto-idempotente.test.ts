import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
const h = vi.hoisted(() => ({
  auth: vi.fn(), sede: vi.fn(), scope: vi.fn(), consenso: vi.fn(), rpc: vi.fn(),
  notify: vi.fn(), destinatari: vi.fn(), insert: vi.fn(), log: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.auth, requireStaff: h.auth }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: h.sede, resolveScuoleAttive: vi.fn(), scuoleDiUtente: vi.fn() }))
vi.mock('@/lib/gallery/tag-scope', () => ({ assertTagStudentsInScope: h.scope }))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: h.consenso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notify }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: h.destinatari, genitoriDiClassi: h.destinatari, genitoriDiScuola: h.destinatari }))
vi.mock('@/lib/logging/logger', () => ({ logErrore: h.log, logEvento: h.log, logOk: h.log }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({
  rpc: h.rpc,
  from: () => ({ insert: h.insert }),
}) }))
import { POST } from '@/app/api/gallery/route'
const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const UPLOAD = '33333333-3333-4333-8333-333333333333'
const ALTRO = '44444444-4444-4444-8444-444444444444'
const BODY = { upload_id: UPLOAD, file_url: `uploads/${OWNER}/foto.jpg`, scuola_id: SEDE }
const req = (body: unknown = BODY) => new Request('http://localhost/api/gallery', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { id: OWNER, role: 'educator', scuola_id: SEDE } })
  h.sede.mockResolvedValue({ scuolaId: SEDE })
  h.scope.mockResolvedValue(null)
  h.consenso.mockResolvedValue([])
  h.destinatari.mockResolvedValue([ALTRO])
  h.notify.mockResolvedValue(undefined)
  h.rpc.mockResolvedValue({ data: { ok: true, created: true, media: { id: UPLOAD } }, error: null })
  h.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: ALTRO }, error: null }) }) })
})
describe('POST foto · protocollo idempotente dopo tutti i gate', () => {
  it('usa autore autenticato, sede validata e payload canonico nella RPC', async () => {
    const res = await POST(req({ ...BODY, uploaded_by: ALTRO, tag_students: [ALTRO, OWNER, ALTRO], target_classes: ['B', 'A', 'B'] }))
    expect(res.status).toBe(201)
    expect(h.rpc).toHaveBeenCalledWith('gallery_publish_photo', {
      p_owner_id: OWNER, p_scuola_id: SEDE, p_upload_id: UPLOAD,
      p_payload: { file_url: BODY.file_url, file_type: 'foto', caption: null, tag_students: [OWNER, ALTRO], is_broadcast: false, target_classes: ['A', 'B'] },
    })
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledOnce()
  })
  it('richieste concorrenti notificano solo il vincitore della RPC', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: true, created: true, media: { id: UPLOAD } }, error: null })
    h.rpc.mockResolvedValue({ data: { ok: true, created: false, media: { id: UPLOAD } }, error: null })
    const risultati = await Promise.all([POST(req()), POST(req()), POST(req())])
    expect(risultati.map(r => r.status).sort()).toEqual([200, 200, 201])
    expect(h.notify).toHaveBeenCalledOnce()
    expect(h.destinatari).toHaveBeenCalledOnce()
  })
  it('UUID con maiuscole e duplicati hanno la stessa forma canonica', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    expect((await POST(req({ ...BODY, tag_students: [id, id.toUpperCase()] }))).status).toBe(201)
    expect(h.rpc.mock.calls[0][1].p_payload.tag_students).toEqual([id])
  })
  it('normalizza un URL Storage legacy prima del confronto idempotente', async () => {
    const res = await POST(req({ ...BODY, file_url: `https://storage.example/storage/v1/object/public/gallery/${BODY.file_url}` }))
    expect(res.status).toBe(201)
    expect(h.rpc.mock.calls[0][1].p_payload.file_url).toBe(BODY.file_url)
  })
  it('replay restituisce lo stesso id senza una seconda notifica', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, created: false, media: { id: UPLOAD } }, error: null })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: UPLOAD, replayed: true })
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.consenso).toHaveBeenCalledOnce()
  })
  it.each([['UPLOAD_CONFLICT', 409, 'CARICAMENTO_IN_CONFLITTO'], ['UPLOAD_DELETED', 410, 'CARICAMENTO_ELIMINATO']])('%s resta un rifiuto esplicito', async (code, status, codice) => {
    h.rpc.mockResolvedValue({ data: { ok: false, code }, error: null })
    const res = await POST(req())
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ codice })
    expect(h.notify).not.toHaveBeenCalled()
  })
  it('RPC assente dà 503 senza ripiegare su INSERT', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing function' } })
    const res = await POST(req())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ codice: 'CARICAMENTO_NON_DISPONIBILE' })
    expect(h.insert).not.toHaveBeenCalled()
  })
  it('errore RPC e risposta malformata falliscono senza INSERT', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true }, error: null })
    expect((await POST(req())).status).toBe(500)
    expect(h.insert).not.toHaveBeenCalled()
  })
  it('consenso revocato respinge anche il replay prima della RPC', async () => {
    h.consenso.mockResolvedValue([{ id: ALTRO, nome: 'Nome sintetico' }])
    expect((await POST(req())).status).toBe(422)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it.each([401, 403])('autenticazione/ruolo %i precede ogni replay', async (status) => {
    h.auth.mockResolvedValue({ response: NextResponse.json({}, { status }) })
    expect((await POST(req())).status).toBe(status)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('sede non autorizzata blocca la RPC', async () => {
    h.sede.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req())).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('tag fuori sede blocca la RPC prima del consenso', async () => {
    h.scope.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    expect((await POST(req())).status).toBe(403)
    expect(h.consenso).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('upload id non UUID è rifiutato', async () => {
    expect((await POST(req({ ...BODY, upload_id: 'non-valido' }))).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('il percorso di un altro autore non diventa una nuova pubblicazione', async () => {
    expect((await POST(req({ ...BODY, file_url: `uploads/${ALTRO}/foto.jpg` }))).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('client legacy senza upload_id mantiene il contratto 201', async () => {
    const legacy = { file_url: BODY.file_url, scuola_id: SEDE }
    expect((await POST(req(legacy))).status).toBe(201)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.insert).toHaveBeenCalledOnce()
  })
})
