/**
 * `DELETE /api/primaria/presenze/giust-vista?presenzaId=&vistaIl=` — «Annulla presa visione»
 * della giustifica, primaria (spec 2026-09-24, punto 2; compito A5).
 *
 * Il finto di Supabase REGISTRA ogni operazione (tabella, verbo, colonne, filtri,
 * payload), e la riga «in tabella» cambia davvero solo se i filtri della UPDATE
 * corrispondono: così i test vedono cosa arriva al database — e soprattutto cosa
 * NON ci arriva quando scope, permesso o stato della riga dicono di no.
 *
 * `haUnRuolo` NON è mockato: il permesso di Segreteria/Direzione si prova sui
 * ruoli veri dell'utente finto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

type Op = { tabella: string; verbo: string; colonne?: string; filtri: unknown[][]; payload?: Record<string, unknown> }

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  riga: null as Record<string, unknown> | null,
  erroreLettura: null as unknown,
  erroreScrittura: null as unknown,
  /** Simula la corsa: fra lettura e scrittura qualcuno ha rifatto la presa visione. */
  cambiaPrimaDellaScrittura: null as Record<string, unknown> | null,
  operazioni: [] as Op[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: h.assertSezioneInScope }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const op: Op = { tabella, verbo: 'select', filtri: [] }
      h.operazioni.push(op)
      const qb: Record<string, unknown> = {}
      qb.select = (c: string) => { if (op.verbo === 'select') op.colonne = c; return qb }
      qb.update = (p: Record<string, unknown>) => { op.verbo = 'update'; op.payload = p; return qb }
      for (const m of ['eq', 'is', 'not', 'in']) qb[m] = (...a: unknown[]) => { op.filtri.push([m, ...a]); return qb }
      qb.maybeSingle = async () => {
        if (tabella !== 'presenze') return { data: null, error: null }
        if (op.verbo === 'select') {
          if (h.erroreLettura) return { data: null, error: h.erroreLettura }
          const idCercato = op.filtri.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2]
          return { data: h.riga && h.riga.id === idCercato ? { ...h.riga } : null, error: null }
        }
        // UPDATE: la riga cambia SOLO se ogni filtro `eq` corrisponde alla riga in tabella.
        if (h.erroreScrittura) return { data: null, error: h.erroreScrittura }
        if (h.cambiaPrimaDellaScrittura && h.riga) h.riga = { ...h.riga, ...h.cambiaPrimaDellaScrittura }
        const r = h.riga
        if (!r) return { data: null, error: null }
        const corrisponde = op.filtri.every((f) => f[0] !== 'eq' || r[f[1] as string] === f[2])
        if (!corrisponde) return { data: null, error: null }
        h.riga = { ...r, ...op.payload }
        return { data: { id: h.riga.id, giust_vista_il: h.riga.giust_vista_il }, error: null }
      }
      return qb
    },
  })),
}))

import { DELETE } from '@/app/api/primaria/presenze/giust-vista/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const ALTRO_DOCENTE = 'd0000000-0000-4000-8000-0000000000d2'
const SEGRETERIA = 'f0000000-0000-4000-8000-0000000000f1'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEDE_UTENTE = 'aaaa0000-0000-4000-8000-00000000a0ff'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'
const GENITORE = 'e0000000-0000-4000-8000-0000000000e1'
const VISTA_IL = '2026-09-25T07:30:00.123456+00:00'

/**
 * `vistaIl` è la presa visione che la pagina aveva a schermo. `null` = parametro
 * assente. Si costruisce con `URLSearchParams`: il `+` del fuso, scritto a mano in
 * un URL, diventerebbe uno spazio.
 */
const richiesta = (presenzaId: string = PRESENZA, vistaIl: string | null = VISTA_IL) => {
  const qs = new URLSearchParams({ presenzaId })
  if (vistaIl !== null) qs.set('vistaIl', vistaIl)
  return new NextRequest(`http://localhost/api/primaria/presenze/giust-vista?${qs.toString()}`, { method: 'DELETE' })
}

const rigaBase = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  section_id: SEZIONE,
  scuola_id: SEDE,
  stato: 'assente',
  giustificata: true,
  giustificata_da: GENITORE,
  giustificazione_testo: 'motivo sanitario',
  giust_vista_il: VISTA_IL,
  giust_vista_da: DOCENTE,
  ...extra,
})

