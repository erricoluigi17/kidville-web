import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.5.3 · le route che preparano l'anno prossimo:
 *   GET|PUT          /api/admin/anni/[annoSedeId]/quote
 *   GET|PUT|DELETE   /api/admin/anni/[annoSedeId]/moduli
 *   GET|PUT          /api/admin/anni/[annoSedeId]/posti
 *   POST             /api/admin/anni/[annoSedeId]/sezioni
 *
 * Il database è finto, ma in modo che il test sia sensibile al codice: il gate onora la lista dei ruoli che la route gli
 * passa, il perimetro legge davvero la riga di `anni_sede`, ogni RPC risponde come PostgREST (`{ data, error }` con
 * `error.message` = codice) e registra gli argomenti con cui è stata chiamata. Importi e titoli sono esempi di prova.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const ANNO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // anni_sede.id della SEDE_A (l'anno che si prepara)
const ANNO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' // anni_sede.id della SEDE_B
const ATTIVO_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // l'anno in corso della SEDE_A
const UTENTE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Esito = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }
type Riga = { id: string; scuola_id: string }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  righe: {} as Record<string, Riga>,
  tabelle: {} as Record<string, unknown[]>,
  letturaTabella: null as null | { code?: string; message?: string },
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esiti: {} as Record<string, Esito>,
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
      const b: Record<string, unknown> = {}
      let id = ''
      b.select = () => b
      b.order = () => b
      b.eq = (_c: string, v: string) => {
        id = v
        return b
      }
      b.maybeSingle = async () => ({ data: h.righe[id] ?? null, error: null })
      // la lettura di una tabella (`await supabase.from(t).select().eq().order()`): thenable
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(
          tabella === 'anni_sede'
            ? { data: null, error: null }
            : h.letturaTabella
              ? { data: null, error: h.letturaTabella }
              : { data: h.tabelle[tabella] ?? [], error: null },
        ).then(ok)
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
import { GET as quoteGET, PUT as quotePUT } from '@/app/api/admin/anni/[annoSedeId]/quote/route'
import { GET as moduliGET, PUT as moduliPUT, DELETE as moduliDELETE } from '@/app/api/admin/anni/[annoSedeId]/moduli/route'
import { GET as postiGET, PUT as postiPUT } from '@/app/api/admin/anni/[annoSedeId]/posti/route'
import { POST as sezioniPOST } from '@/app/api/admin/anni/[annoSedeId]/sezioni/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const url = (parte: string, id = ANNO_A) => `http://localhost/api/admin/anni/${id}/${parte}`
const conCorpo = (metodo: string, corpo: unknown) =>
  ({ method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as const

const leggiQuote = (id = ANNO_A) => quoteGET(new Request(url('quote', id)) as never, contesto(id) as never)
const scriviQuote = (corpo: unknown, id = ANNO_A) =>
  quotePUT(new Request(url('quote', id), conCorpo('PUT', corpo)) as never, contesto(id) as never)
const leggiModuli = (id = ANNO_A) => moduliGET(new Request(url('moduli', id)) as never, contesto(id) as never)
const scriviModulo = (corpo: unknown, id = ANNO_A) =>
  moduliPUT(new Request(url('moduli', id), conCorpo('PUT', corpo)) as never, contesto(id) as never)
const togliModulo = (query = '?lista=conferma&codice=privacy', id = ANNO_A) =>
  moduliDELETE(new Request(url(`moduli${query}`, id), { method: 'DELETE' }) as never, contesto(id) as never)
const leggiPosti = (id = ANNO_A) => postiGET(new Request(url('posti', id)) as never, contesto(id) as never)
const scriviPosti = (corpo: unknown, id = ANNO_A) =>
  postiPUT(new Request(url('posti', id), conCorpo('PUT', corpo)) as never, contesto(id) as never)
const copiaSezioni = (id = ANNO_A) =>
  sezioniPOST(new Request(url('sezioni', id), { method: 'POST' }) as never, contesto(id) as never)

const ok = (data: unknown): Esito => ({ data, error: null })
const rifiuto = (message: string, details?: unknown, code = 'P0001'): Esito => ({
  data: null,
  error: { code, message, details: details === undefined ? null : JSON.stringify(details) },
})

const eventi = (tipo: string, livello?: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo && (livello === undefined || e.livello === livello))

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.righe = { [ANNO_A]: { id: ANNO_A, scuola_id: SEDE_A }, [ANNO_B]: { id: ANNO_B, scuola_id: SEDE_B } }
  h.tabelle = {}
  h.letturaTabella = null
  h.rpc = []
  h.esiti = {
    anno_listino_quota_imposta: ok({ cambiato: true }),
    anno_modulo_richiesto_imposta: ok({ cambiato: true }),
    anno_modulo_richiesto_togli: ok({ cambiato: true }),
    anno_posti_imposta: ok({ cambiato: true }),
    anno_attivo: ok(ATTIVO_A),
    anno_copia_sezioni: ok({ copiate: 2, gia_presenti: 1 }),
  }
  h.gateAmmessi = null
  h.log = []
})

