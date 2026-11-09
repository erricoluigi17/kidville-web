import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * COMPITO 4.6.4 · la route delle rette e dei mesi del listino di un anno. Solo uuid finti, nessun dato di persone.
 * Il cuore (stati, importo, specchio) è del database e si prova in `__tests__/db/anno-listino-rette.test.ts`:
 * qui si prova chi può chiedere, cosa si valida, cosa arriva alla funzione SQL e cosa si logga.
 */

const SEDE_A = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '33333333-3333-4333-8333-333333333333'
const ANNO_A = '44444444-4444-4444-8444-444444444441'
const ANNO_B = '44444444-4444-4444-8444-444444444442'
const ANNO_ID = '55555555-5555-4555-8555-555555555551'
const UTENTE = '11111111-1111-4111-8111-111111111111'
const CAT = '66666666-6666-4666-8666-666666666661'

type Esito = { data: unknown; error: unknown }
const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  righe: {} as Record<string, { id: string; scuola_id: string; anno_id?: string }>,
  tabelle: {} as Record<string, unknown[]>,
  errori: {} as Record<string, { code?: string; message?: string }>,
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esiti: {} as Record<string, Esito>,
  log: [] as Array<{ fn: 'evento' | 'errore' | 'ok'; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, allowed: readonly string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!h.user) return { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) }
    if (!allowed.includes(h.user.role)) return { user: null, response: new Response(JSON.stringify({ error: 'vietato' }), { status: 403 }) }
    return { user: h.user, response: null }
  },
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => (u.scuola_id ? [u.scuola_id] : []),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      let id = ''
      for (const m of ['select', 'order', 'in']) b[m] = () => b
      b.eq = (c: string, v: string) => {
        if (c === 'id') id = v
        return b
      }
      // `anni_sede` si legge per id (il gate e l'anno); le altre tabelle sono elenchi
      b.maybeSingle = async () => ({ data: h.righe[id] ?? null, error: h.errori[tabella] ?? null })
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(h.errori[tabella] ? { data: null, error: h.errori[tabella] } : { data: h.tabelle[tabella] ?? [], error: null }).then(ok)
      return b
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      h.rpc.push({ nome, args })
      return h.esiti[nome] ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    },
  }),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...args: unknown[]) => void h.log.push({ fn: 'evento', args }),
  logErrore: (...args: unknown[]) => void h.log.push({ fn: 'errore', args }),
  logOk: (...args: unknown[]) => void h.log.push({ fn: 'ok', args }),
}))

import { GET, PUT } from '@/app/api/admin/anni/[annoSedeId]/rette/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const url = (id = ANNO_A) => `http://localhost/api/admin/anni/${id}/rette`
const leggi = (id = ANNO_A) => GET(new Request(url(id)) as never, contesto(id) as never)
const scrivi = (corpo: unknown, id = ANNO_A) =>
  PUT(
    new Request(url(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as never,
    contesto(id) as never,
  )

const ok = (data: unknown): Esito => ({ data, error: null })
const rifiuto = (message: string): Esito => ({ data: null, error: { code: 'P0001', message, details: JSON.stringify({}) } })
const eventi = (tipo: string) =>
  h.log.filter((l) => l.fn === 'evento').map((l) => l.args[2] as Record<string, unknown>).filter((c) => c?.tipo === tipo)

const CORPO = { voce: 'retta', fascia: null, importo: 312.5, mesi: [9, 10, 11] }

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.righe = {
    [ANNO_A]: { id: ANNO_A, scuola_id: SEDE_A, anno_id: ANNO_ID },
    [ANNO_B]: { id: ANNO_B, scuola_id: SEDE_B, anno_id: ANNO_ID },
  }
  h.tabelle = {}
  h.errori = {}
  h.rpc = []
  h.esiti = {
    anno_listino_retta_imposta: ok({ cambiato: true, voce: 'retta', fascia: null, importo: 312.5 }),
    listino_mesi: ok([9, 10, 11, 12, 1, 2, 3, 4, 5, 6]),
  }
  h.log = []
})

describe('gate e perimetro', () => {
  it.each([
    ['GET', () => leggi()],
    ['PUT', () => scrivi(CORPO)],
  ])('%s: senza identità 401, docente e genitore 403, sede altrui 403; il database non si tocca', async (_n, chiama) => {
    h.user = null
    expect((await chiama()).status).toBe(401)
    for (const role of ['docente', 'genitore']) {
      h.user = { id: UTENTE, role, scuola_id: SEDE_A }
      expect((await chiama()).status, role).toBe(403)
    }
    h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_B }
    expect((await chiama()).status).toBe(403)
    expect(h.rpc).toEqual([])
  })

  it('un id che non è un uuid è un 400', async () => {
    expect((await leggi('non-un-uuid')).status).toBe(400)
    expect((await scrivi(CORPO, 'non-un-uuid')).status).toBe(400)
    expect(h.rpc).toEqual([])
  })
})