const come = (id: string, role: string, ruoli?: string[]) =>
  h.requireDocente.mockResolvedValue({ user: { id, role, scuola_id: SEDE_UTENTE, ...(ruoli ? { ruoli } : {}) } })

const update = () => h.operazioni.filter((o) => o.tabella === 'presenze' && o.verbo === 'update')
const letture = () => h.operazioni.filter((o) => o.tabella === 'presenze' && o.verbo === 'select')

beforeEach(() => {
  vi.clearAllMocks()
  h.riga = rigaBase()
  h.erroreLettura = null
  h.erroreScrittura = null
  h.cambiaPrimaDellaScrittura = null
  h.operazioni = []
  come(DOCENTE, 'educator')
  h.assertSezioneInScope.mockResolvedValue(null)
  h.logScrittura.mockResolvedValue(undefined)
})

describe('gate, validazione e scope', () => {
  it('senza il ruolo risponde il gate, e il database non viene toccato', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await DELETE(richiesta())
    expect(res.status).toBe(403)
    expect(h.operazioni).toHaveLength(0)
  })

  it('`presenzaId` non uuid → 400 prima di toccare il database', async () => {
    const res = await DELETE(richiesta('non-un-uuid'))
    expect(res.status).toBe(400)
    expect(h.operazioni).toHaveLength(0)
  })

  it.each([
    ['assente', null],
    ['non una data', 'ieri'],
    ['una data senza ora', '2026-09-25'],
    ['una data-ora senza fuso', '2026-09-25T07:30:00'],
  ])('`vistaIl` %s → 400 prima di toccare il database', async (_caso, valore) => {
    const res = await DELETE(richiesta(PRESENZA, valore))
    expect(res.status).toBe(400)
    expect(h.operazioni).toHaveLength(0)
    expect(h.riga?.giust_vista_il).toBe(VISTA_IL)
  })

  it('classe fuori scope → 403 dello scope, sulla sezione DELLA RIGA, e nessuna UPDATE', async () => {
    h.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'fuori' }, { status: 403 }))
    const res = await DELETE(richiesta())
    expect(res.status).toBe(403)
    expect(h.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOCENTE }), SEZIONE)
    expect(update()).toHaveLength(0)
    expect(h.riga?.giust_vista_il).toBe(VISTA_IL)
  })

  it('lo scope viene PRIMA del permesso: un estraneo fuori classe non scopre di chi è la presa visione', async () => {
    come(ALTRO_DOCENTE, 'educator')
    h.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'fuori' }, { status: 403 }))
    const res = await DELETE(richiesta())
    const corpo = await res.json()
    expect(corpo.codice).not.toBe('PRESA_VISIONE_NON_TUA')
  })

  it('la lettura chiede solo le colonne che decidono: né motivo né firma', async () => {
    await DELETE(richiesta())
    const colonne = letture()[0]?.colonne ?? ''
    expect(colonne).toContain('giust_vista_da')
    expect(colonne).not.toContain('giustificazione_testo')
    expect(colonne).not.toContain('giustificazione_firma')
    expect(colonne).not.toContain('*')
  })
})

