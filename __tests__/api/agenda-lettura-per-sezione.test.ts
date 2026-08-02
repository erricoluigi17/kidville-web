import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// W3-A — `/api/agenda` GET: si legge per IDENTITÀ di sezione.
//
// Il complemento server del fix client (R105). Da W2-M la POST accetta
// `section_id` e il nome omonimo è un 400; ma la LETTURA accettava solo il nome,
// quindi la card della home docente restava senza un modo per dire «l'agenda di
// QUESTA 2 ANNI». Con `section_id` la lettura ha lo stesso perimetro della
// scrittura: stessa sezione, e gli eventi di plesso della SUA sede — non quelli
// di tutte le sedi attive, che comparivano mescolati e indistinguibili
// (l'etichetta dice solo «evento di plesso»).
// =============================================================================

const OMONIMA = '2 ANNI'
const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const GIORNO = '2026-08-10'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/primaria/notifiche', () => ({ enqueueNotifichePerAlunni: vi.fn() }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => 'test',
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/agenda/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: SEC_B, scuola_id: SEDE_B, name: OMONIMA },
  ],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [{ utente_id: ID_DOCENTE, section_id: SEC_A }],
  eventi_agenda: [
    { id: 'ev-a', scuola_id: SEDE_A, section_id: SEC_A, titolo: 'SEZIONE-A', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
    { id: 'ev-b', scuola_id: SEDE_B, section_id: SEC_B, titolo: 'SEZIONE-B', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
    { id: 'pl-a', scuola_id: SEDE_A, section_id: null, titolo: 'PLESSO-A', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
    { id: 'pl-b', scuola_id: SEDE_B, section_id: null, titolo: 'PLESSO-B', tipo: 'evento', data: GIORNO, visibile_genitori: true, creato_da: ID_ADMIN },
  ],
  alunni: [],
})

function getReq(qs = ''): NextRequest {
  return {
    url: `http://localhost/api/agenda${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

const titoli = async (res: Response): Promise<string[]> => {
  const j = await res.json()
  return (j.data ?? []).map((e: { titolo: string }) => e.titolo).sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  const admin = { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A }
  h.requireUser.mockResolvedValue({ user: admin })
  h.requireDocente.mockResolvedValue({ user: admin })
})

describe('GET /api/agenda?section_id= — la lettura segue la sezione scelta', () => {
  it('sezione di SEDE_B ⇒ i suoi eventi e il plesso di SEDE_B, nulla di SEDE_A', async () => {
    const res = await GET(getReq(`section_id=${SEC_B}&from=2026-08-01`))

    expect(res.status).toBe(200)
    expect(await titoli(res)).toEqual(['PLESSO-B', 'SEZIONE-B'])
  })

  it('sezione di SEDE_A ⇒ l\'omonima di SEDE_B resta fuori', async () => {
    const res = await GET(getReq(`section_id=${SEC_A}&from=2026-08-01`))

    expect(await titoli(res)).toEqual(['PLESSO-A', 'SEZIONE-A'])
  })

  it('sezione fuori dai propri plessi ⇒ 403 e nessun evento', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })

    const res = await GET(getReq(`section_id=${SEC_B}&from=2026-08-01`))

    expect(res.status).toBe(403)
    expect((await res.json()).data).toBeUndefined()
  })

  it('educator: sezione del proprio plesso ma NON assegnata ⇒ 403', async () => {
    h.db.utenti_sezioni = []
    h.requireUser.mockResolvedValue({ user: { id: ID_DOCENTE, role: 'educator', scuola_id: SEDE_A } })

    const res = await GET(getReq(`section_id=${SEC_A}&from=2026-08-01`))

    expect(res.status).toBe(403)
  })

  it('anche col NOME la lettura resta nella sede della sezione risolta', async () => {
    // Nome univoco (esiste solo in SEDE_A) ma utente su DUE sedi: il filtro per
    // nome non basta, perché gli eventi di PLESSO non hanno sezione — e quelli
    // di SEDE_B comparivano in elenco con l'etichetta «evento di plesso».
    h.db.sections.push({ id: 'aaaa3333-0000-4000-8000-0000000000a3', scuola_id: SEDE_A, name: '3 ANNI A' })

    const res = await GET(getReq(`sezione=${encodeURIComponent('3 ANNI A')}&from=2026-08-01`))

    expect(res.status).toBe(200)
    expect(await titoli(res)).toEqual(['PLESSO-A'])
  })
})
