import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.7.6 · la route del cruscotto dell'anno prossimo:
 *   GET /api/admin/anni/[annoSedeId]/cruscotto
 *
 * Il database è finto, ma in modo che il test sia sensibile al codice: il gate onora la lista dei ruoli che la route gli passa, il
 * perimetro legge davvero la riga di `anni_sede`, la RPC risponde come PostgREST (`{ data, error }`) e registra gli argomenti.
 * La parità dei numeri col database la prova `__tests__/db/anno-cruscotto.test.ts`: qui si prova la FORMA. Solo uuid finti.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const ANNO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // iscrizioni aperte, SEDE_A
const ANNO_A_CORRENTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ANNO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' // iscrizioni aperte, SEDE_B
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

type Esito = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  anni: {} as Record<string, { id: string; scuola_id: string; stato: string }>,
  errAnno: null as null | { code?: string; message?: string },
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esito: null as null | Esito,
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
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => {
        filtri[c] = v
        return b
      }
      b.maybeSingle = async () => {
        if (tabella !== 'anni_sede') return { data: null, error: null }
        if (h.errAnno) return { data: null, error: h.errAnno }
        return { data: h.anni[String(filtri.id ?? '')] ?? null, error: null }
      }
      return b
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      h.rpc.push({ nome, args })
      return h.esito ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    },
  }),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...args: unknown[]) => void h.log.push({ fn: 'evento', args }),
  logErrore: (...args: unknown[]) => void h.log.push({ fn: 'errore', args }),
  logOk: (...args: unknown[]) => void h.log.push({ fn: 'ok', args }),
}))

import { redact } from '@/lib/logging/redact'
import { GET } from '@/app/api/admin/anni/[annoSedeId]/cruscotto/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const leggi = (id = ANNO_A, query = '') =>
  GET(new Request(`http://localhost/api/admin/anni/${id}/cruscotto${query}`) as never, contesto(id) as never)
const eventi = (tipo: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo)
const guasti = () => h.log.filter((l) => l.fn === 'errore')

/** Un cruscotto della forma di `CruscottoAnno`: numeri e nomi di sezione, nessun bambino. */
const CRUSCOTTO = {
  anno: { inizio: '2027-09-01', fine: '2028-08-31', stato: 'iscrizioni_aperte' },
  sezioni: [{ section_id: '51515151-5151-4515-8515-515151515151', nome: 'Sezione A', fascia: 'infanzia', iscritti: 3 }],
  fasce: [{ fascia: 'infanzia', iscritti: 3, posti: 2, oltre: true }],
  risposte: { confermati: 4, no: 1, non_risposto: 3, di_partenza: 8 },
  nuove: { totale: 2 },
  quota: {
    saldate: 2, da_pagare: 1, assenti: 3, senza_listino: 0, euro_incassati: 200, euro_da_incassare: 100,
    euro_assenti_stimati: 550, ritirati_con_voce: 1, euro_ritirati_incassati: 100,
  },
  incrocio: { moduli_senza_quota: 1, quota_senza_moduli: 1, entrambi: 1, nessuno_dei_due: 3, totale: 6, piu_voci: 0 },
  confronto: null,
}

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.anni = {
    [ANNO_A]: { id: ANNO_A, scuola_id: SEDE_A, stato: 'iscrizioni_aperte' },
    [ANNO_A_CORRENTE]: { id: ANNO_A_CORRENTE, scuola_id: SEDE_A, stato: 'corrente' },
    [ANNO_B]: { id: ANNO_B, scuola_id: SEDE_B, stato: 'iscrizioni_aperte' },
  }
  h.errAnno = null
  h.rpc = []
  h.esito = { data: CRUSCOTTO, error: null }
  h.gateAmmessi = null
  h.log = []
})

