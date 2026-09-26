import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Riga, RispostaRpc } from '../fixtures/finto-supabase'
import { redact } from '@/lib/logging/redact'

// =============================================================================
// POST /api/pagamenti/transazioni — DIVISIONE AUTOMATICA PER SEDE (K4, 26/09).
//
// Decisione del titolare: una famiglia con figli in plessi diversi paga voci di
// più sedi in UNA operazione, e l'app crea UNA TRANSAZIONE PER SEDE (una
// ricevuta per sede, tutto o niente, RPC `registra_transazioni_per_sede`).
//
// Il finto client APPLICA i filtri (`.in('id', …)` su pagamenti e alunni): la
// sede di ogni parte viene davvero dal dato, non da un mock che risponde sempre
// la stessa cosa. Le RPC registrano il payload ricevuto, ed è su quel payload —
// cioè su ciò che finirebbe nel database — che si asserisce.
// =============================================================================

const STAFF = '11111111-1111-4111-8111-111111111111'
const GENITORE = '33333333-3333-4333-8333-333333333333'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_C = 'c3c3c3c3-3333-4333-8333-cccccccccccc'
const PAG_A = 'a0000000-0000-4000-8000-00000000000a'
const PAG_B = 'b0000000-0000-4000-8000-00000000000b'
const PAG_C = 'c0000000-0000-4000-8000-00000000000c'
const MOV = 'dddddddd-0000-4000-8000-00000000000d'
const CAT = 'eeeeeeee-0000-4000-8000-00000000000e'

type Payload = Record<string, unknown> & {
  scuola_id: string
  importo_totale: number
  eccedenza_a_credito: number
  voci: { pagamento_id: string; importo: number }[]
  ricariche_mensa: { alunno_id: string; importo: number; ticket: number }[]
  voci_nuove?: Riga[]
  voci_ticket?: Riga[]
}

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  notifica: vi.fn(),
  revoca: vi.fn(),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  rpc: [] as { nome: string; p: unknown }[],
  rpcErrore: null as { code?: string; message?: string } | null,
  // La RPC divisa che risponde con MENO esiti delle sedi chieste (forma inattesa).
  rpcEsitiTroncati: false,
  errori: {} as Record<string, { code: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(['ok', ...a]),
  logErrore: (...a: unknown[]) => h.log.push(['errore', ...a]),
  logEvento: (...a: unknown[]) => h.log.push(['evento', ...a]),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  let n = 0
  // Esito fedele alla RPC singola: un uuid per transazione.
  const esito = (p: Payload) => ({
    transazione_id: `70000000-0000-4000-8000-00000000000${++n}`,
    incassi: p.voci.length,
    ricariche: p.ricariche_mensa.length,
    eccedenza: p.eccedenza_a_credito,
  })
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        rpc: {
          registra_transazione_contabile: (args: Riga): RispostaRpc => {
            h.rpc.push({ nome: 'registra_transazione_contabile', p: args.p })
            if (h.rpcErrore) return { data: null, error: h.rpcErrore }
            return { data: esito(args.p as Payload), error: null }
          },
          registra_transazioni_per_sede: (args: Riga): RispostaRpc => {
            h.rpc.push({ nome: 'registra_transazioni_per_sede', p: args.p })
            if (h.rpcErrore) return { data: null, error: h.rpcErrore }
            const elenco = (args.p as { transazioni: Payload[] }).transazioni
            const esiti = elenco.map(esito)
            return { data: { transazioni: h.rpcEsitiTroncati ? esiti.slice(0, 1) : esiti }, error: null }
          },
        },
      }) as never,
  }
})

import { POST } from '@/app/api/pagamenti/transazioni/route'

const post = (corpo: unknown) =>
  new NextRequest('http://localhost/api/pagamenti/transazioni', {
    method: 'POST',
    body: JSON.stringify(corpo),
    headers: { 'content-type': 'application/json' },
  })

