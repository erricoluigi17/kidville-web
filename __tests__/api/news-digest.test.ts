import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// STEP 3 — archivio digest (lista + dettaglio) e generazione manuale.
//
// Invarianti sotto lock:
//  - genitore vede SOLO le edizioni INVIATE delle sedi dei propri figli.
//  - dettaglio di un'edizione fuori sede o non inviata → 404 (per il genitore).
//  - la lista NON espone il campo html (pesante); il dettaglio sì.
//  - /digest/genera: scuola_id NON accessibile → 403; happy path delega a
//    generaEInviaDigest (idempotenza garantita dalla lib, ON CONFLICT).
//
// ⚠️ QUI NON SI MOCKA `@/lib/auth/scope` (2026-07-31). Le due versioni
// precedenti del file lo mockavano, ed erano entrambe cieche:
//  1. `mockResolvedValue({ scuolaId: 'sc-1' })` — un finto resolver che diceva
//     sempre di sì; il 403 lo produceva un tampone scritto a mano dentro la
//     route, oggi rimosso perché il controllo sta nel resolver.
//  2. una `mockImplementation` che RISCRIVEVA la regola del resolver dentro il
//     test. Misurato dal collaudo: rimettendo il ripiego in `scope.ts` (una sede
//     dichiarata e non accessibile viene «dimenticata» invece che negata) questo
//     file restava VERDE mentre altri cinque diventavano rossi.
// Un mock che replica la regola invecchia sempre in una direzione sola: dice di
// sì quando il codice vero direbbe di no. Perciò `resolveScuolaScrittura` e
// `resolveScuoleAttive` qui sono quelli VERI, e il finto Supabase risponde per
// tabella — `utenti_scuole` è il ponte multi-plesso che il resolver legge
// davvero per sapere quali sedi ha l'utente.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  caricaFigliConTarget: vi.fn(),
  generaEInviaDigest: vi.fn(),
  edizioni: [] as Array<Record<string, unknown>>,
  edizioniError: null as unknown,
  edizione: null as Record<string, unknown> | null,
  /** Righe del ponte `utenti_scuole` (solo la Direzione può essere multi-plesso). */
  utentiScuole: [] as string[],
  calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/news/target', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, caricaFigliConTarget: (...a: unknown[]) => h.caricaFigliConTarget(...a) }
})
vi.mock('@/lib/news/digest', () => ({ generaEInviaDigest: (...a: unknown[]) => h.generaEInviaDigest(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
  createClient: async () => ({}),
}))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const rec = (m: string) => (...args: unknown[]) => { h.calls.push({ table, m, args }); return b }
      for (const m of ['select', 'order', 'eq', 'in', 'is', 'not', 'limit']) b[m] = rec(m)
      b.maybeSingle = async () => ({ data: h.edizione, error: null })
      b.single = async () => ({ data: h.edizione, error: null })
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        // Risposta PER TABELLA: `utenti_scuole` è il ponte che legge
        // `scuoleDiUtente` (resolver vero). Rispondergli con le edizioni
        // renderebbe le sedi dell'utente una funzione dell'archivio digest.
        const risposta = table === 'utenti_scuole'
          ? { data: h.utentiScuole.map((scuola_id) => ({ scuola_id })), error: null }
          : { data: h.edizioni, error: h.edizioniError }
        return Promise.resolve(risposta).then(onF, onR)
      }
      return b
    },
  }
}

import { GET as digestGET } from '@/app/api/news/digest/route'
import { GET as digestIdGET } from '@/app/api/news/digest/[id]/route'
import { POST as generaPOST } from '@/app/api/news/digest/genera/route'

const ED_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
/** Finte `cookies` della richiesta: il SedeSelector deposita `sedi_attive`. */
const cookies = (sediAttive?: string) => ({
  get: (n: string) => (n === 'sedi_attive' && sediAttive ? { value: sediAttive } : undefined),
})
const getReq = (sediAttive?: string) => ({ url: 'http://test/api/news/digest', method: 'GET', headers: new Headers(), cookies: cookies(sediAttive) }) as never
const idReq = () => ({ url: `http://test/api/news/digest/${ED_ID}`, method: 'GET', headers: new Headers(), cookies: cookies() }) as never
const ctx = { params: Promise.resolve({ id: ED_ID }) }
const postReq = (body: unknown) => ({ url: 'http://test/api/news/digest/genera', method: 'POST', headers: new Headers(), json: async () => body, cookies: cookies() }) as never

