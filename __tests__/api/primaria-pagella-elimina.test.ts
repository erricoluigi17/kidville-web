import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * DELETE /api/primaria/pagella — eliminazione di UNA pagella (S2, spec
 * 2026-09-24 «sei interventi»).
 *
 * Il finto qui sotto REGISTRA ogni catena PostgREST (tabella, operazione,
 * filtri, payload) e ogni chiamata allo Storage, e risponde da una coda per
 * `tabella:operazione`. I test guardano QUALI scritture partono, con QUALI
 * filtri e in QUALE ordine: il file dell'alunno (e solo il suo), poi la riga
 * di QUELLA pagella — mai le pagelle dei compagni, mai `pagella_ricezioni`,
 * mai lo scrutinio.
 */

type Chiamata = {
  table: string
  op: 'select' | 'update' | 'delete' | 'insert' | 'upsert'
  payload?: unknown
  colonne?: string
  filtri: Array<[string, string, unknown]>
}
type Esito = { data: unknown; error: unknown }

const h = vi.hoisted(() => {
  const state = {
    code: {} as Record<string, Esito[]>,
    chiamate: [] as Chiamata[],
    storage: [] as Array<{ bucket: string; op: 'remove'; arg: string[] }>,
    // `null` = il finto risponde con i percorsi presenti in `fileEsistenti`.
    removeEsito: null as Esito | null,
    fileEsistenti: new Set<string>(),
    // Sequenza unica di DB e Storage, nell'ordine in cui le operazioni partono davvero.
    ordine: [] as string[],
  }
  function prendi(c: Chiamata): Esito {
    state.ordine.push(`${c.table}:${c.op}`)
    const coda = state.code[`${c.table}:${c.op}`] ?? []
    return coda.shift() ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const c: Chiamata = { table, op: 'select', filtri: [] }
        let opFissata = false
        state.chiamate.push(c)
        const qb: Record<string, unknown> = {}
        const scrive = (op: Chiamata['op']) => (payload?: unknown) => {
          c.op = op
          c.payload = payload
          opFissata = true
          return qb
        }
        qb.update = scrive('update')
        qb.delete = scrive('delete')
        qb.insert = scrive('insert')
        qb.upsert = scrive('upsert')
        qb.select = (col?: string) => {
          if (!opFissata) c.colonne = col
          return qb
        }
        for (const m of ['eq', 'is', 'in', 'neq', 'not', 'order', 'limit']) {
          qb[m] = (col: string, val: unknown) => {
            c.filtri.push([m, col, val])
            return qb
          }
        }
        qb.single = () => Promise.resolve(prendi(c))
        qb.maybeSingle = () => Promise.resolve(prendi(c))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(prendi(c)).then(res, rej)
        return qb
      },
      storage: {
        from(bucket: string) {
          return {
            remove: (percorsi: string[]) => {
              state.storage.push({ bucket, op: 'remove', arg: percorsi })
              state.ordine.push(`storage:${bucket}:remove`)
              if (state.removeEsito) return Promise.resolve(state.removeEsito)
              // Come lo Storage vero: restituisce solo i file che c'erano davvero.
              const tolti = percorsi.filter((p) => state.fileEsistenti.delete(p))
              return Promise.resolve({ data: tolti.map((name) => ({ name })), error: null })
            },
          }
        },
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))

const authMock = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveIdentity: vi.fn(),
  loadAppUser: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => authMock)

const scopeMock = vi.hoisted(() => ({
  assertSezioneInScope: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  assertAlunniInSezione: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => scopeMock)

const auditMock = vi.hoisted(() => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: auditMock.logScrittura }))

const logMock = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: logMock.logEvento,
  logErrore: logMock.logErrore,
}))

import { DELETE } from '@/app/api/primaria/pagella/route'

// Uuid finti, scritti a mano: nessuno esiste in produzione.
const SCRUTINIO = 'a2000000-0000-4000-8000-000000000001'
const SEZIONE = 'b2000000-0000-4000-8000-000000000002'
const SCUOLA = 'c2000000-0000-4000-8000-000000000003'
const ALUNNO = 'd2000000-0000-4000-8000-000000000004'
const COMPAGNO = 'd2000000-0000-4000-8000-000000000005'
const PAGELLA = 'f2000000-0000-4000-8000-000000000006'
const UTENTE = 'e2000000-0000-4000-8000-000000000007'
const GENERATORE = 'e2000000-0000-4000-8000-000000000008'