const dbBase = (): DBFinto => ({
  pagamenti: [
    { id: PAG_A, alunno_id: ALU_A, scuola_id: SEDE_A },
    { id: PAG_B, alunno_id: ALU_B, scuola_id: SEDE_B },
    { id: PAG_C, alunno_id: ALU_C, scuola_id: SEDE_C },
  ],
  alunni: [
    { id: ALU_A, scuola_id: SEDE_A },
    { id: ALU_B, scuola_id: SEDE_B },
    { id: ALU_C, scuola_id: SEDE_C },
  ],
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  registro_modifiche: [],
})

const base = {
  pagante_parent_id: GENITORE,
  metodo: 'bonifico',
  riferimento: 'CRO-1',
  data_valuta: '2026-09-25',
  note: 'nota',
}

/** Il payload di UNA sede, dentro la chiamata alla RPC divisa. */
function payloadDi(sede: string): Payload {
  const chiamata = h.rpc.find((c) => c.nome === 'registra_transazioni_per_sede')
  if (!chiamata) throw new Error('RPC divisa mai chiamata')
  const el = (chiamata.p as { transazioni: Payload[] }).transazioni.find((t) => t.scuola_id === sede)
  if (!el) throw new Error(`nessuna transazione per ${sede}`)
  return el
}

const eventi = (esito: string) =>
  h.log.filter((r) => r[0] === 'evento' && (r[3] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.log = []
  h.rpc = []
  h.tabelle = []
  h.rpcErrore = null
  h.rpcEsitiTroncati = false
  h.errori = {}
  h.db = dbBase()
  h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
  h.notifica.mockResolvedValue(undefined)
  h.revoca.mockResolvedValue({ revocati: [] })
})

