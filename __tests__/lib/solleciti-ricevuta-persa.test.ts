// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * REVISIONE DEL LOTTO 4 — la ricevuta persa, dal sollecito fino a Resend.
 *
 * Gli altri test dei solleciti fingono `sendEmailDetailed`; qui è VERO, e il finto sta un piano
 * sotto: un Resend che RICORDA le chiavi d'idempotenza (stessa chiave + stesso corpo = la risposta
 * di prima, nessun nuovo invio; stessa chiave + corpo diverso = `409 invalid_idempotent_request`),
 * e un database con stato. È l'unico modo di vedere il difetto, che sta nella COMPOSIZIONE: un 504
 * del gateway o un `ECONNRESET` arrivati dopo che Resend aveva preso il messaggio uscivano
 * «certi», la presa si annullava, il giorno dopo la chiave cambiava (porta la data) e alla
 * famiglia arrivava lo stesso sollecito due volte.
 *
 * Indirizzi solo su `example.test`, uuid finti, nessuna rete: il `fetch` finto rifiuta qualunque
 * indirizzo che non sia quello di Resend.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/pagamenti/coordinate-bonifico', () => ({ coordinateBonificoSede: async () => ({ iban: null, intestatario: 'Sede di prova' }) }))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: async () => ({}) }))