const FILE_ALUNNO = `${SCRUTINIO}/${ALUNNO}.pdf`
const FILE_COMPAGNO = `${SCRUTINIO}/${COMPAGNO}.pdf`

const GUASTO = { message: 'canceling statement due to statement timeout', code: '57014' }

function req(query: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(query).toString()
  return new NextRequest(`http://localhost/api/primaria/pagella?${qs}`, { method: 'DELETE' })
}
const reqValida = () => req({ scrutinioId: SCRUTINIO, alunnoId: ALUNNO })

const scrutinioLetto: Esito = {
  data: { id: SCRUTINIO, section_id: SEZIONE, sections: { scuola_id: SCUOLA } },
  error: null,
}

function rigaPagella(extra: Record<string, unknown> = {}): Esito {
  return {
    data: {
      id: PAGELLA,
      file_url: FILE_ALUNNO,
      generata_il: '2026-06-12T09:00:00Z',
      generata_da: GENERATORE,
      ...extra,
    },
    error: null,
  }
}

function preparaPercorsoFelice(riga: Esito = rigaPagella()) {
  h.state.code = {
    'scrutini:select': [scrutinioLetto],
    'pagelle:select': [riga],
    'pagelle:delete': [{ data: [{ id: PAGELLA }], error: null }],
  }
  h.state.fileEsistenti = new Set([FILE_ALUNNO, FILE_COMPAGNO])
}

const scritture = () => h.state.chiamate.filter((c) => c.op !== 'select')
const filtro = (c: Chiamata, m: string, col: string) => c.filtri.find(([mm, cc]) => mm === m && cc === col)?.[2]

beforeEach(() => {
  vi.clearAllMocks()
  h.state.code = {}
  h.state.chiamate = []
  h.state.storage = []
  h.state.removeEsito = null
  h.state.fileEsistenti = new Set()
  h.state.ordine = []
  authMock.requireStaff.mockResolvedValue({
    user: { id: UTENTE, role: 'segreteria', scuola_id: SCUOLA },
    response: null,
  })
  scopeMock.assertSezioneInScope.mockResolvedValue(null)
  auditMock.logScrittura.mockResolvedValue(undefined)
})

describe('DELETE /api/primaria/pagella — chi può', () => {
  it('ammette SOLO Segreteria e Direzione (admin, coordinator, segreteria): il docente resta fuori', async () => {
    authMock.requireStaff.mockResolvedValue({
      user: null,
      response: NextResponse.json({ error: 'no' }, { status: 403 }),
    })
    const res = await DELETE(reqValida())
    expect(res.status).toBe(403)
    const ruoli = authMock.requireStaff.mock.calls[0][1] as string[]
    expect([...ruoli].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
    expect(h.state.chiamate).toEqual([])
    expect(h.state.storage).toEqual([])
  })

  it('fuori dal plesso: il rifiuto di sede esce prima di leggere la pagella e di toccare file o righe', async () => {
    preparaPercorsoFelice()
    scopeMock.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'x' }, { status: 403 }))
    const res = await DELETE(reqValida())
    expect(res.status).toBe(403)
    // La sede si controlla sulla sezione DELLO SCRUTINIO letto, con l'utente del gate.
    expect(scopeMock.assertSezioneInScope.mock.calls[0][1]).toMatchObject({ id: UTENTE })
    expect(scopeMock.assertSezioneInScope.mock.calls[0][2]).toBe(SEZIONE)
    expect(h.state.chiamate.some((c) => c.table === 'pagelle')).toBe(false)
    expect(scritture()).toEqual([])
    expect(h.state.storage).toEqual([])
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
  })

  it('query non valida → 400 senza toccare database e storage', async () => {
    const res = await DELETE(req({ scrutinioId: SCRUTINIO, alunnoId: 'non-un-uuid' }))
    expect(res.status).toBe(400)
    expect(h.state.chiamate).toEqual([])
    expect(h.state.storage).toEqual([])
  })

  it('manca l’alunno → 400 (non si cancella «tutta la cartella» per omissione)', async () => {
    const res = await DELETE(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(400)
    expect(h.state.chiamate).toEqual([])
    expect(h.state.storage).toEqual([])
  })
})

