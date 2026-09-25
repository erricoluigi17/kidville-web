import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/primaria/scrutinio/riapri — riapertura dello scrutinio chiuso (S1,
 * spec 2026-09-24 «sei interventi»).
 *
 * Il finto qui sotto REGISTRA ogni catena PostgREST (tabella, operazione, filtri,
 * payload) e ogni chiamata allo Storage, e risponde da una coda per
 * `tabella:operazione`. I test non guardano lo status e basta: guardano QUALI
 * scritture partono, con QUALI filtri e in QUALE ordine — ritiro della
 * pubblicazione, cancellazione dei PDF (file + righe), riapertura — e che
 * `pagella_ricezioni` non venga mai toccata.
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
    storage: [] as Array<{ bucket: string; op: 'list' | 'remove'; arg: unknown }>,
    listEsito: { data: [], error: null } as Esito,
    removeEsito: null as Esito | null,
  }
  function prendi(c: Chiamata): Esito {
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
            list: (cartella: string, opts: unknown) => {
              state.storage.push({ bucket, op: 'list', arg: { cartella, opts } })
              return Promise.resolve(state.listEsito)
            },
            remove: (percorsi: string[]) => {
              state.storage.push({ bucket, op: 'remove', arg: percorsi })
              return Promise.resolve(
                state.removeEsito ?? { data: percorsi.map((name) => ({ name })), error: null },
              )
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

const authMock = vi.hoisted(() => ({ requireStaff: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: authMock.requireStaff }))

const scopeMock = vi.hoisted(() => ({ assertSezioneInScope: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: scopeMock.assertSezioneInScope }))

const auditMock = vi.hoisted(() => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: auditMock.logScrittura }))

const logMock = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: logMock.logEvento,
  logErrore: logMock.logErrore,
}))

import { POST } from '@/app/api/primaria/scrutinio/riapri/route'

// Uuid finti, scritti a mano: nessuno esiste in produzione.
const SCRUTINIO = 'a1000000-0000-4000-8000-000000000001'
const SEZIONE = 'b1000000-0000-4000-8000-000000000002'
const SCUOLA = 'c1000000-0000-4000-8000-000000000003'
const ALUNNO_1 = 'd1000000-0000-4000-8000-000000000004'
const ALUNNO_2 = 'd1000000-0000-4000-8000-000000000005'
const ALUNNO_ORFANO = 'd1000000-0000-4000-8000-000000000006'
const UTENTE = 'e1000000-0000-4000-8000-000000000007'

const GUASTO = { message: 'canceling statement due to statement timeout', code: '57014' }

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/primaria/scrutinio/riapri', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function scrutinioLetto(extra: Record<string, unknown> = {}): Esito {
  return {
    data: {
      id: SCRUTINIO,
      section_id: SEZIONE,
      stato: 'chiuso',
      pubblicato: true,
      chiuso_il: '2026-06-10T10:00:00Z',
      pubblicato_il: '2026-06-11T10:00:00Z',
      sections: { scuola_id: SCUOLA },
      ...extra,
    },
    error: null,
  }
}

const righePagelle: Esito = {
  data: [
    { id: 'f1000000-0000-4000-8000-000000000001', alunno_id: ALUNNO_1, file_url: `${SCRUTINIO}/${ALUNNO_1}.pdf` },
    { id: 'f1000000-0000-4000-8000-000000000002', alunno_id: ALUNNO_2, file_url: `${SCRUTINIO}/${ALUNNO_2}.pdf` },
    // Un file_url fuori dalla cartella dello scrutinio NON si cancella da qui.
    { id: 'f1000000-0000-4000-8000-000000000003', alunno_id: ALUNNO_ORFANO, file_url: `altro/${ALUNNO_ORFANO}.pdf` },
  ],
  error: null,
}