/** Le generazioni davvero partite, con la loro sede: l'EFFETTO della POST. */
const generazioni = () =>
  h.generaEInviaDigest.mock.calls.map((c) => c[1] as { scuolaId?: string })

/** Le sedi su cui la lista ha davvero filtrato (`.in('scuola_id', …)`). */
const sediInterrogate = () => {
  const c = h.calls.find((x) => x.table === 'news_digest_edizioni' && x.m === 'in')
  expect(c, 'la lista non ha filtrato per sede').toBeTruthy()
  expect(c!.args[0]).toBe('scuola_id')
  return [...(c!.args[1] as string[])].sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.edizioni = []
  h.edizioniError = null
  h.edizione = null
  h.utentiScuole = []
  h.calls = []
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.caricaFigliConTarget.mockResolvedValue([{ scuola_id: SEDE_A, classe_sezione: '1A', grado: 'infanzia' }])
  h.generaEInviaDigest.mockResolvedValue({ edizioni: [] })
})

describe('GET /api/news/digest — lista', () => {
  it('401 quando anonimo', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await digestGET(getReq())
    expect(res.status).toBe(401)
  })

  it('genitore: filtra alle sole INVIATE (not inviata_il is null)', async () => {
    h.edizioni = [{ id: ED_ID, scuola_id: SEDE_A, anno: 2026, mese: 6, titolo: 'x', inviata_il: '2026-07-01', destinatari_count: 10, errori_count: 0 }]
    const res = await digestGET(getReq())
    expect(res.status).toBe(200)
    const notCall = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'not')
    expect(notCall).toBeTruthy()
    expect(notCall!.args).toEqual(['inviata_il', 'is', null])
  })

  it('staff: NON filtra sulle inviate (vede anche le generate non inviate)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    await digestGET(getReq())
    const notCall = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'not')
    expect(notCall).toBeUndefined()
  })

  it('genitore senza figli → lista vuota (fail-closed)', async () => {
    h.caricaFigliConTarget.mockResolvedValue([])
    const res = await digestGET(getReq())
    const j = (await res.json()) as { edizioni: unknown[] }
    expect(j.edizioni).toEqual([])
    expect(h.calls.some((c) => c.table === 'news_digest_edizioni')).toBe(false)
  })

  it('la lista NON seleziona il campo html', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    await digestGET(getReq())
    const sel = h.calls.find((c) => c.table === 'news_digest_edizioni' && c.m === 'select')
    expect(sel).toBeTruthy()
    expect(String(sel!.args[0])).not.toContain('html')
  })

  // C6 (lock zod-coverage gruppo news): la GET valida il query param opzionale
  // `userId` (uuid). Un valore malformato → 400, senza toccare il DB.
  it('400 su userId malformato in query (validazione zod)', async () => {
    const badReq = { url: 'http://test/api/news/digest?userId=non-uuid', method: 'GET', headers: new Headers(), cookies: cookies() } as never
    const res = await digestGET(badReq)
    expect(res.status).toBe(400)
    expect(h.calls.some((c) => c.table === 'news_digest_edizioni')).toBe(false)
  })

  it('userId uuid valido in query → 200', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    const okReq = { url: `http://test/api/news/digest?userId=${ED_ID}`, method: 'GET', headers: new Headers(), cookies: cookies() } as never
    const res = await digestGET(okReq)
    expect(res.status).toBe(200)
  })

  // Le due prove che seguono passano per `resolveScuoleAttive` VERO: le sedi non
  // arrivano da un mock, si leggono dal ponte `utenti_scuole` e dal cookie del
  // SedeSelector, esattamente come in produzione.
  it('Direzione multi-plesso: la lista interroga TUTTE le sedi del ponte, non la sola primaria', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
    h.utentiScuole = [SEDE_C]
    await digestGET(getReq())
    expect(sediInterrogate()).toEqual([SEDE_A, SEDE_C].sort())
  })

  it('con una sede selezionata nel SedeSelector si interroga SOLO quella', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
    h.utentiScuole = [SEDE_C]
    await digestGET(getReq(SEDE_C))
    expect(sediInterrogate()).toEqual([SEDE_C])
  })
})

