import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// UN'ASSENZA CHE DEVE ANCORA ACCADERE NON SI CONTA COME ACCADUTA.
//
// Misurato dai tester il 2026-08-07: comunicando un'assenza per il 31/12/2099 il
// contatore «Assenze» della pagina genitore passava da 1 a 2, e la riga compariva
// nella cronologia «Assenze, ritardi e uscite anticipate». Dopo il DELETE tornava
// a 1.
//
// NON È UN ERRORE DI CALCOLO: è un'assunzione infranta. Fino al 2026-08-07 la
// tabella `presenze` aveva UNA sola sorgente di scrittura (il docente, sul giorno
// corrente), quindi «una riga di presenze è un giorno già trascorso» era vero per
// costruzione e tutti i consumatori sono stati scritti su quel presupposto.
// «Comunica un'assenza» introduce righe con `data >= oggi`, e un solo consumatore
// è stato adeguato (`parent/presenze:GET`, che usa già `.lte('data', oggi)`).
//
// ─── DOVE STA IL CONFINE, E PERCHÉ OGGI CONTA ───────────────────────────────
//
// «Oggi» si calcola in `Europe/Rome` con `oggiFiscaleISO()`, e **oggi è dentro**
// (`.lte`, non `.lt`), per due ragioni che tirano nella stessa direzione:
//  · è la scelta già fatta dalla route sorella sul riepilogo dei 30 giorni: due
//    definizioni diverse di «trascorso» nella stessa app si contraddirebbero
//    proprio nella schermata che le mostra vicine;
//  · con `.lt` l'appello che la maestra fa stamattina resterebbe invisibile al
//    genitore fino a domani — cioè si toglierebbe un dato vero per nascondere
//    un dato futuro.
// =============================================================================

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const OGGI = '2026-08-10'
const IERI = '2026-08-09'
const DOMANI = '2026-08-11'
const LONTANO = '2099-12-31'

const h = vi.hoisted(() => ({ requireParent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

let db: DBFinto
let errori: Record<string, { code: string; message?: string }>
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(db, [], { errori }),
}))

import { GET } from '@/app/api/parent/primaria/assenze/route'

const req = () =>
  new NextRequest(`http://localhost/api/parent/primaria/assenze?studentId=${STUDENT}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  errori = {}
  db = {
    presenze: [
      { id: 'p-ieri', alunno_id: STUDENT, data: IERI, stato: 'assente' },
      { id: 'p-oggi', alunno_id: STUDENT, data: OGGI, stato: 'presente' },
      { id: 'p-domani', alunno_id: STUDENT, data: DOMANI, stato: 'assente', giustificata_da: PARENT },
      { id: 'p-2099', alunno_id: STUDENT, data: LONTANO, stato: 'assente', giustificata_da: PARENT },
    ],
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/parent/primaria/assenze — il riepilogo conta i giorni TRASCORSI', () => {
  it('un’assenza comunicata per DOMANI non entra nel conteggio', async () => {
    const body = await (await GET(req())).json()
    expect(body.riepilogo.assente).toBe(1)
  })

  it('nemmeno quella del 2099 (è il caso misurato dai tester)', async () => {
    db.presenze = [
      { id: 'p-ieri', alunno_id: STUDENT, data: IERI, stato: 'assente' },
      { id: 'p-2099', alunno_id: STUDENT, data: LONTANO, stato: 'assente' },
    ]
    const body = await (await GET(req())).json()
    expect(body.riepilogo.assente).toBe(1)
  })

  it('OGGI conta: l’appello di stamattina non sparisce fino a domani', async () => {
    const body = await (await GET(req())).json()
    expect(body.riepilogo.presente).toBe(1)
  })

  it('la CRONOLOGIA non mostra i giorni futuri', async () => {
    const body = await (await GET(req())).json()
    const date = (body.data as { data: string }[]).map((r) => r.data)
    expect(date).toContain(IERI)
    expect(date).not.toContain(DOMANI)
    expect(date).not.toContain(LONTANO)
  })

  it('il confine è quello ROMANO: a mezzanotte e mezza italiana «oggi» è già il giorno dopo', async () => {
    // 22:30 UTC del 10 = 00:30 dell'11 a Roma: con `new Date().toISOString()` il
    // server conterebbe ancora il 10 come «oggi» e l'11 come futuro, per due ore.
    vi.setSystemTime(new Date('2026-08-10T22:30:00Z'))
    db.presenze = [{ id: 'p-11', alunno_id: STUDENT, data: DOMANI, stato: 'assente' }]
    const body = await (await GET(req())).json()
    expect(body.riepilogo.assente).toBe(1)
  })
})

describe('GET /api/parent/primaria/assenze — la lettura si controlla', () => {
  it('cronologia non letta ⇒ una riga di log, non un elenco vuoto muto', async () => {
    // PostgREST non lancia: senza il controllo del valore di ritorno, «non hai
    // assenze» e «non le ho potute leggere» sono lo stesso 200.
    errori = { presenze: { code: '42501', message: 'permission denied for table presenze' } }
    await GET(req())
    const righe = JSON.stringify([...logEvento.mock.calls, ...logErrore.mock.calls])
    expect(righe).toContain('42501')
  })
})
