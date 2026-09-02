import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// W3-A — `/api/attendance/daily`: la sede scelta arriva fino alla query.
//
// La home docente disegna una chip per sezione e da lì chiede le presenze del
// giorno. Con tre plessi «2 ANNI» esiste ad Aversa E a Cesa: il solo nome-classe
// portava dentro l'appello dei bambini di ENTRAMBE, unito e senza dirlo — un
// elenco che sembra una classe sola. Il gate `assertClasseNomeInScope` non lo
// impediva: risponde a «di quale sede è questa classe?», non a «quale delle
// due».
//
// Contratto conservato di proposito: senza `scuola_id` il perimetro resta
// quello del SedeSelector (le altre pagine docente non dichiarano ancora la
// sede). Una sede dichiarata e non accessibile è invece un 403, mai un elenco
// allargato.
// =============================================================================

const OMONIMA = '2 ANNI'
const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const GIORNO = '2026-08-10'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/attendance/daily/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: SEC_B, scuola_id: SEDE_B, name: OMONIMA },
  ],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  presenze: [
    {
      id: 'p-a', alunno_id: 'al-a', data: GIORNO, stato: 'presente',
      alunni: { id: 'al-a', nome: 'BIMBO', cognome: 'SEDE-A', section_id: SEC_A, classe_sezione: OMONIMA, scuola_id: SEDE_A },
    },
    {
      id: 'p-b', alunno_id: 'al-b', data: GIORNO, stato: 'presente',
      alunni: { id: 'al-b', nome: 'BIMBO', cognome: 'SEDE-B', section_id: SEC_B, classe_sezione: OMONIMA, scuola_id: SEDE_B },
    },
  ],
})

function getReq(qs: string): NextRequest {
  return {
    url: `http://localhost/api/attendance/daily?${qs}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

const cognomi = async (res: Response): Promise<string[]> => {
  const j = await res.json()
  return (j as { alunni: { cognome: string } }[]).map((r) => r.alunni.cognome).sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/attendance/daily — la sede dichiarata restringe l\'appello', () => {
  it('`scuola_id` di SEDE_B ⇒ solo i bambini di SEDE_B', async () => {
    const res = await GET(getReq(`data=${GIORNO}&sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_B}`))

    expect(res.status).toBe(200)
    expect(await cognomi(res)).toEqual(['SEDE-B'])
  })

  it('`scuola_id` di SEDE_A ⇒ solo i bambini di SEDE_A', async () => {
    const res = await GET(getReq(`data=${GIORNO}&sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_A}`))

    expect(await cognomi(res)).toEqual(['SEDE-A'])
  })

  it('sede non accessibile ⇒ 403, mai un elenco allargato', async () => {
    const res = await GET(getReq(`data=${GIORNO}&sezione=${encodeURIComponent(OMONIMA)}&scuola_id=${SEDE_C}`))

    expect(res.status).toBe(403)
  })

  it('senza `scuola_id` il perimetro resta quello del SedeSelector (contratto storico)', async () => {
    const res = await GET(getReq(`data=${GIORNO}&sezione=${encodeURIComponent(OMONIMA)}`))

    expect(res.status).toBe(200)
    expect(await cognomi(res)).toEqual(['SEDE-A', 'SEDE-B'])
  })
})
