/**
 * `DELETE /api/primaria/appello?sectionId=&alunnoId=&data=` — annulla l'appello di
 * un bambino della primaria (spec 2026-09-24, punto 6; compito A3).
 *
 * La libreria `@/lib/presenze/annulla-appello` NON è mockata: il finto di Supabase
 * registra ogni operazione (tabella, verbo, filtri, payload), così i test vedono
 * davvero cosa arriva al database — e soprattutto cosa NON ci arriva quando il
 * gate, lo scope della classe o il «solo oggi» dicono di no.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  assertAlunniInSezione: vi.fn(),
  notificaTitolariScrittura: vi.fn(),
  logScrittura: vi.fn(),
  oggi: '2026-09-25',
  /** true = `oggiFiscaleISO` VERO (fuso Europe/Rome sull'orologio finto), non il mock. */
  oggiVero: false,
  rigaPresenza: null as Record<string, unknown> | null,
  erroreLettura: null as unknown,
  /** Righe restituite da una UPDATE/DELETE su `presenze` (0 = corsa persa). */
  righeScritte: 1,
  erroreScrittura: null as unknown,
  lancia: false,
  operazioni: [] as Array<{ tabella: string; verbo: string; colonne?: string; filtri: unknown[][]; payload?: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: h.assertSezioneInScope,
  assertAlunniInSezione: h.assertAlunniInSezione,
}))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: h.notificaTitolariScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/format/fiscal-date', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/format/fiscal-date')>()
  return { ...vero, oggiFiscaleISO: () => (h.oggiVero ? vero.oggiFiscaleISO() : h.oggi) }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => {
    if (h.lancia) throw new Error('segreto interno: connessione rifiutata')
    return {
      from(tabella: string) {
        const op = { tabella, verbo: 'select', colonne: undefined as string | undefined, filtri: [] as unknown[][], payload: undefined as unknown }
        h.operazioni.push(op)
        const qb: Record<string, unknown> = {}
        qb.select = (c: string) => { if (op.verbo === 'select') op.colonne = c; return qb }
        qb.update = (p: unknown) => { op.verbo = 'update'; op.payload = p; return qb }
        qb.delete = () => { op.verbo = 'delete'; return qb }
        for (const m of ['eq', 'is', 'not', 'in']) qb[m] = (...a: unknown[]) => { op.filtri.push([m, ...a]); return qb }
        qb.maybeSingle = async () => {
          if (tabella !== 'presenze') return { data: null, error: null }
          if (h.erroreLettura) return { data: null, error: h.erroreLettura }
          // La riga c'è solo se la lettura la chiede per la sezione GIUSTA (quando la chiede).
          const perSezione = op.filtri.find((f) => f[0] === 'eq' && f[1] === 'section_id')
          if (perSezione && h.rigaPresenza && perSezione[2] !== h.rigaPresenza.section_id) return { data: null, error: null }
          return { data: h.rigaPresenza, error: null }
        }
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
    }
  }),
}))

import { DELETE } from '@/app/api/primaria/appello/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const SEGRETERIA = 'f0000000-0000-4000-8000-0000000000f1'
const GENITORE = 'e0000000-0000-4000-8000-0000000000e1'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
/** La sede «di casa» della segreteria: DIVERSA da quella della riga annullata. */
const SEDE_SEGRETERIA = 'aaaa0000-0000-4000-8000-00000000a0ff'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const ALTRA_SEZIONE = 'bbbb0000-0000-4000-8000-00000000b002'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'

const richiesta = (q: Record<string, string>) =>
  new NextRequest(`http://localhost/api/primaria/appello?${new URLSearchParams(q)}`, { method: 'DELETE' })
const qOk = (extra: Record<string, string> = {}) => ({ sectionId: SEZIONE, alunnoId: ALUNNO, data: h.oggi, ...extra })

const riga = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  alunno_id: ALUNNO,
  data: h.oggi,
  stato: 'presente',
  orario_entrata: '2026-09-25T06:10:00.000Z',
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
const revocheNotifiche = () => h.operazioni.filter((o) => o.tabella === 'notifiche' && o.verbo === 'delete')

beforeEach(() => {
  vi.clearAllMocks()
  h.oggi = '2026-09-25'
  h.oggiVero = false
  h.rigaPresenza = riga()
  h.erroreLettura = null
  h.righeScritte = 1
  h.erroreScrittura = null
  h.lancia = false
  h.operazioni = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertSezioneInScope.mockResolvedValue(null)
  h.assertAlunniInSezione.mockResolvedValue(null)
  h.notificaTitolariScrittura.mockResolvedValue(undefined)
  h.logScrittura.mockResolvedValue(undefined)
})

