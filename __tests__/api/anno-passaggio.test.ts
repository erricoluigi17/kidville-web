import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.8.8 · le sei route del passaggio d'anno (`annoSedeId` = l'anno NUOVO):
 *   GET   /api/admin/anni/[annoSedeId]/passaggio                    (la lettura)
 *   POST  /api/admin/anni/[annoSedeId]/passaggio                    ({ azione: 'anteprima' })
 *   PUT   /api/admin/anni/[annoSedeId]/passaggio/righe
 *   PUT   /api/admin/anni/[annoSedeId]/passaggio/docenti
 *   POST  /api/admin/anni/[annoSedeId]/passaggio/conferma
 *   POST  /api/admin/anni/[annoSedeId]/passaggio/annulla
 *   POST  /api/admin/anni/[annoSedeId]/passaggio/conferma-tardiva
 *
 * Il database è finto ma REGISTRA tutto: ogni lettura (tabella e filtri), ogni scrittura (che qui NON deve mai avvenire: le scritture
 * stanno nelle funzioni SQL) e ogni RPC con i suoi argomenti. Il gate onora la lista dei ruoli che la route gli passa. Le RPC
 * rispondono come PostgREST (`{ data, error }` con `error.message` = codice e `error.details` = JSON dei conteggi). Solo uuid inventati.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const NUOVO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // l'anno con le iscrizioni aperte della SEDE_A
const ATTIVO_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // l'anno in corso della SEDE_A
const NUOVO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ATTIVO_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PASS = '77777777-7777-4777-8777-777777777777' // passaggi_anno.id verso NUOVO_A
const AL1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const AL2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const SEZ = '51515151-5151-4515-8515-515151515151'
const SEZ2 = '52525252-5252-4525-8525-525252525252'
const DOC = '61616161-6161-4616-8616-616161616161'
const FREQ = '81818181-8181-4818-8818-818181818181'
const PAG = '44444444-4444-4444-8444-444444444444'