describe('divisione in due sedi', () => {
  it('voci di A e di B ⇒ UNA chiamata alla RPC divisa, una transazione per sede, quadratura per transazione', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(200)
    expect(h.rpc.map((c) => c.nome)).toEqual(['registra_transazioni_per_sede'])

    const a = payloadDi(SEDE_A)
    const b = payloadDi(SEDE_B)
    expect(a.voci).toEqual([{ pagamento_id: PAG_A, importo: 100 }])
    expect(b.voci).toEqual([{ pagamento_id: PAG_B, importo: 150 }])
    expect(a.importo_totale).toBe(100)
    expect(b.importo_totale).toBe(150)
    // Metodo, riferimento, valuta, note, pagante e operatore COPIATI su ognuna.
    for (const p of [a, b]) {
      expect(p).toMatchObject({
        pagante_parent_id: GENITORE,
        metodo: 'bonifico',
        riferimento: 'CRO-1',
        data_valuta: '2026-09-25',
        note: 'nota',
        registrato_da: STAFF,
        eccedenza_a_credito: 0,
      })
    }

    const j = await res.json()
    expect(j.data.transazioni).toHaveLength(2)
    expect(j.data.transazioni).toEqual(expect.arrayContaining([
      expect.objectContaining({ scuola_id: SEDE_A, scuola_nome: NOME_SEDE_A, importo_totale: 100 }),
      expect.objectContaining({ scuola_id: SEDE_B, scuola_nome: NOME_SEDE_B, importo_totale: 150 }),
    ]))
    // Compatibilità: i campi di sempre sono quelli della PRIMA transazione.
    expect(j.data.transazione_id).toBe(j.data.transazioni[0].transazione_id)
  })

  it('la divisione si logga (numero sedi e uuid delle transazioni, nessun dato personale)', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    const divisa = eventi('transazione_divisa')
    expect(divisa).toHaveLength(1)
    const campi = divisa[0][3] as Record<string, unknown>
    // Il logger qui è finto: il contesto va passato nel `redact` VERO, perché è
    // quello che decide cosa arriva nella riga persistita. Una stringa
    // «uuid1,uuid2» esce `[redatto:…]`; gli uuid devono restare leggibili.
    const redatto = redact(campi) as Record<string, unknown>
    expect(redatto.sedi).toBe(2)
    const ids = (await res.json()).data.transazioni.map((t: { transazione_id: string }) => t.transazione_id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect([redatto.transazione_1, redatto.transazione_2]).toEqual(ids)
    expect(JSON.stringify(redatto)).not.toContain('CRO-1')
    expect(JSON.stringify(redatto)).not.toContain('nota')
    // Successo di ciascuna transazione, con il suo uuid.
    expect(eventi('transazione_registrata')).toHaveLength(2)
  })

  it('ogni sede notifica i propri alunni, con la propria transazione', async () => {
    await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    const chiamate = h.notifica.mock.calls.map((c) => c[1] as { scuolaId: string; alunnoIds: string[] })
    expect(chiamate).toEqual(expect.arrayContaining([
      expect.objectContaining({ scuolaId: SEDE_A, alunnoIds: [ALU_A] }),
      expect.objectContaining({ scuolaId: SEDE_B, alunnoIds: [ALU_B] }),
    ]))
    expect(chiamate).toHaveLength(2)
  })

  it('una sola sede ⇒ RPC storica, e `transazioni` ha comunque un elemento', async () => {
    const res = await POST(post({ ...base, importo_totale: 100, voci: [{ pagamento_id: PAG_A, importo: 100 }] }))
    expect(res.status).toBe(200)
    expect(h.rpc.map((c) => c.nome)).toEqual(['registra_transazione_contabile'])
    expect((h.rpc[0].p as Payload).scuola_id).toBe(SEDE_A)
    const j = await res.json()
    expect(j.data.transazioni).toEqual([
      { transazione_id: j.data.transazione_id, scuola_id: SEDE_A, scuola_nome: NOME_SEDE_A, importo_totale: 100 },
    ])
    expect(eventi('transazione_divisa')).toHaveLength(0)
  })

  it('voce di una sede NON accessibile ⇒ 403 e nessuna RPC (le sedi attive restano il confine)', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 200,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_C, importo: 100 },
      ],
    }))
    expect(res.status).toBe(403)
    expect(h.rpc).toEqual([])
    expect(JSON.stringify(await res.json())).not.toContain(PAG_C)
  })

  it('errore della RPC divisa ⇒ 500 e nessuna risposta di successo (tutto o niente è della RPC)', async () => {
    h.rpcErrore = { code: 'P0001', message: 'transazioni: due transazioni sulla stessa sede' }
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(500)
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('importi oltre il centesimo che quadrano solo in totale ⇒ 400 prima della RPC, mai un 500 dalla RPC', async () => {
    // 100,004 + 150,004 = 250,008 ≈ 250,01 in totale; divise, le transazioni
    // valgono 100 + 150 = 250. La quadratura va rifatta su OGNI transazione.
    const res = await POST(post({
      ...base,
      importo_totale: 250.01,
      voci: [
        { pagamento_id: PAG_A, importo: 100.004 },
        { pagamento_id: PAG_B, importo: 150.004 },
      ],
    }))
    expect(res.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('RPC divisa assente (DB non migrato) ⇒ 503', async () => {
    h.rpcErrore = { code: 'PGRST202' }
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(503)
  })

  it('l\'audit si scrive una riga per transazione, con il suo uuid', async () => {
    await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    const audit = h.db.registro_modifiche as { record_id?: string }[]
    expect(audit).toHaveLength(2)
    expect(new Set(audit.map((r) => r.record_id)).size).toBe(2)
  })

  it('audit NON scritto ⇒ 200 (l\'incasso è già registrato), un warn per transazione col suo uuid, notifiche partite', async () => {
    // PostgREST non lancia: ignorare `errAudit` sarebbe il catch muto vietato
    // dalla regola 6 di AGENTS.md. Qui l'insert fallisce davvero, e si guarda
    // che il guasto lasci una traccia per OGNI transazione.
    h.errori = { 'registro_modifiche:insert': { code: '42501' } }
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(200)
    const ids = (await res.json()).data.transazioni.map((t: { transazione_id: string }) => t.transazione_id)
    expect(ids).toHaveLength(2)
    expect(h.db.registro_modifiche).toEqual([])

    const nonScritti = eventi('audit-non-scritto')
    expect(nonScritti).toHaveLength(2)
    for (const r of nonScritti) expect(r[2]).toBe('warn')
    expect(nonScritti.map((r) => (r[3] as { transazione_id?: string }).transazione_id)).toEqual(ids)
    // L'errore PostgREST accompagna l'evento: il codice dice PERCHÉ.
    expect(nonScritti.map((r) => (r[4] as { code?: string } | undefined)?.code)).toEqual(['42501', '42501'])

    // Il guasto dell'audit non ferma la conferma alle famiglie.
    expect(h.notifica).toHaveBeenCalledTimes(2)
  })

  it('la RPC divisa restituisce MENO esiti delle sedi ⇒ 200, un solo errore `esito-rpc-inatteso`, uuid mancante a null', async () => {
    // La RPC non ha dato errore: la scrittura è avvenuta, non si risponde 500 a
    // un incasso registrato. Ma la forma inattesa si registra come ERRORE, una
    // volta, con i due numeri che non tornano, e nessun elemento va in crash.
    h.rpcEsitiTroncati = true
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(200)

    const inattesi = eventi('esito-rpc-inatteso')
    expect(inattesi).toHaveLength(1)
    expect(inattesi[0][2]).toBe('error')
    expect(inattesi[0][3]).toMatchObject({ sedi: 2, n: 1 })

    const j = await res.json()
    expect(j.data.transazioni).toHaveLength(2)
    expect(typeof j.data.transazioni[0].transazione_id).toBe('string')
    expect(j.data.transazioni[1].transazione_id).toBeNull()
    // Le altre colonne dell'elemento senza uuid restano quelle della sua sede.
    expect(j.data.transazioni.map((t: { importo_totale: number }) => t.importo_totale).sort((x: number, y: number) => x - y))
      .toEqual([100, 150])
    expect(j.data.transazione_id).toBe(j.data.transazioni[0].transazione_id)

    // Audit e notifiche partono comunque, con uuid null dove manca l'esito.
    const audit = h.db.registro_modifiche as { record_id?: string | null }[]
    expect(audit).toHaveLength(2)
    expect(audit.filter((r) => r.record_id == null)).toHaveLength(1)
    expect(h.notifica).toHaveBeenCalledTimes(2)
    const entita = h.notifica.mock.calls.map((c) => (c[1] as { entitaId: string | null }).entitaId)
    expect(entita.filter((e) => e == null)).toHaveLength(1)
  })
})

describe('ricariche mensa nella sede dell\'ALUNNO', () => {
  it('scuola_id dichiarato A, ricarica di un alunno di B ⇒ la ricarica va nella transazione di B', async () => {
    // Il difetto: la ricarica finiva nella sede della transazione (quella del
    // client), cioè il saldo ticket di un alunno di B incassato su A.
    const res = await POST(post({
      ...base,
      scuola_id: SEDE_A,
      importo_totale: 130,
      voci: [{ pagamento_id: PAG_A, importo: 100 }],
      ricariche_mensa: [{ alunno_id: ALU_B, importo: 30, ticket: 6 }],
    }))
    expect(res.status).toBe(200)
    const a = payloadDi(SEDE_A)
    const b = payloadDi(SEDE_B)
    expect(a.ricariche_mensa).toEqual([])
    expect(b.ricariche_mensa).toEqual([{ alunno_id: ALU_B, importo: 30, ticket: 6 }])
    expect(b.voci).toEqual([])
    expect(a.importo_totale).toBe(100)
    expect(b.importo_totale).toBe(30)
  })

  it('solo una ricarica di B, scuola_id dichiarato A ⇒ una transazione, su B', async () => {
    const res = await POST(post({
      ...base,
      scuola_id: SEDE_A,
      importo_totale: 30,
      ricariche_mensa: [{ alunno_id: ALU_B, importo: 30, ticket: 6 }],
    }))
    expect(res.status).toBe(200)
    expect(h.rpc.map((c) => c.nome)).toEqual(['registra_transazione_contabile'])
    expect((h.rpc[0].p as Payload).scuola_id).toBe(SEDE_B)
  })

  // Il 403 degli alunni fuori scope è quello di `rifiutoSede`: `{ error, codice }`
  // col codice traducibile, e NESSUN id nel corpo (dire quale alunno è fuori
  // confermerebbe l'esistenza di un bambino di un altro plesso).
  const atteso403SenzaId = async (res: Response) => {
    expect(res.status).toBe(403)
    const j = await res.json()
    expect(j.codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(typeof j.error).toBe('string')
    expect(Object.keys(j).sort()).toEqual(['codice', 'error'])
    expect(JSON.stringify(j)).not.toContain(ALU_C)
    expect(h.rpc).toEqual([])
  }

  it('ricarica per un alunno di una sede non accessibile ⇒ 403 SEDE_NON_ACCESSIBILE, nessun id, nessuna RPC', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 30,
      ricariche_mensa: [{ alunno_id: ALU_C, importo: 30, ticket: 6 }],
    }))
    await atteso403SenzaId(res)
  })

  it('voce nuova per un alunno di una sede non accessibile ⇒ 403 SEDE_NON_ACCESSIBILE, nessun id, nessuna RPC', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 140,
      voci: [{ pagamento_id: PAG_A, importo: 100 }],
      voci_nuove: [{ alunno_id: ALU_C, categoria_id: CAT, descrizione: 'Gita', importo: 40, scadenza: '2026-09-30' }],
    }))
    await atteso403SenzaId(res)
  })

  it('ticket per un alunno di una sede non accessibile ⇒ 403 SEDE_NON_ACCESSIBILE, nessun id, nessuna RPC', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 2.3,
      voci_ticket: [{ alunno_id: ALU_C, quantita: 2, costo_unitario: 1.15 }],
    }))
    await atteso403SenzaId(res)
  })

  it('lettura degli alunni fallita ⇒ 500 e nessuna RPC, mai «nessun alunno fuori sede»', async () => {
    // PostgREST non lancia: un errore ignorato qui diventerebbe un permesso.
    h.errori = { 'alunni:select': { code: '42501' } }
    const res = await POST(post({
      ...base,
      importo_totale: 30,
      ricariche_mensa: [{ alunno_id: ALU_A, importo: 30, ticket: 6 }],
    }))
    expect(res.status).toBe(500)
    expect(h.rpc).toEqual([])
  })

  it('voci nuove e ticket seguono l\'alunno; il ticket entra nella quadratura come quantità × costo', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 100 + 40 + 3.45,
      voci: [{ pagamento_id: PAG_A, importo: 100 }],
      voci_nuove: [{ alunno_id: ALU_B, categoria_id: CAT, descrizione: 'Gita', importo: 40, scadenza: '2026-09-30' }],
      voci_ticket: [{ alunno_id: ALU_B, quantita: 3, costo_unitario: 1.15 }],
    }))
    expect(res.status).toBe(200)
    const a = payloadDi(SEDE_A)
    const b = payloadDi(SEDE_B)
    expect(a.voci_nuove ?? []).toEqual([])
    expect(b.voci_nuove).toHaveLength(1)
    expect(b.voci_ticket).toHaveLength(1)
    expect(b.importo_totale).toBe(43.45)
    expect(a.importo_totale).toBe(100)
  })
})