describe('gate e scope, identici alla POST', () => {
  it('senza il ruolo risponde il gate, e il database non viene toccato', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(403)
    expect(h.operazioni).toHaveLength(0)
    expect(h.assertSezioneInScope).not.toHaveBeenCalled()
  })

  it('classe fuori scope → 403, e `presenze` non si legge nemmeno', async () => {
    h.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }))
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(403)
    expect(h.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOCENTE }), SEZIONE)
    expect(toccaPresenze()).toBe(false)
    expect(h.assertAlunniInSezione).not.toHaveBeenCalled()
  })

  it('alunno di un\'altra classe → 403, e `presenze` non si legge nemmeno', async () => {
    h.assertAlunniInSezione.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }))
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(403)
    expect(h.assertAlunniInSezione).toHaveBeenCalledWith(expect.anything(), [ALUNNO], SEZIONE)
    expect(toccaPresenze()).toBe(false)
  })

  it.each([
    [{ alunnoId: ALUNNO, data: '2026-09-25' }],
    [{ sectionId: SEZIONE, data: '2026-09-25' }],
    [{ sectionId: SEZIONE, alunnoId: 'non-un-uuid', data: '2026-09-25' }],
    [{ sectionId: SEZIONE, alunnoId: ALUNNO, data: '25/09/2026' }],
    [{ sectionId: SEZIONE, alunnoId: ALUNNO }],
  ])('query malformata → 400: %o', async (q) => {
    const res = await DELETE(richiesta(q as Record<string, string>))
    expect(res.status).toBe(400)
    expect(toccaPresenze()).toBe(false)
  })

  it('la segreteria per conto del titolare passa dallo stesso scope e il titolare viene avvisato', async () => {
    // La sede dell'utente NON è quella della riga: all'avviso deve arrivare la sede
    // della RIGA annullata (letta dalla libreria), non quella di chi annulla.
    const segreteria = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_SEGRETERIA }
    h.requireDocente.mockResolvedValue({ user: segreteria })
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(200)
    expect(h.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), segreteria, SEZIONE)
    expect(h.notificaTitolariScrittura).toHaveBeenCalledWith(expect.anything(), {
      attore: segreteria,
      sectionId: SEZIONE,
      scuolaId: SEDE,
      area: 'appello',
      link: `/teacher/primaria/${SEZIONE}/appello`,
    })
    // l'audit porta la segreteria come autore, non il docente che aveva fatto l'appello
    expect((h.logScrittura.mock.calls[0][1] as { attore: { id: string } }).attore.id).toBe(SEGRETERIA)
  })
})

describe('solo il giorno stesso, in data di Roma', () => {
  it.each([['ieri', '2026-09-24'], ['domani', '2026-09-26']])(
    '%s → 409 APPELLO_ANNULLA_SOLO_OGGI, niente letto né scritto',
    async (_q, data) => {
      const res = await DELETE(richiesta(qOk({ data })))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('APPELLO_ANNULLA_SOLO_OGGI')
      expect(toccaPresenze()).toBe(false)
      expect(revocheNotifiche()).toHaveLength(0)
    },
  )
})

