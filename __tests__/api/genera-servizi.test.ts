import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// Generazione MANUALE dei servizi mensili: anteprima (GET) e conferma (POST).
//
// Il finto Supabase applica davvero i filtri e le scritture; le rpc dei servizi
// sono emulate con uno STATO (le voci già generate), così l'idempotenza — due
// POST, la seconda genera zero — è una proprietà verificata e non asserita.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const CAT_POMERIDIANO = 'c0000000-0000-4000-8000-0000000000a1'
const CAT_PULMINO = 'c0000000-0000-4000-8000-0000000000a2'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Record<string, unknown>[],
  errori: {} as Record<string, { code: string; message?: string }>,
  chiamate: [] as { nome: string; args: Record<string, unknown> }[],
  /** Le voci che l'anteprima restituisce. */
  daGenerare: [] as Record<string, unknown>[],
  /** Le voci già scritte (chiave alunno|categoria|periodo): lo stato dell'idempotenza. */
  scritte: new Set<string>(),
  rpc: 'ok' as 'ok' | 'errore' | 'assente' | 'lancia',
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))

function guasto(): { data: unknown; error: unknown } | null {
  if (h.rpc === 'lancia') throw new Error('rpc non emulata')
  if (h.rpc === 'errore') return { data: null, error: { code: 'XX000', message: 'guasto servizi' } }
  if (h.rpc === 'assente') return { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
  return null
}

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        scritture: h.scritture as unknown as Scrittura[],
        rpc: {
          servizi_da_generare: (args: Riga) => {
            h.chiamate.push({ nome: 'servizi_da_generare', args })
            return guasto() ?? { data: h.daGenerare, error: null }
          },
          genera_servizi_mensili: (args: Riga) => {
            h.chiamate.push({ nome: 'genera_servizi_mensili', args })
            const g = guasto()
            if (g) return g
            // Idempotenza: una voce già scritta non si riscrive.
            let nuove = 0
            for (const v of h.daGenerare) {
              const k = `${v.alunno_id}|${v.categoria_id}|${args.p_periodo}`
              if (!h.scritte.has(k)) { h.scritte.add(k); nuove++ }
            }
            return { data: nuove, error: null }
          },
        },
      }) as never,
  }
})

import { GET, POST } from '@/app/api/pagamenti/genera-servizi/route'

const get = (qs: string) => new Request(`http://localhost/api/pagamenti/genera-servizi?${qs}`)
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/genera-servizi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: 'Sede A' },
    { id: SEDE_B, nome: 'Sede B' },
    { id: SEDE_E2E, nome: 'Sede di collaudo' },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_E2E, attiva: true },
  ],
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
    { utente_id: ADMIN, scuola_id: SEDE_E2E },
  ],
  payment_categories: [
    { id: CAT_POMERIDIANO, nome: 'Pomeridiano' },
    { id: CAT_PULMINO, nome: 'Pulmino' },
  ],
  registro_modifiche: [],
})

const voce = (alunno: string, cat: string, importo: number) => ({
  iscrizione_id: `i-${alunno}-${cat}`, alunno_id: alunno, categoria_id: cat, importo,
  scadenza: '2026-10-31', visibile_dal: '2026-10-01', descrizione: 'Servizio', gruppo: 'servizio-2026-10',
})

const ADMIN_UTENTE = { id: ADMIN, role: 'admin', scuola_id: SEDE_A }
const SEGRETERIA_UTENTE = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_B }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.log = []
  h.chiamate = []
  h.scritte = new Set()
  h.rpc = 'ok'
  h.daGenerare = [
    voce(ALU_1, CAT_POMERIDIANO, 77.5),
    voce(ALU_2, CAT_POMERIDIANO, 77.5),
    voce(ALU_1, CAT_PULMINO, 33.25),
  ]
  h.requireStaff.mockResolvedValue({ user: ADMIN_UTENTE })
})

const audit = () => h.db.registro_modifiche as Riga[]