describe('chi può annullare', () => {
  it('il docente che l’ha presa → 200, e le DUE colonne tornano null in tabella', async () => {
    const res = await DELETE(richiesta())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo).toEqual({ success: true, presenza: { id: PRESENZA, giust_vista_il: null } })
    expect(h.riga).toMatchObject({ giust_vista_il: null, giust_vista_da: null })
    // La giustifica del genitore resta intatta: si toglie la LETTURA, non la comunicazione.
    expect(h.riga).toMatchObject({ giustificata: true, giustificata_da: GENITORE, giustificazione_testo: 'motivo sanitario' })
  })

  it('la UPDATE scrive SOLO le due colonne ed è condizionata a riga, classe e presa visione letta', async () => {
    await DELETE(richiesta())
    const [u] = update()
    expect(u.payload).toEqual({ giust_vista_il: null, giust_vista_da: null })
    expect(u.filtri).toEqual(expect.arrayContaining([
      ['eq', 'id', PRESENZA],
      ['eq', 'section_id', SEZIONE],
      ['eq', 'giust_vista_il', VISTA_IL],
    ]))
    expect(u.colonne ?? '').not.toContain('giustificazione')
  })

  it('un ALTRO docente della classe → 403 PRESA_VISIONE_NON_TUA, nessuna UPDATE', async () => {
    come(ALTRO_DOCENTE, 'educator')
    const res = await DELETE(richiesta())
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('PRESA_VISIONE_NON_TUA')
    expect(update()).toHaveLength(0)
    expect(h.riga?.giust_vista_il).toBe(VISTA_IL)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it.each(['segreteria', 'admin', 'coordinator'])('%s (non autore) → 200', async (ruolo) => {
    come(SEGRETERIA, ruolo)
    const res = await DELETE(richiesta())
    expect(res.status).toBe(200)
    expect(h.riga).toMatchObject({ giust_vista_il: null, giust_vista_da: null })
  })

  it('conta il ruolo REALE: una segretaria in veste di docente può annullare', async () => {
    come(SEGRETERIA, 'educator', ['educator', 'segreteria'])
    const res = await DELETE(richiesta())
    expect(res.status).toBe(200)
  })

  it('presa visione senza autore registrato: la toglie solo lo staff', async () => {
    h.riga = rigaBase({ giust_vista_da: null })
    const res = await DELETE(richiesta())
    expect(res.status).toBe(403)
    expect(update()).toHaveLength(0)
  })

  it('nessun termine: una presa visione di mesi fa si annulla lo stesso', async () => {
    const vecchia = '2026-01-10T08:00:00+00:00'
    h.riga = rigaBase({ giust_vista_il: vecchia })
    const res = await DELETE(richiesta(PRESENZA, vecchia))
    expect(res.status).toBe(200)
  })
})

describe('stati della riga', () => {
  it('presenza inesistente → 404 con codice, nessuna UPDATE', async () => {
    h.riga = null
    const res = await DELETE(richiesta())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRESA_VISIONE_PRESENZA_NON_TROVATA')
    expect(update()).toHaveLength(0)
  })

  it('nessuna presa visione → 409 PRESA_VISIONE_ASSENTE, nessuna UPDATE', async () => {
    h.riga = rigaBase({ giust_vista_il: null, giust_vista_da: null })
    const res = await DELETE(richiesta())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRESA_VISIONE_ASSENTE')
    expect(update()).toHaveLength(0)
  })

  it('presa visione RIFATTA fra lettura e scrittura → 409 PRESA_VISIONE_CAMBIATA, riga intatta, niente audit', async () => {
    h.cambiaPrimaDellaScrittura = { giust_vista_il: '2026-09-25T09:00:00+00:00', giust_vista_da: DOCENTE }
    const res = await DELETE(richiesta())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRESA_VISIONE_CAMBIATA')
    expect(h.riga?.giust_vista_il).toBe('2026-09-25T09:00:00+00:00')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  describe('la presa visione deve essere QUELLA che si aveva a schermo (`vistaIl`)', () => {
    // Scenario: la pagina è stata caricata con la presa visione del docente A
    // (VISTA_IL). Nel frattempo A l'ha tolta e il docente B l'ha rifatta: in tabella
    // c'è quella di B, con un altro istante.
    const RIFATTA_IL = '2026-09-25T10:15:00.654321+00:00'
    const rifattaDaB = () => { h.riga = rigaBase({ giust_vista_il: RIFATTA_IL, giust_vista_da: ALTRO_DOCENTE }) }

    it('la Segreteria con la riga vecchia → 409 PRESA_VISIONE_CAMBIATA, nessuna UPDATE, riga di B intatta, niente audit', async () => {
      rifattaDaB()
      come(SEGRETERIA, 'segreteria')
      const res = await DELETE(richiesta(PRESENZA, VISTA_IL))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('PRESA_VISIONE_CAMBIATA')
      expect(update()).toHaveLength(0)
      expect(h.riga).toMatchObject({ giust_vista_il: RIFATTA_IL, giust_vista_da: ALTRO_DOCENTE })
      expect(h.logScrittura).not.toHaveBeenCalled()
      expect(h.logEvento).toHaveBeenCalledWith('registro', 'warn', expect.objectContaining({
        operazione: 'primaria/presenze/giust-vista:DELETE',
        esito: 'presa-visione-cambiata-dalla-lettura',
        presenza: PRESENZA,
      }))
      expect(h.logEvento).not.toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ esito: 'presa-visione-annullata' }))
    })

    it('il docente A con la sua riga vecchia → 409 CAMBIATA, non 403 NON_TUA: la risposta è «rileggi»', async () => {
      rifattaDaB()
      come(DOCENTE, 'educator')
      const res = await DELETE(richiesta(PRESENZA, VISTA_IL))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('PRESA_VISIONE_CAMBIATA')
      expect(update()).toHaveLength(0)
    })

    it('la Segreteria che ha a schermo la presa visione di B → 200, e la UPDATE è condizionata a quell’istante', async () => {
      rifattaDaB()
      come(SEGRETERIA, 'segreteria')
      const res = await DELETE(richiesta(PRESENZA, RIFATTA_IL))
      expect(res.status).toBe(200)
      expect(update()[0].filtri).toContainEqual(['eq', 'giust_vista_il', RIFATTA_IL])
      expect(h.riga).toMatchObject({ giust_vista_il: null, giust_vista_da: null })
    })

    it('stesso istante scritto in un’altra forma (`Z`, zeri in coda) → non è un cambiamento', async () => {
      h.riga = rigaBase({ giust_vista_il: '2026-09-25T07:30:00.1234+00:00' })
      const res = await DELETE(richiesta(PRESENZA, '2026-09-25T07:30:00.123400Z'))
      expect(res.status).toBe(200)
      // Il filtro usa la forma della colonna (quella letta), non quella della richiesta.
      expect(update()[0].filtri).toContainEqual(['eq', 'giust_vista_il', '2026-09-25T07:30:00.1234+00:00'])
    })

    it('un microsecondo di differenza È un cambiamento', async () => {
      h.riga = rigaBase({ giust_vista_il: '2026-09-25T07:30:00.123457+00:00' })
      const res = await DELETE(richiesta(PRESENZA, '2026-09-25T07:30:00.123456+00:00'))
      expect(res.status).toBe(409)
      expect(update()).toHaveLength(0)
    })
  })

  it('lettura fallita (PostgREST ritorna `{ error }`) → 500 con codice, il messaggio resta nel log', async () => {
    h.erroreLettura = { message: 'segreto interno di postgrest', code: 'XX000' }
    const res = await DELETE(richiesta())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRESA_VISIONE_NON_ANNULLATA')
    expect(JSON.stringify(corpo)).not.toContain('segreto')
    expect(update()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith('db', 'error', expect.objectContaining({ esito: 'presenza-non-letta' }), h.erroreLettura)
  })

  it('scrittura fallita → 500 con codice, niente audit né log di successo', async () => {
    h.erroreScrittura = { message: 'segreto interno di postgrest', code: 'XX000' }
    const res = await DELETE(richiesta())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PRESA_VISIONE_NON_ANNULLATA')
    expect(JSON.stringify(corpo)).not.toContain('segreto')
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.logEvento).not.toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ esito: 'presa-visione-annullata' }))
  })
})