describe('GET /api/admin/anni/[annoSedeId]/cruscotto', () => {
  it('risponde con la forma di `CruscottoAnno`, chiama la funzione una volta sola e logga il successo', async () => {
    const r = await leggi()
    expect(r.status).toBe(200)
    const corpo = await r.json()
    expect(corpo.success).toBe(true)
    expect(corpo.data).toEqual(CRUSCOTTO)
    expect(Object.keys(corpo.data).sort()).toEqual(['anno', 'confronto', 'fasce', 'incrocio', 'nuove', 'quota', 'risposte', 'sezioni'])
    expect(h.rpc).toEqual([{ nome: 'anno_cruscotto', args: { p_anno_sede: ANNO_A } }])
    expect(eventi('cruscotto-letto')).toEqual([
      { livello: 'info', campi: expect.objectContaining({ anno_sede_id: ANNO_A, utente: UTENTE, tipo: 'cruscotto-letto' }) },
    ])
    expect(guasti()).toHaveLength(0)
  })

  it('il gate è dello staff: un genitore o un docente non passano', async () => {
    h.user = { id: UTENTE, role: 'parent', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(403)
    h.user = { id: UTENTE, role: 'teacher', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(403)
    expect(h.rpc).toHaveLength(0)
    h.user = null
    expect((await leggi()).status).toBe(401)
    h.user = { id: UTENTE, role: 'admin', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(200)
    expect([...(h.gateAmmessi ?? [])].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('un anno non aperto risponde 409 `ANNO_NON_APERTO` e la funzione non gira', async () => {
    const r = await leggi(ANNO_A_CORRENTE)
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_NON_APERTO')
    expect(h.rpc).toHaveLength(0)
  })

  it('l\'anno di un\'altra sede è rifiutato e la funzione non gira', async () => {
    const r = await leggi(ANNO_B)
    expect(r.status).toBe(403)
    expect(h.rpc).toHaveLength(0)
  })

  it('un anno che non c\'è risponde 404, un id che non è un uuid 400', async () => {
    expect((await leggi('99999999-9999-4999-8999-999999999999')).status).toBe(404)
    expect((await leggi('non-un-uuid')).status).toBe(400)
    expect(h.rpc).toHaveLength(0)
  })

  it('schema indietro (la funzione non c\'è ancora) → 503 e nessun 500', async () => {
    for (const code of ['42883', 'PGRST202']) {
      h.rpc = []
      h.log = []
      h.esito = { data: null, error: { code, message: 'function public.anno_cruscotto does not exist' } }
      const r = await leggi()
      expect(r.status, code).toBe(503)
      expect(guasti(), code).toHaveLength(0)
    }
  })

  it('un errore vero → 500 loggato, mai 200', async () => {
    h.esito = { data: null, error: { code: 'XX000', message: 'boom' } }
    const r = await leggi()
    expect(r.status).toBe(500)
    expect((await r.json()).codice).toBe('LETTURA_FALLITA')
    expect(guasti().length).toBeGreaterThan(0)
    expect(eventi('cruscotto-letto')).toHaveLength(0)
  })

  it('una risposta che non è un oggetto non diventa un 200 vuoto', async () => {
    for (const data of [null, [], 'ciao']) {
      h.log = []
      h.esito = { data, error: null }
      const r = await leggi()
      expect(r.status).toBe(500)
      expect(guasti().length).toBeGreaterThan(0)
    }
  })

  it('la lettura dell\'anno che cade → 500 (o 503 se lo schema è indietro), la funzione non gira', async () => {
    h.errAnno = { code: 'XX000', message: 'boom' }
    expect((await leggi()).status).toBe(500)
    h.errAnno = { code: '42P01', message: 'relation "anni_sede" does not exist' }
    expect((await leggi()).status).toBe(503)
    expect(h.rpc).toHaveLength(0)
  })

  it('la risposta non contiene chiavi di persona: nessun `nome` o `cognome` di bambino', async () => {
    const corpo = await (await leggi()).json()
    const chiavi = new Set<string>()
    const visita = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visita)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          chiavi.add(k)
          visita(x)
        }
      }
    }
    visita(corpo.data)
    // `nome` esiste solo dentro `sezioni` (il nome della sezione); `cognome`, `alunno_id`, `codice_fiscale` non ci sono mai.
    expect(chiavi.has('cognome')).toBe(false)
    expect(chiavi.has('alunno_id')).toBe(false)
    expect(chiavi.has('codice_fiscale')).toBe(false)
    expect(corpo.data.sezioni.every((s: Record<string, unknown>) => 'section_id' in s && 'nome' in s)).toBe(true)
    expect(Object.keys(corpo.data).includes('nome')).toBe(false)
    expect(Object.keys(corpo.data.risposte)).not.toContain('nome')
  })

  it('i log del successo e dell\'errore non portano nomi: passano la redazione senza perdere uuid e numeri', async () => {
    await leggi()
    const campi = eventi('cruscotto-letto')[0].campi
    const rosso = redact(campi) as Record<string, unknown>
    expect(rosso.anno_sede_id).toBe(ANNO_A)
    expect(rosso.utente).toBe(UTENTE)
    expect(JSON.stringify(campi)).not.toMatch(/nome|cognome|codice_fiscale/i)
  })
})
