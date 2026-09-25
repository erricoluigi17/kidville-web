/**
 * `DELETE /api/attendance/daily?alunno_id=&data=` — annulla l'appello di un bambino
 * (nido e infanzia; spec 2026-09-24, punto 6).
 *
 * La libreria NON è mockata: il finto di Supabase registra ogni operazione, così
 * i test della rotta vedono davvero cosa arriva al database — e soprattutto cosa
 * NON ci arriva quando il gate, lo scope o il «solo oggi» dicono di no.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logScrittura: vi.fn(),
  oggi: '2026-09-25',
  rigaPresenza: null as Record<string, unknown> | null,
  erroreLettura: null as unknown,
  /** Righe restituite da una UPDATE/DELETE su `presenze` (0 = corsa persa). */
  righeScritte: 1,
  erroreScrittura: null as unknown,
  operazioni: [] as Array<{ tabella: string; verbo: string; filtri: unknown[][]; payload?: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  resolveScuoleAttive: vi.fn(),
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(), nomeUtente: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/format/fiscal-date', () => ({ oggiFiscaleISO: () => h.oggi }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const op = { tabella, verbo: 'select', filtri: [] as unknown[][], payload: undefined as unknown }
      h.operazioni.push(op)
      const qb: Record<string, unknown> = {}
      qb.select = () => qb
      qb.update = (p: unknown) => { op.verbo = 'update'; op.payload = p; return qb }
      qb.delete = () => { op.verbo = 'delete'; return qb }
      for (const m of ['eq', 'is', 'not', 'in']) qb[m] = (...a: unknown[]) => { op.filtri.push([m, ...a]); return qb }
      qb.maybeSingle = async () =>
        tabella === 'presenze' ? { data: h.rigaPresenza, error: h.erroreLettura } : { data: null, error: null }
      const risultato = () => {
        if (tabella !== 'presenze') return { data: null, error: null }
        if (op.verbo !== 'select' && h.erroreScrittura) return { data: null, error: h.erroreScrittura }
        const base = { ...(h.rigaPresenza ?? {}), ...((op.payload as object) ?? {}) }
        const n = op.verbo === 'select' ? 1 : h.righeScritte
        return { data: Array.from({ length: n }, () => base), error: null }
      }
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve(risultato()).then(res)
      return qb
    },
  })),
}))

import { DELETE } from '@/app/api/attendance/daily/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const GENITORE = 'e0000000-0000-4000-8000-0000000000e1'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'

const richiesta = (q: Record<string, string>) =>
  new NextRequest(`http://localhost/api/attendance/daily?${new URLSearchParams(q)}`, { method: 'DELETE' })

const riga = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  alunno_id: ALUNNO,
  data: h.oggi,
  stato: 'presente',
  orario_entrata: '2026-09-25T06:45:00.000Z',
  orario_uscita: null,
  registrato_da: DOCENTE,
  giustificata_da: null,
  scuola_id: SEDE,
  section_id: SEZIONE,
  giustificazione_testo: 'febbre',
  note_appello: 'nota interna',
  ...extra,
})

const scritturePresenze = () => h.operazioni.filter((o) => o.tabella === 'presenze' && o.verbo !== 'select')
const toccaPresenze = () => h.operazioni.some((o) => o.tabella === 'presenze')

beforeEach(() => {
  vi.clearAllMocks()
  h.oggi = '2026-09-25'
  h.rigaPresenza = riga()
  h.erroreLettura = null
  h.righeScritte = 1
  h.erroreScrittura = null
  h.operazioni = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.logScrittura.mockResolvedValue(undefined)
})

describe('gate e scope, come la POST', () => {
  it('senza il ruolo risponde il gate, e il database non viene toccato', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(403)
    expect(h.operazioni).toHaveLength(0)
  })

  it('alunno fuori scope (altra sezione / altra sede) → 403, e `presenze` non si legge nemmeno', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }))
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(403)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOCENTE }), ALUNNO)
    expect(toccaPresenze()).toBe(false)
  })

  it.each([
    [{ alunno_id: 'non-un-uuid', data: '2026-09-25' }],
    [{ alunno_id: ALUNNO, data: '25/09/2026' }],
    [{ alunno_id: ALUNNO }],
  ])('query malformata → 400: %o', async (q) => {
    const res = await DELETE(richiesta(q as Record<string, string>))
    expect(res.status).toBe(400)
    expect(toccaPresenze()).toBe(false)
  })
})