describe('«oggi» è quello di Roma, non quello UTC del runtime', () => {
  // Qui `oggiFiscaleISO` è quella VERA: l'orologio finto segna le 22:30 UTC del
  // 25, cioè le 00:30 del 26 a Roma (ora legale, UTC+2). Una rotta che usasse
  // `new Date().toISOString().slice(0, 10)` direbbe ancora «25».
  beforeEach(() => {
    h.oggiVero = true
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T22:30:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('il 25 (ancora «oggi» in UTC) → 409 APPELLO_ANNULLA_SOLO_OGGI, niente letto', async () => {
    const res = await DELETE(richiesta(qOk({ data: '2026-09-25' })))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('APPELLO_ANNULLA_SOLO_OGGI')
    expect(toccaPresenze()).toBe(false)
  })

  it('il 26 (oggi a Roma) supera il controllo: si legge la riga del 26 e si annulla', async () => {
    h.rigaPresenza = riga({ data: '2026-09-26' })
    const res = await DELETE(richiesta(qOk({ data: '2026-09-26' })))
    expect(res.status).toBe(200)
    expect((await res.json()).esito).toBe('cancellata')
    const lettura = h.operazioni.find((o) => o.tabella === 'presenze' && o.verbo === 'select')
    expect(lettura?.filtri).toEqual(expect.arrayContaining([['eq', 'data', '2026-09-26']]))
  })
})

describe('gli esiti', () => {
  it('la lettura cerca la riga per alunno, giorno E classe verificata', async () => {
    await DELETE(richiesta(qOk()))
    const lettura = h.operazioni.find((o) => o.tabella === 'presenze' && o.verbo === 'select')
    expect(lettura?.filtri).toEqual(expect.arrayContaining([
      ['eq', 'alunno_id', ALUNNO],
      ['eq', 'data', h.oggi],
      ['eq', 'section_id', SEZIONE],
    ]))
  })

  it('presenza registrata in un\'ALTRA classe → 404, nessuna scrittura né revoca', async () => {
    h.rigaPresenza = riga({ section_id: ALTRA_SEZIONE })
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRESENZA_NON_TROVATA')
    expect(scritturePresenze()).toHaveLength(0)
    expect(revocheNotifiche()).toHaveLength(0)
  })

  it('appello senza comunicazione → 200 `cancellata`: DELETE sulla riga della sede, avviso ritirato, audit e titolare', async () => {
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, esito: 'cancellata', presenza: null })

    const [del] = scritturePresenze()
    expect(del.verbo).toBe('delete')
    expect(del.filtri).toEqual(expect.arrayContaining([
      ['eq', 'id', PRESENZA],
      ['eq', 'scuola_id', SEDE],
      ['is', 'giustificata_da', null],
    ]))

    const [rev] = revocheNotifiche()
    expect(rev.filtri).toEqual(expect.arrayContaining([
      ['eq', 'tipo', 'assenza_non_comunicata'],
      ['eq', 'entita_id', ALUNNO],
      ['is', 'push_inviata_il', null],
    ]))

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({
      entitaTipo: 'presenze', entitaId: PRESENZA, azione: 'delete', sectionId: SEZIONE, scuolaId: SEDE, valoreDopo: null,
    })
    expect(h.notificaTitolariScrittura).toHaveBeenCalledTimes(1)
  })

  it('appello sopra una comunicazione → 200 `ripristinata-comunicazione` con le SOLE sei colonne', async () => {
    h.rigaPresenza = riga({ giustificata_da: GENITORE })
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.esito).toBe('ripristinata-comunicazione')
    expect(corpo.presenza).toMatchObject({ id: PRESENZA, stato: 'assente', orario_entrata: null, orario_uscita: null })
    expect(Object.keys(corpo.presenza).sort()).toEqual(
      ['alunno_id', 'data', 'id', 'orario_entrata', 'orario_uscita', 'stato'].sort(),
    )
    expect(JSON.stringify(corpo)).not.toMatch(/febbre|nota interna/)

    const [upd] = scritturePresenze()
    expect(upd.verbo).toBe('update')
    expect(upd.payload).toMatchObject({ stato: 'assente', registrato_da: null, orario_entrata: null, orario_uscita: null })
    expect(Object.keys(upd.payload as object).some((k) => /^giustific|^giust_vista_/.test(k))).toBe(false)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({ azione: 'update', sectionId: SEZIONE })
  })

  it('nessuna riga → 404 PRESENZA_NON_TROVATA, niente audit né avviso al titolare', async () => {
    h.rigaPresenza = null
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRESENZA_NON_TROVATA')
    expect(scritturePresenze()).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.notificaTitolariScrittura).not.toHaveBeenCalled()
  })

  it('solo la comunicazione del genitore → 409 NIENTE_DA_ANNULLARE', async () => {
    h.rigaPresenza = riga({ registrato_da: null, stato: 'assente', giustificata_da: GENITORE })
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('NIENTE_DA_ANNULLARE')
    expect(scritturePresenze()).toHaveLength(0)
    expect(h.notificaTitolariScrittura).not.toHaveBeenCalled()
  })

  it.each([
    ['senza comunicazione (DELETE)', {}],
    ['sopra una comunicazione (UPDATE)', { giustificata_da: GENITORE }],
  ])('corsa persa %s → 409 APPELLO_CAMBIATO_NEL_FRATTEMPO, nessuna revoca né audit', async (_c, extra) => {
    h.rigaPresenza = riga(extra)
    h.righeScritte = 0
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('APPELLO_CAMBIATO_NEL_FRATTEMPO')
    expect(corpo.success).toBeUndefined()
    expect(scritturePresenze()).toHaveLength(1)
    expect(revocheNotifiche()).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.notificaTitolariScrittura).not.toHaveBeenCalled()
  })

  it('lettura fallita → 500 APPELLO_NON_ANNULLATO senza il messaggio di PostgREST, mai 404', async () => {
    h.erroreLettura = { code: '42501', message: 'permission denied for table presenze' }
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('APPELLO_NON_ANNULLATO')
    expect(JSON.stringify(corpo)).not.toContain('permission denied')
    expect(scritturePresenze()).toHaveLength(0)
  })

  it('scrittura fallita → 500 APPELLO_NON_ANNULLATO, nessuna revoca né avviso al titolare', async () => {
    h.erroreScrittura = { code: '23503', message: 'violates foreign key constraint x' }
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('APPELLO_NON_ANNULLATO')
    expect(JSON.stringify(corpo)).not.toMatch(/violates|23503/)
    expect(revocheNotifiche()).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.notificaTitolariScrittura).not.toHaveBeenCalled()
  })

  it('eccezione imprevista → 500 con codice, mai il `message` grezzo', async () => {
    h.lancia = true
    const res = await DELETE(richiesta(qOk()))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('APPELLO_NON_ANNULLATO')
    expect(JSON.stringify(corpo)).not.toContain('segreto interno')
  })
})
