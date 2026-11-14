import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * «Incassa» dalla riga del bambino: la route porta con la riga la voce della quota ancora da pagare (id, importo, già pagato, sconto),
 * quanto basta a riaprire la finestra «Registra incasso» della Contabilità. Alla riga saldata o senza quota la voce non va.
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
const PAG2 = '45454545-4545-4545-8545-454545454545'
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

type Riga = { frequenza_id: string; quota: string; quota_piu_voci: boolean; quota_voce?: Record<string, unknown> | null }

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

describe('GET conferme · voce della quota da incassare', () => {
  it('la riga con la quota da pagare porta la voce letta dal database; le altre righe no', async () => {
    scenario([nuova(0, { quota_pagamento_id: PAG }), nuova(1, { quota_pagamento_id: PAG2, quota_saldata: true }), nuova(2)])
    h.tabelle.pagamenti = [
      { id: PAG, scuola_id: SEDE_A, alunno_id: AL[0], descrizione: 'Iscrizione prova', importo: 100, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: 'singolo', parent_payment_id: null },
      { id: PAG2, scuola_id: SEDE_A, alunno_id: AL[1], descrizione: 'Iscrizione prova', importo: 100, importo_pagato: 100, sconto: 0, stato: 'pagato', tipo: 'singolo', parent_payment_id: null },
    ]
    h.esiti.anno_quota_piu_voci = { data: [], error: null }
    const { data } = await (await leggi()).json()
    const per = new Map((data.righe as Riga[]).map((r) => [r.frequenza_id, r]))
    expect(per.get(F[0])?.quota).toBe('da_pagare')
    expect(per.get(F[0])?.quota_voce).toMatchObject({ id: PAG, importo: 100, importo_pagato: 0, sconto: 0, stato: 'da_pagare', alunno_id: AL[0] })
    expect(per.get(F[1])?.quota).toBe('saldata')
    expect(per.get(F[1])?.quota_voce ?? null).toBeNull()
    expect(per.get(F[2])?.quota_voce ?? null).toBeNull()
  })
})
