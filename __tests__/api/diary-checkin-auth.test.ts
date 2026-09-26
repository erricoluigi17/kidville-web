import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// G1 — GET /api/diary/checkin esponeva orario di entrata/stato presenza per
// QUALSIASI alunno_id (IDOR). Ora passa da requireParentOfStudent: staff/docenti
// passano, il genitore solo i propri figli, l'anonimo è 401.
//
// A1 (2026-09-26) — l'orario d'ingresso esce SOLO sul ritardo. La riga letta dal
// finto DB è mutabile (`h.riga`) apposta: ogni caso dichiara lo stato che mette in
// tabella, e un finto che restituisse sempre la stessa riga non misurerebbe niente.
const h = vi.hoisted(() => {
  const stato: { riga: Record<string, unknown> | null; errore: unknown } = {
    riga: { orario_entrata: '08:30', stato: 'ritardo' },
    errore: null,
  }
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.maybeSingle = () => Promise.resolve({ data: stato.riga, error: stato.errore })
    return qb
  })
  return { requireParentOfStudent: vi.fn(), fromSpy, stato }
})

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
// Solo `logErrore` è una spia: il resto del logger resta vero (withRoute lo usa).
// Serve al caso d'errore PostgREST: il ramo `if (error)` della route deve LOGGARE,
// non solo rispondere 500 (regola 7 di AGENTS.md: PostgREST non lancia).
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: vi.fn() }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { GET } from '@/app/api/diary/checkin/route'
import { logErrore } from '@/lib/logging/logger'
import { NextRequest } from 'next/server'

const ALUNNO = '11111111-1111-1111-1111-111111111111'
const req = (qs: string) => new NextRequest(`http://localhost/api/diary/checkin?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.stato.riga = { orario_entrata: '08:30', stato: 'ritardo' }
  h.stato.errore = null
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
})

describe('GET /api/diary/checkin — gate genitore↔alunno (G1)', () => {
  it('401 anonimo: nessun accesso alle presenze', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'x' }, { status: 401 }),
    })
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('403 IDOR: genitore che chiede un figlio non suo', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(403)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200 per il genitore legittimo', async () => {
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.orario_entrata).toBe('08:30')
    expect(h.requireParentOfStudent).toHaveBeenCalledWith(expect.anything(), ALUNNO)
  })
})

describe('GET /api/diary/checkin — l\'orario esce solo sul ritardo (A1)', () => {
  it('ritardo: orario d\'ingresso e stato', async () => {
    h.stato.riga = { orario_entrata: '2026-09-07T07:50:00Z', stato: 'ritardo' }
    const res = await GET(req(`alunno_id=${ALUNNO}&date=2026-09-07`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orario_entrata: '2026-09-07T07:50:00Z', stato: 'ritardo' })
  })

  it('presente con l\'ora del tocco salvata: orario null, stato «presente»', async () => {
    h.stato.riga = { orario_entrata: '2026-09-07T06:35:04.428Z', stato: 'presente' }
    const res = await GET(req(`alunno_id=${ALUNNO}&date=2026-09-07`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ orario_entrata: null, stato: 'presente' })
    // Il dato non deve nemmeno viaggiare: nessuna traccia dell'ora nel corpo.
    expect(JSON.stringify(j)).not.toContain('06:35')
  })

  it('uscita anticipata: l\'orario d\'INGRESSO non esce', async () => {
    h.stato.riga = { orario_entrata: '08:10', stato: 'uscita_anticipata' }
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(await res.json()).toEqual({ orario_entrata: null, stato: 'uscita_anticipata' })
  })

  it('assente: niente orario, lo stato sì', async () => {
    h.stato.riga = { orario_entrata: null, stato: 'assente' }
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(await res.json()).toEqual({ orario_entrata: null, stato: 'assente' })
  })

  it('appello non ancora fatto (nessuna riga): tutto null', async () => {
    h.stato.riga = null
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orario_entrata: null, stato: null })
  })

  it('errore PostgREST: 500 senza riecheggiare il messaggio del database', async () => {
    h.stato.riga = null
    h.stato.errore = { message: 'relation "presenze" leaked detail', code: 'XX000' }
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('leaked detail')
    // Stesso codice (e stessa frase) della route sorella `GET /api/parent/presenze`, che
    // legge la stessa tabella: il client lo traduce, con l'interfaccia in inglese pure.
    expect(body.codice).toBe('PRESENZE_NON_LETTE')
    expect(body.error).toBe('Errore interno')
    // Il messaggio non va al browser ma NON si butta: finisce nel log, con l'errore vero.
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'diary/checkin:GET', stato: 500, evento: 'db' }),
      expect.objectContaining({ code: 'XX000' }),
    )
  })

  it('lettura riuscita: nessun logErrore (la spia non scatta a vuoto)', async () => {
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(200)
    expect(logErrore).not.toHaveBeenCalled()
  })
})