describe('GET /api/news/digest/[id] — dettaglio', () => {
  it('genitore: edizione NON inviata → 404', async () => {
    h.edizione = { id: ED_ID, scuola_id: SEDE_A, anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: null }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('genitore: edizione di sede non dei figli → 404', async () => {
    h.edizione = { id: ED_ID, scuola_id: SEDE_B, anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: '2026-07-01' }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('genitore in sede + inviata → 200 con html', async () => {
    h.edizione = { id: ED_ID, scuola_id: SEDE_A, anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: '2026-07-01' }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { edizione: { html: string } }
    expect(j.edizione.html).toBe('<b>x</b>')
  })

  it('404 se l\'edizione non esiste', async () => {
    h.edizione = null
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('staff: edizione di una sede NON sua → 404 (scope vero, non mockato)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    h.edizione = { id: ED_ID, scuola_id: SEDE_B, anno: 2026, mese: 6, html: '<b>x</b>', inviata_il: '2026-07-01' }
    const res = await digestIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/news/digest/genera', () => {
  it('scuola_id NON accessibile → 403, e generaEInviaDigest NON chiamata', async () => {
    // La segreteria ha una sede sola. Il 403 arriva da `resolveScuolaScrittura`
    // (il tampone locale della route è stato rimosso il 2026-07-31): con il
    // ripiego rimesso nel resolver, la sede dichiarata verrebbe dimenticata e la
    // funzione ricadrebbe sull'«unica sede accessibile» — cioè 200, e il digest
    // mensile spedito alle famiglie del plesso sbagliato.
    const res = await generaPOST(postReq({ anno: 2026, mese: 2, scuola_id: SEDE_B }))
    // PRIMA l'EFFETTO, poi lo status: se un giorno il ripiego tornasse, questa
    // riga dice a quale sede sarebbe partito il digest — lo status direbbe solo
    // «200».
    expect(generazioni()).toEqual([])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' })
  })

  it('Direzione multi-plesso: sede dichiarata fuori dai propri plessi → 403, nessuna generazione', async () => {
    // Ada ha Alfa (primaria) e Gamma (ponte); chiede il digest di Beta.
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
    h.utentiScuole = [SEDE_C]
    const res = await generaPOST(postReq({ anno: 2026, mese: 2, scuola_id: SEDE_B }))
    expect(generazioni()).toEqual([])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' })
  })

  it('CONTROLLO POSITIVO: la stessa Direzione sulla sede del ponte → 200 e digest su QUELLA sede', async () => {
    // Senza questo, i due 403 qui sopra sarebbero verdi anche su un resolver che
    // nega tutto.
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
    h.utentiScuole = [SEDE_C]
    const res = await generaPOST(postReq({ anno: 2026, mese: 2, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(h.generaEInviaDigest).toHaveBeenCalledWith(expect.anything(), { anno: 2026, mese: 2, scuolaId: SEDE_C })
  })

  it('happy path: delega a generaEInviaDigest e ritorna le edizioni', async () => {
    h.generaEInviaDigest.mockResolvedValue({ edizioni: [{ scuola_id: SEDE_A, generata: true, inviata: true, destinatari_count: 3, errori_count: 0 }] })
    const res = await generaPOST(postReq({ anno: 2026, mese: 2 }))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { edizioni: Array<{ scuola_id: string }> }
    expect(j.edizioni).toHaveLength(1)
    expect(h.generaEInviaDigest).toHaveBeenCalledWith(expect.anything(), { anno: 2026, mese: 2, scuolaId: SEDE_A })
  })

  it('body malformato (mese 13) → 400', async () => {
    const res = await generaPOST(postReq({ anno: 2026, mese: 13 }))
    expect(res.status).toBe(400)
    expect(h.generaEInviaDigest).not.toHaveBeenCalled()
  })
})
