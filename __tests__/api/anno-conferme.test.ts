import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.5.6 · le route delle conferme per l'anno prossimo:
 *   GET   /api/admin/anni/[annoSedeId]/conferme
 *   POST  /api/admin/anni/[annoSedeId]/conferme
 *   POST  /api/admin/anni/[annoSedeId]/conferme/non-rinnova
 *
 * Il database è finto, ma in modo che il test sia sensibile al codice: il gate onora la lista dei ruoli che la route gli passa, il
 * perimetro legge davvero la riga di `anni_sede`, le letture rispondono con le righe date e registrano i filtri, ogni RPC
 * risponde come PostgREST (`{ data, error }` con `error.message` = codice) e registra gli argomenti. Solo uuid finti.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const NUOVO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // anni_sede.id della SEDE_A: l'anno che ha le iscrizioni aperte
const ATTIVO_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // l'anno in corso della SEDE_A
const NUOVO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' // anni_sede.id della SEDE_B
const ATTIVO_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const F2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2'
const F3 = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3'
const F4 = 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4'
const FB = 'fbfbfbfb-fbfb-4fbf-8fbf-fbfbfbfbfbfb' // una frequenza della SEDE_B
const N1 = '91919191-9191-4919-8919-919191919191'
const N4 = '94949494-9494-4949-8949-949494949494'
const AL = [1, 2, 3, 4].map((n) => `a${n}a${n}a${n}a${n}-a${n}a${n}-4a${n}a-8a${n}a-a${n}a${n}a${n}a${n}a${n}a${n}`)
const S_INF = '51515151-5151-4515-8515-515151515151'
const S_NUOVA_PRIM = '52525252-5252-4525-8525-525252525252'
const PAG = '44444444-4444-4444-8444-444444444444'
const MOD1 = '71717171-7171-4717-8717-717171717171'
const MOD2 = '72727272-7272-4727-8727-727272727272'

type Esito = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }
type Query = { tabella: string; colonne?: string; filtri: Record<string, unknown>; range?: [number, number] }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  anni: {} as Record<string, { id: string; scuola_id: string; stato: string }>,
  frequenze: {} as Record<string, { id: string; anno_sede_id: string }>,
  tabelle: {} as Record<string, unknown[]>,
  /** Le frequenze dell'anno NUOVO: la lettura di `frequenze` con `anno_sede_id` = anno nuovo risponde con queste. */
  nuove: [] as unknown[],
  conteggio: null as null | number,
  /** Se true, le letture APPLICANO davvero `eq`/`in`/`order`/`range` alle righe di `tabelle` e contano il totale: serve a misurare il filtro. */
  applica: false,
  errLettura: {} as Record<string, { code?: string; message?: string }>,
  query: [] as Array<{ tabella: string; colonne?: string; filtri: Record<string, unknown>; range?: [number, number] }>,
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esiti: {} as Record<string, { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }>,
  gateAmmessi: null as null | readonly string[],
  log: [] as Array<{ fn: 'evento' | 'errore' | 'ok'; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, allowed: readonly string[] = ['admin', 'coordinator', 'segreteria']) => {
    h.gateAmmessi = allowed
    if (!h.user) return { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) }
    if (!allowed.includes(h.user.role)) {
      return { user: null, response: new Response(JSON.stringify({ error: 'vietato' }), { status: 403 }) }
    }
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
      const q: Query = { tabella, filtri: {} }
      h.query.push(q)
      const b: Record<string, unknown> = {}
      const cond: Array<(r: Record<string, unknown>) => boolean> = []
      let ordine: string | null = null
      b.select = (colonne?: string) => {
        q.colonne = colonne
        return b
      }
      b.order = (c: string) => {
        ordine = c
        return b
      }
      b.eq = (c: string, v: unknown) => {
        q.filtri[c] = v
        cond.push((r) => r[c] === v)
        return b
      }
      b.in = (c: string, v: unknown) => {
        q.filtri[`in:${c}`] = v
        cond.push((r) => (v as unknown[]).includes(r[c]))
        return b
      }
      b.range = (da: number, a: number) => {
        q.range = [da, a]
        return b
      }
      b.maybeSingle = async () => {
        const errore = h.errLettura[tabella]
        if (errore) return { data: null, error: errore }
        const id = String(q.filtri.id ?? '')
        if (tabella === 'anni_sede') return { data: h.anni[id] ?? null, error: null }
        if (tabella === 'frequenze') return { data: h.frequenze[id] ?? null, error: null }
        return { data: null, error: null }
      }
      b.then = (ok: (v: unknown) => unknown) => {
        const errore = h.errLettura[tabella]
        if (h.applica && !errore) {
          let r = ((h.tabelle[tabella] ?? []) as Array<Record<string, unknown>>).filter((x) => cond.every((c) => c(x)))
          if (ordine) r = [...r].sort((a, c) => String(a[ordine as string]).localeCompare(String(c[ordine as string])))
          const totale = r.length
          if (q.range) r = r.slice(q.range[0], q.range[1] + 1)
          return Promise.resolve({ data: r, error: null, count: totale }).then(ok)
        }
        const righe = tabella === 'frequenze' && q.filtri.anno_sede_id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ? h.nuove : (h.tabelle[tabella] ?? [])
        return Promise.resolve(
          errore ? { data: null, error: errore, count: null } : { data: righe, error: null, count: h.conteggio ?? righe.length },
        ).then(ok)
      }
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

