import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

const SEDE = '11000000-0000-4000-8000-000000000001'
const JOB = '22000000-0000-4000-8000-000000000002'
const h = vi.hoisted(() => ({ auth: vi.fn(), cron: vi.fn(), opzioni: vi.fn(), leggi: vi.fn(), ctx: vi.fn(), after: vi.fn(), logErrore: vi.fn(), sedi: [] as string[], bytes: new Uint8Array(), db: {} as DBFinto }))
vi.mock('next/server', async originale => ({ ...await originale<typeof import('next/server')>(), after: h.after }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.auth }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => h.sedi }))
vi.mock('@/lib/security/segreto-cron', () => ({ segretoCronValido: h.cron }))
vi.mock('@/lib/storici/scope', () => ({ preparaContestoStorico: h.ctx }))
vi.mock('@/lib/storici/generazioni', () => ({ opzioniStorici: h.opzioni, leggiGenerazione: h.leggi, eseguiGenerazione: vi.fn(), pulisciGenerazioniScadute: async () => 2, riprendiGenerazioni: async () => 1 }))
vi.mock('@/lib/logging/logger', () => ({ logErrore: h.logErrore, logEvento: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => {
    const client = creaFintoSupabase(h.db)
    client.storage = { from: () => ({ download: async () => ({ data: { size: h.bytes.length, arrayBuffer: async () => h.bytes.slice().buffer }, error: null }) }) } as unknown as typeof client.storage
    return client
  } }
})

import { GET as catalogo } from '@/app/api/admin/storici/catalogo/route'
import { POST as anteprima } from '@/app/api/admin/storici/anteprima/route'
import { GET as appartenenzeGet, POST as appartenenzePost, DELETE as appartenenzeDelete } from '@/app/api/admin/storici/appartenenze/route'
import { GET as collegamentiGet, POST as collegamentiPost } from '@/app/api/admin/storici/collegamenti/route'
import { POST as cron } from '@/app/api/admin/storici/cron/route'
import { GET as generazioniGet, POST as generazioniPost } from '@/app/api/admin/storici/generazioni/route'
import { GET as generazione } from '@/app/api/admin/storici/generazioni/[id]/route'
import { GET as file } from '@/app/api/admin/storici/generazioni/[id]/file/route'
import { ErroreStorico } from '@/lib/storici/db'

const richiesta = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://test/api/admin/storici/${path}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
const contesto = (id = JOB) => ({ params: Promise.resolve({ id }) })
const bodyStorico = { scuolaId: SEDE, alunnoId: JOB, dal: '2026-01-01', al: '2026-01-31', categorie: ['anagrafica_scheda'], formato: 'pdf', raggruppamento: 'alunno' }
const staff = { user: { id: JOB, role: 'admin', scuola_id: SEDE } }
const riservata = (res: Response) => expect(res.headers.get('Cache-Control')).toBe('private, no-store')

const staffRoutes = [
  ['catalogo', () => catalogo(richiesta(`catalogo?scuolaId=${SEDE}`))],
  ['anteprima', () => anteprima(richiesta('anteprima', 'POST', bodyStorico))],
  ['appartenenze GET', () => appartenenzeGet(richiesta(`appartenenze?scuolaId=${SEDE}&alunnoId=${JOB}`))],
  ['appartenenze POST', () => appartenenzePost(richiesta('appartenenze', 'POST', {}))],
  ['appartenenze DELETE', () => appartenenzeDelete(richiesta('appartenenze', 'DELETE', {}))],
  ['collegamenti GET', () => collegamentiGet(richiesta(`collegamenti?scuolaId=${SEDE}&tipo=modulo`))],
  ['collegamenti POST', () => collegamentiPost(richiesta('collegamenti', 'POST', {}))],
  ['generazioni GET', () => generazioniGet(richiesta('generazioni'))],
  ['generazioni POST', () => generazioniPost(richiesta('generazioni', 'POST', bodyStorico))],
  ['generazione', () => generazione(richiesta(`generazioni/${JOB}`), contesto())],
  ['file', () => file(richiesta(`generazioni/${JOB}/file`), contesto())],
] as const

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue(staff)
  h.cron.mockReturnValue(true)
  h.opzioni.mockResolvedValue({ categorie: [] })
  h.ctx.mockResolvedValue({ titolo: 'Storico di prova', scuolaNome: 'Scuola di prova', alunni: [], avvisi: [] })
  h.sedi = [SEDE]
  h.db = { storici_generazioni: [] }
  h.bytes = new Uint8Array([37, 80, 68, 70, 45, 0, 255])
  h.leggi.mockResolvedValue({ id: JOB, scuola_id: SEDE, stato: 'completato', file_path: `${SEDE}/${JOB}/storico.pdf`, richiesta: bodyStorico, cursore: 1, titolo: 'Storico', avvisi: [], errore: null, scade_il: '2099-01-01T00:00:00Z' })
})