function preparaPercorsoFelice(scrutinio: Esito = scrutinioLetto()) {
  h.state.code = {
    'scrutini:select': [scrutinio],
    'scrutini:update': [
      { data: null, error: null }, // ritiro pubblicazione (senza .select)
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p', stato: 'aperto', pubblicato: false }, error: null },
    ],
    'notifiche:delete': [{ data: [{ id: 'n1' }, { id: 'n2' }], error: null }],
    'pagelle:select': [righePagelle],
    'pagelle:delete': [{ data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null }],
  }
  // Nella cartella c'è anche un PDF SENZA riga (upsert fallito a suo tempo).
  h.state.listEsito = {
    data: [{ name: `${ALUNNO_1}.pdf` }, { name: `${ALUNNO_ORFANO}.pdf` }],
    error: null,
  }
}

const scritture = () => h.state.chiamate.filter((c) => c.op !== 'select')
const filtro = (c: Chiamata, m: string, col: string) => c.filtri.find(([mm, cc]) => mm === m && cc === col)?.[2]

beforeEach(() => {
  vi.clearAllMocks()
  h.state.code = {}
  h.state.chiamate = []
  h.state.storage = []
  h.state.listEsito = { data: [], error: null }
  h.state.removeEsito = null
  authMock.requireStaff.mockResolvedValue({
    user: { id: UTENTE, role: 'segreteria', scuola_id: SCUOLA },
    response: null,
  })
  scopeMock.assertSezioneInScope.mockResolvedValue(null)
  auditMock.logScrittura.mockResolvedValue(undefined)
})

describe('POST /api/primaria/scrutinio/riapri — chi può', () => {
  it('ammette SOLO Segreteria e Direzione (admin, coordinator, segreteria)', async () => {
    authMock.requireStaff.mockResolvedValue({
      user: null,
      response: NextResponse.json({ error: 'no' }, { status: 403 }),
    })
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(403)
    const ruoli = authMock.requireStaff.mock.calls[0][1] as string[]
    expect([...ruoli].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
    expect(h.state.chiamate).toEqual([])
  })

  it('fuori dal plesso: il rifiuto di sede esce e NON parte nessuna scrittura', async () => {
    preparaPercorsoFelice()
    scopeMock.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'x' }, { status: 403 }))
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(403)
    expect(scopeMock.assertSezioneInScope.mock.calls[0][2]).toBe(SEZIONE)
    expect(scritture()).toEqual([])
    expect(h.state.storage).toEqual([])
  })

  it('fuori dal plesso con scrutinio APERTO: 403, non 409 (lo stato di un altro plesso non trapela)', async () => {
    preparaPercorsoFelice(scrutinioLetto({ stato: 'aperto', pubblicato: false }))
    scopeMock.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'x' }, { status: 403 }))
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).not.toBe('SCRUTINIO_RIAPERTURA_NON_CHIUSO')
    expect(scopeMock.assertSezioneInScope).toHaveBeenCalledTimes(1)
    expect(scritture()).toEqual([])
    expect(h.state.storage).toEqual([])
  })

  it('corpo non valido → 400 senza toccare il database', async () => {
    const res = await POST(req({ scrutinioId: 'non-un-uuid' }))
    expect(res.status).toBe(400)
    expect(h.state.chiamate).toEqual([])
  })
})