describe('traccia: audit e log', () => {
  it('audit `logScrittura` con prima/dopo, la sede della RIGA e la classe', async () => {
    come(SEGRETERIA, 'segreteria')
    await DELETE(richiesta())
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura).toHaveBeenCalledWith(expect.anything(), {
      attore: expect.objectContaining({ id: SEGRETERIA }),
      entitaTipo: 'presenze',
      entitaId: PRESENZA,
      azione: 'update',
      sectionId: SEZIONE,
      scuolaId: SEDE,
      valorePrima: { id: PRESENZA, giust_vista_il: VISTA_IL, giust_vista_da: DOCENTE },
      valoreDopo: { id: PRESENZA, giust_vista_il: null, giust_vista_da: null },
    })
  })

  it('il SUCCESSO si logga, e dice se a togliere è stato l’autore', async () => {
    await DELETE(richiesta())
    expect(h.logEvento).toHaveBeenCalledWith('registro', 'info', expect.objectContaining({
      operazione: 'primaria/presenze/giust-vista:DELETE',
      esito: 'presa-visione-annullata',
      presenza: PRESENZA,
      sezione: SEZIONE,
      da_autore: true,
    }))
  })

  it('nessun avviso al genitore quando la presa visione si toglie', async () => {
    await DELETE(richiesta())
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(h.operazioni.some((o) => o.tabella === 'notifiche')).toBe(false)
  })
})
