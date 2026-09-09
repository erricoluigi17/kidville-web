import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// CHI CONTROLLA I CONTROLLORI — il registro lo legge solo la Direzione
// ════════════════════════════════════════════════════════════════════════════
//
// Le conversazioni le può aprire anche la `segreteria`. Il registro di CHI le ha
// aperte no: quello è riservato ad `admin` e `coordinator`. La segreteria è la
// parte sorvegliata, e un controllore che consulta il registro di sé stesso non
// è un controllo — è un elenco degli altri.
//
// L'asserzione che conta non è lo status: è che con un ruolo `segreteria` la
// tabella del registro non venga nemmeno TOCCATA.

const ADMIN = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEGRETARIA = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALTRO = 'cccccccc-0000-4000-8000-00000000000c'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  ruoliRichiesti: [] as unknown[],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (req: unknown, allowed?: unknown) => {
    h.ruoliRichiesti.push(allowed)
    return h.requireStaff(req, allowed)
  },
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  restringiSedi: (attive: string[], scuolaId?: string | null) => {
    if (!scuolaId) return attive
    const dentro = attive.filter((id) => id.toLowerCase() === scuolaId.toLowerCase())
    return dentro.length > 0 ? dentro : null
  },
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }) }
})

import { GET } from '@/app/api/admin/chat/vigilanza/route'

const req = (qs = '') => new NextRequest(`http://localhost/api/admin/chat/vigilanza${qs ? '?' + qs : ''}`)

const dbBase = (): DBFinto => ({
  chat_vigilanza_accessi: [
    { id: 'v1', operatore_id: SEGRETARIA, operatore_ruolo: 'segreteria', azione: 'lettura', esito: 'ok', thread_id: 't1', alunno_id: 'a1', scuola_id: SEDE_A, n_messaggi: 7, termine: null, ip: '203.0.113.9', letto_il: '2026-09-08T10:00:00.000Z' },
    { id: 'v2', operatore_id: ADMIN, operatore_ruolo: 'admin', azione: 'ricerca', esito: 'ok', thread_id: null, alunno_id: null, scuola_id: SEDE_A, n_messaggi: 3, termine: 'febbre', ip: null, letto_il: '2026-09-09T08:00:00.000Z' },
    { id: 'v3', operatore_id: ALTRO, operatore_ruolo: 'segreteria', azione: 'lettura', esito: 'ok', thread_id: 't9', alunno_id: 'a9', scuola_id: SEDE_B, n_messaggi: 2, termine: null, ip: null, letto_il: '2026-09-09T09:00:00.000Z' },
  ],
  utenti: [
    { id: SEGRETARIA, nome: 'Anna', cognome: 'Bianchi' },
    { id: ADMIN, nome: 'Luigi', cognome: 'Errico' },
  ],
  alunni: [{ id: 'a1', nome: 'Marco', cognome: 'Rossi', classe_sezione: '2 ANNI' }],
})

const idsRestituiti = async (res: Response) => ((await res.json()).data as { id: string }[]).map((r) => r.id)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.ruoliRichiesti = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/admin/chat/vigilanza — il registro, solo alla Direzione', () => {
  it('chiede il gate con una lista che NON contiene «segreteria»', async () => {
    await GET(req())
    expect(h.ruoliRichiesti).toHaveLength(1)
    const ruoli = h.ruoliRichiesti[0] as string[]
    expect(ruoli).toEqual(expect.arrayContaining(['admin', 'coordinator']))
    expect(ruoli).not.toContain('segreteria')
  })

  it('alla segreteria risponde 403 e NON tocca la tabella del registro', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('chat_vigilanza_accessi')
    expect(h.tabelle).toEqual([])
  })

  it('mostra solo le letture della propria sede, dalla piu recente', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    // `v3` e di SEDE_B e non deve comparire; l'ordine e per `letto_il` discendente.
    expect(await idsRestituiti(res)).toEqual(['v2', 'v1'])
  })

  it('le letture della DIREZIONE ci sono, senza esenzioni per sé', async () => {
    const res = await GET(req())
    const dati = (await res.json()).data as { operatore: { id: string; ruolo: string } }[]
    expect(dati.some((r) => r.operatore.id === ADMIN && r.operatore.ruolo === 'admin')).toBe(true)
  })

  it('filtra per operatore e per azione', async () => {
    expect(await idsRestituiti(await GET(req(`operatoreId=${SEGRETARIA}`)))).toEqual(['v1'])
    expect(await idsRestituiti(await GET(req('azione=ricerca')))).toEqual(['v2'])
  })

  it('l\'estremo destro del periodo comprende tutto il giorno indicato', async () => {
    // `v2` è delle 08:00 del 9 settembre: con un confronto a mezzanotte sparirebbe.
    expect(await idsRestituiti(await GET(req('da=2026-09-09&a=2026-09-09')))).toEqual(['v2'])
  })

  it('una sede non accessibile è 403, e il registro non si legge', async () => {
    const res = await GET(req(`scuolaId=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.tabelle).not.toContain('chat_vigilanza_accessi')
  })

  it('nessuna sede attiva: elenco vuoto, mai «tutto»', async () => {
    h.resolveScuoleAttive.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
    expect(h.tabelle).not.toContain('chat_vigilanza_accessi')
  })

  it('sul DB E2E della CI (tabella assente) degrada, non 500', async () => {
    h.errori = { chat_vigilanza_accessi: { code: '42P01' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).disponibile).toBe(false)
  })

  it('non restituisce mai lo user-agent', async () => {
    const res = await GET(req())
    expect(JSON.stringify(await res.json())).not.toContain('user_agent')
  })
})