describe('POST /api/primaria/scrutinio/riapri — il percorso completo', () => {
  it('ritira la pubblicazione, cancella file e righe delle pagelle, riapre, e non tocca pagella_ricezioni', async () => {
    preparaPercorsoFelice()
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, pagelleEliminate: 3, avvisiRitirati: 2 })

    const w = scritture()
    expect(w.map((c) => `${c.table}:${c.op}`)).toEqual([
      'scrutini:update', // 1. ritiro pubblicazione
      'notifiche:delete', //    avviso «Pagella disponibile» in coda
      'pagelle:delete', // 2. righe delle pagelle (dopo i file)
      'scrutini:update', // 3. riapertura
    ])

    // 1. Ritiro: solo la pubblicazione, a scrutinio ancora chiuso.
    expect(w[0].payload).toEqual({ pubblicato: false, pubblicato_da: null, pubblicato_il: null })
    expect(filtro(w[0], 'eq', 'id')).toBe(SCRUTINIO)
    expect(filtro(w[0], 'eq', 'stato')).toBe('chiuso')

    // Avviso: solo quello della pagella DI QUESTO scrutinio, e solo se non è partito.
    expect(filtro(w[1], 'eq', 'tipo')).toBe('pagella')
    expect(filtro(w[1], 'eq', 'entita_tipo')).toBe('scrutinio')
    expect(filtro(w[1], 'eq', 'entita_id')).toBe(SCRUTINIO)
    expect(filtro(w[1], 'is', 'push_inviata_il')).toBeNull()
    expect(w[1].filtri.some(([m, col]) => m === 'is' && col === 'push_inviata_il')).toBe(true)

    // 2. File: righe + cartella, deduplicati, e MAI fuori dalla cartella.
    const list = h.state.storage.find((s) => s.op === 'list')!
    expect(list.bucket).toBe('pagelle')
    expect((list.arg as { cartella: string }).cartella).toBe(SCRUTINIO)
    const remove = h.state.storage.find((s) => s.op === 'remove')!
    expect(remove.bucket).toBe('pagelle')
    expect([...(remove.arg as string[])].sort()).toEqual(
      [`${SCRUTINIO}/${ALUNNO_1}.pdf`, `${SCRUTINIO}/${ALUNNO_2}.pdf`, `${SCRUTINIO}/${ALUNNO_ORFANO}.pdf`].sort(),
    )
    expect(remove.arg as string[]).not.toContain(`altro/${ALUNNO_ORFANO}.pdf`)
    // Righe: tutte quelle dello scrutinio.
    expect(filtro(w[2], 'eq', 'scrutinio_id')).toBe(SCRUTINIO)

    // 3. Riapertura condizionata allo stato chiuso.
    expect(w[3].payload).toEqual({
      stato: 'aperto',
      chiuso_da: null,
      chiuso_il: null,
      pubblicato: false,
      pubblicato_da: null,
      pubblicato_il: null,
    })
    expect(filtro(w[3], 'eq', 'id')).toBe(SCRUTINIO)
    expect(filtro(w[3], 'eq', 'stato')).toBe('chiuso')

    // Le firme di ricezione sono storico: nessuna operazione su quella tabella.
    expect(h.state.chiamate.some((c) => c.table === 'pagella_ricezioni')).toBe(false)
  })

  it('scrive l’audit con la sede della classe e logga il SUCCESSO (solo uuid e numeri)', async () => {
    preparaPercorsoFelice()
    await POST(req({ scrutinioId: SCRUTINIO }))

    expect(auditMock.logScrittura).toHaveBeenCalledTimes(1)
    const audit = auditMock.logScrittura.mock.calls[0][1]
    expect(audit).toMatchObject({
      entitaTipo: 'scrutinio',
      entitaId: SCRUTINIO,
      azione: 'update',
      scuolaId: SCUOLA,
      sectionId: SEZIONE,
      valorePrima: { stato: 'chiuso', pubblicato: true },
      valoreDopo: { stato: 'aperto', pubblicato: false, pagelle_eliminate: 3, file_eliminati: 3 },
    })
    expect(audit.valorePrima.pagelle).toHaveLength(3)

    const ok = logMock.logEvento.mock.calls.find(
      (c) => c[0] === 'registro' && c[1] === 'info' && c[2]?.esito === 'scrutinio-riaperto',
    )
    expect(ok, 'manca il log di successo della riapertura').toBeTruthy()
    expect(ok![2]).toMatchObject({
      scrutinio_id: SCRUTINIO,
      section_id: SEZIONE,
      scuola_id: SCUOLA,
      era_pubblicato: true,
      pagelle_eliminate: 3,
      file_eliminati: 3,
      avvisi_ritirati: 2,
    })
  })

  it('scrutinio chiuso ma NON pubblicato: niente ritiro della pubblicazione, ma avvisi in coda ritirati, pagelle cancellate e riapertura', async () => {
    preparaPercorsoFelice(scrutinioLetto({ pubblicato: false, pubblicato_il: null }))
    // Con una sola update in coda, la prima è la riapertura.
    h.state.code['scrutini:update'] = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p', stato: 'aperto', pubblicato: false }, error: null },
    ]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect(scritture().map((c) => `${c.table}:${c.op}`)).toEqual([
      'notifiche:delete',
      'pagelle:delete',
      'scrutini:update',
    ])
    expect((scritture()[2].payload as { stato: string }).stato).toBe('aperto')
  })

  it('non pubblicato ma con un avviso «Pagella disponibile» ancora in coda (tentativo precedente a metà, o pubblicazione ritirata a parte): l’avviso si ritira lo stesso', async () => {
    preparaPercorsoFelice(scrutinioLetto({ pubblicato: false, pubblicato_il: null }))
    h.state.code['scrutini:update'] = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p', stato: 'aperto', pubblicato: false }, error: null },
    ]
    h.state.code['notifiche:delete'] = [{ data: [{ id: 'n-in-coda' }], error: null }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect((await res.json()).avvisiRitirati).toBe(1)

    const avvisi = scritture().filter((c) => c.table === 'notifiche')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].op).toBe('delete')
    // I quattro filtri: solo l'avviso della pagella DI QUESTO scrutinio, non ancora partito.
    expect(filtro(avvisi[0], 'eq', 'tipo')).toBe('pagella')
    expect(filtro(avvisi[0], 'eq', 'entita_tipo')).toBe('scrutinio')
    expect(filtro(avvisi[0], 'eq', 'entita_id')).toBe(SCRUTINIO)
    expect(avvisi[0].filtri.some(([m, col, v]) => m === 'is' && col === 'push_inviata_il' && v === null)).toBe(true)
    expect(avvisi[0].filtri).toHaveLength(4)
    // Nessun ritiro della pubblicazione: c'è solo l'update della riapertura.
    expect(scritture().filter((c) => c.table === 'scrutini')).toHaveLength(1)
  })

  it('nessuna pagella generata: nessuna rimozione, ma la riapertura avviene', async () => {
    preparaPercorsoFelice(scrutinioLetto({ pubblicato: false }))
    h.state.code['pagelle:select'] = [{ data: [], error: null }]
    h.state.code['scrutini:update'] = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p', stato: 'aperto', pubblicato: false }, error: null },
    ]
    h.state.listEsito = { data: [], error: null }
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect(h.state.storage.some((s) => s.op === 'remove')).toBe(false)
    expect(scritture().map((c) => `${c.table}:${c.op}`)).toEqual(['notifiche:delete', 'scrutini:update'])
  })
})

