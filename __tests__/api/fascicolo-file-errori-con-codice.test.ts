import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Compito I7 (spec 2026-09-24) — il download del fascicolo non rimanda il messaggio GREZZO ──
// `GET /api/primaria/fascicolo/file` rispondeva nei due 500 con `error.message` dello Storage
// (la firma dell'URL, che può nominare bucket e percorso del file — cioè l'alunno e il tipo di
// documento) e con `err.message` dell'eccezione. Ora il client riceve un CODICE traducibile e il
// testo intero resta nel log (`logErrore`), come nel resto del fascicolo.

const SEGRETO_STORAGE = 'Object not found: sensitive_documents/alunno-x/diagnosi-104.pdf'
const SEGRETO_ECCEZIONE = 'relation "student_documents" violates constraint fk_segreto'

const log = vi.hoisted(() => ({ logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: log.logErrore }
})

const rbac = vi.hoisted(() => ({
  puoAccedereFascicolo: vi.fn(),
  logAccessoFascicolo: vi.fn(),
}))
vi.mock('@/lib/primaria/fascicolo-rbac', () => rbac)

const h = vi.hoisted(() => {
  const state = {
    doc: null as unknown,
    firma: { data: null, error: null } as { data: unknown; error: unknown },
  }
  function makeClient() {
    return {
      from() {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) qb[m] = () => qb
        qb.maybeSingle = () => Promise.resolve({ data: state.doc, error: null })
        return qb
      },
      storage: {
        from: () => ({ createSignedUrl: () => Promise.resolve(state.firma) }),
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))
const auth = vi.hoisted(() => ({ getRequestUserId: vi.fn(), resolveIdentity: vi.fn(), loadAppUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)

import { GET as FILE } from '@/app/api/primaria/fascicolo/file/route'
import { NextRequest } from 'next/server'

const DOC_ID = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const ALUNNO_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'

function richiesta() {
  return new NextRequest(`http://localhost/api/primaria/fascicolo/file?documentoId=${DOC_ID}`, {
    headers: { 'x-user-id': 'u-1' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.doc = { id: DOC_ID, student_id: ALUNNO_ID, storage_path: 'a-1/x.pdf', file_name: 'x.pdf' }
  h.state.firma = { data: { signedUrl: 'https://signed/x' }, error: null }
  auth.resolveIdentity.mockResolvedValue({ userId: 'u-1', source: 'header' })
  rbac.puoAccedereFascicolo.mockResolvedValue({ consentito: true, ruolo: 'coordinator', motivo: 'staff' })
  rbac.logAccessoFascicolo.mockResolvedValue(undefined)
})

describe('GET /api/primaria/fascicolo/file — errori con codice, messaggio nel log', () => {
  it('firma dello Storage fallita: 500 con LETTURA_FALLITA, il messaggio dello Storage solo nel log', async () => {
    const erroreStorage = new Error(SEGRETO_STORAGE)
    h.state.firma = { data: null, error: erroreStorage }

    const res = await FILE(richiesta())
    const testo = await res.text()

    expect(res.status).toBe(500)
    expect(JSON.parse(testo).codice).toBe('LETTURA_FALLITA')
    expect(testo).not.toContain(SEGRETO_STORAGE)
    expect(testo).not.toContain('sensitive_documents')
    expect(log.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'primaria/fascicolo/file:GET', stato: 500, evento: 'storage:createSignedUrl' }),
      erroreStorage,
    )
    // Un download mai firmato non è un accesso: niente riga d'audit «download».
    expect(rbac.logAccessoFascicolo).not.toHaveBeenCalled()
  })

  it('firma senza errore ma senza URL: 500 con codice, e il guasto è comunque nel log', async () => {
    h.state.firma = { data: { signedUrl: '' }, error: null }

    const res = await FILE(richiesta())
    const corpo = await res.json()

    expect(res.status).toBe(500)
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    expect(log.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'primaria/fascicolo/file:GET', evento: 'storage:signedUrl_vuoto' }),
      expect.any(Error),
    )
  })

  it('eccezione nel corpo: 500 con codice, il testo dell’eccezione non torna al client', async () => {
    const eccezione = new Error(SEGRETO_ECCEZIONE)
    rbac.puoAccedereFascicolo.mockRejectedValue(eccezione)

    const res = await FILE(richiesta())
    const testo = await res.text()

    expect(res.status).toBe(500)
    expect(JSON.parse(testo).codice).toBe('LETTURA_FALLITA')
    expect(testo).not.toContain(SEGRETO_ECCEZIONE)
    expect(testo).not.toContain('fk_segreto')
    expect(log.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'primaria/fascicolo/file:GET', stato: 500 }),
      eccezione,
    )
  })

  it('il percorso felice resta intatto: 200 con l’URL firmato e l’audit del download', async () => {
    const res = await FILE(richiesta())
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.data).toEqual({ url: 'https://signed/x', fileName: 'x.pdf' })
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ azione: 'download', documentoId: DOC_ID }),
    )
    expect(log.logErrore).not.toHaveBeenCalled()
  })
})