vi.mock('@/lib/email/messaggi/sollecito', async (originale) => ({
  ...(await originale<typeof import('@/lib/email/messaggi/sollecito')>()),
  messaggioSollecito: () => ({ html: '<p>sollecito</p>' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunno: async () => ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'] }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: vi.fn(async () => {}) }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { sollecitaPagamenti } from '@/lib/pagamenti/solleciti-invio'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1'
const GID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

type Riga = Record<string, unknown>
let db: Record<string, Riga[]>

/** Il database finto, con stato: filtri `in`/`eq`/`is`/`contains`, UPDATE condizionati, INSERT. */
function client(): SupabaseClient {
  return {
    from(tabella: string) {
      let op: 'select' | 'update' | 'insert' = 'select'
      let modifica: Riga = {}
      let nuova: Riga = {}
      const filtri: ((r: Riga) => boolean)[] = []
      const b = {
        select: () => b,
        in: (c: string, v: unknown[]) => { filtri.push((r) => v.includes(r[c])); return b },
        eq: (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return b },
        is: (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return b },
        contains: (c: string, v: string) => {
          const attesi = JSON.parse(v) as Riga[]
          filtri.push((r) => {
            const valore = r[c]
            return Array.isArray(valore) && attesi.every((a) =>
              valore.some((x: Riga) => Object.entries(a).every(([k, y]) => x[k] === y)))
          })
          return b
        },
        update: (p: Riga) => { op = 'update'; modifica = p; return b },
        insert: (r: Riga) => { op = 'insert'; nuova = r; return b },
        maybeSingle: async () => ({ data: (db[tabella] ?? []).find((r) => filtri.every((f) => f(r))) ?? null, error: null }),
        then(risolvi: (v: unknown) => unknown, rifiuta?: (e: unknown) => unknown) {
          const righe = (db[tabella] ?? []).filter((r) => filtri.every((f) => f(r)))
          let out: unknown
          if (op === 'insert') { (db[tabella] ??= []).push({ ...nuova }); out = { data: null, error: null } }
          else if (op === 'update') { for (const r of righe) Object.assign(r, modifica); out = { data: righe.map((r) => ({ id: r.id })), error: null } }
          else out = { data: righe.map((r) => ({ ...r })), error: null }
          return Promise.resolve(out).then(risolvi, rifiuta)
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

/**
 * Resend finto con MEMORIA delle chiavi. `guasto` decide che cosa vede il NOSTRO lato dopo che
 * il provider ha già preso (e consegnato) il messaggio; `dns-una-volta` è l'unico in cui la
 * richiesta non arriva affatto.
 */
type Guasto = 'nessuno' | '504-dopo-consegna' | 'reset-dopo-consegna' | '502-sempre-dopo-consegna' | 'dns-una-volta'
let guasto: Guasto
let consegne: string[]
let chiavi: Map<string, { corpo: string; id: string }>

function installaResend(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`rete vietata nei test: ${String(url)}`)
    if (guasto === 'dns-una-volta') {
      guasto = 'nessuno'
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    }
    const chiave = (init?.headers as Record<string, string>)['Idempotency-Key']
    const corpo = String(init?.body)
    if (guasto === '502-sempre-dopo-consegna' && consegne.length > 0) {
      return new Response('<html>502 Bad Gateway</html>', { status: 502 })
    }
    const vista = chiavi.get(chiave)
    if (vista) {
      if (vista.corpo !== corpo) {
        return new Response(JSON.stringify({ name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' }), { status: 409 })
      }
      return new Response(JSON.stringify({ id: vista.id }), { status: 200 })
    }
    const id = `msg-finto-${consegne.length + 1}`
    consegne.push(chiave)
    chiavi.set(chiave, { corpo, id })
    if (guasto === '504-dopo-consegna') { guasto = 'nessuno'; return new Response('<html>504 Gateway Time-out</html>', { status: 504 }) }
    if (guasto === 'reset-dopo-consegna') { guasto = 'nessuno'; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }
    if (guasto === '502-sempre-dopo-consegna') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
    return new Response(JSON.stringify({ id }), { status: 200 })
  }))
}

/** Porta a termine un giro che aspetta i ritentativi: avanza l'orologio finto solo quando serve. */
async function finisci<T>(p: Promise<T>): Promise<T> {
  let fatto = false
  p.then(() => { fatto = true }, () => { fatto = true })
  for (let i = 0; i < 1_000 && !fatto; i++) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1_000)
    else await new Promise((r) => setImmediate(r))
  }
  return p
}

const bottone = () => sollecitaPagamenti(client(), [PID], { automatico: false, attoreId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
const cadenza = () => db.pagamenti[0].ultimo_sollecito_il
const consegneL1 = () => consegne.filter((c) => c.includes(':L1:')).length
const registro = () => db.solleciti as { destinatari: { inviata: boolean; incerta?: true }[] }[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-26T07:00:00.000Z'))
  vi.stubEnv('RESEND_API_KEY', 'chiave-finta')
  log.logEvento.mockClear()
  guasto = 'nessuno'
  consegne = []
  chiavi = new Map()
  installaResend()
  db = {
    pagamenti: [{
      id: PID, alunno_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', scuola_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      descrizione: 'Retta', importo: 150, importo_pagato: 0, sconto: 0, stato: 'scaduto', scadenza: '2026-09-05',
      tipo: 'singolo', periodo_competenza: null, ultimo_sollecito_il: null, metodi_ammessi: null,
      alunni: { nome: 'Mario', cognome: 'Rossi', codice_fiscale: null }, payment_categories: null,
    }],
    solleciti: [],
    utenti: [{ id: GID, email: 'genitore.uno@example.test' }],
    pagamenti_quote: [],
    scuole: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', nome: 'Sede di prova' }],
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('solleciti + Resend — la ricevuta persa non diventa un doppio invio', () => {
  it('🔴 bottone: 504 del gateway DOPO la consegna ⇒ esito incerto, la presa resta, il giorno dopo nessun nuovo invio', async () => {
    guasto = '504-dopo-consegna'
    const [giorno1] = await bottone()
    expect(giorno1).toMatchObject({ ok: false, inviate: 0, tentate: 1, motivo: 'esito incerto presso il provider: nessun nuovo invio prima della prossima cadenza' })
    expect(cadenza()).toBe('2026-10-26T07:00:00.000Z')
    expect(registro()[0].destinatari).toMatchObject([{ inviata: false, incerta: true }])

    vi.setSystemTime(new Date('2026-10-27T07:00:00.000Z'))
    const [giorno2] = await bottone()
    expect(giorno2.ok).toBe(false)
    expect(giorno2.motivo).toContain('cadenza minima')
    expect(consegneL1()).toBe(1)
  })

  it('🔴 bottone: connessione caduta (`ECONNRESET`) DOPO la consegna ⇒ stessa cosa: una consegna sola', async () => {
    guasto = 'reset-dopo-consegna'
    await bottone()
    expect(cadenza()).toBe('2026-10-26T07:00:00.000Z')
    vi.setSystemTime(new Date('2026-10-27T07:00:00.000Z'))
    await bottone()
    expect(consegneL1()).toBe(1)
  })

  it('giro automatico: 504 dopo la consegna, il ritentativo con la STESSA chiave ⇒ Resend risponde «già fatto», inviato', async () => {
    guasto = '504-dopo-consegna'
    const [esito] = await finisci(sollecitaPagamenti(client(), [PID], { livello: 1, automatico: true, scadenza: Date.now() + 240_000 }))
    expect(esito).toMatchObject({ ok: true, inviate: 1, tentate: 1 })
    expect(consegneL1()).toBe(1)
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })

  it('🔴 giro automatico: 502 fisso dopo la consegna ⇒ tre chiamate, esito incerto, la presa resta', async () => {
    guasto = '502-sempre-dopo-consegna'
    const [esito] = await finisci(sollecitaPagamenti(client(), [PID], { livello: 1, automatico: true, scadenza: Date.now() + 240_000 }))
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3)
    expect(esito).toMatchObject({ ok: false, inviate: 0, tentate: 1 })
    expect(cadenza()).toBe('2026-10-26T07:00:00.000Z')
    expect(log.logEvento.mock.calls.some((c) => (c[2] as { esito?: string }).esito === 'sollecito-esito-incerto')).toBe(true)
  })

  it('DNS giù (la richiesta non è mai partita) ⇒ esito certo, la presa si annulla e il giorno dopo il sollecito parte', async () => {
    guasto = 'dns-una-volta'
    const [giorno1] = await bottone()
    expect(giorno1).toMatchObject({ ok: false, inviate: 0, motivo: 'nessuna email partita: il sollecito resta per il giro successivo' })
    expect(cadenza()).toBeNull()

    vi.setSystemTime(new Date('2026-10-27T07:00:00.000Z'))
    const [giorno2] = await bottone()
    expect(giorno2).toMatchObject({ ok: true, inviate: 1 })
    expect(consegneL1()).toBe(1)
  })
})
