import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/schools` non deve agganciare gli account di COLLAUDO.
//
// Il 2026-07-29 il provisioning di Kidville Aversa e Kidville Cesa ha collegato
// alla Direzione di due plessi VERI anche `admin.e2e@kidville.test` — l'account
// del seed della CI, la cui password era un letterale in un repository PUBBLICO.
// La causa: l'elenco dei candidati era `.from('utenti').eq('ruolo','admin')`,
// TUTTI gli admin, senza nessun concetto di «account di collaudo».
//
// Il predicato è UNO SOLO, `isUtenteCollaudo` (src/lib/scuole/reali.ts), gemello
// di `isScuolaE2E`: nessuna euristica locale, altrimenti fra un anno ce ne sono
// tre che non concordano.
//
// Nota sul metodo: qui NON si asserisce `expect(...).not.toBe(qualcosa)` sul
// solo esito HTTP — è la forma di falso verde che il 30/07 ha certificato due
// bug. Si guarda che cosa è finito DAVVERO in `utenti_scuole` (il finto client
// esegue le scritture) e con quali argomenti è stata chiamata la RPC.
// =============================================================================

const ADMIN_REALE = '11111111-1111-4111-8111-111111111111'
const ADMIN_COLLAUDO = '22222222-2222-4222-8222-222222222222'
const DOCENTE = '44444444-4444-4444-8444-444444444444'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  rpcArgs: [] as Record<string, unknown>[],
  rpcEsito: { data: 'sede-nuova', error: null } as { data: unknown; error: unknown },
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
        rpc: {
          provisiona_sede: (args) => {
            h.rpcArgs.push(args)
            return h.rpcEsito
          },
        },
      }),
  }
})

import { POST } from '@/app/api/admin/schools/route'
import { isUtenteCollaudo } from '@/lib/scuole/reali'

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti: [
    { id: ADMIN_REALE, ruolo: 'admin', scuola_id: SEDE_A },
    // L'account del seed E2E: `utenti.scuola_id` è la sede finta `e2e00000-…`.
    { id: ADMIN_COLLAUDO, ruolo: 'admin', scuola_id: SEDE_E2E },
    { id: DOCENTE, ruolo: 'educator', scuola_id: SEDE_A },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [],
  utenti_scuole: [],
  admin_settings: [],
})

/** Gli id passati alla RPC `provisiona_sede`. */
const idsRpc = (): string[] => (h.rpcArgs[0]?.p_admin_ids as string[]) ?? []

/** Gli `utente_id` finiti DAVVERO in `utenti_scuole` (ramo fallback). */
const idsCollegati = (): string[] =>
  (h.db.utenti_scuole ?? []).map((r) => String(r.utente_id))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_A } })
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.rpcArgs = []
  h.rpcEsito = { data: 'sede-nuova', error: null }
  h.errori = {}
})

describe('POST /api/admin/schools — gli account di collaudo restano fuori', () => {
  it('ramo RPC: `p_admin_ids` contiene SOLO l’admin reale', async () => {
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    expect(idsRpc()).toEqual([ADMIN_REALE])
  })

  it('ramo fallback: in `utenti_scuole` finisce SOLO l’admin reale', async () => {
    h.rpcEsito = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    expect(idsCollegati()).toEqual([ADMIN_REALE])
    // …e nessuna scrittura, di nessun tipo, nomina l'account di collaudo.
    const scritte = JSON.stringify(h.scritture)
    expect(scritte.includes(ADMIN_COLLAUDO)).toBe(false)
  })

  it('il ponte `utenti_scuole`: sedi TUTTE E2E ⇒ collaudo, una sola reale ⇒ no', async () => {
    // Due admin senza sede primaria: si distinguono solo dal ponte.
    const PONTE_SOLO_E2E = '55555555-5555-4555-8555-555555555555'
    const PONTE_MISTO = '66666666-6666-4666-8666-666666666666'
    h.db.utenti = [
      { id: PONTE_SOLO_E2E, ruolo: 'admin', scuola_id: null },
      { id: PONTE_MISTO, ruolo: 'admin', scuola_id: null },
    ]
    h.db.utenti_scuole = [
      { utente_id: PONTE_SOLO_E2E, scuola_id: SEDE_E2E },
      { utente_id: PONTE_MISTO, scuola_id: SEDE_E2E },
      { utente_id: PONTE_MISTO, scuola_id: SEDE_B },
    ]
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    expect(idsRpc()).toEqual([PONTE_MISTO])
  })

  it('lettura di `schools` in errore ⇒ 500 e NESSUNA sede creata (non si tira a indovinare)', async () => {
    h.errori = { schools: { code: '08006', message: 'connection failure' } }
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(500)
    expect(h.rpcArgs).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('DB E2E non migrato (`utenti_scuole` assente) ⇒ la sede si crea, il collaudo resta fuori', async () => {
    h.errori = { utenti_scuole: { code: 'PGRST205', message: 'table not found in schema cache' } }
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    // La sede primaria basta a riconoscere l'account di collaudo.
    expect(idsRpc()).toEqual([ADMIN_REALE])
    // Il degrado va DETTO, non taciuto.
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'info',
      expect.objectContaining({ esito: 'ponte-utenti-scuole-non-disponibile' }),
      expect.anything(),
    )
  })

  it('l’esclusione è un evento, e finisce nei log (conteggi, mai identità)', async () => {
    await POST(post({ nome: 'Kidville Nuova' }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'info',
      expect.objectContaining({
        operazione: 'admin/schools:POST',
        esito: 'admin-collaudo-esclusi',
        admin_esclusi: 1,
      }),
    )
  })

  it('403 senza Direzione: non si legge nemmeno l’elenco degli admin', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
  })
})

describe('isUtenteCollaudo — il predicato, senza la route intorno', () => {
  const nomi = new Map([
    [SEDE_A, NOME_SEDE_A],
    [SEDE_B, NOME_SEDE_B],
    [SEDE_E2E, NOME_SEDE_E2E],
  ])

  it('sede primaria E2E ⇒ collaudo', () => {
    expect(isUtenteCollaudo({ scuola_id: SEDE_E2E }, nomi)).toBe(true)
  })

  it('sede primaria reale ⇒ NON collaudo, anche col ponte su una sede E2E', () => {
    expect(isUtenteCollaudo({ scuola_id: SEDE_A, sedi: [SEDE_E2E] }, nomi)).toBe(false)
  })

  it('senza sede primaria: tutte le sedi del ponte E2E ⇒ collaudo', () => {
    expect(isUtenteCollaudo({ scuola_id: null, sedi: [SEDE_E2E] }, nomi)).toBe(true)
    expect(isUtenteCollaudo({ scuola_id: null, sedi: [SEDE_E2E, SEDE_B] }, nomi)).toBe(false)
  })

  it('riconosce la sede E2E dal solo id, se il nome non è noto', () => {
    // I nomi arrivano da una lettura di `schools` che può degradare (DB non
    // migrato): il prefisso `e2e00000-…` deve bastare da solo.
    expect(isUtenteCollaudo({ scuola_id: SEDE_E2E }, new Map())).toBe(true)
  })

  it('nessuna sede ⇒ NON collaudo (un insieme vuoto non prova niente)', () => {
    // `every` su un insieme vuoto è vero: senza questa guardia un utente senza
    // sede sarebbe classificato «di collaudo» e sparirebbe dalla Direzione.
    expect(isUtenteCollaudo({ scuola_id: null, sedi: [] }, nomi)).toBe(false)
    expect(isUtenteCollaudo({}, nomi)).toBe(false)
  })
})