describe('POST /api/primaria/scrutinio/riapri — rifiuti e guasti', () => {
  it('scrutinio inesistente → 404 con codice', async () => {
    h.state.code = { 'scrutini:select': [{ data: null, error: null }] }
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_TROVATO')
    expect(scritture()).toEqual([])
  })

  it('scrutinio già aperto → 409 con codice, nessuna scrittura e nessun file toccato', async () => {
    preparaPercorsoFelice(scrutinioLetto({ stato: 'aperto', pubblicato: false }))
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_CHIUSO')
    expect(scritture()).toEqual([])
    expect(h.state.storage).toEqual([])
  })

  it('lettura dello scrutinio fallita → 500 con codice, non 404, e nessuna scrittura', async () => {
    h.state.code = { 'scrutini:select': [{ data: null, error: GUASTO }] }
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_RIUSCITA')
    expect(scritture()).toEqual([])
  })

  it('rimozione dei file fallita → 500: le righe restano e lo scrutinio RESTA CHIUSO (si può ripetere)', async () => {
    preparaPercorsoFelice()
    h.state.removeEsito = { data: null, error: { message: 'storage down', statusCode: '500' } }
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('SCRUTINIO_RIAPERTURA_NON_RIUSCITA')
    expect(JSON.stringify(body)).not.toContain('storage down')
    const w = scritture()
    expect(w.some((c) => c.table === 'pagelle' && c.op === 'delete')).toBe(false)
    expect(w.some((c) => c.table === 'scrutini' && (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    // Il guasto del bucket si logga sotto 'storage', non sotto 'db'.
    const logStorage = logMock.logEvento.mock.calls.find(
      (c) => c[2]?.esito === 'file-pagelle-non-eliminati',
    )
    expect(logStorage, 'manca il log del guasto dello storage').toBeTruthy()
    expect(logStorage![0]).toBe('storage')
    expect(logStorage![1]).toBe('error')
  })

  it('lettura della cartella fallita → 500 prima di cancellare qualunque cosa', async () => {
    preparaPercorsoFelice()
    h.state.listEsito = { data: null, error: { message: 'x' } }
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(h.state.storage.some((s) => s.op === 'remove')).toBe(false)
    expect(scritture().some((c) => c.table === 'pagelle')).toBe(false)
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'storage' && c[1] === 'error' && c[2]?.esito === 'cartella-pagelle-non-letta',
      ),
    ).toBe(true)
  })

  it('cancellazione delle righe fallita → 500 e lo scrutinio resta chiuso', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:delete'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(scritture().some((c) => (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
  })

  it('ritiro dell’avviso fallito: NON blocca la riapertura, ma si logga come errore', async () => {
    preparaPercorsoFelice()
    h.state.code['notifiche:delete'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect((await res.json()).avvisiRitirati).toBe(0)
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'notifica' && c[1] === 'error' && c[2]?.esito === 'avviso-pagella-non-ritirato',
      ),
    ).toBe(true)
  })

  it('ritiro della pubblicazione fallito → 500 e si ferma lì: nessun file, nessuna riga, nessun avviso toccato, scrutinio chiuso', async () => {
    preparaPercorsoFelice() // scrutinio chiuso E pubblicato
    h.state.code['scrutini:update'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_RIUSCITA')
    // «Ritiro PRIMA di tutto»: se non riesce, con lo scrutinio ancora pubblicato
    // non si cancella niente (i genitori vedrebbero una pagella senza file).
    expect(h.state.storage).toEqual([])
    const w = scritture()
    expect(w.map((c) => `${c.table}:${c.op}`)).toEqual(['scrutini:update'])
    expect(w.some((c) => c.table === 'pagelle' && c.op === 'delete')).toBe(false)
    expect(w.some((c) => c.table === 'notifiche' && c.op === 'delete')).toBe(false)
    expect(w.some((c) => (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'pubblicazione-non-ritirata',
      ),
    ).toBe(true)
  })

  it('lettura delle pagelle fallita → 500 prima dello storage: nessun file cancellato, nessuna riga, scrutinio chiuso', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:select'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_RIUSCITA')
    // Se l'errore fosse ignorato, `data: null` diventerebbe `[]`: si cancellerebbero
    // i PDF della cartella lasciando le righe `pagelle` a puntare a file spariti.
    expect(h.state.storage).toEqual([])
    const w = scritture()
    expect(w.some((c) => c.table === 'pagelle' && c.op === 'delete')).toBe(false)
    expect(w.some((c) => (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'pagelle-non-lette',
      ),
    ).toBe(true)
    expect(logMock.logEvento.mock.calls.some((c) => c[2]?.esito === 'scrutinio-riaperto')).toBe(false)
  })

  it('UPDATE finale di riapertura fallito → 500, NON 409 (lo scrutinio è ancora chiuso, non «già aperto»)', async () => {
    preparaPercorsoFelice()
    h.state.code['scrutini:update'] = [{ data: null, error: null }, { data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_RIUSCITA')
    expect(
      logMock.logEvento.mock.calls.some(
        (c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'scrutinio-non-riaperto',
      ),
    ).toBe(true)
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(logMock.logEvento.mock.calls.some((c) => c[2]?.esito === 'scrutinio-riaperto')).toBe(false)
  })

  it('riapertura contesa (nessuna riga aggiornata) → 409 e nessun audit né log di successo', async () => {
    preparaPercorsoFelice()
    h.state.code['scrutini:update'] = [{ data: null, error: null }, { data: null, error: null }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SCRUTINIO_RIAPERTURA_NON_CHIUSO')
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(logMock.logEvento.mock.calls.some((c) => c[2]?.esito === 'scrutinio-riaperto')).toBe(false)
  })
})