describe('eccedenza a credito con più sedi', () => {
  const corpoEcc = (extra: Record<string, unknown> = {}) => ({
    ...base,
    importo_totale: 270,
    voci: [
      { pagamento_id: PAG_A, importo: 100 },
      { pagamento_id: PAG_B, importo: 150 },
    ],
    eccedenza_a_credito: 20,
    conferma_eccedenza: 'credito_famiglia',
    ...extra,
  })

  it('senza sede_eccedenza ⇒ 422, nessuna RPC', async () => {
    const res = await POST(post(corpoEcc()))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('SEDE_ECCEDENZA_MANCANTE')
    expect(h.rpc).toEqual([])
  })

  it('sede_eccedenza = B ⇒ l\'eccedenza e il suo importo stanno SOLO nella transazione di B', async () => {
    const res = await POST(post(corpoEcc({ sede_eccedenza: SEDE_B })))
    expect(res.status).toBe(200)
    const a = payloadDi(SEDE_A)
    const b = payloadDi(SEDE_B)
    expect(a.eccedenza_a_credito).toBe(0)
    expect(a.importo_totale).toBe(100)
    expect(b.eccedenza_a_credito).toBe(20)
    expect(b.importo_totale).toBe(170)
  })

  it('sede_eccedenza scritta in MAIUSCOLO è la stessa sede (uuid confrontati in forma canonica)', async () => {
    const res = await POST(post(corpoEcc({ sede_eccedenza: SEDE_B.toUpperCase() })))
    expect(res.status).toBe(200)
    expect(payloadDi(SEDE_B).eccedenza_a_credito).toBe(20)
  })

  it('sede_eccedenza accessibile ma ESTRANEA all\'operazione ⇒ 422', async () => {
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B, SEDE_C])
    const res = await POST(post(corpoEcc({ sede_eccedenza: SEDE_C })))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('SEDE_ECCEDENZA_ESTRANEA')
    expect(h.rpc).toEqual([])
  })

  it('una sola sede ⇒ l\'eccedenza va su quella senza bisogno di sceglierla', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 120,
      voci: [{ pagamento_id: PAG_A, importo: 100 }],
      eccedenza_a_credito: 20,
      conferma_eccedenza: 'credito_famiglia',
    }))
    expect(res.status).toBe(200)
    const p = h.rpc[0].p as Payload
    expect(h.rpc[0].nome).toBe('registra_transazione_contabile')
    expect(p.scuola_id).toBe(SEDE_A)
    expect(p.eccedenza_a_credito).toBe(20)
    expect(p.importo_totale).toBe(120)
  })
})

