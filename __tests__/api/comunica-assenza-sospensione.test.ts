import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// M4 — Morosità residua: il genitore SOSPESO non può comunicare un'assenza.
// La guardia va DOPO requireParentOfStudent (identità di sessione + legame
// genitore↔alunno) e blocca la SCRITTURA. Le letture restano libere.
//
// ⚠️ Il finto client di questo file è PIATTO, e il 2026-08-07 ha presentato il
// conto: conosceva solo `.upsert()`, e quando la route è passata alla scrittura
// condizionata (UPDATE con `registrato_da IS NULL` nella WHERE, poi INSERT) la
// catena è esplosa in un TypeError che il `catch` della route ha travestito da
// 500 — cioè un test rosso che accusava il gate della sospensione per una cosa
// che il gate non aveva fatto. La prova sui DATI vive in
// `comunica-assenza-tutti-i-gradi.test.ts`, sul fixture che le scritture le
// esegue davvero; qui si prova SOLO che il gate blocchi prima di scrivere.

const STUDENT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const PARENT = 'u1u1u1u1-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
  notificaEvento: vi.fn(),
  docentiDiSezione: vi.fn(),
  righeScritte: 0,
  alunno: null as Record<string, unknown> | null,
  section: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.is = () => b
    b.maybeSingle = async () => {
      if (table === 'alunni') return { data: h.alunno, error: null }
      if (table === 'sections') return { data: h.section, error: null }
      // `presenze`: nessuna riga per quel giorno, quindi l'UPDATE condizionato
      // non colpisce niente e la riga la crea l'INSERT.
      return { data: null, error: null }
    }
    // UPDATE … WHERE registrato_da IS NULL → zero righe colpite (non c'è niente).
    b.update = () => {
      const catena: Record<string, unknown> = {}
      catena.eq = () => catena
      catena.is = () => catena
      catena.select = () => catena
      catena.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, ko)
      return catena
    }
    b.insert = () => {
      h.righeScritte++
      return { select: () => ({ single: async () => ({ data: { id: 'p-1' }, error: null }) }) }
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/parent/presenze/comunica-assenza/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

/**
 * «OGGI» NEL FUSO DI ROMA, non in UTC — ed è la stessa lezione che la rotta ha già scritto
 * nel proprio codice, applicata al test che la collaudava.
 *
 * Era `new Date().toISOString().slice(0, 10)`, cioè la data UTC. La rotta invece confronta con
 * `oggiFiscaleISO()` (Europe/Rome), perché il runtime di Vercel gira in UTC e fra mezzanotte e
 * le due del mattino italiane «oggi» in UTC è ancora IERI. In quella finestra il test spediva
 * una data del PASSATO e la rotta rispondeva — correttamente — 400 `ASSENZA_DATA_PASSATA`:
 * rosso ogni notte per due ore, sul codice giusto. Misurato il 2026-08-08 alle 00:18 di Roma
 * (22:18 UTC del 7).
 *
 * Un test che dipende dall'ora in cui gira è un test che si impara a rilanciare invece che a
 * leggere. Qui si usa la STESSA funzione della rotta: se un giorno il fuso cambia, cambiano
 * insieme.
 */
const TODAY = oggiFiscaleISO()
const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  // Il tetto di frequenza della rotta vive nel MODULO, non nel test: senza
  // questo, i colpi di un caso finiscono nella finestra del successivo e il 429
  // scatta dove non c'entra niente. Ogni test è una raffica indipendente.
  resetRateLimit()
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.notificaEvento.mockResolvedValue(undefined)
  h.docentiDiSezione.mockResolvedValue([])
  h.righeScritte = 0
  h.alunno = { id: STUDENT, section_id: 'sec-1', scuola_id: 'sc-1' }
  h.section = { school_type: 'primaria' }
})

describe('POST /api/parent/presenze/comunica-assenza — gate sospensione morosità (M4)', () => {
  it('genitore sospeso → 403 e NESSUNA riga scritta', async () => {
    h.assertGenitore.mockResolvedValue(
      NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }),
    )
    const res = await POST(postReq({ studentId: STUDENT, data: TODAY }))
    expect(res.status).toBe(403)
    expect(h.righeScritte).toBe(0)
    expect(h.assertGenitore).toHaveBeenCalledWith(expect.anything(), PARENT)
  })

  it('genitore non sospeso → 201 e assenza registrata', async () => {
    h.assertGenitore.mockResolvedValue(null)
    const res = await POST(postReq({ studentId: STUDENT, data: TODAY, motivo: 'febbre' }))
    expect(res.status).toBe(201)
    expect(h.righeScritte).toBe(1)
    expect(h.assertGenitore).toHaveBeenCalled()
  })
})