describe('GET /api/pagamenti/genera-servizi — anteprima', () => {
  it('non staff: la risposta del gate passa tale e quale, nessuna rpc', async () => {
    const { NextResponse } = await import('next/server')
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect(h.chiamate).toEqual([])
  })

  it('periodo malformato o assente: 400, nessuna rpc', async () => {
    for (const qs of [`periodo=ottobre&scuola_id=${SEDE_B}`, `periodo=2026-13&scuola_id=${SEDE_B}`, `scuola_id=${SEDE_B}`]) {
      expect((await GET(get(qs))).status).toBe(400)
    }
    expect(h.chiamate).toEqual([])
  })

  it('scuola_id non uuid: 400', async () => {
    expect((await GET(get('periodo=2026-10&scuola_id=xyz'))).status).toBe(400)
  })

  it('admin con più sedi e senza scuola_id: 400 (mai «ne scelgo una io»)', async () => {
    h.db.utenti_scuole = [
      { utente_id: ADMIN, scuola_id: SEDE_A },
      { utente_id: ADMIN, scuola_id: SEDE_B },
    ]
    const res = await GET(get('periodo=2026-10'))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
  })

  it('sede fuori dal perimetro: 403', async () => {
    h.requireStaff.mockResolvedValue({ user: SEGRETERIA_UTENTE })
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_A}`))
    expect(res.status).toBe(403)
    expect(h.chiamate).toEqual([])
  })

  it('sede di collaudo: 400 con codice SEDE_DI_COLLAUDO', async () => {
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_E2E}`))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DI_COLLAUDO')
    expect(h.chiamate).toEqual([])
  })

  it('Direzione: conteggi per servizio con nome, e importi (totale e per servizio)', async () => {
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    expect(h.chiamate).toEqual([{
      nome: 'servizi_da_generare',
      args: { p_periodo: '2026-10-01', p_scuola_id: SEDE_B, p_alunno_ids: null },
    }])
    const { data } = await res.json()
    expect(data.periodo).toBe('2026-10-01')
    expect(data.voci).toBe(3)
    expect(data.totale).toBe(188.25)
    expect(data.per_servizio).toEqual(expect.arrayContaining([
      { categoria_id: CAT_POMERIDIANO, nome: 'Pomeridiano', voci: 2, totale: 155 },
      { categoria_id: CAT_PULMINO, nome: 'Pulmino', voci: 1, totale: 33.25 },
    ]))
    expect(data.per_servizio).toHaveLength(2)
  })

  it('Segreteria: i conteggi ci sono, le CHIAVI degli importi no (assenti, non azzerate)', async () => {
    h.requireStaff.mockResolvedValue({ user: SEGRETERIA_UTENTE })
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.voci).toBe(3)
    expect('totale' in data).toBe(false)
    for (const s of data.per_servizio) expect('totale' in s).toBe(false)
    expect(data.per_servizio.map((s: { voci: number }) => s.voci).sort()).toEqual([1, 2])
    // nemmeno in forma serializzata compare un importo
    expect(JSON.stringify(data)).not.toMatch(/77\.5|33\.25/)
  })

  it('nessuna voce dovuta: 0 voci, nessuna lettura dei nomi', async () => {
    h.daGenerare = []
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    const { data } = await res.json()
    expect(data.voci).toBe(0)
    expect(data.per_servizio).toEqual([])
    expect(h.tabelle).not.toContain('payment_categories')
  })

  it('funzione assente (PGRST202): 503 SERVIZI_NON_DISPONIBILI e log error', async () => {
    h.rpc = 'assente'
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SERVIZI_NON_DISPONIBILI')
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('servizi-non-disponibili'))).toBe(true)
  })

  it('altro errore della rpc: 500 SERVIZI_ANTEPRIMA_FALLITA senza il testo del database', async () => {
    h.rpc = 'errore'
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZI_ANTEPRIMA_FALLITA')
    expect(JSON.stringify(j)).not.toContain('guasto servizi')
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('anteprima-servizi-fallita'))).toBe(true)
  })

  it('i nomi si leggono nel perimetro: una causale di un\'altra sede non dà il suo nome', async () => {
    h.db.payment_categories = [
      { id: CAT_POMERIDIANO, nome: 'Pomeridiano', scuola_id: SEDE_A },
      { id: CAT_PULMINO, nome: 'Pulmino', scuola_id: null },
    ]
    const { data } = await (await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))).json()
    const nomi = Object.fromEntries(data.per_servizio.map((s: { categoria_id: string; nome: string | null }) => [s.categoria_id, s.nome]))
    expect(nomi).toEqual({ [CAT_POMERIDIANO]: null, [CAT_PULMINO]: 'Pulmino' })
  })

  it('lettura dei nomi fallita: 500 SERVIZI_ANTEPRIMA_FALLITA', async () => {
    h.errori = { payment_categories: { code: 'XX000', message: 'boom' } }
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SERVIZI_ANTEPRIMA_FALLITA')
  })
})

