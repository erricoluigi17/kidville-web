import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// m1 — GET /api/locker/materials enumerava la configurazione materiali in modo
// anonimo. Ora: requireUser (i genitori autenticati leggono comunque).
//
// ⚠️ IL MOCK DEVE COPRIRE TUTTO CIÒ CHE LA ROUTE CHIAMA, e fino al 2026-09-01 non lo
// faceva. Mancavano `scuoleDiUtente` sullo scope e `.in()` sul query builder: la GET
// andava in eccezione dentro `sezioniConNome`, l'eccezione finiva nel catch (allora
// muto) in fondo alla route, e il test riceveva i MATERIALI_DEFAULT credendo di
// leggere la riga `c1`. Restava verde perché asseriva `length > 0`, e i default sono
// quattro. Un mock incompleto non fa fallire il test: gli fa collaudare un'altra cosa.
const SEDE = '11111111-1111-4111-8111-111111111111' // uuid di scuola, come `scuoleDiUtente` nella realtà

const h = vi.hoisted(() => {
  const SEZIONE_ID = '22222222-2222-4222-8222-222222222222'
  // Righe per TABELLA: `sections` e `locker_config` hanno forme diverse, e restituire
  // le stesse a entrambe nasconderebbe uno scambio fra le due query.
  const righe: Record<string, unknown[]> = {
    sections: [{ id: SEZIONE_ID }],
    locker_config: [{ id: 'c1', nome: 'Bavaglini', attivo: true, ordine: 1, section_id: SEZIONE_ID }],
  }
  const fromSpy = vi.fn((tabella: string) => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.in = () => qb
    qb.order = () => qb
    ;(qb as { then: unknown }).then = (res: (v: { data: unknown; error: null }) => unknown) =>
      res({ data: righe[tabella] ?? [], error: null })
    return qb
  })
  return { requireUser: vi.fn(), requireDocente: vi.fn(), scuoleDiUtente: vi.fn(), fromSpy }
})

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertClasseNomeInScope: vi.fn().mockResolvedValue(null),
  scuoleDiUtente: h.scuoleDiUtente,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
// Logger VERO, con `logEvento` sotto spia: sotto vitest il logger è silenzioso per
// scelta (`SILENZIOSO`), quindi «ha loggato?» non si legge dalla console — si legge
// solo qui. È l'unico modo di provare che il ripiego d'ultima istanza parla.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const originale = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...originale, logEvento: vi.fn(originale.logEvento) }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { GET } from '@/app/api/locker/materials/route'
import { NextRequest } from 'next/server'
import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default'
import { logEvento } from '@/lib/logging/logger'

const req = (qs = '') => new NextRequest(`http://localhost/api/locker/materials${qs ? '?' + qs : ''}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore', scuola_id: SEDE } })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
})

describe('GET /api/locker/materials — gate utente autenticato (m1)', () => {
  it('401 anonimo: niente enumerazione della configurazione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req('classe_sezione=Girasoli'))
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200 per l\'utente autenticato, e torna la CONFIGURAZIONE — non i default', async () => {
    const res = await GET(req('classe_sezione=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Array.isArray(j)).toBe(true)

    // 'Bavaglini' non è fra i MATERIALI_DEFAULT, ed è deliberato: è l'unica cosa che
    // rende l'asserzione capace di distinguere «ho letto locker_config» da «sono
    // caduto nel ripiego». Con la riga chiamata 'Pannolini' — com'era fino al
    // 2026-09-01 — anche i quattro default avrebbero superato il controllo.
    expect(MATERIALI_DEFAULT.map((m) => m.nome)).not.toContain('Bavaglini')
    expect(j.map((m: { nome: string }) => m.nome)).toEqual(['Bavaglini'])

    // Il ramo «configurazione popolata» passa da `sections` (nome-classe → sezione
    // della propria sede) e poi filtra `locker_config` su quella. Se il mock di
    // `scuoleDiUtente` tornasse a mancare, la route cadrebbe nel catch e queste due
    // righe direbbero che il percorso non è stato percorso.
    expect(h.scuoleDiUtente).toHaveBeenCalled()
    expect(h.fromSpy.mock.calls.map((c) => c[0])).toEqual(['locker_config', 'sections'])
    expect(h.requireUser).toHaveBeenCalled()
  })

  it('se la GET va in ECCEZIONE ripiega sui default, ma lo DICE', async () => {
    // La classe di guasto che il catch in fondo alla route intercetta: non un errore
    // PostgREST (quello non lancia, ritorna `{ error }`), ma un'eccezione vera nella
    // risoluzione dello scope. Fino al 2026-09-01 quel catch era muto e questo caso
    // era indistinguibile da una route che funziona.
    h.scuoleDiUtente.mockRejectedValue(new Error('scope non risolto'))

    const res = await GET(req('classe_sezione=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.map((m: { nome: string }) => m.nome)).toEqual(MATERIALI_DEFAULT.map((m) => m.nome))

    expect(logEvento).toHaveBeenCalledWith(
      'db',
      'warn',
      expect.objectContaining({
        operazione: 'locker/materials:GET',
        esito: 'locker-materials-eccezione-uso-default',
      }),
      expect.anything(),
    )
  })
})
