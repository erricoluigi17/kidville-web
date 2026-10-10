import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `POST`/`PATCH /api/primaria/scrutinio` — il controllo di versione (fase 5
 * robustezza, D5-B). La decisione sta nelle funzioni SQL `salva_*_scrutinio`
 * (provate su PGlite in `__tests__/lib/scrutinio-controllo-versione-sql.test.ts`);
 * qui si prova che la route passi la versione così com'è arrivata — assente ≠
 * null — e traduca ogni esito in una risposta con il suo codice, senza scrivere
 * audit né notifiche quando non si è scritto niente.
 */

const h = vi.hoisted(() => {
  const state = {
    scrutinio: { data: null as unknown, error: null as unknown },
    materie: { data: [] as unknown, error: null as unknown },
    mie: { data: [] as unknown, error: null as unknown },
    rpc: { data: null as unknown, error: null as unknown },
    chiamate: [] as Array<{ fn: string; args: { p_scrutinio_id: string; p_righe: Array<Record<string, unknown>> } }>,
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order']) qb[m] = () => qb
        const esito = () =>
          table === 'scrutini' ? state.scrutinio
            : table === 'materie' ? state.materie
              : table === 'utenti_sezioni_materie' ? state.mie
                : { data: null, error: null }
        qb.maybeSingle = () => Promise.resolve(esito())
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(esito()).then(res, rej)
        return qb
      },
      rpc(fn: string, args: { p_scrutinio_id: string; p_righe: Array<Record<string, unknown>> }) {
        state.chiamate.push({ fn, args })
        return Promise.resolve(state.rpc)
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn(async () => h.makeClient()) }))
const authMock = vi.hoisted(() => ({ requireDocente: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: authMock.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
}))
const audit = vi.hoisted(() => ({ logScrittura: vi.fn(), notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: audit.logScrittura }))
vi.mock('@/lib/audit/valutatore', () => ({ titolareDiMateria: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: audit.notificaTitolariScrittura }))
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<object>()), logEvento: log.logEvento, logErrore: log.logErrore }))

import { POST, PATCH } from '@/app/api/primaria/scrutinio/route'

// Uuid finti: nessuno esiste in produzione.
const SCRUTINIO = 'a0000000-0000-4000-8000-000000000001'
const SEZIONE = 'b0000000-0000-4000-8000-000000000002'
const ALUNNO = 'c0000000-0000-4000-8000-000000000003'
const MATERIA = 'd0000000-0000-4000-8000-000000000004'
const DOCENTE = 'e0000000-0000-4000-8000-000000000005'
const VERSIONE = '2026-10-10T08:12:33.123456+00:00'

function req(body: unknown, metodo: 'POST' | 'PATCH' = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/primaria/scrutinio', {
    method: metodo,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
const giudizio = (extra: Record<string, unknown> = {}) => ({
  scrutinioId: SCRUTINIO,
  giudizi: [{ alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'Buono', ...extra }],
})
const eventi = (esito: string) => log.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.scrutinio = { data: { id: SCRUTINIO, stato: 'aperto', section_id: SEZIONE }, error: null }
  h.state.materie = { data: [{ id: MATERIA }], error: null }
  h.state.mie = { data: [{ materia_id: MATERIA }], error: null }
  h.state.rpc = { data: { esito: 'ok', righe: [{ alunno_id: ALUNNO, materia_id: MATERIA, updated_at: VERSIONE }] }, error: null }
  h.state.chiamate = []
  authMock.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: 'sc-1' }, response: null })
})

describe('POST — la versione arriva alla funzione così come l’ha mandata il client', () => {
  it('versione presente → passata; esito ok → 200 con le righe (e le loro versioni nuove), audit e log di successo', async () => {
    const res = await POST(req(giudizio({ versione: VERSIONE })))
    expect(res.status).toBe(200)
    expect(h.state.chiamate).toHaveLength(1)
    expect(h.state.chiamate[0].fn).toBe('salva_giudizi_scrutinio')
    expect(h.state.chiamate[0].args.p_scrutinio_id).toBe(SCRUTINIO)
    expect(h.state.chiamate[0].args.p_righe).toEqual([
      { alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: 'Buono', proposto_da: DOCENTE, versione: VERSIONE },
    ])
    expect((await res.json()).data[0].updated_at).toBe(VERSIONE)
    expect(audit.logScrittura).toHaveBeenCalledTimes(1)
    expect(eventi('salvato')).toHaveLength(1)
  })

  it('versione null («la riga non c’era») resta null, non sparisce', async () => {
    await POST(req(giudizio({ versione: null })))
    expect(h.state.chiamate[0].args.p_righe[0]).toHaveProperty('versione', null)
    expect(eventi('versione_assente')).toHaveLength(0)
  })

  it('versione assente (pagina aperta prima del rilascio) → nessuna chiave, e un warn che lo conta', async () => {
    await POST(req(giudizio()))
    expect(h.state.chiamate[0].args.p_righe[0]).not.toHaveProperty('versione')
    expect(eventi('versione_assente')).toHaveLength(1)
    expect(eventi('versione_assente')[0][1]).toBe('warn')
  })
})