describe('POST /api/pagamenti/genera-servizi — conferma', () => {
  it('non staff: rifiutato, nessuna generazione', async () => {
    const { NextResponse } = await import('next/server')
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))).status).toBe(403)
    expect(h.chiamate).toEqual([])
  })

  it('periodo malformato: 400', async () => {
    expect((await POST(post({ periodo: '10/2026', scuola_id: SEDE_B }))).status).toBe(400)
    expect((await POST(post({ scuola_id: SEDE_B }))).status).toBe(400)
    expect(h.chiamate).toEqual([])
  })

  it('admin con più sedi senza scuola_id: 400', async () => {
    h.db.utenti_scuole = [
      { utente_id: ADMIN, scuola_id: SEDE_A },
      { utente_id: ADMIN, scuola_id: SEDE_B },
    ]
    expect((await POST(post({ periodo: '2026-10' }))).status).toBe(400)
    expect(h.chiamate).toEqual([])
  })

  it('sede fuori dal perimetro: 403; sede di collaudo: 400 SEDE_DI_COLLAUDO', async () => {
    h.requireStaff.mockResolvedValue({ user: SEGRETERIA_UTENTE })
    expect((await POST(post({ periodo: '2026-10', scuola_id: SEDE_A }))).status).toBe(403)
    h.requireStaff.mockResolvedValue({ user: ADMIN_UTENTE })
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_E2E }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DI_COLLAUDO')
    expect(h.chiamate).toEqual([])
  })

  it('successo: genera con periodo, sede e alunni null; audit "manuale"; log del successo', async () => {
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { periodo: '2026-10-01', generati: 3 } })
    expect(h.chiamate).toEqual([{
      nome: 'genera_servizi_mensili',
      args: { p_periodo: '2026-10-01', p_scuola_id: SEDE_B, p_alunno_ids: null },
    }])
    expect(audit()).toHaveLength(1)
    expect(audit()[0]).toMatchObject({
      azione: 'genera_servizi',
      utente_id: ADMIN,
      nuovo_valore: { periodo: '2026-10-01', generati: 3, scuola_id: SEDE_B, azione: 'manuale' },
    })
    expect(h.log.some((c) => c[1] === 'info' && JSON.stringify(c).includes('servizi-generati'))).toBe(true)
  })

  it('idempotenza: due POST di fila, la seconda genera 0', async () => {
    const corpo = { periodo: '2026-10', scuola_id: SEDE_B }
    expect((await (await POST(post(corpo))).json()).data.generati).toBe(3)
    expect((await (await POST(post(corpo))).json()).data.generati).toBe(0)
  })

  it('funzione assente: 503 SERVIZI_NON_DISPONIBILI e nessun audit', async () => {
    h.rpc = 'assente'
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SERVIZI_NON_DISPONIBILI')
    expect(audit()).toEqual([])
  })

  it.each(['errore', 'lancia'] as const)('rpc in %s: 500 SERVIZI_NON_GENERATI, log error, nessun audit', async (modo) => {
    h.rpc = modo
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE_B }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SERVIZI_NON_GENERATI')
    expect(JSON.stringify(j)).not.toContain('guasto servizi')
    expect(audit()).toEqual([])
    expect(h.log.some((c) => c[1] === 'error' && JSON.stringify(c).includes('servizi-non-generati'))).toBe(true)
  })
})