describe('PUT', () => {
  it.each([
    ['importo come stringa', { ...CORPO, importo: '312.5' }],
    ['campo in più', { ...CORPO, sconto: 10 }],
    ['voce che non è retta né servizio', { ...CORPO, voce: 'quota_nuova' }],
    ['fascia sconosciuta', { ...CORPO, fascia: 'liceo' }],
    ['mese fuori da 1..12', { ...CORPO, mesi: [9, 13] }],
    ['fascia mancante', { voce: 'retta', importo: 100 }],
    ['categoria su una retta (nascerebbero due righe senza fascia)', { voce: 'retta', fascia: null, importo: 100, categoria_id: CAT }],
    ['togliere la riga e dare dei mesi insieme', { voce: 'retta', fascia: null, importo: null, mesi: [9, 10] }],
  ])('%s → 400, e la funzione SQL non parte', async (_n, corpo) => {
    expect((await scrivi(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('passa alla funzione SQL i sei argomenti, con NULL dove il corpo non dice', async () => {
    const r = await scrivi({ voce: 'servizio', fascia: 'infanzia', importo: 80, categoria_id: CAT })
    expect(r.status).toBe(200)
    expect(h.rpc).toEqual([
      {
        nome: 'anno_listino_retta_imposta',
        args: { p_anno_sede: ANNO_A, p_voce: 'servizio', p_fascia: 'infanzia', p_categoria: CAT, p_importo: 80, p_mesi: null },
      },
    ])
    await scrivi(CORPO)
    expect(h.rpc[1].args).toMatchObject({ p_fascia: null, p_categoria: null, p_importo: 312.5, p_mesi: [9, 10, 11] })
  })

  it('il successo si logga solo se è cambiato qualcosa, e senza importo né mesi', async () => {
    await scrivi(CORPO)
    const ev = eventi('anno-retta-impostata')
    expect(ev).toEqual([{ tipo: 'anno-retta-impostata', anno_sede_id: ANNO_A, utente: UTENTE, entita_tipo: 'retta', rimossa: false }])
    expect(JSON.stringify(ev)).not.toContain('312')
    h.log = []
    h.esiti.anno_listino_retta_imposta = ok({ cambiato: false })
    await scrivi(CORPO)
    expect(eventi('anno-retta-impostata')).toEqual([])
  })

  it('importo null toglie la riga e lo dice nel log', async () => {
    await scrivi({ voce: 'retta', fascia: 'nido_1', importo: null })
    expect(eventi('anno-retta-impostata')[0]).toMatchObject({ rimossa: true })
  })

  it.each([
    ['ANNO_NON_MODIFICABILE', 409],
    ['IMPORTO_NON_VALIDO', 422],
    ['ANNO_NON_TROVATO', 404],
    ['PARAMETRO_MANCANTE', 400],
  ])('il rifiuto %s del database diventa %i col suo codice', async (codice, stato) => {
    h.esiti.anno_listino_retta_imposta = rifiuto(codice)
    const r = await scrivi(CORPO)
    expect(r.status).toBe(stato)
    expect((await r.json()).codice).toBe(codice)
    expect(eventi('anno-retta-impostata')).toEqual([])
  })

  it('schema indietro (funzione assente) → 503 e non 500', async () => {
    delete h.esiti.anno_listino_retta_imposta
    const r = await scrivi(CORPO)
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
  })
})

describe('GET', () => {
  it('porta le righe, i mesi che valgono e le fasce in uso (senza doppioni, in ordine)', async () => {
    h.tabelle.listino_voci = [
      { voce: 'retta', fascia: null, payment_category_id: CAT, importo: 250, mesi: null },
      { voce: 'retta', fascia: 'infanzia', payment_category_id: CAT, importo: 280, mesi: null },
    ]
    h.tabelle.sections = [{ fascia: 'nido_1' }, { fascia: 'infanzia' }, { fascia: 'infanzia' }, { fascia: null }]
    const r = await leggi()
    expect(r.status).toBe(200)
    const { data } = await r.json()
    expect(data.rette).toHaveLength(2)
    expect(data.fasce_in_uso).toEqual(['infanzia', 'nido_1'])
    expect(data.mesi_effettivi.retta).toEqual([9, 10, 11, 12, 1, 2, 3, 4, 5, 6])
    expect(h.rpc.map((x) => [x.nome, x.args.p_voce])).toEqual([['listino_mesi', 'retta'], ['listino_mesi', 'servizio']])
  })

  it('senza sezioni con fascia: fasce_in_uso è vuoto (la schermata lo dice)', async () => {
    h.tabelle.sections = [{ fascia: null }]
    const { data } = await (await leggi()).json()
    expect(data.fasce_in_uso).toEqual([])
  })

  it('schema indietro sui mesi (funzione assente) → 503', async () => {
    delete h.esiti.listino_mesi
    expect((await leggi()).status).toBe(503)
  })

  it('un guasto vero di lettura → 500 con il codice, non un elenco vuoto', async () => {
    h.errori.listino_voci = { code: '57014', message: 'timeout' }
    const r = await leggi()
    expect(r.status).toBe(500)
    expect((await r.json()).codice).toBe('LETTURA_FALLITA')
  })
})