import { redact } from '@/lib/logging/redact'
import { GET as confermeGET, POST as confermePOST } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { POST as nonRinnovaPOST } from '@/app/api/admin/anni/[annoSedeId]/conferme/non-rinnova/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const url = (parte = '', id = NUOVO_A) => `http://localhost/api/admin/anni/${id}/conferme${parte}`
const conCorpo = (corpo: unknown) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as const

const leggi = (query = '', id = NUOVO_A) => confermeGET(new Request(url(query, id)) as never, contesto(id) as never)
const conferma = (corpo: unknown, id = NUOVO_A) =>
  confermePOST(new Request(url('', id), conCorpo(corpo)) as never, contesto(id) as never)
const nonRinnova = (corpo: unknown, id = NUOVO_A) =>
  nonRinnovaPOST(new Request(url('/non-rinnova', id), conCorpo(corpo)) as never, contesto(id) as never)

const ok = (data: unknown): Esito => ({ data, error: null })
const rifiuto = (message: string, code = 'P0001'): Esito => ({ data: null, error: { code, message, details: null } })

const eventi = (tipo: string, livello?: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo && (livello === undefined || e.livello === livello))

const RISULTATO_CONFERMA = {
  frequenza_id: N1, creata: true, cambia_grado: false, retta_personalizzata_precedente: false,
  quota: 'creata', pagamento_id: PAG, posti_oltre: false,
}

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.anni = {
    [NUOVO_A]: { id: NUOVO_A, scuola_id: SEDE_A, stato: 'iscrizioni_aperte' },
    [ATTIVO_A]: { id: ATTIVO_A, scuola_id: SEDE_A, stato: 'corrente' },
    [NUOVO_B]: { id: NUOVO_B, scuola_id: SEDE_B, stato: 'iscrizioni_aperte' },
    [ATTIVO_B]: { id: ATTIVO_B, scuola_id: SEDE_B, stato: 'corrente' },
  }
  h.frequenze = { [F1]: { id: F1, anno_sede_id: ATTIVO_A }, [FB]: { id: FB, anno_sede_id: ATTIVO_B } }
  h.tabelle = {}
  h.nuove = []
  h.conteggio = null
  h.applica = false
  h.errLettura = {}
  h.query = []
  h.rpc = []
  h.esiti = {
    anno_attivo: ok(ATTIVO_A),
    anno_conta_posti: ok([]),
    anno_conferma: ok(RISULTATO_CONFERMA),
    anno_non_rinnova: ok({ frequenza_id: F1, non_rinnova: true, cambiato: true }),
  }
  h.gateAmmessi = null
  h.log = []
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate, uuid, perimetro: uguali per tutte e tre le chiamate
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CORPO_CONFERMA = { frequenza_id: F1 }
const CORPO_NO = { frequenza_id: F1, attivo: true, motivo: 'trasloco' }
const CHIAMATE: Array<[string, (id?: string) => Promise<Response>]> = [
  ['GET conferme', (id) => leggi('', id)],
  ['POST conferme', (id) => conferma(CORPO_CONFERMA, id)],
  ['POST non-rinnova', (id) => nonRinnova(CORPO_NO, id)],
]