describe('DELETE /api/primaria/pagella — il percorso completo', () => {
  it('cancella il file dell’alunno e la SUA riga, in quest’ordine; niente compagni, ricezioni, scrutinio o avvisi', async () => {
    preparaPercorsoFelice()
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, rigaEliminata: true, fileEliminati: 1 })

    // Letture: scrutinio per id, pagella per (scrutinio, alunno).
    const letturaPagella = h.state.chiamate.find((c) => c.table === 'pagelle' && c.op === 'select')!
    expect(filtro(letturaPagella, 'eq', 'scrutinio_id')).toBe(SCRUTINIO)
    expect(filtro(letturaPagella, 'eq', 'alunno_id')).toBe(ALUNNO)

    // Storage: bucket `pagelle`, SOLO il file dell'alunno. Il PDF del compagno resta.
    expect(h.state.storage).toHaveLength(1)
    expect(h.state.storage[0].bucket).toBe('pagelle')
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
    expect(h.state.fileEsistenti.has(FILE_COMPAGNO)).toBe(true)

    // Una sola scrittura su DB: il DELETE della riga, ristretto a id + scrutinio + alunno.
    const w = scritture()
    expect(w.map((c) => `${c.table}:${c.op}`)).toEqual(['pagelle:delete'])
    expect(filtro(w[0], 'eq', 'id')).toBe(PAGELLA)
    expect(filtro(w[0], 'eq', 'scrutinio_id')).toBe(SCRUTINIO)
    expect(filtro(w[0], 'eq', 'alunno_id')).toBe(ALUNNO)

    // L'ordine intero: sede letta, pagella letta, POI il file, POI la riga.
    expect(h.state.ordine).toEqual([
      'scrutini:select',
      'pagelle:select',
      'storage:pagelle:remove',
      'pagelle:delete',
    ])

    // Le firme di ricezione sono storico; lo scrutinio e gli avvisi non si toccano.
    expect(h.state.chiamate.some((c) => c.table === 'pagella_ricezioni')).toBe(false)
    expect(h.state.chiamate.some((c) => c.table === 'notifiche')).toBe(false)
    expect(h.state.chiamate.some((c) => c.table === 'scrutini' && c.op !== 'select')).toBe(false)
  })

  it('scrive l’audit (delete, con sede e classe) e logga il SUCCESSO con soli uuid, numeri e booleani', async () => {
    preparaPercorsoFelice()
    await DELETE(reqValida())

    expect(auditMock.logScrittura).toHaveBeenCalledTimes(1)
    const audit = auditMock.logScrittura.mock.calls[0][1]
    expect(audit).toMatchObject({
      entitaTipo: 'pagella',
      entitaId: PAGELLA,
      azione: 'delete',
      scuolaId: SCUOLA,
      sectionId: SEZIONE,
      valorePrima: {
        scrutinio_id: SCRUTINIO,
        alunno_id: ALUNNO,
        file_url: FILE_ALUNNO,
        generata_da: GENERATORE,
      },
      valoreDopo: null,
    })
    expect(audit.attore).toMatchObject({ id: UTENTE })

    const ok = logMock.logEvento.mock.calls.find(
      (c) => c[0] === 'registro' && c[1] === 'info' && c[2]?.esito === 'pagella-eliminata',
    )
    expect(ok, 'manca il log di successo dell’eliminazione').toBeTruthy()
    expect(ok![2]).toEqual({
      operazione: 'primaria/pagella:DELETE',
      esito: 'pagella-eliminata',
      scrutinio_id: SCRUTINIO,
      alunno_id: ALUNNO,
      section_id: SEZIONE,
      scuola_id: SCUOLA,
      attore_id: UTENTE,
      riga_eliminata: true,
      file_eliminati: 1,
    })
  })

  it('PDF rimasto SENZA riga (upsert fallito a suo tempo): il file si elimina lo stesso, e l’audit porta scrutinio e alunno', async () => {
    preparaPercorsoFelice({ data: null, error: null })
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, rigaEliminata: false, fileEliminati: 1 })
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
    expect(scritture()).toEqual([])
    const audit = auditMock.logScrittura.mock.calls[0][1]
    expect(audit.entitaId).toBeNull()
    expect(audit.valorePrima).toMatchObject({ scrutinio_id: SCRUTINIO, alunno_id: ALUNNO })
  })

  it('riga col `file_url` di un COMPAGNO (dato incoerente): quel file NON si tocca, si cancella solo il percorso dell’alunno', async () => {
    preparaPercorsoFelice(rigaPagella({ file_url: FILE_COMPAGNO }))
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
    expect(h.state.fileEsistenti.has(FILE_COMPAGNO)).toBe(true)
  })

  it('riga con `file_url` fuori dalla cartella dello scrutinio o in una sottocartella: non si cancella da qui', async () => {
    preparaPercorsoFelice(rigaPagella({ file_url: `altro/${ALUNNO}.pdf` }))
    await DELETE(reqValida())
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])

    h.state.chiamate = []
    h.state.storage = []
    preparaPercorsoFelice(rigaPagella({ file_url: `${SCRUTINIO}/${ALUNNO}/../${COMPAGNO}.pdf` }))
    await DELETE(reqValida())
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
  })

  it('riga con un `file_url` diverso ma dell’alunno nella cartella giusta: si cancellano entrambi i percorsi', async () => {
    const vecchio = `${SCRUTINIO}/${ALUNNO}-v1.pdf`
    preparaPercorsoFelice(rigaPagella({ file_url: vecchio }))
    h.state.fileEsistenti.add(vecchio)
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect([...h.state.storage[0].arg].sort()).toEqual([FILE_ALUNNO, vecchio].sort())
    expect((await res.json()).fileEliminati).toBe(2)
  })
})