describe('movimento bancario', () => {
  it('movimento_id con più sedi ⇒ 422 chiaro, nessuna RPC', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 250,
      movimento_id: MOV,
      voci: [
        { pagamento_id: PAG_A, importo: 100 },
        { pagamento_id: PAG_B, importo: 150 },
      ],
    }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.codice).toBe('MOVIMENTO_PIU_SEDI')
    expect(j.error).toMatch(/movimento/i)
    expect(h.rpc).toEqual([])
  })

  it('movimento_id con una sede ⇒ comportamento storico: registrato, e il movimento NON arriva alla RPC', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 100,
      movimento_id: MOV,
      voci: [{ pagamento_id: PAG_A, importo: 100 }],
    }))
    expect(res.status).toBe(200)
    expect(h.rpc.map((c) => c.nome)).toEqual(['registra_transazione_contabile'])
    // Il legame col movimento passa dai gate di Riconciliazione, mai da qui.
    expect(JSON.stringify(h.rpc[0].p)).not.toContain(MOV)
    expect(eventi('movimento-ignorato')).toHaveLength(1)
  })
})

describe('tetti di righe: solo sugli elenchi nuovi', () => {
  const voci = (n: number) =>
    Array.from({ length: n }, () => ({ pagamento_id: PAG_A, importo: 1 }))
  const nuove = (n: number) =>
    Array.from({ length: n }, () => ({ alunno_id: ALU_A, categoria_id: CAT, descrizione: 'x', importo: 1, scadenza: '2026-09-30' }))

  it('`voci` e `ricariche_mensa` restano senza tetto, come prima: 70 voci a una sede ⇒ 200', async () => {
    const res = await POST(post({
      ...base,
      importo_totale: 71,
      voci: voci(70),
      ricariche_mensa: [{ alunno_id: ALU_A, importo: 1, ticket: 1 }],
    }))
    expect(res.status).toBe(200)
  })

  it('voci_nuove: 50 ok, 51 ⇒ 400', async () => {
    expect((await POST(post({ ...base, importo_totale: 50, voci_nuove: nuove(50) }))).status).toBe(200)
    expect((await POST(post({ ...base, importo_totale: 51, voci_nuove: nuove(51) }))).status).toBe(400)
  })

  it('voci_nuove + voci_ticket: 60 ok, 61 ⇒ 400', async () => {
    const ticket = (n: number) => Array.from({ length: n }, () => ({ alunno_id: ALU_A, quantita: 1, costo_unitario: 1 }))
    expect((await POST(post({ ...base, importo_totale: 60, voci_nuove: nuove(30), voci_ticket: ticket(30) }))).status).toBe(200)
    expect((await POST(post({ ...base, importo_totale: 61, voci_nuove: nuove(31), voci_ticket: ticket(30) }))).status).toBe(400)
  })
})