type Esito = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }
type Query = { tabella: string; colonne?: string; filtri: Record<string, unknown>; range?: [number, number] }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  anni: {} as Record<string, { id: string; scuola_id: string; stato: string; ultimo_giorno_aperto?: string; inizio?: string }>,
  utenti: {} as Record<string, { id: string; ruolo: string; scuola_id: string | null }>,
  alunni: [] as Array<Record<string, unknown>>,
  /** I passaggi non annullati, per anno nuovo (`a_anno_sede_id`). */
  passaggi: {} as Record<string, unknown>,
  righe: [] as Array<Record<string, unknown>>,
  docenti: [] as Array<Record<string, unknown>>,
  /** Errori di lettura per tabella. */
  errLettura: {} as Record<string, { code?: string; message?: string }>,
  query: [] as Array<{ tabella: string; colonne?: string; filtri: Record<string, unknown>; range?: [number, number] }>,
  /** Ogni `insert|update|delete|upsert` su qualunque tabella: qui non deve mai comparirne una. */
  scritture: [] as Array<{ tabella: string; metodo: string }>,
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
      b.select = (colonne?: string) => {
        q.colonne = colonne
        return b
      }
      for (const metodo of ['insert', 'update', 'delete', 'upsert']) {
        b[metodo] = () => {
          h.scritture.push({ tabella, metodo })
          return b
        }
      }
      b.order = () => b
      b.in = (c: string, vs: unknown[]) => {
        q.filtri[`in:${c}`] = vs
        cond.push((r) => vs.includes(r[c]))
        return b
      }
      b.limit = () => b
      b.eq = (c: string, v: unknown) => {
        q.filtri[c] = v
        cond.push((r) => r[c] === v)
        return b
      }
      b.neq = (c: string, v: unknown) => {
        q.filtri[`neq:${c}`] = v
        return b
      }
      b.range = (da: number, a: number) => {
        q.range = [da, a]
        return b
      }
      b.maybeSingle = async () => {
        const errore = h.errLettura[tabella]
        if (errore) return { data: null, error: errore }
        if (tabella === 'anni_sede') return { data: h.anni[String(q.filtri.id ?? '')] ?? null, error: null }
        if (tabella === 'utenti') return { data: h.utenti[String(q.filtri.id ?? '')] ?? null, error: null }
        if (tabella === 'passaggi_anno') return { data: h.passaggi[String(q.filtri.a_anno_sede_id ?? '')] ?? null, error: null }
        return { data: null, error: null }
      }
      b.then = (ok: (v: unknown) => unknown) => {
        const errore = h.errLettura[tabella]
        if (errore) return Promise.resolve({ data: null, error: errore, count: null }).then(ok)
        const sorgente = tabella === 'passaggi_anno_righe' ? h.righe : tabella === 'passaggi_anno_docenti' ? h.docenti : tabella === 'alunni' ? h.alunni : []
        let r = sorgente.filter((x) => cond.every((c) => c(x)))
        const totale = r.length
        if (q.range) r = r.slice(q.range[0], q.range[1] + 1)
        return Promise.resolve({ data: r, error: null, count: totale }).then(ok)
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
import { GET as passaggioGET, POST as passaggioPOST } from '@/app/api/admin/anni/[annoSedeId]/passaggio/route'
import { PUT as righePUT } from '@/app/api/admin/anni/[annoSedeId]/passaggio/righe/route'
import { PUT as docentiPUT } from '@/app/api/admin/anni/[annoSedeId]/passaggio/docenti/route'
import { POST as confermaPOST } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma/route'
import { POST as annullaPOST } from '@/app/api/admin/anni/[annoSedeId]/passaggio/annulla/route'
import { POST as tardivaPOST } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma-tardiva/route'
import { GET as nomiGET } from '@/app/api/admin/anni/[annoSedeId]/passaggio/nomi/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const url = (parte = '', id = NUOVO_A) => `http://localhost/api/admin/anni/${id}/passaggio${parte}`
const conCorpo = (metodo: 'POST' | 'PUT', corpo: unknown) =>
  ({ method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as const

const leggi = (query = '', id = NUOVO_A) => passaggioGET(new Request(url(query, id)) as never, contesto(id) as never)
const anteprima = (corpo: unknown = { azione: 'anteprima' }, id = NUOVO_A) =>
  passaggioPOST(new Request(url('', id), conCorpo('POST', corpo)) as never, contesto(id) as never)
const correggi = (corpo: unknown, id = NUOVO_A) =>
  righePUT(new Request(url('/righe', id), conCorpo('PUT', corpo)) as never, contesto(id) as never)
const docente = (corpo: unknown, id = NUOVO_A) =>
  docentiPUT(new Request(url('/docenti', id), conCorpo('PUT', corpo)) as never, contesto(id) as never)
const conferma = (corpo: unknown = {}, id = NUOVO_A) =>
  confermaPOST(new Request(url('/conferma', id), conCorpo('POST', corpo)) as never, contesto(id) as never)
const annulla = (corpo: unknown = {}, id = NUOVO_A) =>
  annullaPOST(new Request(url('/annulla', id), conCorpo('POST', corpo)) as never, contesto(id) as never)
const tardiva = (corpo: unknown, id = NUOVO_A) =>
  tardivaPOST(new Request(url('/conferma-tardiva', id), conCorpo('POST', corpo)) as never, contesto(id) as never)

const ok = (data: unknown): Esito => ({ data, error: null })
const rifiuto = (message: string, details: unknown = null, code = 'P0001'): Esito => ({
  data: null,
  error: { code, message, details: details === null ? null : JSON.stringify(details) },
})

const eventi = (tipo: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo)

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.anni = {
    [NUOVO_A]: { id: NUOVO_A, scuola_id: SEDE_A, stato: 'iscrizioni_aperte', inizio: '2027-09-15' },
    [ATTIVO_A]: { id: ATTIVO_A, scuola_id: SEDE_A, stato: 'corrente', ultimo_giorno_aperto: '2027-07-31' },
    [NUOVO_B]: { id: NUOVO_B, scuola_id: SEDE_B, stato: 'iscrizioni_aperte' },
    [ATTIVO_B]: { id: ATTIVO_B, scuola_id: SEDE_B, stato: 'corrente', ultimo_giorno_aperto: '2027-07-31' },
  }
  h.passaggi = {
    [NUOVO_A]: { id: PASS, stato: 'anteprima', conteggi: { continua: 2, esce: 1 }, da_anno_sede_id: ATTIVO_A },
  }
  h.righe = []
  h.docenti = []
  h.utenti = { [DOC]: { id: DOC, ruolo: 'docente', scuola_id: SEDE_A } }
  h.alunni = []
  h.errLettura = {}
  h.query = []
  h.scritture = []
  h.rpc = []
  h.esiti = {
    anno_attivo: ok(ATTIVO_A),
    passaggio_anteprima: ok({
      passaggio_id: PASS,
      creato: true,
      righe: { continua: 2, cambia_grado: 0, nuova: 1, esce: 1, non_risposto: 0 },
      avvisi: { ritirato_tendina: 0, senza_sezione: 1 },
      docenti: { copiati: 3 },
      apribile_dal: '2027-08-01',
    }),
    passaggio_riga_correggi: ok({ alunno_id: AL1, esito: 'esce', eccezione: true }),
    passaggio_docente_imposta: ok({ utente_id: DOC, sezione_a_id: SEZ, origine: 'aggiunta' }),
    passaggio_conferma: ok({
      passaggio_id: PASS,
      gia_confermato: false,
      conteggi: { continuano: 2, nuovi: 1, usciti: 1, cambia_grado: 0, docenti_copiati: 3 },
    }),
    passaggio_annulla: ok({ passaggio_id: PASS, conteggi: { ripristinati: 4 } }),
    passaggio_conferma_tardiva: ok({ frequenza_id: FREQ, creata: true, quota: 'creata', pagamento_id: PAG }),
  }
  h.gateAmmessi = null
  h.log = []
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate, uuid, perimetro: uguali per tutte le chiamate
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CORPO_RIGA = { alunno_id: AL1, esito: 'esce' }
const CORPO_DOCENTE = { utente_id: DOC, section_id: SEZ, origine: 'aggiunta' }
const CORPO_TARDIVA = { alunno_id: AL1 }
const CHIAMATE: Array<[string, (id?: string) => Promise<Response>]> = [
  ['GET passaggio', (id) => leggi('', id)],
  ['POST passaggio (anteprima)', (id) => anteprima(undefined, id)],
  ['PUT righe', (id) => correggi(CORPO_RIGA, id)],
  ['PUT docenti', (id) => docente(CORPO_DOCENTE, id)],
  ['POST conferma', (id) => conferma({}, id)],
  ['POST annulla', (id) => annulla({}, id)],
  ['POST conferma-tardiva', (id) => tardiva(CORPO_TARDIVA, id)],
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

// Le cinque scritture che agiscono su UN passaggio: lo trovano dal server (l'anno dell'URL), il corpo non lo nomina mai.
const SCRITTURE_SU_PASSAGGIO: Array<[string, (id?: string) => Promise<Response>, string]> = [
  ['PUT righe', (id) => correggi(CORPO_RIGA, id), 'passaggio_riga_correggi'],
  ['PUT docenti', (id) => docente(CORPO_DOCENTE, id), 'passaggio_docente_imposta'],
  ['POST conferma', (id) => conferma({}, id), 'passaggio_conferma'],
  ['POST annulla', (id) => annulla({}, id), 'passaggio_annulla'],
  ['POST conferma-tardiva', (id) => tardiva(CORPO_TARDIVA, id), 'passaggio_conferma_tardiva'],
]

describe.each(SCRITTURE_SU_PASSAGGIO)('il passaggio lo decide il server — %s', (_nome, chiama, rpc) => {
  it('passa alla funzione l’uuid del passaggio dell’anno dell’URL e p_da = l’utente del token', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveLength(1)
    expect(h.rpc[0].nome).toBe(rpc)
    expect(h.rpc[0].args.p_passaggio).toBe(PASS)
    expect(h.rpc[0].args.p_da).toBe(UTENTE)
    // mai un giorno «oggi» dal client: la funzione usa il giorno di Roma
    expect(Object.keys(h.rpc[0].args)).not.toContain('p_oggi')
  })

  it('404 PASSAGGIO_NON_TROVATO, senza chiamare la funzione, se l’anno non ha un passaggio', async () => {
    h.passaggi = {}
    const res = await chiama()
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_TROVATO')
    expect(h.rpc).toEqual([])
  })

  it('503 quando la lettura del passaggio trova lo schema indietro', async () => {
    h.errLettura.passaggi_anno = { code: 'PGRST205', message: 'tabella assente' }
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(h.rpc).toEqual([])
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])
  })

  it('503 e `info` quando la funzione non esiste ancora (database indietro)', async () => {
    h.esiti[rpc] = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const res = await chiama()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])
    expect(eventi('passaggio-schema-indietro').length).toBeGreaterThan(0)
  })

  it('500 SCRITTURA_FALLITA per un guasto qualunque, con il solo codice di Postgres nel log', async () => {
    h.esiti[rpc] = { data: null, error: { code: '23514', message: 'new row for relation "x" violates check: Mario Rossi' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(h.log)).not.toContain('Mario Rossi')
  })

  it('nessuna scrittura diretta su `passaggi_anno*` (né su altre tabelle): scrivono solo le funzioni SQL', async () => {
    await chiama()
    expect(h.scritture).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET — la lettura
// ─────────────────────────────────────────────────────────────────────────────────────────────

function datiDelPassaggio() {
  h.righe = [
    // le colonne in più (nome, cognome, codice fiscale, note) non devono uscire MAI: il database finto le tiene apposta
    {
      passaggio_id: PASS, alunno_id: AL1, esito: 'continua', avviso: null, eccezione: false, sezione_da_id: SEZ, sezione_a_id: SEZ2,
      frequenza_a_id: null, nome: 'NOME-FINTO', cognome: 'COGNOME-FINTO', codice_fiscale: 'CF-FINTO', note: 'NOTA-FINTA',
    },
    {
      passaggio_id: PASS, alunno_id: AL2, esito: 'esce', avviso: 'ritirato_tendina', eccezione: true, sezione_da_id: SEZ, sezione_a_id: null,
      frequenza_a_id: FREQ, nome: 'NOME-FINTO-2', cognome: 'COGNOME-FINTO-2', codice_fiscale: 'CF-FINTO-2', note: 'NOTA-FINTA-2',
    },
  ]
  h.docenti = [{ passaggio_id: PASS, utente_id: DOC, sezione_a_id: SEZ2, origine: 'copiata', email: 'docente@esempio.invalid' }]
}

describe('GET passaggio', () => {
  it('ritorna il passaggio, le righe della pagina, il totale e i docenti: solo uuid e stati', async () => {
    datiDelPassaggio()
    const res = await leggi()
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo.data.passaggio).toEqual({
      id: PASS, stato: 'anteprima', conteggi: { continua: 2, esce: 1 }, apribile_dal: '2027-08-01', inizio_anno_nuovo: '2027-09-15',
    })
    expect(corpo.data.totale).toBe(2)
    expect(corpo.data.pagina).toBe(1)
    expect(corpo.data.righe).toHaveLength(2)
    expect(corpo.data.righe[0]).toEqual({
      alunno_id: AL1, esito: 'continua', avviso: null, eccezione: false, sezione_da_id: SEZ, sezione_a_id: SEZ2, frequenza_a_id: null,
    })
    expect(corpo.data.docenti).toEqual([{ utente_id: DOC, sezione_a_id: SEZ2, origine: 'copiata' }])
  })

  it('non ritorna nomi, cognomi, codici fiscali né note, e non legge neppure la tabella degli alunni', async () => {
    datiDelPassaggio()
    const testo = JSON.stringify(await (await leggi()).json())
    for (const vietato of ['NOME-FINTO', 'COGNOME-FINTO', 'CF-FINTO', 'NOTA-FINTA', 'esempio.invalid', '"nome"', '"cognome"', 'codice_fiscale']) {
      expect(testo).not.toContain(vietato)
    }
    expect(h.query.map((x) => x.tabella)).not.toContain('alunni')
    expect(h.query.map((x) => x.tabella)).not.toContain('utenti')
  })

  it('senza passaggio: 200 con `passaggio: null` (la pagina propone di calcolare l’anteprima)', async () => {
    h.passaggi = {}
    const res = await leggi()
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.passaggio).toBeNull()
    expect(corpo.data.righe).toEqual([])
    expect(corpo.data.totale).toBe(0)
  })

  it('i filtri `esito` e `avviso` arrivano alla lettura; il tetto e la pagina fanno l’intervallo', async () => {
    datiDelPassaggio()
    await leggi('?esito=esce&avviso=ritirato_tendina&tetto=50&pagina=3')
    const righe = h.query.find((x) => x.tabella === 'passaggi_anno_righe')
    expect(righe?.filtri.esito).toBe('esce')
    expect(righe?.filtri.avviso).toBe('ritirato_tendina')
    expect(righe?.range).toEqual([100, 149])
  })

  it('senza filtri la pagina predefinita è la prima', async () => {
    datiDelPassaggio()
    const corpo = await (await leggi()).json()
    expect(corpo.data.pagina).toBe(1)
    const righe = h.query.find((x) => x.tabella === 'passaggi_anno_righe')
    expect(righe?.filtri.esito).toBeUndefined()
    expect(righe?.filtri.avviso).toBeUndefined()
    expect(righe?.range?.[0]).toBe(0)
  })

  it.each([
    ['un esito fuori elenco', '?esito=boh'],
    ['un avviso fuori elenco', '?avviso=boh'],
    ['una pagina zero', '?pagina=0'],
    ['un tetto oltre il massimo', '?tetto=5000'],
  ])('400 per %s, senza leggere il passaggio', async (_nome, query) => {
    const res = await leggi(query)
    expect(res.status).toBe(400)
    expect(h.query.map((x) => x.tabella)).not.toContain('passaggi_anno_righe')
  })

  it('scrive il log `info` della lettura con soli uuid e numeri', async () => {
    datiDelPassaggio()
    await leggi()
    const e = eventi('passaggio-letto')
    expect(e).toHaveLength(1)
    expect(e[0].livello).toBe('info')
    expect(e[0].campi.n).toBe(2)
    expect(e[0].campi.anno_sede_id).toBe(NUOVO_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST — l'anteprima
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST passaggio (anteprima)', () => {
  it('l’anno di partenza è l’anno attivo della sede, letto dal server; p_da è l’utente del token; nessun p_oggi', async () => {
    const res = await anteprima()
    expect(res.status).toBe(200)
    const attivo = h.rpc.find((r) => r.nome === 'anno_attivo')
    expect(attivo?.args).toEqual({ p_scuola: SEDE_A })
    const chiamata = h.rpc.find((r) => r.nome === 'passaggio_anteprima')
    expect(chiamata?.args).toEqual({ p_da_anno_sede: ATTIVO_A, p_a_anno_sede: NUOVO_A, p_da: UTENTE })
    const corpo = await res.json()
    expect(corpo.data.passaggio_id).toBe(PASS)
    expect(corpo.data.creato).toBe(true)
    expect(corpo.data.righe.continua).toBe(2)
    expect(corpo.data.apribile_dal).toBe('2027-08-01')
  })

  it.each([
    ['un anno di partenza dal corpo', { azione: 'anteprima', da_anno_sede: ATTIVO_B }],
    ['un giorno «oggi» dal corpo', { azione: 'anteprima', oggi: '2027-08-01' }],
    ['un’azione che non esiste', { azione: 'conferma' }],
    ['un corpo vuoto', {}],
  ])('400 per %s', async (_nome, corpo) => {
    const res = await anteprima(corpo)
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('403 se l’anno attivo risulta di un’altra sede (anche l’anno di partenza è nel perimetro), senza chiamare la funzione', async () => {
    h.esiti.anno_attivo = ok(ATTIVO_B)
    const res = await anteprima()
    expect(res.status).toBe(403)
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo'])
  })

  it('409 PASSAGGIO_NON_PRONTO se la sede non ha un anno attivo, senza chiamare la funzione', async () => {
    h.esiti.anno_attivo = ok(null)
    const res = await anteprima()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_PRONTO')
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo'])
  })

  it('409 PASSAGGIO_NON_PRONTO se l’anno attivo è quello dell’URL', async () => {
    h.esiti.anno_attivo = ok(NUOVO_A)
    const res = await anteprima()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_PRONTO')
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo'])
  })

  it('409 PASSAGGIO_NON_PRONTO e 409 PASSAGGIO_GIA_CONFERMATO dalla funzione', async () => {
    h.esiti.passaggio_anteprima = rifiuto('PASSAGGIO_NON_PRONTO')
    const a = await anteprima()
    expect(a.status).toBe(409)
    expect((await a.json()).codice).toBe('PASSAGGIO_NON_PRONTO')
    h.esiti.passaggio_anteprima = rifiuto('PASSAGGIO_GIA_CONFERMATO')
    const b = await anteprima()
    expect(b.status).toBe(409)
    expect((await b.json()).codice).toBe('PASSAGGIO_GIA_CONFERMATO')
  })

  it('503 se `anno_attivo` non esiste ancora', async () => {
    h.esiti.anno_attivo = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const res = await anteprima()
    expect(res.status).toBe(503)
    expect(h.rpc.map((r) => r.nome)).toEqual(['anno_attivo'])
  })

  it('503 se `passaggio_anteprima` non esiste ancora', async () => {
    delete h.esiti.passaggio_anteprima
    const res = await anteprima()
    expect(res.status).toBe(503)
    expect(h.log.filter((l) => l.fn === 'errore')).toEqual([])
  })

  it('non scrive su nessuna tabella', async () => {
    await anteprima()
    expect(h.scritture).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PUT righe
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PUT passaggio/righe', () => {
  it('passa alla funzione bambino, esito e sezione; la risposta riporta la riga corretta', async () => {
    const res = await correggi({ alunno_id: AL1, esito: 'continua', section_id: SEZ2 })
    expect(res.status).toBe(200)
    expect(h.rpc[0].args).toEqual({ p_passaggio: PASS, p_alunno: AL1, p_esito: 'continua', p_sezione: SEZ2, p_da: UTENTE })
    expect((await res.json()).data).toEqual({ alunno_id: AL1, esito: 'esce', eccezione: true })
  })

  it('la sezione è facoltativa: assente = null', async () => {
    await correggi({ alunno_id: AL1, esito: 'esce' })
    expect(h.rpc[0].args.p_sezione).toBeNull()
  })

  it.each([
    ['un esito fuori elenco', { alunno_id: AL1, esito: 'boh' }],
    ['un bambino che non è un uuid', { alunno_id: 'x', esito: 'esce' }],
    ['una sezione che non è un uuid', { alunno_id: AL1, esito: 'continua', section_id: 'x' }],
    ['l’uuid del passaggio nel corpo (lo decide il server)', { alunno_id: AL1, esito: 'esce', passaggio_id: PASS }],
    ['un campo in più', { alunno_id: AL1, esito: 'esce', da: UTENTE }],
    ['un corpo vuoto', {}],
  ])('400 per %s', async (_nome, corpo) => {
    const res = await correggi(corpo)
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('422 RIGA_NON_VALIDA, 409 PASSAGGIO_NON_MODIFICABILE, 422 SEZIONE_DI_ALTRO_ANNO dalla funzione', async () => {
    h.esiti.passaggio_riga_correggi = rifiuto('RIGA_NON_VALIDA')
    const a = await correggi(CORPO_RIGA)
    expect(a.status).toBe(422)
    expect((await a.json()).codice).toBe('RIGA_NON_VALIDA')
    h.esiti.passaggio_riga_correggi = rifiuto('PASSAGGIO_NON_MODIFICABILE')
    const b = await correggi(CORPO_RIGA)
    expect(b.status).toBe(409)
    expect((await b.json()).codice).toBe('PASSAGGIO_NON_MODIFICABILE')
    h.esiti.passaggio_riga_correggi = rifiuto('SEZIONE_DI_ALTRO_ANNO')
    const c = await correggi(CORPO_RIGA)
    expect(c.status).toBe(422)
    expect((await c.json()).codice).toBe('SEZIONE_DI_ALTRO_ANNO')
  })

  it('404 PASSAGGIO_NON_TROVATO dalla funzione (il passaggio è sparito fra la lettura e la scrittura)', async () => {
    h.esiti.passaggio_riga_correggi = rifiuto('PASSAGGIO_NON_TROVATO', { campo: 'passaggio' })
    const res = await correggi(CORPO_RIGA)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_TROVATO')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PUT docenti
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PUT passaggio/docenti', () => {
  // Giro 1, B5: si aggiunge solo personale DI QUESTA SEDE e non un genitore; togliere non controlla (chi è in elenco si toglie sempre).
  it.each([
    ['un genitore', { id: DOC, ruolo: 'genitore', scuola_id: SEDE_A }],
    ['un collega di un’altra sede', { id: DOC, ruolo: 'docente', scuola_id: SEDE_B }],
    ['una persona senza sede', { id: DOC, ruolo: 'docente', scuola_id: null }],
  ])('422 DOCENTE_NON_VALIDO per %s: la funzione non viene chiamata', async (_nome, utente) => {
    h.utenti = { [DOC]: utente }
    const res = await docente(CORPO_DOCENTE)
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('DOCENTE_NON_VALIDO')
    expect(h.rpc).toHaveLength(0)
  })

  it('422 DOCENTE_NON_VALIDO per un uuid che non è nessuno', async () => {
    h.utenti = {}
    const res = await docente(CORPO_DOCENTE)
    expect(res.status).toBe(422)
    expect(h.rpc).toHaveLength(0)
  })

  it('«tolta» non controlla chi è: un genitore finito per errore in elenco si toglie', async () => {
    h.utenti = { [DOC]: { id: DOC, ruolo: 'genitore', scuola_id: SEDE_B } }
    const res = await docente({ ...CORPO_DOCENTE, origine: 'tolta' })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveLength(1)
  })

  it('passa alla funzione docente, sezione e origine', async () => {
    const res = await docente(CORPO_DOCENTE)
    expect(res.status).toBe(200)
    expect(h.rpc[0].args).toEqual({ p_passaggio: PASS, p_utente: DOC, p_sezione: SEZ, p_origine: 'aggiunta', p_da: UTENTE })
    expect((await res.json()).data).toEqual({ utente_id: DOC, sezione_a_id: SEZ, origine: 'aggiunta' })
  })

  it.each([
    ['un’origine fuori elenco', { utente_id: DOC, section_id: SEZ, origine: 'copiata' }],
    ['un’origine che non esiste', { utente_id: DOC, section_id: SEZ, origine: 'boh' }],
    ['una sezione mancante', { utente_id: DOC, origine: 'tolta' }],
    ['un docente che non è un uuid', { utente_id: 'x', section_id: SEZ, origine: 'tolta' }],
    ['l’uuid del passaggio nel corpo', { utente_id: DOC, section_id: SEZ, origine: 'tolta', passaggio_id: PASS }],
  ])('400 per %s', async (_nome, corpo) => {
    const res = await docente(corpo)
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('409 PASSAGGIO_NON_MODIFICABILE dalla funzione (il passaggio non è più in anteprima)', async () => {
    h.esiti.passaggio_docente_imposta = rifiuto('PASSAGGIO_NON_MODIFICABILE', { passaggio_id: 1 })
    const res = await docente(CORPO_DOCENTE)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_MODIFICABILE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST conferma
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST passaggio/conferma', () => {
  it('passa SOLO il passaggio e p_da = l’utente del token (esattamente questi argomenti)', async () => {
    const res = await conferma({})
    expect(res.status).toBe(200)
    expect(h.rpc).toEqual([{ nome: 'passaggio_conferma', args: { p_passaggio: PASS, p_da: UTENTE } }])
    const corpo = await res.json()
    expect(corpo.data).toEqual({
      passaggio_id: PASS,
      gia_confermato: false,
      conteggi: { continuano: 2, nuovi: 1, usciti: 1, cambia_grado: 0, docenti_copiati: 3 },
    })
  })

  it.each([
    ['un giorno «oggi» dal client', { oggi: '2027-08-01' }],
    ['l’uuid del passaggio', { passaggio_id: PASS }],
    ['un «da» che nomina un altro utente', { da: AL1 }],
  ])('400 per %s: il client non decide né il giorno né chi agisce né quale passaggio', async (_nome, corpo) => {
    const res = await conferma(corpo)
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('rifatta su un passaggio già confermato: 200 con gia_confermato', async () => {
    h.esiti.passaggio_conferma = ok({ passaggio_id: PASS, gia_confermato: true, conteggi: { continuano: 2 } })
    const res = await conferma({})
    expect(res.status).toBe(200)
    expect((await res.json()).data.gia_confermato).toBe(true)
  })

  it('409 PASSAGGIO_TROPPO_PRESTO con i giorni che mancano', async () => {
    h.esiti.passaggio_conferma = rifiuto('PASSAGGIO_TROPPO_PRESTO', { giorni_mancanti: 12 })
    const res = await conferma({})
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PASSAGGIO_TROPPO_PRESTO')
    expect(corpo.giorni_mancanti).toBe(12)
  })

  it('409 PASSAGGIO_NON_PRONTO', async () => {
    h.esiti.passaggio_conferma = rifiuto('PASSAGGIO_NON_PRONTO')
    const res = await conferma({})
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PASSAGGIO_NON_PRONTO')
  })

  it('409 ANTEPRIMA_VECCHIA con il numero di righe diverse dal ricalcolo', async () => {
    h.esiti.passaggio_conferma = rifiuto('ANTEPRIMA_VECCHIA', { righe_diverse: 3 })
    const res = await conferma({})
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ANTEPRIMA_VECCHIA')
    expect(corpo.righe_diverse).toBe(3)
  })

  it('409 RIGHE_DA_DECIDERE con i conteggi (senza classe e con avviso aperto)', async () => {
    h.esiti.passaggio_conferma = rifiuto('RIGHE_DA_DECIDERE', { senza_sezione: 2, ritirato_tendina: 1 })
    const res = await conferma({})
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('RIGHE_DA_DECIDERE')
    expect(corpo.senza_sezione).toBe(2)
    expect(corpo.ritirato_tendina).toBe(1)
  })

  it('404 PASSAGGIO_NON_TROVATO e 409 PASSAGGIO_NON_MODIFICABILE dalla funzione', async () => {
    h.esiti.passaggio_conferma = rifiuto('PASSAGGIO_NON_TROVATO', { campo: 'passaggio' })
    expect((await conferma({})).status).toBe(404)
    h.esiti.passaggio_conferma = rifiuto('PASSAGGIO_NON_MODIFICABILE', { passaggio_id: 1 })
    expect((await conferma({})).status).toBe(409)
  })

  it('i dettagli del DETAIL che non sono numeri non finiscono nella risposta', async () => {
    h.esiti.passaggio_conferma = rifiuto('RIGHE_DA_DECIDERE', { senza_sezione: 2, nota: 'testo libero', Altro: 5 })
    const corpo = await (await conferma({})).json()
    expect(corpo.senza_sezione).toBe(2)
    expect(JSON.stringify(corpo)).not.toContain('testo libero')
    expect(corpo.Altro).toBeUndefined()
  })

  it('il log del successo ha soli uuid, codici e numeri: nessun nome', async () => {
    await conferma({})
    const e = eventi('passaggio-confermato')
    expect(e).toHaveLength(1)
    expect(e[0].livello).toBe('info')
    expect(e[0].campi.entita_id).toBe(PASS)
    expect(e[0].campi.n).toBe(4)
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const l of h.log.filter((x) => x.fn === 'evento')) {
      for (const [chiave, valore] of Object.entries(l.args[2] as Record<string, unknown>)) {
        const lecito =
          typeof valore === 'number' ||
          typeof valore === 'boolean' ||
          valore === undefined ||
          (typeof valore === 'string' && (UUID.test(valore) || /^[a-z0-9_:/\-[\]]+$/i.test(valore)))
        expect(lecito, `chiave ${chiave}`).toBe(true)
      }
      // la lista bianca del logger non cambia nulla di ciò che le route scrivono
      const campi = l.args[2] as Record<string, unknown>
      expect(redact(campi)).toEqual(campi)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST annulla
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST passaggio/annulla', () => {
  it('passa SOLO il passaggio e p_da = l’utente del token', async () => {
    const res = await annulla({})
    expect(res.status).toBe(200)
    expect(h.rpc).toEqual([{ nome: 'passaggio_annulla', args: { p_passaggio: PASS, p_da: UTENTE } }])
    expect((await res.json()).data.passaggio_id).toBe(PASS)
  })

  it('400 con un giorno «oggi» dal client', async () => {
    expect((await annulla({ oggi: '2027-08-01' })).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('409 PASSAGGIO_NON_ANNULLABILE con i conteggi per tabella', async () => {
    h.esiti.passaggio_annulla = rifiuto('PASSAGGIO_NON_ANNULLABILE', { presenze: 4, diario_giornaliero: 1 })
    const res = await annulla({})
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PASSAGGIO_NON_ANNULLABILE')
    expect(corpo.conteggi).toEqual({ presenze: 4, diario_giornaliero: 1 })
  })

  it('rifatta su un passaggio già annullato: 200', async () => {
    h.esiti.passaggio_annulla = ok({ passaggio_id: PASS, gia_annullato: true })
    const res = await annulla({})
    expect(res.status).toBe(200)
    expect((await res.json()).data.gia_annullato).toBe(true)
  })

  it('il log del successo (`passaggio-annullato`) ha soli uuid e codici', async () => {
    await annulla({})
    const e = eventi('passaggio-annullato')
    expect(e).toHaveLength(1)
    expect(e[0].campi.entita_id).toBe(PASS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST conferma-tardiva
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST passaggio/conferma-tardiva', () => {
  it('passa passaggio, bambino, sezione (se data) e p_da = l’utente del token', async () => {
    const res = await tardiva({ alunno_id: AL1, section_id: SEZ2 })
    expect(res.status).toBe(200)
    expect(h.rpc).toEqual([
      { nome: 'passaggio_conferma_tardiva', args: { p_passaggio: PASS, p_alunno: AL1, p_section: SEZ2, p_da: UTENTE } },
    ])
    expect((await res.json()).data).toEqual({ frequenza_id: FREQ, creata: true, quota: 'creata', pagamento_id: PAG })
  })

  it('la sezione è facoltativa: assente = null (la continuazione della sezione di partenza)', async () => {
    await tardiva({ alunno_id: AL1 })
    expect(h.rpc[0].args.p_section).toBeNull()
  })

  it.each([
    ['un giorno «oggi» dal client', { alunno_id: AL1, oggi: '2027-09-01' }],
    ['un bambino mancante', {}],
    ['un bambino che non è un uuid', { alunno_id: 'x' }],
    ['una sezione che non è un uuid', { alunno_id: AL1, section_id: 'x' }],
    ['l’uuid del passaggio', { alunno_id: AL1, passaggio_id: PASS }],
  ])('400 per %s', async (_nome, corpo) => {
    const res = await tardiva(corpo)
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('422 RIGA_NON_VALIDA e 409 PASSAGGIO_NON_PRONTO dalla funzione', async () => {
    h.esiti.passaggio_conferma_tardiva = rifiuto('RIGA_NON_VALIDA')
    const a = await tardiva(CORPO_TARDIVA)
    expect(a.status).toBe(422)
    expect((await a.json()).codice).toBe('RIGA_NON_VALIDA')
    h.esiti.passaggio_conferma_tardiva = rifiuto('PASSAGGIO_NON_PRONTO')
    const b = await tardiva(CORPO_TARDIVA)
    expect(b.status).toBe(409)
    expect((await b.json()).codice).toBe('PASSAGGIO_NON_PRONTO')
  })

  it('il log del successo (`passaggio-conferma-tardiva`) ha soli uuid e numeri', async () => {
    await tardiva(CORPO_TARDIVA)
    const e = eventi('passaggio-conferma-tardiva')
    expect(e).toHaveLength(1)
    expect(e[0].campi.entita_id).toBe(FREQ)
    expect(e[0].campi.n).toBe(1)
  })
})


// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET nomi (giro 1, S20) e contatori nella GET principale (S19)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET passaggio/nomi', () => {
  const AL_IN = '88888888-8888-4888-8888-888888888881'
  const AL_FUORI = '88888888-8888-4888-8888-888888888882'
  const chiedi = (ids: string, id = NUOVO_A) => nomiGET(new Request(url(`/nomi?ids=${ids}`, id)) as never, contesto(id) as never)

  beforeEach(() => {
    h.righe = [{ passaggio_id: PASS, alunno_id: AL_IN, esito: 'continua' }]
    h.alunni = [
      { id: AL_IN, nome: 'Prova', cognome: 'Finto', classe_sezione: 'Classe X', codice_fiscale: 'NON-DEVE-USCIRE', note_mediche: 'NON-DEVE-USCIRE' },
      { id: AL_FUORI, nome: 'Altro', cognome: 'Finto', classe_sezione: 'Classe Y' },
    ]
  })

  it('dà solo nome, cognome e classe, e solo di chi ha una riga in questo passaggio', async () => {
    const res = await chiedi(`${AL_IN},${AL_FUORI}`)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data).toEqual([{ id: AL_IN, nome: 'Prova', cognome: 'Finto', classe: 'Classe X' }])
    expect(JSON.stringify(corpo)).not.toContain('NON-DEVE-USCIRE')
    expect(h.query.filter((q) => q.tabella === 'alunni').map((q) => q.colonne)).toEqual(['id, nome, cognome, classe_sezione'])
  })

  it('400 senza ids, con più di 200 uuid o con un valore che non è un uuid; 403 fuori sede; 403 al ruolo sbagliato', async () => {
    expect((await chiedi('')).status).toBe(400)
    expect((await chiedi('non-un-uuid')).status).toBe(400)
    expect((await chiedi(Array.from({ length: 201 }, (_, i) => `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`).join(','))).status).toBe(400)
    expect((await chiedi(AL_IN, NUOVO_B)).status).toBe(403)
    h.user = { id: UTENTE, role: 'genitore', scuola_id: SEDE_A }
    expect((await chiedi(AL_IN)).status).toBe(403)
  })

  it('nessun passaggio: 404, e nessuna lettura dei nomi', async () => {
    h.passaggi = {}
    const res = await chiedi(AL_IN)
    expect(res.status).toBe(404)
    expect(h.query.some((q) => q.tabella === 'alunni')).toBe(false)
  })
})

describe('GET passaggio con ?contatori=N', () => {
  it('porta nella stessa risposta i numeri per esito, per avviso e le prime righe da decidere', async () => {
    h.righe = [
      { passaggio_id: PASS, alunno_id: 'a1', esito: 'continua', avviso: null },
      { passaggio_id: PASS, alunno_id: 'a2', esito: 'esce', avviso: null },
      { passaggio_id: PASS, alunno_id: 'a3', esito: 'cambia_grado', avviso: 'senza_sezione' },
      { passaggio_id: PASS, alunno_id: 'a4', esito: 'continua', avviso: 'ritirato_tendina' },
    ]
    const res = await leggi('?pagina=1&tetto=1&contatori=50')
    expect(res.status).toBe(200)
    const { contatori } = (await res.json()).data
    expect(contatori.esiti).toEqual({ continua: 2, cambia_grado: 1, nuova: 0, esce: 1, non_risposto: 0 })
    expect(contatori.avvisi).toEqual({ ritirato_tendina: 1, senza_sezione: 1 })
    expect(contatori.daDecidere.map((r: { alunno_id: string }) => r.alunno_id).sort()).toEqual(['a3', 'a4'])
  })

  it('senza il parametro la risposta non porta i contatori; con 0 o 201 è un 400', async () => {
    expect((await (await leggi('?pagina=1&tetto=1')).json()).data.contatori).toBeUndefined()
    expect((await leggi('?contatori=0')).status).toBe(400)
    expect((await leggi('?contatori=201')).status).toBe(400)
  })
})
