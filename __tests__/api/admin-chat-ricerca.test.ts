import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// LA RICERCA NELLE CONVERSAZIONI — il gesto più invasivo della vigilanza
// ════════════════════════════════════════════════════════════════════════════
//
// Cercare una parola attraversa TUTTE le conversazioni della sede in una volta,
// non una sola. Per questo si registra col termine cercato, e per questo la
// riga di registro è bloccante: se non si può registrare, i risultati non si
// mostrano.
//
// Il termine sta nel REGISTRO e MAI nei log. Il parametro si chiama `q` apposta:
// una chiave come `tipo`/`stato`/`azione` è nella lista bianca di `redact` e il
// testo cercato — che può essere il nome di un bambino — uscirebbe in chiaro in
// `app_log` attraverso il payload che `parseQuery` deposita nel contesto.

const OPERATORE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TERMINE = 'PAROLA-CERCATA'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  rpcChiamate: [] as { nome: string; args: Record<string, unknown> }[],
  rpcRisposta: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  // `restringiSedi` è pura: si usa quella vera, è la regola che si vuole collaudare.
  restringiSedi: (attive: string[], scuolaId?: string | null) => {
    if (!scuolaId) return attive
    const dentro = attive.filter((id) => id.toLowerCase() === scuolaId.toLowerCase())
    return dentro.length > 0 ? dentro : null
  },
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        scritture: h.scritture,
        rpc: {
          chat_vigilanza_ricerca: (args: Record<string, unknown>) => {
            h.rpcChiamate.push({ nome: 'chat_vigilanza_ricerca', args })
            return h.rpcRisposta as { data: unknown; error: unknown }
          },
        },
      }),
  }
})

import { GET } from '@/app/api/admin/chat/ricerca/route'

const req = (qs: string) => new NextRequest(`http://localhost/api/admin/chat/ricerca?${qs}`)

const dbBase = (): DBFinto => ({ chat_vigilanza_accessi: [] })
const righeRegistro = () => h.scritture.filter((s) => s.tabella === 'chat_vigilanza_accessi')
const rigaRegistro = () => {
  const v = righeRegistro()[0].valori as Record<string, unknown> | Record<string, unknown>[]
  return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.rpcChiamate = []
  h.rpcRisposta = { data: [{ messaggio_id: 'm1', thread_id: 't1', contenuto: 'ha la febbre', creato_il: '2026-09-08T10:00:00.000Z', mittente_id: 'x', docente_id: 'd', genitore_id: 'g', alunno_id: 'a', alunno_nome: 'Rossi Anna', classe: '2 ANNI', scuola_id: SEDE_A }], error: null }
  h.requireStaff.mockResolvedValue({ user: { id: OPERATORE, role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/admin/chat/ricerca', () => {
  it('passa alla funzione di database le SEDI ATTIVE, non quelle chieste dal client', async () => {
    const res = await GET(req(`q=${TERMINE}`))
    expect(res.status).toBe(200)
    expect(h.rpcChiamate).toHaveLength(1)
    expect(h.rpcChiamate[0].args.p_scuola_ids).toEqual([SEDE_A])
    expect(h.rpcChiamate[0].args.p_termine).toBe(TERMINE)
  })

  it('una sede non accessibile è 403, e la ricerca non parte nemmeno', async () => {
    const res = await GET(req(`q=${TERMINE}&scuolaId=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.rpcChiamate).toHaveLength(0)
  })

  it('registra la ricerca CON il termine cercato', async () => {
    await GET(req(`q=${TERMINE}`))
    expect(rigaRegistro()).toMatchObject({
      operatore_id: OPERATORE,
      azione: 'ricerca',
      esito: 'ok',
      termine: TERMINE,
      n_messaggi: 1,
      scuola_id: SEDE_A,
    })
  })

  it('se il registro non si scrive, i risultati NON escono', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502' } }
    const res = await GET(req(`q=${TERMINE}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('VIGILANZA_NON_TRACCIABILE')
    expect(JSON.stringify(body)).not.toContain('ha la febbre')
  })

  it('meno di tre caratteri: 400, nessuna ricerca e nessuna riga di registro', async () => {
    const res = await GET(req('q=ab'))
    expect(res.status).toBe(400)
    expect(h.rpcChiamate).toHaveLength(0)
    expect(righeRegistro()).toHaveLength(0)
  })

  it('il gate nega: nessuna ricerca, nessuna tabella, nessun registro', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await GET(req(`q=${TERMINE}`))
    expect(res.status).toBe(403)
    expect(h.rpcChiamate).toHaveLength(0)
    expect(h.tabelle).toEqual([])
  })

  it('con più sedi attive la sede del registro resta vuota invece che arbitraria', async () => {
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    await GET(req(`q=${TERMINE}`))
    expect(rigaRegistro().scuola_id).toBeNull()
  })

  it('sul DB E2E della CI (funzione assente) degrada a elenco vuoto, non 500', async () => {
    h.rpcRisposta = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    const res = await GET(req(`q=${TERMINE}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
    expect(body.data).toEqual([])
  })
})