describe('storici — ogni uscita HTTP è privata e non memorizzabile', () => {
  for (const [nome, esegui] of staffRoutes) {
    it.each([401, 403])(`${nome}: autenticazione %i mantiene status e payload ma sovrascrive cache pubblica`, async status => {
      h.auth.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato', codice: 'CODICE_GATE' }, { status, headers: { 'Cache-Control': 'public, max-age=600', 'Retry-After': '30', 'X-Gate': 'preservato' } }) })
      const res = await esegui()
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error: 'Accesso negato', codice: 'CODICE_GATE' })
      expect(res.headers.get('Retry-After')).toBe('30')
      expect(res.headers.get('X-Gate')).toBe('preservato')
      riservata(res)
    })
  }

  it('cron non autorizzato: 401 con codice originale e no-store', async () => {
    h.cron.mockReturnValue(false)
    const res = await cron(richiesta('cron', 'POST', {}))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ codice: 'CRON_NON_AUTORIZZATO' })
    riservata(res)
  })

  it.each([
    ['catalogo', () => catalogo(richiesta('catalogo'))],
    ['anteprima', () => anteprima(richiesta('anteprima', 'POST', {}))],
    ['appartenenze GET', () => appartenenzeGet(richiesta('appartenenze'))],
    ['appartenenze POST', () => appartenenzePost(richiesta('appartenenze', 'POST', {}))],
    ['appartenenze DELETE', () => appartenenzeDelete(richiesta('appartenenze', 'DELETE', {}))],
    ['collegamenti GET', () => collegamentiGet(richiesta('collegamenti'))],
    ['collegamenti POST', () => collegamentiPost(richiesta('collegamenti', 'POST', {}))],
    ['generazioni POST', () => generazioniPost(richiesta('generazioni', 'POST', {}))],
    ['generazione', () => generazione(richiesta('generazioni/errato'), contesto('errato'))],
    ['file', () => file(richiesta('generazioni/errato/file'), contesto('errato'))],
    ['cron', () => cron(richiesta('cron', 'POST', 'corpo non valido'))],
  ] as const)('%s: validazione zod 400 resta privata', async (_nome, esegui) => {
    const res = await esegui()
    expect(res.status).toBe(400)
    riservata(res)
  })

  it('generazioni senza sedi: anche il ritorno anticipato 200 è privato', async () => {
    h.sedi = []
    const res = await generazioniGet(richiesta('generazioni'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
    riservata(res)
  })

  it('creazione 202 conserva payload e accodamento after', async () => {
    const res = await generazioniPost(richiesta('generazioni', 'POST', bodyStorico))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ id: expect.any(String), stato: 'in_coda' })
    expect(h.after).toHaveBeenCalledTimes(1)
    riservata(res)
  })

  it.each([
    [410, 'STORICO_SCADUTO'], [503, 'STORICO_NON_DISPONIBILE'], [500, 'STORICO_RICHIESTA_RIFIUTATA'],
  ] as const)('errore storico %i: codice e status originali, no-store', async (status, codice) => {
    h.opzioni.mockRejectedValue(new ErroreStorico(status, 'MOTIVO_DI_PROVA', 'Errore di prova'))
    const res = await catalogo(richiesta(`catalogo?scuolaId=${SEDE}`))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: 'Errore di prova', codice, motivo: 'MOTIVO_DI_PROVA' })
    riservata(res)
  })

  it('errore inatteso dal gate: 500 privato con errore vero al logger', async () => {
    const errore = new Error('Trasporto di prova non disponibile')
    h.auth.mockRejectedValue(errore)
    const res = await catalogo(richiesta(`catalogo?scuolaId=${SEDE}`))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'STORICO_NON_RIUSCITO' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), errore)
    riservata(res)
  })

  it.each([
    ['pdf', 'application/pdf', [37, 80, 68, 70, 45, 0, 255]],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [80, 75, 3, 4, 0, 255]],
  ] as const)('download %s: byte e intestazioni restano identici', async (formato, contentType, bytes) => {
    h.bytes = new Uint8Array(bytes)
    h.leggi.mockResolvedValue({ id: JOB, scuola_id: SEDE, stato: 'completato', file_path: `${SEDE}/${JOB}/storico.${formato}`, richiesta: { ...bodyStorico, formato } })
    const res = await file(richiesta(`generazioni/${JOB}/file`), contesto())
    expect(res.status).toBe(200)
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
    expect(res.headers.get('Content-Type')).toBe(contentType)
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="storico-2026-01-01-2026-01-31.${formato}"`)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    riservata(res)
  })
})
