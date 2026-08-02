// @vitest-environment node
//
// ⚠️ AMBIENTE `node`, NON jsdom, ed è la ragione per cui questo test falliva SOLO in CI.
// Misurato il 2026-08-02: verde in locale su Node 24, rosso in CI su Node 22 con
// `TypeError: object.stream is not a function`. La route risponde con
// `new NextResponse(data)` dove `data` è il Blob restituito dallo Storage; il `Blob`
// di jsdom non espone `.stream()` come quello di Node, e la conversione che Node 24
// tollerava su Node 22 non passa. Il difetto non era nel finto (che restituisce un
// Blob vero) né nella route: era l'ambiente. Un test di ROTTA API non ha bisogno di
// un finto browser — e girare in jsdom lo rendeva dipendente dalla versione di Node
// della macchina, cioè verde qui e rosso in CI.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// GET /api/admin/credentials-pdf — il PDF con la password IN CHIARO.
//
// Fino al 2026-07-31 l'unico presidio era `requireStaff` più l'entropia della
// chiave (`<uuid>-<epoch_ms>.pdf`): autorizzazione per oscurità, non controllo
// d'accesso. Il link vive per sempre nel centro notifiche, quindi chi si sposta
// da una sede all'altra continuava a scaricare le credenziali dei genitori del
// plesso che ha lasciato — e nessun controllo lo fermava.
//
// Ora la sede si risolve dall'uuid del DESTINATARIO contenuto nella chiave, e
// il download passa da `assertUtenteInScope` / `assertParentInScope`.
// =============================================================================

const STAFF_A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1'
const STAFF_B = 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1'
const PARENT_A = 'a2a2a2a2-2222-4222-8222-a2a2a2a2a2a2'
const PARENT_B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2'
const IGNOTO = '99999999-9999-4999-8999-999999999999'
const SEGRETERIA_A = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scaricate: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@supabase/supabase-js', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createClient: () => {
      const client = creaFintoSupabase(h.db, h.tabelle) as unknown as Record<string, unknown>
      // Il finto client LANCIA su `storage.from(...)`: qui lo si sostituisce con
      // uno storage che registra gli accessi, così «non ha scaricato» è una
      // proprietà verificata e non un'assenza dedotta dallo stato HTTP.
      client.storage = {
        from: () => ({
          download: async (key: string) => {
            h.scaricate.push(key)
            return { data: new Blob(['%PDF-1.4 finto'], { type: 'application/pdf' }), error: null }
          },
        }),
      }
      return client
    },
  }
})

import { GET } from '@/app/api/admin/credentials-pdf/route'

const chiave = (id: string) => `${id}-1783326349261.pdf`
const req = (key: string) =>
  new NextRequest(`http://localhost/api/admin/credentials-pdf?key=${encodeURIComponent(key)}`)

const dbBase = (): DBFinto => ({
  utenti: [
    { id: STAFF_A, scuola_id: SEDE_A, ruolo: 'educator' },
    { id: STAFF_B, scuola_id: SEDE_B, ruolo: 'educator' },
    { id: SEGRETERIA_A, scuola_id: SEDE_A, ruolo: 'segreteria' },
  ],
  parents: [{ id: PARENT_A }, { id: PARENT_B }],
  student_parents: [
    { parent_id: PARENT_A, student_id: 'al-a', alunni: { scuola_id: SEDE_A } },
    { parent_id: PARENT_B, student_id: 'al-b', alunni: { scuola_id: SEDE_B } },
  ],
  utenti_scuole: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scaricate = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'chiave-finta-di-test'
  h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA_A, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/admin/credentials-pdf — il PDF si scarica solo per il proprio plesso', () => {
  it('403 sul PDF di un dipendente di un\'altra sede: il file non viene nemmeno scaricato', async () => {
    const res = await GET(req(chiave(STAFF_B)))
    expect(res.status).toBe(403)
    expect(h.scaricate).toEqual([])
  })

  it('403 sul PDF di un genitore i cui figli sono in un\'altra sede', async () => {
    const res = await GET(req(chiave(PARENT_B)))
    expect(res.status).toBe(403)
    expect(h.scaricate).toEqual([])
  })

  it('200 sul PDF di un dipendente del proprio plesso, e il download finisce nell\'audit', async () => {
    const res = await GET(req(chiave(STAFF_A)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(h.scaricate).toEqual([chiave(STAFF_A)])
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const riga = h.logScrittura.mock.calls[0][1] as { entitaId: string; entitaTipo: string }
    expect(riga.entitaId).toBe(STAFF_A)
    expect(riga.entitaTipo).toBe('credenziali_pdf')
  })

  it('200 sul PDF di un genitore del proprio plesso', async () => {
    const res = await GET(req(chiave(PARENT_A)))
    expect(res.status).toBe(200)
    expect(h.scaricate).toEqual([chiave(PARENT_A)])
  })

  it('404 se l\'uuid della chiave non corrisponde a nessuno: niente download «a caso»', async () => {
    const res = await GET(req(chiave(IGNOTO)))
    expect(res.status).toBe(404)
    expect(h.scaricate).toEqual([])
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('400 se la chiave non ha la forma <uuid>-<epoch>.pdf', async () => {
    const res = await GET(req('non-un-uuid-123.pdf'))
    expect(res.status).toBe(400)
    expect(h.scaricate).toEqual([])
  })

  it('401 anonimo: nessuna lettura e nessun download', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req(chiave(STAFF_A)))
    expect(res.status).toBe(401)
    expect(h.tabelle).toHaveLength(0)
    expect(h.scaricate).toEqual([])
  })
})