describe.each(CHIAMATE)('gate e perimetro — %s', (_nome, chiama) => {
  it('401 senza identità', async () => {
    h.user = null
    expect((await chiama()).status).toBe(401)
    expect(h.rpc).toEqual([])
    expect(h.query).toEqual([])
  })

  it.each(['educator', 'genitore', 'cuoca'])('403 a un utente %s, senza toccare il database', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    expect((await chiama()).status).toBe(403)
    expect(h.rpc).toEqual([])
    expect(h.query).toEqual([])
  })

  it('il gate è quello dello staff, con la lista dei ruoli della route', async () => {
    await chiama()
    expect(h.gateAmmessi).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('400 se l’id dell’anno non è un uuid', async () => {
    expect((await chiama('non-un-uuid')).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('404 per un anno che non esiste', async () => {
    expect((await chiama('99999999-9999-4999-8999-999999999999')).status).toBe(404)
    expect(h.rpc).toEqual([])
  })

  it('403 per l’anno nuovo di un’altra sede, senza scrivere né chiamare funzioni', async () => {
    expect((await chiama(NUOVO_B)).status).toBe(403)
    expect(h.rpc).toEqual([])
    expect(h.query.filter((x) => x.tabella !== 'anni_sede')).toEqual([])
  })

  it('503, mai 500, quando il database non ha ancora lo schema dell’anno (`info`, nessun `errore`)', async () => {
    h.errLettura.anni_sede = { code: 'PGRST205', message: 'tabella assente' }
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])
    expect(h.rpc).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Quattro bambini dell'anno in corso: confermato (e cambia grado), «no», non ha risposto, confermato poi ritirato. */
function datiDelloScenario() {
  h.tabelle.frequenze = [
    { id: F1, alunno_id: AL[0], section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
    { id: F2, alunno_id: AL[1], section_id: S_INF, non_rinnova_il: '2027-02-01T10:00:00Z', non_rinnova_motivo: 'trasloco' },
    { id: F3, alunno_id: AL[2], section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
    { id: F4, alunno_id: AL[3], section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
  ]
}
function conLeFrequenzeNuove() {
  h.nuove = [
    { id: N1, alunno_id: AL[0], section_id: S_NUOVA_PRIM, stato: 'in_attesa', quota_saldata: false, quota_pagamento_id: PAG, tipo: 'conferma' },
    { id: N4, alunno_id: AL[3], section_id: null, stato: 'ritirato', quota_saldata: false, quota_pagamento_id: null, tipo: 'conferma' },
  ]
}

describe('GET conferme', () => {
  beforeEach(() => {
    datiDelloScenario()
    conLeFrequenzeNuove()
    h.tabelle.moduli_richiesti = [{ id: MOD1, lista: 'conferma' }, { id: MOD2, lista: 'conferma' }]
    h.tabelle.frequenze_moduli = [{ frequenza_id: N1, modulo_id: MOD1 }, { frequenza_id: N1, modulo_id: '73737373-7373-4737-8737-737373737373' }]
    h.tabelle.sections = [
      { id: S_INF, scuola_id: SEDE_A, name: 'Sezione Prova A', school_type: 'infanzia', fascia: 'infanzia' },
      { id: S_NUOVA_PRIM, scuola_id: SEDE_A, name: 'Classe Prova B', school_type: 'primaria', fascia: 'primaria' },
    ]
    // Nomi inventati: la route li porta alle righe della pagina (compito 4.5.10), e solo quelli.
    h.tabelle.alunni = AL.map((id, i) => ({ id, scuola_id: SEDE_A, nome: `NomeProva${i + 1}`, cognome: `CognomeProva${i + 1}` }))
  })

  it('per ogni frequenza viva: stato della conferma, moduli, quota e cambio di grado', async () => {
    const res = await leggi()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ pagina: 1, limite: 100, totale: 4 })
    const per = (f: string) => data.righe.find((r: { frequenza_id: string }) => r.frequenza_id === f)
    expect(per(F1)).toEqual({
      frequenza_id: F1, alunno_id: AL[0], section_id: S_INF, nuova_frequenza_id: N1, nuova_section_id: S_NUOVA_PRIM,
      conferma: 'confermato', non_rinnova_motivo: null, moduli: { fatti: 1, richiesti: 2 }, quota: 'da_pagare', quota_piu_voci: false, cambia_grado: true, grado_partenza: 'infanzia',
      stato_frequenza: 'in_attesa', nome: 'NomeProva1', cognome: 'CognomeProva1', classe: 'Sezione Prova A',
    })
    expect(per(F2)).toMatchObject({ conferma: 'no', non_rinnova_motivo: 'trasloco', quota: 'assente', cambia_grado: false, nuova_frequenza_id: null })
    expect(per(F3)).toMatchObject({ conferma: 'non_risposto', moduli: { fatti: 0, richiesti: 2 }, quota: 'assente' })
    // la frequenza dell'anno prossimo ritirata non conta come conferma
    expect(per(F4)).toMatchObject({ conferma: 'non_risposto', nuova_frequenza_id: null })
  })

  it('una quota saldata si dice saldata', async () => {
    h.nuove = (h.nuove as Array<Record<string, unknown>>).map((n) => ({ ...n, quota_saldata: true }))
    const { data } = await (await leggi()).json()
    expect(data.righe.find((r: { frequenza_id: string }) => r.frequenza_id === F1).quota).toBe('saldata')
  })

  it('legge le frequenze VIVE dell’anno ATTIVO, ordinate, e le nuove solo di quei bambini nell’anno nuovo', async () => {
    await leggi()
    const partenza = h.query.find((x) => x.tabella === 'frequenze' && x.filtri.anno_sede_id === ATTIVO_A)
    expect(partenza?.range).toEqual([0, 99])
    const nuove = h.query.find((x) => x.tabella === 'frequenze' && x.filtri.anno_sede_id === NUOVO_A)
    expect(nuove?.filtri['in:alunno_id']).toEqual(AL)
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo', 'anno_conta_posti'])
    expect(h.rpc[0].args).toEqual({ p_scuola: SEDE_A })
  })

  it('pagina e tetto: `pagina=2&limite=2` legge le righe 2-3 e dichiara il totale', async () => {
    h.conteggio = 4
    const { data } = await (await leggi('?pagina=2&limite=2')).json()
    const partenza = h.query.find((x) => x.tabella === 'frequenze' && x.filtri.anno_sede_id === ATTIVO_A)
    expect(partenza?.range).toEqual([2, 3])
    expect(data).toMatchObject({ pagina: 2, limite: 2, totale: 4 })
  })

  it.each(['?limite=0', '?limite=201', '?pagina=0', '?pagina=abc', '?limite=x'])('400 per %s', async (query) => {
    expect((await leggi(query)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('un anno senza le iscrizioni aperte risponde 409 `ANNO_NON_APERTO`', async () => {
    h.anni[NUOVO_A].stato = 'in_preparazione'
    const res = await leggi()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_NON_APERTO')
  })

  it('403 se l’anno attivo risolto non è di una sede dell’utente', async () => {
    h.esiti.anno_attivo = ok(ATTIVO_B)
    expect((await leggi()).status).toBe(403)
  })

  it('nessun anno attivo: elenco vuoto, non un errore', async () => {
    h.esiti.anno_attivo = ok(null)
    const res = await leggi()
    expect(res.status).toBe(200)
    expect((await res.json()).data.righe).toEqual([])
  })

  it('i posti arrivano accanto all’elenco come avviso (numeri e booleani); se non si leggono l’elenco c’è lo stesso', async () => {
    h.esiti.anno_conta_posti = ok([{ fascia: 'infanzia', iscritti: '3', posti: 2, oltre: true }])
    expect((await (await leggi()).json()).data.posti).toEqual([{ fascia: 'infanzia', iscritti: 3, posti: 2, oltre: true }])
    h.esiti.anno_conta_posti = rifiuto('boom', 'XX000')
    const res = await leggi()
    expect(res.status).toBe(200)
    expect((await res.json()).data.posti).toEqual([])
    expect(h.log.filter((l) => l.fn === 'errore')).toHaveLength(1)
  })

  it('una lettura guasta è 500 con `logErrore`; lo schema indietro è 503 con `info`', async () => {
    h.errLettura.sections = { code: 'XX000', message: 'boom' }
    expect((await leggi()).status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
    h.log = []
    h.errLettura.sections = { code: 'PGRST205', message: 'tabella assente' }
    expect((await leggi()).status).toBe(503)
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])
  })

  it('la risposta porta nome e cognome SOLO nei campi dedicati; ogni altra foglia e il log restano uuid, stati, numeri e booleani', async () => {
    const corpo = await (await leggi()).json()
    const ammessi = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|confermato|no|non_risposto|saldata|da_pagare|assente|trasloco|in_attesa|iscritto|infanzia|primaria)$/
    const foglie: unknown[] = []
    const visita = (v: unknown, chiave?: string): void => {
      if (v !== null && typeof v === 'object') Object.entries(v).forEach(([k, x]) => visita(x, k))
      else if (!['nome', 'cognome', 'classe'].includes(chiave ?? '')) foglie.push(v)
    }
    visita(corpo.data.righe)
    for (const f of foglie) {
      if (typeof f === 'string') expect(f, String(f)).toMatch(ammessi)
      else expect(['number', 'boolean', 'object']).toContain(typeof f)
    }
    // il nome non esce mai nel log
    expect(JSON.stringify(h.log)).not.toMatch(/NomeProva|CognomeProva|Sezione Prova/)
    const letture = eventi('conferme-lette', 'info')
    expect(letture).toHaveLength(1)
    expect(letture[0].campi).toMatchObject({ n: 4, anno_sede_id: NUOVO_A, utente: UTENTE })
    expect(JSON.stringify(redact(letture[0].campi))).not.toContain('[redatto')
  })

  it('i nomi li porta la route: due colonne di `alunni`, dentro la sede, solo dei bambini della pagina', async () => {
    await leggi()
    const nomi = h.query.find((x) => x.tabella === 'alunni')
    expect(nomi?.colonne).toBe('id, nome, cognome')
    expect(nomi?.filtri['in:id']).toEqual(AL)
    expect(nomi?.filtri.scuola_id).toBe(SEDE_A)
  })

  it('una lettura dei nomi fallita è un errore, non una pagina di «Bambino non in elenco»', async () => {
    h.errLettura.alunni = { code: 'XX000', message: 'boom' }
    expect((await leggi()).status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Compito 4.5.10 · la vista delle NUOVE iscrizioni e il filtro «mancano moduli»
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET conferme — vista=nuove e mancano_moduli', () => {
  const NA = [1, 2, 3, 4, 5].map((n) => `b${n}b${n}b${n}b${n}-b${n}b${n}-4b${n}b-8b${n}b-b${n}b${n}b${n}b${n}b${n}b${n}`)
  const FN = [1, 2, 3, 4, 5].map((n) => `d${n}d${n}d${n}d${n}-d${n}d${n}-4d${n}d-8d${n}d-d${n}d${n}d${n}d${n}d${n}d${n}`)
  const MNUOVA1 = '81818181-8181-4818-8818-818181818181'
  const MNUOVA2 = '82828282-8282-4828-8828-828282828282'

  function nuoveDelloScenario() {
    h.applica = true
    // 5 frequenze `nuova` vive dell'anno nuovo + una `conferma` + una nuova ritirata + una nuova di un'altra sede
    h.tabelle.frequenze = [
      ...FN.map((id, i) => ({ id, alunno_id: NA[i], anno_sede_id: NUOVO_A, tipo: 'nuova', stato: 'in_attesa', section_id: i === 0 ? S_NUOVA_PRIM : null, quota_saldata: i === 4, quota_pagamento_id: i === 4 ? PAG : null })),
      { id: N1, alunno_id: AL[0], anno_sede_id: NUOVO_A, tipo: 'conferma', stato: 'in_attesa', section_id: null, quota_saldata: false, quota_pagamento_id: null },
      // chi ha confermato FREQUENTA: ha una frequenza viva nell'anno attivo (4.5.17: è questo che lo tiene fuori dalle nuove)
      { id: F1, alunno_id: AL[0], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: null },
      { id: N4, alunno_id: AL[3], anno_sede_id: NUOVO_A, tipo: 'nuova', stato: 'ritirato', section_id: null, quota_saldata: false, quota_pagamento_id: null },
      { id: 'fffffff0-ffff-4fff-8fff-fffffffffff0', alunno_id: NA[0], anno_sede_id: NUOVO_B, tipo: 'nuova', stato: 'in_attesa', section_id: null, quota_saldata: false, quota_pagamento_id: null },
    ]
    h.tabelle.moduli_richiesti = [
      { id: MNUOVA1, anno_sede_id: NUOVO_A, lista: 'nuova' },
      { id: MNUOVA2, anno_sede_id: NUOVO_A, lista: 'nuova' },
      { id: MOD1, anno_sede_id: NUOVO_A, lista: 'conferma' },
      { id: MOD2, anno_sede_id: NUOVO_A, lista: 'conferma' },
    ]
    // FN[0] ha tutti e due i moduli; FN[1] uno; FN[2..4] nessuno
    h.tabelle.frequenze_moduli = [
      { id: 'm1', frequenza_id: FN[0], modulo_id: MNUOVA1 },
      { id: 'm2', frequenza_id: FN[0], modulo_id: MNUOVA2 },
      { id: 'm3', frequenza_id: FN[1], modulo_id: MNUOVA1 },
    ]
    h.tabelle.sections = [{ id: S_NUOVA_PRIM, scuola_id: SEDE_A, name: 'Classe Prova B', school_type: 'primaria', fascia: 'primaria' }]
    h.tabelle.alunni = NA.map((id, i) => ({ id, scuola_id: SEDE_A, nome: `Nuovo${i + 1}`, cognome: `Arrivo${i + 1}` }))
  }

  it('`vista=nuove`: le frequenze `nuova` vive dell’anno nuovo, con nome, moduli della lista nuova, quota e stato', async () => {
    nuoveDelloScenario()
    const res = await leggi('?vista=nuove')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.totale).toBe(5)
    expect(data.righe.map((r: { frequenza_id: string }) => r.frequenza_id)).toEqual([...FN].sort())
    const prima = data.righe.find((r: { frequenza_id: string }) => r.frequenza_id === FN[0])
    expect(prima).toEqual({
      frequenza_id: FN[0], alunno_id: NA[0], section_id: S_NUOVA_PRIM, nuova_frequenza_id: FN[0], nuova_section_id: S_NUOVA_PRIM,
      conferma: 'confermato', non_rinnova_motivo: null, moduli: { fatti: 2, richiesti: 2 }, quota: 'assente', quota_piu_voci: false, cambia_grado: false,
      stato_frequenza: 'in_attesa', nome: 'Nuovo1', cognome: 'Arrivo1', classe: 'Classe Prova B',
    })
    expect(data.righe.find((r: { frequenza_id: string }) => r.frequenza_id === FN[4])).toMatchObject({ quota: 'saldata', moduli: { fatti: 0, richiesti: 2 } })
    // 4.5.17 (B): le liste si leggono insieme e ogni riga usa quella del suo `tipo` (qui `nuova`: 2 moduli)
    expect(h.query.find((x) => x.tabella === 'moduli_richiesti')?.filtri['in:lista']).toEqual(['conferma', 'nuova'])
    // 4.7.4: la lettura "più voci" sta fra le due (una chiamata per la pagina, sulle frequenze senza voce)
    // 4.5.17 (A): nell'anno nuovo c'è una riga `conferma`, quindi serve l'anno attivo per sapere chi frequenta
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo', 'anno_quota_piu_voci', 'anno_conta_posti'])
  })

  it('una frequenza non compare in tutte e due le viste: chi ha confermato non è fra le nuove, chi arriva non è fra le conferme', async () => {
    nuoveDelloScenario()
    h.tabelle.frequenze = [
      ...(h.tabelle.frequenze as unknown[]),
      { id: F1, alunno_id: AL[0], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
    ]
    const nuove = (await (await leggi('?vista=nuove')).json()).data.righe.map((r: { alunno_id: string }) => r.alunno_id)
    expect(nuove).not.toContain(AL[0])
    const conferme = (await (await leggi('?vista=conferme')).json()).data.righe.map((r: { alunno_id: string }) => r.alunno_id)
    for (const n of NA) expect(conferme).not.toContain(n)
    expect(conferme).toContain(AL[0])
  })

  it('`vista=nuove&conferma=mancano_moduli` filtra sul TOTALE e la paginazione lo segue (4 su 5, pagine da 3)', async () => {
    nuoveDelloScenario()
    const p1 = (await (await leggi('?vista=nuove&conferma=mancano_moduli&limite=3&pagina=1')).json()).data
    const p2 = (await (await leggi('?vista=nuove&conferma=mancano_moduli&limite=3&pagina=2')).json()).data
    expect(p1.totale).toBe(4)
    expect(p2.totale).toBe(4)
    expect(p1.righe).toHaveLength(3)
    expect(p2.righe).toHaveLength(1)
    const ids = [...p1.righe, ...p2.righe].map((r: { frequenza_id: string }) => r.frequenza_id).sort()
    expect(ids).toEqual([FN[1], FN[2], FN[3], FN[4]].sort())
    // chi ha tutti i moduli non c'è mai; chi ne ha 1 su 2 sì
    expect(ids).not.toContain(FN[0])
  })

  it('senza moduli richiesti nessuno «manca» niente', async () => {
    nuoveDelloScenario()
    h.tabelle.moduli_richiesti = []
    const { data } = await (await leggi('?vista=nuove&conferma=mancano_moduli')).json()
    expect(data.totale).toBe(0)
    expect(data.righe).toEqual([])
  })

  it.each(['?vista=altro', '?vista=nuove&conferma=confermato', '?vista=nuove&conferma=no', '?vista=nuove&conferma=non_risposto', '?conferma=qualcosa'])(
    '400 per %s, senza chiamare il database',
    async (query) => {
      expect((await leggi(query)).status).toBe(400)
      expect(h.rpc).toEqual([])
    },
  )

  it('`conferma=mancano_moduli` nella vista delle conferme: solo chi ha confermato e ha spuntato meno della lista, sul totale', async () => {
    h.applica = true
    // 4 partenze (F1..F4): F1 e F3 hanno confermato, F1 con 1 modulo su 2, F3 con 2 su 2; F2 e F4 no
    const NC3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
    h.tabelle.frequenze = [
      { id: F1, alunno_id: AL[0], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
      { id: F2, alunno_id: AL[1], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: '2027-02-01', non_rinnova_motivo: null },
      { id: F3, alunno_id: AL[2], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
      { id: F4, alunno_id: AL[3], anno_sede_id: ATTIVO_A, stato: 'iscritto', section_id: S_INF, non_rinnova_il: null, non_rinnova_motivo: null },
      { id: N1, alunno_id: AL[0], anno_sede_id: NUOVO_A, tipo: 'conferma', stato: 'in_attesa', section_id: S_INF, quota_saldata: false, quota_pagamento_id: null },
      { id: NC3, alunno_id: AL[2], anno_sede_id: NUOVO_A, tipo: 'conferma', stato: 'in_attesa', section_id: S_INF, quota_saldata: false, quota_pagamento_id: null },
    ]
    h.tabelle.moduli_richiesti = [
      { id: MOD1, anno_sede_id: NUOVO_A, lista: 'conferma' },
      { id: MOD2, anno_sede_id: NUOVO_A, lista: 'conferma' },
    ]
    h.tabelle.frequenze_moduli = [
      { id: 'x1', frequenza_id: N1, modulo_id: MOD1 },
      { id: 'x2', frequenza_id: NC3, modulo_id: MOD1 },
      { id: 'x3', frequenza_id: NC3, modulo_id: MOD2 },
    ]
    h.tabelle.sections = [{ id: S_INF, scuola_id: SEDE_A, name: 'Sezione Prova A', school_type: 'infanzia', fascia: 'infanzia' }]
    h.tabelle.alunni = AL.map((id, i) => ({ id, scuola_id: SEDE_A, nome: `NomeProva${i + 1}`, cognome: `CognomeProva${i + 1}` }))
    const { data } = await (await leggi('?conferma=mancano_moduli')).json()
    expect(data.totale).toBe(1)
    expect(data.righe.map((r: { frequenza_id: string }) => r.frequenza_id)).toEqual([F1])
    expect(data.righe[0].moduli).toEqual({ fatti: 1, richiesti: 2 })
    // 4.5.17 (B): le due liste si leggono insieme, e la riga usa quella del suo `tipo` (qui `conferma`)
    expect(h.query.find((x) => x.tabella === 'moduli_richiesti')?.filtri['in:lista']).toEqual(['conferma', 'nuova'])
  })

  it('il perimetro vale anche per le nuove: 403 per l’anno di un’altra sede', async () => {
    nuoveDelloScenario()
    expect((await leggi('?vista=nuove', NUOVO_B)).status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST conferme
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST conferme', () => {
  it('chiama `anno_conferma` con l’anno nuovo, la frequenza, la sezione scelta, chi conferma e la spunta', async () => {
    const res = await conferma({ frequenza_id: F1, section_id: S_NUOVA_PRIM, cambia_grado: true })
    expect(res.status).toBe(200)
    expect(h.rpc.filter((r) => r.nome === 'anno_conferma')).toEqual([
      {
        nome: 'anno_conferma',
        args: { p_frequenza: F1, p_anno_sede_nuovo: NUOVO_A, p_section: S_NUOVA_PRIM, p_da: UTENTE, p_cambia_grado: true },
      },
    ])
    expect((await res.json()).data).toEqual(RISULTATO_CONFERMA)
  })

  it('senza sezione e senza spunta: sezione NULL (la continuazione la sceglie il database) e `p_cambia_grado` falso', async () => {
    await conferma(CORPO_CONFERMA)
    expect(h.rpc.find((r) => r.nome === 'anno_conferma')?.args).toMatchObject({ p_section: null, p_cambia_grado: false })
  })

  it.each([
    ['corpo vuoto', {}],
    ['frequenza non uuid', { frequenza_id: 'x' }],
    ['sezione non uuid', { frequenza_id: F1, section_id: 'x' }],
    ['spunta non booleana', { frequenza_id: F1, cambia_grado: 'si' }],
    ['campo in più (strict)', { frequenza_id: F1, da: UTENTE }],
  ])('400 per %s, senza chiamare il database', async (_nome, corpo) => {
    expect((await conferma(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('403 se la frequenza è di un’altra sede, anche se l’anno nuovo è il proprio: `anno_conferma` non parte', async () => {
    h.frequenze[F1] = { id: F1, anno_sede_id: ATTIVO_B }
    expect((await conferma(CORPO_CONFERMA)).status).toBe(403)
    expect(h.rpc.find((r) => r.nome === 'anno_conferma')).toBeUndefined()
  })

  it('una frequenza che non esiste è un 400 `PARAMETRO_MANCANTE`', async () => {
    const res = await conferma({ frequenza_id: '99999999-9999-4999-8999-999999999999' })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PARAMETRO_MANCANTE')
    expect(h.rpc.find((r) => r.nome === 'anno_conferma')).toBeUndefined()
  })

  it.each([
    ['SEZIONE_OBBLIGATORIA', 422],
    ['FREQUENZA_NON_VIVA', 409],
    ['ANNO_NON_APERTO', 409],
    ['SEDE_DIVERSA', 422],
  ])('il rifiuto %s del database è un %s con il suo codice', async (codice, stato) => {
    h.esiti.anno_conferma = rifiuto(codice)
    const res = await conferma(CORPO_CONFERMA)
    expect(res.status).toBe(stato)
    expect((await res.json()).codice).toBe(codice)
  })

  it('503, mai 500, se la funzione non c’è ancora; un guasto vero è 500 con `logErrore` e solo il SQLSTATE', async () => {
    h.esiti.anno_conferma = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    expect((await conferma(CORPO_CONFERMA)).status).toBe(503)
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])

    h.esiti.anno_conferma = { data: null, error: { code: '23514', message: 'riga con dati: new row for relation violates check' } }
    expect((await conferma(CORPO_CONFERMA)).status).toBe(500)
    const errori = h.log.filter((l) => l.fn === 'errore')
    expect(errori.length).toBeGreaterThan(0)
    expect(JSON.stringify(errori)).not.toContain('riga con dati')
  })

  it('il successo si logga a `info`: uuid, esito e booleani, nessun nome', async () => {
    await conferma(CORPO_CONFERMA)
    const e = eventi('conferma-anno-registrata', 'info')
    expect(e).toHaveLength(1)
    expect(e[0].campi).toMatchObject({ esito: 'creata', entita_id: N1, utente: UTENTE, cambia_grado: false, posti_oltre: false })
    expect(JSON.stringify(redact(e[0].campi))).not.toContain('[redatto')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST non-rinnova
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST non-rinnova', () => {
  it('scrive il motivo dell’elenco chiuso sulla frequenza di partenza', async () => {
    const res = await nonRinnova(CORPO_NO)
    expect(res.status).toBe(200)
    expect(h.rpc.find((r) => r.nome === 'anno_non_rinnova')?.args).toEqual({
      p_frequenza: F1, p_attivo: true, p_motivo: 'trasloco', p_da: UTENTE,
    })
    expect((await res.json()).data).toEqual({ frequenza_id: F1, non_rinnova: true, cambiato: true })
  })

  it.each(['altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro'])('il motivo «%s» passa', async (motivo) => {
    expect((await nonRinnova({ frequenza_id: F1, attivo: true, motivo })).status).toBe(200)
  })

  it('un motivo libero è respinto da `zod` e non arriva al database', async () => {
    const res = await nonRinnova({ frequenza_id: F1, attivo: true, motivo: 'La famiglia si trasferisce a Torino' })
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('`attivo:false` azzera: il motivo, anche se arriva, non viene mandato', async () => {
    await nonRinnova({ frequenza_id: F1, attivo: false, motivo: 'altro' })
    expect(h.rpc.find((r) => r.nome === 'anno_non_rinnova')?.args).toMatchObject({ p_attivo: false, p_motivo: null })
  })

  it('il motivo può mancare', async () => {
    await nonRinnova({ frequenza_id: F1, attivo: true })
    expect(h.rpc.find((r) => r.nome === 'anno_non_rinnova')?.args).toMatchObject({ p_attivo: true, p_motivo: null })
  })

  it.each([
    ['senza `attivo`', { frequenza_id: F1 }],
    ['`attivo` non booleano', { frequenza_id: F1, attivo: 'si' }],
    ['frequenza non uuid', { frequenza_id: 'x', attivo: true }],
    ['campo in più (strict)', { frequenza_id: F1, attivo: true, nota: 'testo' }],
  ])('400 %s', async (_n, corpo) => {
    expect((await nonRinnova(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('403 se la frequenza è di un’altra sede', async () => {
    h.frequenze[F1] = { id: F1, anno_sede_id: ATTIVO_B }
    expect((await nonRinnova(CORPO_NO)).status).toBe(403)
    expect(h.rpc.find((r) => r.nome === 'anno_non_rinnova')).toBeUndefined()
  })

  it('`FREQUENZA_NON_VIVA` è un 409; la funzione assente un 503', async () => {
    h.esiti.anno_non_rinnova = rifiuto('FREQUENZA_NON_VIVA')
    const res = await nonRinnova(CORPO_NO)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FREQUENZA_NON_VIVA')
    h.esiti.anno_non_rinnova = { data: null, error: { code: '42883', message: 'function does not exist' } }
    expect((await nonRinnova(CORPO_NO)).status).toBe(503)
  })

  it('il successo si logga a `info` con uuid e il codice del motivo, senza testo libero', async () => {
    await nonRinnova(CORPO_NO)
    const e = eventi('non-rinnova-registrato', 'info')
    expect(e).toHaveLength(1)
    expect(e[0].campi).toMatchObject({ esito: 'segnato', entita_id: F1, utente: UTENTE, entita_tipo: 'trasloco' })
    expect(JSON.stringify(redact(e[0].campi))).not.toContain('[redatto')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET con il filtro `?conferma=` — lo applica la ROUTE, sul totale e non sulla pagina (giro di correzione 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET conferme — filtro lato route', () => {
  const idF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const idA = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const idN = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const NO = '2027-02-01T10:00:00Z'

  /** Sette bambini dell'anno in corso (+ uno già ritirato che non conta) e le loro frequenze nell'anno nuovo, in UNA tabella come nel database. */
  beforeEach(() => {
    h.applica = true
    const partenza = (n: number, extra: Record<string, unknown> = {}, stato = 'iscritto') => ({
      id: idF(n), alunno_id: idA(n), anno_sede_id: ATTIVO_A, section_id: S_INF, stato, non_rinnova_il: null, non_rinnova_motivo: null, ...extra,
    })
    const nuova = (n: number, stato: string) => ({
      id: idN(n), alunno_id: idA(n), anno_sede_id: NUOVO_A, section_id: null, stato, quota_saldata: false, quota_pagamento_id: null,
    })
    h.tabelle.frequenze = [
      partenza(1), partenza(2, { non_rinnova_il: NO, non_rinnova_motivo: 'trasloco' }), partenza(3), partenza(4),
      partenza(5, { non_rinnova_il: NO, non_rinnova_motivo: 'altro' }), partenza(6), partenza(7),
      partenza(8, {}, 'ritirato'),
      nuova(1, 'in_attesa'), nuova(4, 'iscritto'), nuova(7, 'ritirato'),
    ]
    h.tabelle.sections = [{ id: S_INF, scuola_id: SEDE_A, school_type: 'infanzia', fascia: 'infanzia' }]
  })

  const ids = (data: { righe: Array<{ frequenza_id: string }> }) => data.righe.map((r) => r.frequenza_id)

  it('«non hanno risposto»: il totale è dei soli non risposti e la seconda pagina porta quelli che restano', async () => {
    const p1 = (await (await leggi('?conferma=non_risposto&limite=2&pagina=1')).json()).data
    expect(ids(p1)).toEqual([idF(3), idF(6)])
    expect(p1.totale).toBe(3)
    const p2 = (await (await leggi('?conferma=non_risposto&limite=2&pagina=2')).json()).data
    expect(ids(p2)).toEqual([idF(7)]) // la conferma poi ritirata vale «non ha risposto»
    expect(p2.totale).toBe(3)
    for (const r of [...p1.righe, ...p2.righe]) expect(r.conferma).toBe('non_risposto')
  })

  it('«confermati»: solo chi ha una frequenza viva nell’anno nuovo, con i dati della sua nuova frequenza', async () => {
    const { data } = await (await leggi('?conferma=confermato&limite=10')).json()
    expect(ids(data)).toEqual([idF(1), idF(4)])
    expect(data.totale).toBe(2)
    expect(data.righe.map((r: { nuova_frequenza_id: string }) => r.nuova_frequenza_id)).toEqual([idN(1), idN(4)])
  })

  it('«non rinnovano»: solo chi ha detto no e non ha poi confermato, col suo motivo', async () => {
    const { data } = await (await leggi('?conferma=no&limite=10')).json()
    expect(ids(data)).toEqual([idF(2), idF(5)])
    expect(data.totale).toBe(2)
    expect(data.righe.map((r: { non_rinnova_motivo: string }) => r.non_rinnova_motivo)).toEqual(['trasloco', 'altro'])
  })

  it('chi ha detto no e poi ha confermato è «confermato», non «no»', async () => {
    ;(h.tabelle.frequenze as Array<Record<string, unknown>>).push({
      id: idN(2), alunno_id: idA(2), anno_sede_id: NUOVO_A, section_id: null, stato: 'iscritto', quota_saldata: false, quota_pagamento_id: null,
    })
    const no = (await (await leggi('?conferma=no&limite=10')).json()).data
    expect(ids(no)).toEqual([idF(5)])
    const si = (await (await leggi('?conferma=confermato&limite=10')).json()).data
    expect(ids(si)).toEqual([idF(1), idF(2), idF(4)])
  })

  it('senza filtro (o «tutti») torna l’elenco intero, ritirati dell’anno in corso esclusi', async () => {
    for (const q of ['', '?conferma=tutti']) {
      const { data } = await (await leggi(`${q}${q ? '&' : '?'}limite=100`)).json()
      expect(data.totale).toBe(7)
      expect(ids(data)).toEqual([1, 2, 3, 4, 5, 6, 7].map(idF))
    }
  })

  it('400 per un filtro fuori dall’elenco chiuso, senza leggere niente', async () => {
    const res = await leggi('?conferma=boh')
    expect(res.status).toBe(400)
    expect(h.query.filter((x) => x.tabella === 'frequenze')).toEqual([])
  })
})