describe('DELETE /api/primaria/pagella — rifiuti e guasti', () => {
  it('scrutinio inesistente → 404 con codice, nessun file e nessuna riga toccati', async () => {
    h.state.code = { 'scrutini:select': [{ data: null, error: null }] }
    const res = await DELETE(reqValida())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PAGELLA_ELIMINAZIONE_SCRUTINIO_NON_TROVATO')
    expect(scopeMock.assertSezioneInScope).not.toHaveBeenCalled()
    expect(h.state.storage).toEqual([])
    expect(scritture()).toEqual([])
  })

  it('nessuna riga e nessun file → 404 con codice, senza audit né log di successo', async () => {
    preparaPercorsoFelice({ data: null, error: null })
    h.state.fileEsistenti = new Set([FILE_COMPAGNO])
    const res = await DELETE(reqValida())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PAGELLA_ELIMINAZIONE_NON_TROVATA')
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(logMock.logEvento.mock.calls.some((c) => c[2]?.esito === 'pagella-eliminata')).toBe(false)
    expect(h.state.fileEsistenti.has(FILE_COMPAGNO)).toBe(true)
  })

  it('lettura dello scrutinio fallita → 500 con codice (non 404), senza il messaggio grezzo', async () => {
    h.state.code = { 'scrutini:select': [{ data: null, error: GUASTO }] }
    const res = await DELETE(reqValida())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('PAGELLA_ELIMINAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(body)).not.toContain('statement timeout')
    expect(h.state.storage).toEqual([])
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'scrutinio-non-letto',
      ),
    ).toBe(true)
  })

  it('lettura della pagella fallita → 500 PRIMA dello storage (con `data: null` ignorato si cancellerebbe il file lasciando la riga)', async () => {
    preparaPercorsoFelice({ data: null, error: GUASTO })
    const res = await DELETE(reqValida())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('PAGELLA_ELIMINAZIONE_NON_RIUSCITA')
    expect(h.state.storage).toEqual([])
    expect(scritture()).toEqual([])
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'pagella-non-letta',
      ),
    ).toBe(true)
  })

  it('rimozione del file fallita → 500 sotto «storage»: la riga RESTA (si può ripetere), niente audit', async () => {
    preparaPercorsoFelice()
    h.state.removeEsito = { data: null, error: { message: 'storage down', statusCode: '500' } }
    const res = await DELETE(reqValida())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('PAGELLA_ELIMINAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(body)).not.toContain('storage down')
    expect(scritture().some((c) => c.table === 'pagelle' && c.op === 'delete')).toBe(false)
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    const logStorage = logMock.logEvento.mock.calls.find((c) => c[2]?.esito === 'file-pagella-non-eliminato')
    expect(logStorage, 'manca il log del guasto dello storage').toBeTruthy()
    expect(logStorage![0]).toBe('storage')
    expect(logStorage![1]).toBe('error')
  })

  it('cancellazione della riga fallita → 500 con codice, niente audit né log di successo', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:delete'] = [{ data: null, error: GUASTO }]
    const res = await DELETE(reqValida())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('PAGELLA_ELIMINAZIONE_NON_RIUSCITA')
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(logMock.logEvento.mock.calls.some((c) => c[2]?.esito === 'pagella-eliminata')).toBe(false)
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'riga-pagella-non-eliminata',
      ),
    ).toBe(true)
  })
})
