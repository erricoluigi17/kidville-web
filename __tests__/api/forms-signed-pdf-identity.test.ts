// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signedFormsClient, PARENT, SCHOOL, SUBMISSION } from '../fixtures/signed-forms'

const ATTACKER = '66666666-6666-4666-8666-666666666666'
const STAFF = '77777777-7777-4777-8777-777777777777'
const AUTH_PARENT = '99999999-9999-4999-8999-999999999999'
const h = vi.hoisted(() => ({ getUser: vi.fn(), client: null as unknown, scopes: [] as string[] }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => h.client,
  createClient: async () => ({ auth: { getUser: h.getUser, getSession: async () => ({ data: { session: { access_token: 'token-fittizio' } } }) } }),
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async (_request: unknown, _client: unknown, user: { id: string }) => { h.scopes.push(user.id); return [SCHOOL] } }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
import { GET, POST } from '@/app/api/forms/signed-pdf/route'
import { ensureSignedSubmissionPdf } from '@/lib/forms/signed-archive'

const success = (id: string) => ({ data: { user: { id, email: 'account@example.invalid' } }, error: null })
const failure = () => ({ data: { user: null }, error: new Error('errore provider auth') })
function request(method: 'GET' | 'POST', headerUser: string = PARENT) {
  return new NextRequest(`http://localhost/api/forms/signed-pdf${method === 'GET' ? `?id=${SUBMISSION}&userId=${headerUser}` : ''}`, {
    method, headers: { 'content-type': 'application/json', 'x-user-id': headerUser },
    ...(method === 'POST' ? { body: JSON.stringify({ id: SUBMISSION }) } : {}),
  })
}
async function fixture() {
  const f = signedFormsClient(); h.client = f.client
  f.db.utenti[0].role = 'genitore'; f.db.utenti[0].ruolo = 'genitore'
  f.db.utenti.push({ id: ATTACKER, nome: 'Attaccante', cognome: 'Fittizio', role: 'genitore', ruolo: 'genitore' })
  f.db.utenti.push({ id: STAFF, nome: 'Staff', cognome: 'Fittizio', role: 'segreteria', ruolo: 'segreteria', scuola_id: SCHOOL })
  await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  f.storage.downloads.length = 0; f.storage.uploads.length = 0; f.actions.length = 0
  return f
}
beforeEach(() => { h.getUser.mockReset(); h.scopes.length = 0; vi.stubEnv('ALLOW_HEADER_IDENTITY', 'true') })
afterEach(() => vi.unstubAllEnvs())

describe('PDF firmato: binding all’UID già verificato, auth applicativa reale', () => {
  it.each(['GET', 'POST'] as const)('%s: seconda lettura auth fallita non assume il firmatario dallo header', async (method) => {
    const f = await fixture()
    h.getUser.mockResolvedValueOnce(success(ATTACKER)).mockResolvedValue(failure())
    const response = await ({ GET, POST })[method](request(method))
    expect(response.status).toBe(403)
    expect(h.getUser).toHaveBeenCalledTimes(1)
    expect(f.storage.downloads).toHaveLength(0)
    expect(f.storage.uploads).toHaveLength(0)
    expect(h.scopes).toEqual([])
  })
  it.each(['GET', 'POST'] as const)('%s: terza lettura auth fallita non assume lo staff dallo header', async (method) => {
    const f = await fixture()
    h.getUser.mockResolvedValueOnce(success(ATTACKER)).mockResolvedValueOnce(success(ATTACKER)).mockResolvedValue(failure())
    const response = await ({ GET, POST })[method](request(method, STAFF))
    expect(response.status).toBe(403)
    expect(h.getUser).toHaveBeenCalledTimes(1)
    expect(f.storage.downloads).toHaveLength(0)
    expect(h.scopes).toEqual([])
  })
  it.each(['GET', 'POST'] as const)('%s: staff autorizzato mantiene il proprio ruolo e scope anche se letture auth successive fallirebbero', async (method) => {
    await fixture()
    h.getUser.mockResolvedValueOnce(success(STAFF)).mockResolvedValue(failure())
    const response = await ({ GET, POST })[method](request(method, ATTACKER))
    expect(response.status).toBe(200)
    expect(h.getUser).toHaveBeenCalledTimes(1)
    expect(h.scopes).toEqual([STAFF])
  })
  it.each(['GET', 'POST'] as const)('%s: ponte parents.auth_user_id accede con parents.id senza riga utenti', async (method) => {
    const f = await fixture()
    f.db.utenti = f.db.utenti.filter((user) => user.id !== PARENT)
    f.db.parents = [{ id: PARENT, auth_user_id: AUTH_PARENT, first_name: 'Genitore', last_name: 'Esempio' }]
    h.getUser.mockResolvedValue(success(AUTH_PARENT))
    const response = await ({ GET, POST })[method](request(method, ATTACKER))
    expect(response.status).toBe(200)
    expect(h.getUser).toHaveBeenCalledTimes(1)
    if (method === 'POST') expect(await response.json()).toMatchObject({ submission: { parent_id: PARENT } })
    expect(h.scopes).toEqual([])
  })
  it('una prima verifica auth fallita rimane anonima con header staff valido', async () => {
    const f = await fixture(); h.getUser.mockResolvedValue(failure())
    const response = await GET(request('GET', STAFF))
    expect(response.status).toBe(401)
    expect(f.storage.downloads).toHaveLength(0)
    expect(f.actions).toHaveLength(0)
  })
})