describe('solo il giorno stesso, in data di Roma', () => {
  it('ieri → 409 APPELLO_ANNULLA_SOLO_OGGI, niente letto né scritto', async () => {
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: '2026-09-24' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('APPELLO_ANNULLA_SOLO_OGGI')
    expect(toccaPresenze()).toBe(false)
  })

  it('domani → 409 lo stesso', async () => {
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: '2026-09-26' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('APPELLO_ANNULLA_SOLO_OGGI')
  })

  it('«oggi» è quello di Roma, non quello UTC del runtime', async () => {
    // Il mock di `oggiFiscaleISO` dice «26»: la data del 25 (che sarebbe ancora
    // l'oggi UTC alle 00:30 italiane) non passa più.
    h.oggi = '2026-09-26'
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: '2026-09-25' }))
    expect(res.status).toBe(409)
  })
})

describe('gli esiti', () => {
  it('appello senza comunicazione → 200 `cancellata`, presenza null, DELETE sulla riga della sede', async () => {
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, esito: 'cancellata', presenza: null })
    const [del] = scritturePresenze()
    expect(del.verbo).toBe('delete')
    expect(del.filtri).toEqual(expect.arrayContaining([['eq', 'id', PRESENZA], ['eq', 'scuola_id', SEDE]]))
    // e l'avviso in coda viene ritirato
    expect(h.operazioni.some((o) => o.tabella === 'notifiche' && o.verbo === 'delete')).toBe(true)
  })

  it('appello sopra una comunicazione → 200 `ripristinata-comunicazione` con le SOLE sei colonne', async () => {
    h.rigaPresenza = riga({ giustificata_da: GENITORE })
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.esito).toBe('ripristinata-comunicazione')
    expect(corpo.presenza).toMatchObject({ id: PRESENZA, stato: 'assente', orario_entrata: null, orario_uscita: null })
    expect(Object.keys(corpo.presenza).sort()).toEqual(
      ['alunno_id', 'data', 'id', 'orario_entrata', 'orario_uscita', 'stato'].sort(),
    )
    expect(JSON.stringify(corpo)).not.toMatch(/febbre|nota interna/)
    expect(scritturePresenze()[0].verbo).toBe('update')
  })

  it('nessuna riga → 404 PRESENZA_NON_TROVATA', async () => {
    h.rigaPresenza = null
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRESENZA_NON_TROVATA')
    expect(scritturePresenze()).toHaveLength(0)
  })

  it('solo la comunicazione del genitore → 409 NIENTE_DA_ANNULLARE', async () => {
    h.rigaPresenza = riga({ registrato_da: null, stato: 'assente', giustificata_da: GENITORE })
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('NIENTE_DA_ANNULLARE')
    expect(scritturePresenze()).toHaveLength(0)
  })

  it('lettura fallita → 500 senza il messaggio di PostgREST, mai 404', async () => {
    h.rigaPresenza = null
    h.erroreLettura = { code: '42501', message: 'permission denied for table presenze' }
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('permission denied')
  })

  const revocheNotifiche = () => h.operazioni.filter((o) => o.tabella === 'notifiche' && o.verbo === 'delete')

  it.each([
    ['senza comunicazione (DELETE)', {}],
    ['sopra una comunicazione (UPDATE)', { giustificata_da: GENITORE }],
  ])('corsa persa %s: 0 righe scritte → 409 APPELLO_CAMBIATO_NEL_FRATTEMPO, nessuna revoca', async (_c, extra) => {
    h.rigaPresenza = riga(extra)
    h.righeScritte = 0
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('APPELLO_CAMBIATO_NEL_FRATTEMPO')
    expect(corpo.success).toBeUndefined()
    // la scrittura è stata tentata, ma l'avviso in coda resta dov'è
    expect(scritturePresenze()).toHaveLength(1)
    expect(revocheNotifiche()).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('scrittura fallita → 500 senza il messaggio di PostgREST, nessuna revoca', async () => {
    h.erroreScrittura = { code: '23503', message: 'violates foreign key constraint x' }
    const res = await DELETE(richiesta({ alunno_id: ALUNNO, data: h.oggi }))
    expect(res.status).toBe(500)
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toContain('violates')
    expect(testo).not.toContain('23503')
    expect(scritturePresenze()).toHaveLength(1)
    expect(revocheNotifiche()).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})