const QUOTA = { voce: 'quota_conferma', fascia: null, importo: 120, scadenza: '2027-02-15' }
const MODULO = { lista: 'conferma', codice: 'privacy', titolo: 'Informativa di prova', ordine: 1 }
const POSTI = { fascia: 'infanzia', posti: 40, fonte: 'Autorizzazione di prova' }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate e perimetro: uguali per tutte le chiamate
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CHIAMATE: Array<[string, () => Promise<Response>]> = [
  ['GET quote', () => leggiQuote()],
  ['PUT quote', () => scriviQuote(QUOTA)],
  ['GET moduli', () => leggiModuli()],
  ['PUT moduli', () => scriviModulo(MODULO)],
  ['DELETE moduli', () => togliModulo()],
  ['GET posti', () => leggiPosti()],
  ['PUT posti', () => scriviPosti(POSTI)],
  ['POST sezioni', () => copiaSezioni()],
]

describe.each(CHIAMATE)('gate e perimetro — %s', (_nome, chiama) => {
  it('401 senza identità', async () => {
    h.user = null
    expect((await chiama()).status).toBe(401)
    expect(h.rpc).toEqual([])
  })

  it.each(['educator', 'genitore', 'cuoca'])('403 a un utente %s, senza toccare il database', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    expect((await chiama()).status).toBe(403)
    expect(h.rpc).toEqual([])
  })

  it('il gate ammette solo Direzione e segreteria', async () => {
    await chiama()
    expect([...(h.gateAmmessi ?? [])].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it.each(['admin', 'coordinator', 'segreteria'])('%s della sede passa il gate', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    expect((await chiama()).status).toBe(200)
  })

  it('403 SEDE_NON_ACCESSIBILE (con warn) a una segreteria che nomina l’anno di un’altra sede', async () => {
    h.righe[ANNO_A] = { id: ANNO_A, scuola_id: SEDE_B }
    const r = await chiama()
    expect(r.status).toBe(403)
    expect((await r.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.rpc).toEqual([]) // il database non è stato toccato
    expect(h.log.filter((l) => l.fn === 'evento' && l.args[1] === 'warn').length).toBeGreaterThanOrEqual(1)
  })

  it('404 ANNO_NON_TROVATO se l’id non esiste', async () => {
    h.righe = {}
    const r = await chiama()
    expect(r.status).toBe(404)
    expect((await r.json()).codice).toBe('ANNO_NON_TROVATO')
    expect(h.rpc).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Validazione: zod, prima di toccare il database
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('validazione del corpo', () => {
  it('400 se l’id non è un uuid', async () => {
    const r = await quoteGET(new Request(url('quote', 'x')) as never, contesto('non-un-uuid') as never)
    expect(r.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it.each([
    ['importo stringa', { ...QUOTA, importo: '120' }],
    ['importo mancante', { voce: 'quota_nuova' }],
    ['voce retta (la scrive la 4.6)', { ...QUOTA, voce: 'retta' }],
    ['fascia sconosciuta', { ...QUOTA, fascia: 'liceo' }],
    ['scadenza non valida', { ...QUOTA, scadenza: '2027-02-30' }],
    ['scadenza in un altro formato', { ...QUOTA, scadenza: '15/02/2027' }],
    ['un campo in più (la sede non è un campo)', { ...QUOTA, scuola_id: SEDE_B }],
  ])('quote: %s → 400, e il database non si tocca', async (_nome, corpo) => {
    const r = await scriviQuote(corpo)
    expect(r.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it.each([
    ['titolo oltre 120 caratteri', { ...MODULO, titolo: 'x'.repeat(121) }],
    ['titolo vuoto', { ...MODULO, titolo: '   ' }],
    ['codice con maiuscole e spazi', { ...MODULO, codice: 'Con Spazi' }],
    ['codice vuoto', { ...MODULO, codice: '' }],
    ['lista sconosciuta', { ...MODULO, lista: 'altra' }],
    ['ordine non intero', { ...MODULO, ordine: 1.5 }],
    ['un campo in più', { ...MODULO, descrizione: 'testo libero' }],
  ])('moduli: %s → 400', async (_nome, corpo) => {
    expect((await scriviModulo(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it.each([
    ['?lista=conferma', 'manca il codice'],
    ['?codice=privacy', 'manca la lista'],
    ['?lista=altra&codice=privacy', 'lista sconosciuta'],
    ['?lista=conferma&codice=Con%20Spazi', 'codice non valido'],
  ])('moduli DELETE %s (%s) → 400', async (query) => {
    expect((await togliModulo(query)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it.each([
    ['posti negativi', { ...POSTI, posti: -1 }],
    ['posti non interi', { ...POSTI, posti: 2.5 }],
    ['posti stringa', { ...POSTI, posti: '40' }],
    ['fascia sconosciuta', { ...POSTI, fascia: 'liceo' }],
    ['fonte oltre 200 caratteri', { ...POSTI, fonte: 'x'.repeat(201) }],
    ['posti mancanti', { fascia: 'infanzia' }],
  ])('posti: %s → 400', async (_nome, corpo) => {
    expect((await scriviPosti(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Il lavoro: argomenti delle funzioni, risposte, log del successo
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('quote', () => {
  it('PUT passa alla funzione l’anno dell’URL e ciò che c’è nel corpo, e logga il successo senza importo né scadenza', async () => {
    const r = await scriviQuote(QUOTA)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { cambiato: true } })
    expect(h.rpc).toEqual([
      {
        nome: 'anno_listino_quota_imposta',
        args: { p_anno_sede: ANNO_A, p_voce: 'quota_conferma', p_fascia: null, p_importo: 120, p_scadenza: '2027-02-15' },
      },
    ])
    const ev = eventi('anno-quota-impostata', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toEqual({ tipo: 'anno-quota-impostata', anno_sede_id: ANNO_A, utente: UTENTE, entita_tipo: 'quota_conferma', rimossa: false })
    const dopoRedazione = JSON.stringify(redact(ev[0].campi))
    expect(dopoRedazione).toContain(ANNO_A)
    expect(JSON.stringify(h.log)).not.toContain('2027-02-15')
    expect(JSON.stringify(h.log)).not.toContain('120')
  })

  it('PUT con fascia, senza scadenza: i campi opzionali arrivano come null', async () => {
    await scriviQuote({ voce: 'quota_nuova', fascia: 'nido_1', importo: 99.5 })
    expect(h.rpc[0].args).toMatchObject({ p_voce: 'quota_nuova', p_fascia: 'nido_1', p_importo: 99.5, p_scadenza: null })
  })

  it('PUT con importo null toglie la riga: lo dice il log (rimossa), la funzione riceve null', async () => {
    await scriviQuote({ voce: 'quota_conferma', importo: null })
    expect(h.rpc[0].args).toMatchObject({ p_importo: null })
    expect(eventi('anno-quota-impostata')[0].campi).toMatchObject({ rimossa: true })
  })

  it('PUT che non cambia niente (cambiato false): 200 e nessun log di successo', async () => {
    h.esiti.anno_listino_quota_imposta = ok({ cambiato: false })
    expect((await scriviQuote(QUOTA)).status).toBe(200)
    expect(eventi('anno-quota-impostata')).toEqual([])
  })

  it('ANNO_NON_MODIFICABILE → 409 e IMPORTO_NON_VALIDO → 422, con la frase, e un warn con il codice', async () => {
    h.esiti.anno_listino_quota_imposta = rifiuto('ANNO_NON_MODIFICABILE', { anno_sede_id: ANNO_A, stato: 'corrente' })
    let r = await scriviQuote(QUOTA)
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_NON_MODIFICABILE')
    expect(eventi('anno-rifiuto', 'warn')[0].campi).toMatchObject({ error_code: 'ANNO_NON_MODIFICABILE', anno_sede_id: ANNO_A })

    h.esiti.anno_listino_quota_imposta = rifiuto('IMPORTO_NON_VALIDO')
    r = await scriviQuote({ ...QUOTA, importo: 0 })
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('IMPORTO_NON_VALIDO')
  })

  it('GET porta solo le quote: le righe retta e servizio stanno nella route delle rette', async () => {
    h.tabelle.listino_voci = [
      { voce: 'quota_conferma', fascia: null, importo: 120, scadenza: '2027-02-15' },
      { voce: 'retta', fascia: null, importo: 150, scadenza: null },
      { voce: 'servizio', fascia: 'infanzia', importo: 30, scadenza: null },
      { voce: 'quota_nuova', fascia: 'nido_1', importo: 99, scadenza: null },
    ]
    const r = await leggiQuote()
    expect(r.status).toBe(200)
    const { data } = await r.json()
    expect(data.quote.map((q: { voce: string }) => q.voce)).toEqual(['quota_conferma', 'quota_nuova'])
    expect(data).not.toHaveProperty('listino')
    expect(h.rpc).toEqual([])
  })
})

describe('moduli', () => {
  it('PUT passa lista, codice, titolo e ordine; il log non porta né il titolo né il codice', async () => {
    const r = await scriviModulo(MODULO)
    expect(r.status).toBe(200)
    expect(h.rpc).toEqual([
      {
        nome: 'anno_modulo_richiesto_imposta',
        args: { p_anno_sede: ANNO_A, p_lista: 'conferma', p_codice: 'privacy', p_titolo: 'Informativa di prova', p_ordine: 1 },
      },
    ])
    const ev = eventi('anno-modulo-impostato', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toEqual({ tipo: 'anno-modulo-impostato', anno_sede_id: ANNO_A, utente: UTENTE, entita_tipo: 'conferma' })
    expect(JSON.stringify(h.log)).not.toContain('Informativa')
    expect(JSON.stringify(h.log)).not.toContain('privacy')
  })

  it('PUT senza ordine: la funzione riceve null (non toccare)', async () => {
    await scriviModulo({ lista: 'nuova', codice: 'regolamento', titolo: 'Regolamento di prova' })
    expect(h.rpc[0].args).toMatchObject({ p_lista: 'nuova', p_ordine: null })
  })

  it('PUT: il titolo si riceve già senza spazi ai bordi', async () => {
    await scriviModulo({ ...MODULO, titolo: '  Informativa  ' })
    expect(h.rpc[0].args).toMatchObject({ p_titolo: 'Informativa' })
  })

  it('DELETE passa lista e codice dalla query e logga solo la lista', async () => {
    const r = await togliModulo('?lista=nuova&codice=regolamento')
    expect(r.status).toBe(200)
    expect(h.rpc).toEqual([
      { nome: 'anno_modulo_richiesto_togli', args: { p_anno_sede: ANNO_A, p_lista: 'nuova', p_codice: 'regolamento' } },
    ])
    expect(eventi('anno-modulo-tolto')[0].campi).toEqual({ tipo: 'anno-modulo-tolto', anno_sede_id: ANNO_A, utente: UTENTE, entita_tipo: 'nuova' })
  })

  it('DELETE di un modulo che non c’è: 200 cambiato false, senza log di successo', async () => {
    h.esiti.anno_modulo_richiesto_togli = ok({ cambiato: false })
    const r = await togliModulo()
    expect(r.status).toBe(200)
    expect(eventi('anno-modulo-tolto')).toEqual([])
  })

  it('anno non modificabile → 409 anche per PUT e DELETE', async () => {
    h.esiti.anno_modulo_richiesto_imposta = rifiuto('ANNO_NON_MODIFICABILE')
    h.esiti.anno_modulo_richiesto_togli = rifiuto('ANNO_NON_MODIFICABILE')
    expect((await scriviModulo(MODULO)).status).toBe(409)
    expect((await togliModulo()).status).toBe(409)
  })

  it('GET restituisce i moduli', async () => {
    h.tabelle.moduli_richiesti = [{ lista: 'conferma', codice: 'privacy', titolo: 'Informativa di prova', ordine: 1 }]
    const r = await leggiModuli()
    expect((await r.json()).data.moduli).toEqual([{ lista: 'conferma', codice: 'privacy', titolo: 'Informativa di prova', ordine: 1 }])
  })
})

describe('posti', () => {
  it('PUT passa fascia, posti e fonte; il log porta la fascia e il numero, non la fonte', async () => {
    const r = await scriviPosti(POSTI)
    expect(r.status).toBe(200)
    expect(h.rpc).toEqual([
      { nome: 'anno_posti_imposta', args: { p_anno_sede: ANNO_A, p_fascia: 'infanzia', p_posti: 40, p_fonte: 'Autorizzazione di prova' } },
    ])
    expect(eventi('anno-posti-impostati')[0].campi).toEqual({
      tipo: 'anno-posti-impostati', anno_sede_id: ANNO_A, utente: UTENTE, entita_tipo: 'infanzia', n: 40, rimossa: false,
    })
    expect(JSON.stringify(h.log)).not.toContain('Autorizzazione')
  })

  it('PUT con posti null toglie la fascia', async () => {
    await scriviPosti({ fascia: 'primaria', posti: null })
    expect(h.rpc[0].args).toMatchObject({ p_fascia: 'primaria', p_posti: null, p_fonte: null })
    expect(eventi('anno-posti-impostati')[0].campi).toMatchObject({ rimossa: true })
  })

  it('GET restituisce i posti', async () => {
    h.tabelle.posti_autorizzati = [{ fascia: 'infanzia', posti: 40, fonte: null }]
    expect((await (await leggiPosti()).json()).data.posti).toEqual([{ fascia: 'infanzia', posti: 40, fonte: null }])
  })
})

describe('sezioni', () => {
  it('copia dall’anno in corso della sede all’anno dell’URL e restituisce copiate e gia_presenti', async () => {
    const r = await copiaSezioni()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { copiate: 2, gia_presenti: 1 } })
    expect(h.rpc).toEqual([
      { nome: 'anno_attivo', args: { p_scuola: SEDE_A } },
      { nome: 'anno_copia_sezioni', args: { p_da: ATTIVO_A, p_a: ANNO_A } },
    ])
    expect(eventi('anno-sezioni-copiate', 'info')[0].campi).toEqual({ tipo: 'anno-sezioni-copiate', anno_sede_id: ANNO_A, utente: UTENTE, n: 2 })
  })

  it('senza un anno in corso da cui partire non copia niente e non è un errore', async () => {
    h.esiti.anno_attivo = ok(null)
    const r = await copiaSezioni()
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ copiate: 0, gia_presenti: 0 })
    expect(h.rpc.map((x) => x.nome)).toEqual(['anno_attivo'])
    expect(eventi('anno-sezioni-senza-partenza', 'info')).toHaveLength(1)
  })

  it('l’anno di arrivo non modificabile → 409; l’anno in corso stesso → ANNO_NON_COERENTE, mai 200', async () => {
    h.esiti.anno_copia_sezioni = rifiuto('ANNO_NON_MODIFICABILE')
    expect((await copiaSezioni()).status).toBe(409)
    h.esiti.anno_copia_sezioni = rifiuto('ANNO_NON_COERENTE')
    expect((await copiaSezioni()).status).not.toBe(200)
  })

  it('una risposta della funzione che non ha la forma attesa è un guasto, non un 200', async () => {
    h.esiti.anno_copia_sezioni = ok({ altro: 1 })
    expect((await copiaSezioni()).status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Database non migrato (la CI): 503 pulito, mai 500
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('schema indietro (database della CI non migrato)', () => {
  const SCRITTURE: Array<[string, () => Promise<Response>]> = [
    ['PUT quote', () => scriviQuote(QUOTA)],
    ['PUT moduli', () => scriviModulo(MODULO)],
    ['DELETE moduli', () => togliModulo()],
    ['PUT posti', () => scriviPosti(POSTI)],
    ['POST sezioni', () => copiaSezioni()],
  ]
  it.each(SCRITTURE)('%s: funzione assente (PGRST202) → 503 CALENDARIO_NON_DISPONIBILE, con info e senza errore', async (_n, chiama) => {
    for (const k of Object.keys(h.esiti)) delete h.esiti[k]
    const r = await chiama()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(eventi('impostazioni-schema-indietro', 'info').length).toBeGreaterThanOrEqual(1)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(false)
  })

  const LETTURE: Array<[string, () => Promise<Response>]> = [
    ['GET quote', () => leggiQuote()],
    ['GET moduli', () => leggiModuli()],
    ['GET posti', () => leggiPosti()],
  ]
  it.each(LETTURE)('%s: tabella o colonna assente (42P01, 42703) → 503, mai 500', async (_n, chiama) => {
    for (const code of ['42P01', '42703']) {
      h.log = []
      h.letturaTabella = { code, message: 'assente' }
      const r = await chiama()
      expect(r.status, code).toBe(503)
      expect(eventi('impostazioni-schema-indietro', 'info')).toHaveLength(1)
      expect(h.log.some((l) => l.fn === 'errore')).toBe(false)
    }
  })

  it.each(LETTURE)('%s: un guasto vero di lettura è 500 con logErrore', async (_n, chiama) => {
    h.letturaTabella = { code: 'XX000', message: 'guasto' }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
  })
})
