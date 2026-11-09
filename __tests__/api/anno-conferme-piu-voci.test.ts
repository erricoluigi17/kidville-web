import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.7.4 · la riga «più voci» sopravvive al ricaricamento, e i due filtri dell'incrocio moduli/quota.
 *   GET /api/admin/anni/[annoSedeId]/conferme
 *
 * Il database è finto ma APPLICA i filtri `eq`/`in`/`order`/`range` alle righe date: un filtro tolto dal codice cambia le righe. L'RPC
 * `anno_quota_piu_voci` risponde come PostgREST e registra gli argomenti. Solo uuid finti.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const NUOVO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ATTIVO_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const F = [1, 2, 3, 4].map((n) => `f${n}f${n}f${n}f${n}-f${n}f${n}-4f${n}f-8f${n}f-f${n}f${n}f${n}f${n}f${n}f${n}`)
const N = [1, 2, 3, 4].map((n) => `9${n}9${n}9${n}9${n}-9${n}9${n}-49${n}9-89${n}9-9${n}9${n}9${n}9${n}9${n}9${n}`)
const AL = [1, 2, 3, 4].map((n) => `a${n}a${n}a${n}a${n}-a${n}a${n}-4a${n}a-8a${n}a-a${n}a${n}a${n}a${n}a${n}a${n}`)
const PAG = '44444444-4444-4444-8444-444444444444'
const MOD1 = '71717171-7171-4717-8717-717171717171'
const S_INF = '51515151-5151-4515-8515-515151515151'

type Err = { code?: string; message?: string } | null

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  tabelle: {} as Record<string, unknown[]>,
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esiti: {} as Record<string, { data: unknown; error: Err }>,
  log: [] as Array<{ fn: string; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: h.user, response: null }),
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => (u.scuola_id ? [u.scuola_id] : []),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      const cond: Array<(r: Record<string, unknown>) => boolean> = []
      let ordine: string | null = null
      let range: [number, number] | null = null
      b.select = () => b
      b.order = (c: string) => {
        ordine = c
        return b
      }
      b.eq = (c: string, v: unknown) => {
        cond.push((r) => r[c] === v)
        return b
      }
      b.in = (c: string, v: unknown) => {
        cond.push((r) => (v as unknown[]).includes(r[c]))
        return b
      }
      b.range = (da: number, a: number) => {
        range = [da, a]
        return b
      }
      const risolvi = () => {
        let r = ((h.tabelle[tabella] ?? []) as Array<Record<string, unknown>>).filter((x) => cond.every((c) => c(x)))
        if (ordine) r = [...r].sort((a, c) => String(a[ordine as string]).localeCompare(String(c[ordine as string])))
        const totale = r.length
        if (range) r = r.slice(range[0], range[1] + 1)
        return { data: r, error: null, count: totale }
      }
      b.maybeSingle = async () => ({ data: risolvi().data[0] ?? null, error: null })
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(risolvi()).then(ok)
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

import { GET } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'

const leggi = (query = '') =>
  GET(new Request(`http://localhost/api/admin/anni/${NUOVO_A}/conferme${query}`) as never, { params: Promise.resolve({ annoSedeId: NUOVO_A }) } as never)

type Riga = { frequenza_id: string; quota: string; quota_piu_voci: boolean }

/** Quattro bambini che partono; il 1, il 2 e il 3 hanno la frequenza nuova. */
function scenario(nuove: Array<Record<string, unknown>>) {
  const partenza = (i: number) => ({ id: F[i], alunno_id: AL[i], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null })
  h.tabelle.frequenze = [0, 1, 2, 3].map(partenza).concat(nuove as never[])
  h.tabelle.moduli_richiesti = [{ id: MOD1, anno_sede_id: NUOVO_A, lista: 'conferma' }]
  h.tabelle.frequenze_moduli = []
  h.tabelle.sections = [{ id: S_INF, scuola_id: SEDE_A, name: 'Sezione Prova', school_type: 'infanzia', fascia: 'infanzia' }]
  h.tabelle.alunni = AL.map((id, i) => ({ id, scuola_id: SEDE_A, nome: `NomeProva${i}`, cognome: `CognomeProva${i}` }))
}
const nuova = (i: number, extra: Record<string, unknown> = {}) => ({
  id: N[i], alunno_id: AL[i], anno_sede_id: NUOVO_A, tipo: 'conferma', stato: 'in_attesa', section_id: S_INF,
  quota_saldata: false, quota_pagamento_id: null, moduli_completi: false, ...extra,
})

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.tabelle = {
    anni_sede: [
      { id: NUOVO_A, scuola_id: SEDE_A, stato: 'iscrizioni_aperte' },
      { id: ATTIVO_A, scuola_id: SEDE_A, stato: 'corrente' },
    ],
  }
  h.rpc = []
  h.log = []
  h.esiti = { anno_attivo: { data: ATTIVO_A, error: null }, anno_conta_posti: { data: [], error: null } }
})

