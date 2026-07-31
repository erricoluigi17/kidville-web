import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
import { NextResponse, NextRequest } from 'next/server'

// =============================================================================
// LOCK del contratto sullo spazio-id: `richieste_cancellazione.parent_id` è un
// `parents.id`, e la Direzione lo passa TALE E QUALE ad `anonimizzaParent`.
//
// La route è già corretta e NON va cambiata: questo file blocca il consumatore
// mentre i produttori (canale in-app + canale pubblico) vengono corretti, così
// il contratto resta scritto da entrambi i lati. `anonimizzaParent`/
// `anonimizzaAlunno` sono mockate: qui interessa SOLO l'id che ricevono (la loro
// logica è coperta da `__tests__/lib/gdpr-esegui.test.ts`).
//
// Il fixture tiene di proposito un `utenti.id` diverso dal `parents.id`: se un
// domani la route passasse l'id utente, questo test diventerebbe rosso.
// =============================================================================

const UTENTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-utente000001'
const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'
const SCUOLA_ID = SEDE_A

const h = vi.hoisted(() => {
  const state = {
    richiesta: null as Record<string, unknown> | null,
    links: [] as { student_id: string }[],
    alunni: [] as Record<string, unknown>[],
    updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    errRichiesta: null as { code?: string } | null,
  }
  const requireStaff = vi.fn()
  const logScrittura = vi.fn()
  const anonimizzaParent = vi.fn()
  const anonimizzaAlunno = vi.fn()
  return { state, requireStaff, logScrittura, anonimizzaParent, anonimizzaAlunno }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null
      const dati = () => {
        if (table === 'student_parents') return h.state.links
        if (table === 'alunni') return h.state.alunni
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.update = (v: Record<string, unknown>) => { patch = v; return b }
      b.maybeSingle = async () =>
        table === 'richieste_cancellazione'
          ? { data: h.state.errRichiesta ? null : h.state.richiesta, error: h.state.errRichiesta }
          : { data: null, error: null }
      b.then = (res: (v: unknown) => unknown) => {
        if (patch) h.state.updates.push({ table, patch })
        return Promise.resolve({ data: dati(), error: null }).then(res)
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/richieste/route'

// NextRequest (non Request): da quando la route verifica la sede legge il cookie
// `sedi_attive` tramite `resolveScuoleAttive`, che vuole `request.cookies`.
const req = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/gdpr/richieste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SCUOLA_ID } })
  h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SCUOLA_ID }
  h.state.links = []
  h.state.alunni = []
  h.state.updates = []
  h.state.errRichiesta = null
  h.anonimizzaParent.mockResolvedValue({
    newsVisualizzazioniRimosse: 0,
    segnalazioniBonificate: 0,
    sospensioniBonificate: 0,
  })
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0,
    segnalazioniBonificate: 0, sospensioniBonificate: 0,
  })
})

describe('POST /api/admin/gdpr/richieste — evasione', () => {
  it('execute: anonimizza ESATTAMENTE il parent_id della richiesta (parents.id)', async () => {
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(200)
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    const parentIdPassato = h.anonimizzaParent.mock.calls[0][1]
    expect(parentIdPassato).toBe(PARENT_ID)
    expect(parentIdPassato).not.toBe(UTENTE_ID)
  })

  it('execute: marca la richiesta come evasa e scrive l’audit', async () => {
    await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    const upd = h.state.updates.find((u) => u.table === 'richieste_cancellazione')
    expect(upd).toBeTruthy()
    expect(upd!.patch).toMatchObject({ stato: 'evasa', evasa_da: 'dir-1' })
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })

  it('execute: anonimizza i figli NON iscritti e lascia gli iscritti alla scuola', async () => {
    // `scuola_id` sui figli è ORA parte del fixture: dal 2026-07-31 la route
    // anonimizza solo i minori del proprio plesso (F5), e un figlio senza sede
    // è fuori scope per progetto (fail-closed). Vedi
    // `admin-gdpr-richieste-scope-sede.test.ts` per il caso a due sedi.
    h.state.links = [{ student_id: 'al-1' }, { student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'non_iscritto', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
      { id: 'al-2', stato: 'iscritto', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    const j = await res.json()
    expect(j.alunni).toBe(1)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect((h.anonimizzaAlunno.mock.calls[0][1] as { id: string }).id).toBe('al-1')
  })

  it('dryrun: conta senza anonimizzare nulla', async () => {
    h.state.links = [{ student_id: 'al-1' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'non_iscritto', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ dryrun: true, parent: 1, alunni_non_iscritti: 1, alunni_iscritti_mantenuti: 0 })
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it('conferma testuale sbagliata → 400, nessuna anonimizzazione', async () => {
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'anonimizza tutto' }))
    expect(res.status).toBe(400)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('richiesta già gestita → 409', async () => {
    h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'evasa', scuola_id: SCUOLA_ID }
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(409)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('richiesta inesistente → 404', async () => {
    h.state.richiesta = null
    const res = await POST(req({ id: 'ignota', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(404)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('401 senza identità', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(401)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('403 se non è Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(403)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })
})