describe('gli esiti della funzione diventano risposte con il loro codice', () => {
  it('🔴 conflitto → 409 SCRUTINIO_CONFLITTO con i soli uuid, niente audit né notifiche', async () => {
    h.state.rpc = { data: { esito: 'conflitto', conflitti: [{ alunno_id: ALUNNO, materia_id: MATERIA, versione: VERSIONE }] }, error: null }
    const res = await POST(req(giudizio({ versione: '2026-10-10T08:00:00+00:00' })))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRUTINIO_CONFLITTO')
    expect(corpo.conflitti).toEqual([{ alunno_id: ALUNNO, materia_id: MATERIA, versione: VERSIONE }])
    expect(audit.logScrittura).not.toHaveBeenCalled()
    expect(audit.notificaTitolariScrittura).not.toHaveBeenCalled()
    expect(eventi('conflitto_versione')).toHaveLength(1)
  })

  it('chiuso sotto il blocco → 423 SCRUTINIO_CHIUSO; non trovato → 404 SCRUTINIO_NON_TROVATO', async () => {
    h.state.rpc = { data: { esito: 'chiuso' }, error: null }
    const chiuso = await POST(req(giudizio({ versione: null })))
    expect(chiuso.status).toBe(423)
    expect(await chiuso.json()).toMatchObject({ codice: 'SCRUTINIO_CHIUSO', locked: true })

    h.state.rpc = { data: { esito: 'non_trovato' }, error: null }
    const assente = await POST(req(giudizio({ versione: null })))
    expect(assente.status).toBe(404)
    expect((await assente.json()).codice).toBe('SCRUTINIO_NON_TROVATO')
  })

  it('funzione assente (DB non migrato, PGRST202) → 503 senza scrivere, log error', async () => {
    h.state.rpc = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    const res = await POST(req(giudizio({ versione: null })))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SCRUTINIO_SALVATAGGIO_NON_DISPONIBILE')
    expect(eventi('funzione_assente')[0][1]).toBe('error')
    expect(audit.logScrittura).not.toHaveBeenCalled()
  })

  it('versione malformata (22007) → 400 SCRUTINIO_DATI_NON_VALIDI', async () => {
    h.state.rpc = { data: null, error: { code: '22007', message: 'invalid input syntax for type timestamp with time zone' } }
    const res = await POST(req(giudizio({ versione: 'ieri' })))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SCRUTINIO_DATI_NON_VALIDI')
  })

  it('ogni altro guasto → 500 senza il `message` di PostgREST', async () => {
    h.state.rpc = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await POST(req(giudizio({ versione: null })))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('statement')
  })
})

describe('PATCH — comportamento, stesso controllo', () => {
  it('righe con la versione → salva_comportamento_scrutinio; conflitto → 409', async () => {
    h.state.rpc = { data: { esito: 'conflitto', conflitti: [{ alunno_id: ALUNNO, versione: VERSIONE }] }, error: null }
    const res = await PATCH(req({ scrutinioId: SCRUTINIO, comportamento: [{ alunnoId: ALUNNO, giudizioTesto: 'Corretto', versione: VERSIONE }] }, 'PATCH'))
    expect(h.state.chiamate[0].fn).toBe('salva_comportamento_scrutinio')
    expect(h.state.chiamate[0].args.p_righe).toEqual([
      { alunno_id: ALUNNO, giudizio_testo: 'Corretto', scala_valore: null, giudizio_globale: null, versione: VERSIONE },
    ])
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SCRUTINIO_CONFLITTO')
  })
})
