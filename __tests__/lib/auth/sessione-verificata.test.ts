// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signedFormsClient, PARENT } from '../../fixtures/signed-forms'
const h = vi.hoisted(() => ({ client: null as unknown, createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: h.createAdminClient, createClient: h.createClient }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
const AUTH_UID = '99999999-9999-4999-8999-999999999999'
const SPOOF = '66666666-6666-4666-8666-666666666666'
const req = () => new Request(`http://localhost/private?userId=${SPOOF}`, { headers: { 'x-user-id': SPOOF, cookie: 'kv-active-role=admin' } })
async function subject() {
  const authModule = await import('@/lib/auth/require-staff')
  expect(authModule.requireUserDaSessioneVerificata).toBeTypeOf('function')
  return authModule.requireUserDaSessioneVerificata
}
beforeEach(() => {
  h.createAdminClient.mockReset(); h.createAdminClient.mockImplementation(async () => h.client)
  h.createClient.mockReset(); h.createClient.mockRejectedValue(new Error('nessuna nuova lettura GoTrue ammessa'))
})
describe('gate additivo dall’UID verificato', () => {
  it('parent-only: parents.id è l’identità applicativa senza creare privilegi staff', async () => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    f.db.utenti = []; f.db.parents = [{ id: PARENT, auth_user_id: AUTH_UID, first_name: 'Nome', last_name: 'Esempio' }]
    expect(await gate(req(), AUTH_UID)).toMatchObject({ user: { id: PARENT, role: 'genitore', nome: 'Nome', cognome: 'Esempio' } })
    expect(h.createClient).not.toHaveBeenCalled()
  })
  it('utenti mantiene precedenza sul ponte e ruolo attivo entro i ruoli reali', async () => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    f.db.utenti[0].ruolo = 'segreteria'; f.db.utenti[0].role = 'segreteria'
    f.db.parents = [{ id: AUTH_UID, auth_user_id: PARENT, first_name: 'Nome', last_name: 'Esempio' }]
    expect(await gate(req(), PARENT)).toMatchObject({ user: { id: PARENT, role: 'segreteria', ruoli: ['segreteria', 'genitore'] } })
    expect(h.createClient).not.toHaveBeenCalled()
  })
  it('staff revocato col ponte conserva solo il ruolo famiglia', async () => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    f.db.utenti[0].ruolo = 'segreteria'; f.db.utenti[0].role = 'segreteria'; f.db.utenti[0].archiviato_il = '2026-10-14T08:00:00Z'
    f.db.parents = [{ id: AUTH_UID, auth_user_id: PARENT }]
    expect(await gate(req(), PARENT)).toMatchObject({ user: { id: PARENT, role: 'genitore', ruoli: ['genitore'] } })
  })
  it('staff revocato senza ponte viene negato', async () => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    f.db.utenti[0].ruolo = 'segreteria'; f.db.utenti[0].role = 'segreteria'; f.db.utenti[0].archiviato_il = '2026-10-14T08:00:00Z'
    expect((await gate(req(), PARENT)).response?.status).toBe(403)
  })
  it.each(['utenti', 'parents'])('errore lookup %s: 503 esplicito senza fallback', async (table) => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    f.faults[`${table}:select`] = { code: 'XX000', message: 'lookup failed' }
    const response = (await gate(req(), PARENT)).response!
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Non è stato possibile verificare l’identità', codice: 'IDENTITA_NON_VERIFICATA' })
    expect(h.createClient).not.toHaveBeenCalled()
  })
  it('eccezione lookup: 503 con codice stabile, nessuna prosa del provider o fallback', async () => {
    const gate = await subject()
    h.createAdminClient.mockRejectedValue(new Error('dettaglio provider riservato'))
    const response = (await gate(req(), PARENT)).response!
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Non è stato possibile verificare l’identità', codice: 'IDENTITA_NON_VERIFICATA' })
    expect(h.createClient).not.toHaveBeenCalled()
  })
  it('UID sconosciuto non viene sostituito dall’identità spoofata in header/query', async () => {
    const gate = await subject(); const f = signedFormsClient(); h.client = f.client
    expect((await gate(req(), AUTH_UID)).response?.status).toBe(401)
    expect(h.createClient).not.toHaveBeenCalled()
  })
})