describe('GET conferme · quota_piu_voci', () => {
  it('la riga porta `quota_piu_voci` dal database, con UNA chiamata che nomina solo le frequenze vive senza voce della pagina', async () => {
    scenario([nuova(0), nuova(1), nuova(2, { quota_pagamento_id: PAG }), nuova(3, { stato: 'ritirato' })])
    h.esiti.anno_quota_piu_voci = { data: [{ frequenza_id: N[0] }], error: null }
    const { data } = await (await leggi()).json()
    const per = new Map((data.righe as Riga[]).map((r) => [r.frequenza_id, r]))
    expect(per.get(F[0])?.quota_piu_voci).toBe(true)
    expect(per.get(F[1])?.quota_piu_voci).toBe(false)
    expect(per.get(F[2])?.quota_piu_voci).toBe(false)
    const chiamate = h.rpc.filter((r) => r.nome === 'anno_quota_piu_voci')
    expect(chiamate).toHaveLength(1)
    expect(chiamate[0].args.p_anno_sede).toBe(NUOVO_A)
    expect([...(chiamate[0].args.p_frequenze as string[])].sort()).toEqual([N[0], N[1]].sort())
  })

  it('nessuna frequenza senza voce nella pagina: l’RPC non parte', async () => {
    scenario([nuova(0, { quota_pagamento_id: PAG })])
    await leggi()
    expect(h.rpc.filter((r) => r.nome === 'anno_quota_piu_voci')).toEqual([])
  })

  it('schema indietro (CI): `quota_piu_voci` falso per tutti, la pagina risponde 200 e lo dice un log a livello info', async () => {
    scenario([nuova(0)])
    h.esiti.anno_quota_piu_voci = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const res = await leggi()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect((data.righe as Riga[]).every((r) => r.quota_piu_voci === false)).toBe(true)
    expect(h.log.some((l) => l.fn === 'evento' && l.args[1] === 'info' && (l.args[2] as { tipo?: string }).tipo === 'conferme-piu-voci-schema-indietro')).toBe(true)
  })

  it('un guasto vero dell’RPC non si inghiotte: 500, mai una pagina che dice «una sola voce»', async () => {
    scenario([nuova(0)])
    h.esiti.anno_quota_piu_voci = { data: null, error: { code: 'XX000', message: 'boom' } }
    expect((await leggi()).status).toBe(500)
  })

  it('nella vista delle nuove la riga porta lo stesso campo', async () => {
    scenario([nuova(0, { tipo: 'nuova' })])
    h.esiti.anno_quota_piu_voci = { data: [{ frequenza_id: N[0] }], error: null }
    const { data } = await (await leggi('?vista=nuove')).json()
    expect((data.righe as Riga[])[0].quota_piu_voci).toBe(true)
  })
})

describe('GET conferme · quota di un ritirato con la voce ancora attaccata', () => {
  it('la vista dice la verità sulla voce (saldata), non «assente»', async () => {
    scenario([nuova(0, { stato: 'ritirato', quota_saldata: true, quota_pagamento_id: PAG })])
    const { data } = await (await leggi()).json()
    const riga = (data.righe as Riga[]).find((r) => r.frequenza_id === F[0])
    expect(riga?.quota).toBe('saldata')
    expect(riga?.quota_piu_voci).toBe(false)
  })
})

describe('GET conferme · filtri dell’incrocio moduli/quota', () => {
  const dueCasi = () =>
    scenario([
      nuova(0, { moduli_completi: true, quota_saldata: false }), // moduli fatti, quota no
      nuova(1, { moduli_completi: false, quota_saldata: true, quota_pagamento_id: PAG }), // quota pagata, moduli no
      nuova(2, { moduli_completi: true, quota_saldata: true, quota_pagamento_id: PAG }), // tutto a posto
    ])

  it('`moduli_senza_quota`: moduli completi e quota non saldata, sul totale', async () => {
    dueCasi()
    const { data } = await (await leggi('?conferma=moduli_senza_quota')).json()
    expect(data.totale).toBe(1)
    expect((data.righe as Riga[]).map((r) => r.frequenza_id)).toEqual([F[0]])
  })

  it('`quota_senza_moduli`: quota saldata e moduli incompleti, sul totale', async () => {
    dueCasi()
    const { data } = await (await leggi('?conferma=quota_senza_moduli')).json()
    expect(data.totale).toBe(1)
    expect((data.righe as Riga[]).map((r) => r.frequenza_id)).toEqual([F[1]])
  })

  it('il totale conta oltre la pagina: limite 1, totale resta quello vero', async () => {
    scenario([nuova(0, { moduli_completi: true }), nuova(1, { moduli_completi: true }), nuova(2, { moduli_completi: true })])
    const { data } = await (await leggi('?conferma=moduli_senza_quota&limite=1')).json()
    expect(data.totale).toBe(3)
    expect(data.righe).toHaveLength(1)
  })

  it('nelle nuove iscrizioni i due filtri valgono; confermato/no/non_risposto restano 400', async () => {
    scenario([nuova(0, { tipo: 'nuova', moduli_completi: true }), nuova(1, { tipo: 'nuova', quota_saldata: true, quota_pagamento_id: PAG })])
    const a = await (await leggi('?vista=nuove&conferma=moduli_senza_quota')).json()
    expect(a.data.righe.map((r: Riga) => r.frequenza_id)).toEqual([N[0]])
    const b = await (await leggi('?vista=nuove&conferma=quota_senza_moduli')).json()
    expect(b.data.righe.map((r: Riga) => r.frequenza_id)).toEqual([N[1]])
    for (const f of ['confermato', 'no', 'non_risposto']) {
      expect((await leggi(`?vista=nuove&conferma=${f}`)).status).toBe(400)
    }
  })
})
