import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * `GET` e `POST /api/pagamenti/fattura/coda` (nucleo §3).
 *
 * Tutti gli uuid sono FINTI (il repository è pubblico): due sedi, `SEDE_A` dell'utente e
 * `SEDE_B` di un altro plesso.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  scuole: vi.fn(),
  sb: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async (originale) => {
  const actual = await originale<typeof import('@/lib/auth/scope')>()
  return { ...actual, assertPagamentoInScope: h.scope, scuoleDiUtente: h.scuole }
})
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.sb }))

import { GET, POST } from '@/app/api/pagamenti/fattura/coda/route'
import { CODICI_ERRORE_CODA, PASSO_FATTURA_STIMA_MS } from '@/lib/fatture-coda/api'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const STAFF = uuid(7000)

type Rpc = Record<string, (args: Riga) => RispostaRpc>

let db: DBFinto
let rpcChiamate: { nome: string; args: Riga }[]

function monta(opzioni: { errori?: Record<string, { code: string }>; rpc?: Rpc } = {}) {
  rpcChiamate = []
  const rpc: Rpc = {
    fatture_coda_accoda: () => ({
      data: { gruppo_id: uuid(8000), accodate: 2, gia_in_coda: [] },
      error: null,
    }),
    fatture_coda_tick_http: () => ({ data: null, error: null }),
    ...(opzioni.rpc ?? {}),
  }
  const tracciate: Rpc = Object.fromEntries(
    Object.entries(rpc).map(([nome, impl]) => [
      nome,
      (args: Riga) => {
        rpcChiamate.push({ nome, args })
        return impl(args)
      },
    ]),
  )
  h.sb = creaFintoSupabase(db, [], { errori: opzioni.errori, rpc: tracciate })
}

function rpcDi(nome: string) {
  return rpcChiamate.filter((c) => c.nome === nome)
}

function get(): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda', { method: 'GET' })
}

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

function voce(n: number, campi: Partial<Riga> = {}): Riga {
  return {
    id: uuid(n),
    stato: 'in_coda',
    urgente: false,
    gruppo_seq: 1,
    data_riferimento: '2026-09-01',
    ordine_selezione: 0,
    accodata_il: '2026-09-23T07:00:00.000Z',
    esito_codice: null,
    esito_messaggio: null,
    scuola_id: SEDE_A,
    pagamento_id: uuid(100 + n),
    creato_da: STAFF,
    concluso_il: null,
    pagamenti: { descrizione: 'Retta', importo: '150.00', alunni: { nome: 'Alunno', cognome: `Finto${n}` } },
    schools: { nome: 'Sede di prova' },
    ...campi,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db = {
    fatture_coda: [],
    fatture_coda_stato: [{ id: 1, sospesa: false, sospesa_il: null, pausa_fino_a: null, pausa_motivo: null, ultimo_giro_il: null }],
    pagamenti: [],
    utenti: [{ id: STAFF, nome: 'Operatrice', cognome: 'Finta' }],
    // Gli istanti dell'ultima ora per la stima di fine (consegna 2b, D3).
    fatture_emesse: [],
  }
  monta()
  h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } })
  h.scope.mockResolvedValue(null)
  h.scuole.mockResolvedValue([SEDE_A])
})

// ═════════════════════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /coda — gate', () => {
  it('401/403 del gate passano così come sono, e il DB non si tocca', async () => {
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await GET(get())).status).toBe(401)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await GET(get())).status).toBe(403)
    expect(h.scuole).not.toHaveBeenCalled()
  })
})

describe('GET /coda — DB non migrato', () => {
  it.each(['PGRST205', '42P01'])('tabella assente (%s) ⇒ 200 {disponibile:false}', async (code) => {
    monta({ errori: { fatture_coda: { code } } })
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disponibile: false })
  })

  it('un altro errore di lettura NON si traveste da «non disponibile»: 500 LETTURA_FALLITA', async () => {
    monta({ errori: { fatture_coda: { code: '57014' } } })
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
  })
})

describe('GET /coda — contenuto', () => {
  it('stato, conteggi, posizione, stima di fine e nomi', async () => {
    db.fatture_coda = [
      voce(1, { gruppo_seq: 2 }),
      voce(2, { gruppo_seq: 1 }),
      voce(3, { gruppo_seq: 3, urgente: true }),
      voce(4, { stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'invio interrotto' }),
      voce(5, { stato: 'in_invio' }),
      voce(6, { stato: 'emessa', esito_codice: 'emessa', concluso_il: new Date().toISOString() }),
      voce(7, { stato: 'tolta', concluso_il: new Date().toISOString() }),
      // Conclusa da più di sette giorni: fuori da elenco e contatori.
      voce(8, { stato: 'emessa', concluso_il: '2026-01-01T00:00:00.000Z' }),
    ]
    const res = await GET(get())
    expect(res.status).toBe(200)
    const corpo = await res.json()

    expect(corpo.disponibile).toBe(true)
    expect(corpo.stato).toEqual({
      sospesa: false,
      sospesa_il: null,
      pausa_fino_a: null,
      pausa_motivo: null,
      ultimo_giro_il: null,
    })
    expect(corpo.conteggi).toEqual({ in_coda: 3, in_invio: 1, errore: 1, emesse_7g: 1, tolte_7g: 1 })

    const ids = corpo.voci.map((v: { id: string }) => v.id)
    expect(ids).not.toContain(uuid(8))
    expect(ids).toHaveLength(7)

    // L'urgente è in testa, poi per gruppo_seq. La posizione conta solo le `in_coda`.
    const posizioni = Object.fromEntries(
      corpo.voci.map((v: { id: string; posizione: number | null }) => [v.id, v.posizione]),
    )
    expect(posizioni[uuid(3)]).toBe(1)
    expect(posizioni[uuid(2)]).toBe(2)
    expect(posizioni[uuid(1)]).toBe(3)
    expect(posizioni[uuid(4)]).toBeNull()
    expect(posizioni[uuid(5)]).toBeNull()

    const prima = corpo.voci.find((v: { id: string }) => v.id === uuid(1))
    expect(prima).toMatchObject({
      alunno: 'Alunno Finto1',
      descrizione: 'Retta',
      importo: 150,
      scuola_id: SEDE_A,
      scuola_nome: 'Sede di prova',
      creato_da_nome: 'Operatrice Finta',
      urgente: false,
    })

    // 3 in coda più 1 in invio, secchio vuoto: il primo tick del cron arriva entro 10 minuti
    // (i salti 27→37 e 57→07), poi tre fatture da `PASSO_FATTURA_STIMA_MS`.
    const fine = Date.parse(corpo.stima_fine)
    expect(fine).toBeGreaterThan(Date.now())
    expect(fine - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 3 * PASSO_FATTURA_STIMA_MS + 1_000)
  })

  it('la stima conta le fatture emesse nell’ultima ora: 50 un minuto fa ⇒ la fine è fra più di 59 minuti', async () => {
    const unMinutoFa = new Date(Date.now() - 60_000).toISOString()
    db.fatture_emesse = Array.from({ length: 50 }, (_, i) => ({ id: uuid(5000 + i), creato_il: unMinutoFa, scuola_id: SEDE_B }))
    db.fatture_coda = [voce(1)]
    const corpo = await (await GET(get())).json()
    expect(corpo.stima_fine).not.toBeNull()
    expect(Date.parse(corpo.stima_fine) - Date.now()).toBeGreaterThan(59 * 60_000)
  })

  it('un guasto di fatture_emesse spegne la STIMA, non la coda', async () => {
    monta({ errori: { fatture_emesse: { code: 'XX000' } } })
    db.fatture_coda = [voce(1)]
    const res = await GET(get())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.disponibile).toBe(true)
    expect(corpo.voci.map((v: { id: string }) => v.id)).toEqual([uuid(1)])
    expect(corpo.stima_fine).toBeNull()
  })

  it('il messaggio d’esito di una voce di un’ALTRA sede è null; il codice resta', async () => {
    db.fatture_coda = [
      voce(1, { stato: 'errore', esito_codice: 'scarto_aruba', esito_messaggio: 'dettaglio A', scuola_id: SEDE_A }),
      voce(2, { stato: 'errore', esito_codice: 'scarto_aruba', esito_messaggio: 'dettaglio B', scuola_id: SEDE_B }),
    ]
    const corpo = await (await GET(get())).json()
    const perId = Object.fromEntries(corpo.voci.map((v: { id: string }) => [v.id, v]))
    expect(perId[uuid(1)].esito_messaggio).toBe('dettaglio A')
    expect(perId[uuid(2)].esito_messaggio).toBeNull()
    expect(perId[uuid(2)].esito_codice).toBe('scarto_aruba')
    // La voce dell'altra sede si VEDE (decisione 6): è solo il messaggio a restare chiuso.
    expect(perId[uuid(2)].scuola_id).toBe(SEDE_B)
  })

  it('fuori sede resta chiuso SOLO il messaggio d’esito: nome dell’alunno, importo e chi ha accodato attraversano (voce AMMESSE `coda:GET`)', async () => {
    // Due voci gemelle, una per sede, accodate da un'utente che NON è quella che legge. Tutto
    // ciò che la GET restituisce per la voce propria lo restituisce identico per quella
    // dell'altra sede, tranne `esito_messaggio`. Se un giorno si nasconde anche un altro campo
    // (o se ne scopre uno nuovo), questo test diventa rosso e la voce di
    // `isolamento-sede-coverage` va riscritta insieme: deve dire per esteso cosa attraversa.
    const ALTRA = uuid(900)
    db.utenti = [...db.utenti, { id: ALTRA, nome: 'Collega', cognome: 'Finta' }]
    const gemella = {
      stato: 'errore',
      esito_codice: 'scarto_aruba',
      esito_messaggio: 'dettaglio',
      creato_da: ALTRA,
      pagamenti: { descrizione: 'Retta', importo: '230.50', alunni: { nome: 'Alunno', cognome: 'Gemello' } },
    }
    db.fatture_coda = [
      voce(1, { ...gemella, scuola_id: SEDE_A }),
      voce(2, { ...gemella, scuola_id: SEDE_B }),
    ]
    const corpo = await (await GET(get())).json()
    const perId = Object.fromEntries(corpo.voci.map((v: { id: string }) => [v.id, v]))
    const fuori = perId[uuid(2)]

    expect(fuori).toMatchObject({
      alunno: 'Alunno Gemello',
      importo: 230.5,
      descrizione: 'Retta',
      creato_da_nome: 'Collega Finta',
      esito_codice: 'scarto_aruba',
      esito_messaggio: null,
      propria: false,
    })

    // Il confronto campo per campo: diversi solo ciò che per costruzione deve esserlo.
    const DIVERSI = new Set(['id', 'pagamento_id', 'scuola_id', 'propria', 'esito_messaggio'])
    const senza = (v: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(v).filter(([k]) => !DIVERSI.has(k)))
    expect(senza(fuori)).toEqual(senza(perId[uuid(1)]))
    expect(perId[uuid(1)].esito_messaggio).toBe('dettaglio')
  })

  it('`propria` dice se la voce è di una sede dell’utente: il pannello la rende selezionabile solo allora', async () => {
    // /coda/azioni rifiuta TUTTO il gesto (403) se anche una sola voce è di un'altra sede:
    // senza questo campo il pannello lasciava spuntare anche quelle, e «Seleziona tutto» +
    // «Togli» falliva sempre appena in coda c'era una voce di un altro plesso.
    db.fatture_coda = [
      voce(1, { stato: 'in_coda', scuola_id: SEDE_A }),
      voce(2, { stato: 'errore', scuola_id: SEDE_B }),
    ]
    const corpo = await (await GET(get())).json()
    const perId = Object.fromEntries(corpo.voci.map((v: { id: string }) => [v.id, v]))
    expect(perId[uuid(1)].propria).toBe(true)
    expect(perId[uuid(2)].propria).toBe(false)
  })

  it('`?solo=conteggi` (il contatore del menu): solo stato e conteggi, niente voci, nessuna lettura di autori o sedi', async () => {
    db.fatture_coda = [
      voce(1),
      voce(2, { stato: 'in_invio' }),
      voce(3, { stato: 'errore', scuola_id: SEDE_B }),
      voce(4, { stato: 'emessa', concluso_il: new Date().toISOString() }),
    ]
    const res = await GET(new Request('http://localhost/api/pagamenti/fattura/coda?solo=conteggi'))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo).toEqual({
      disponibile: true,
      conteggi: { in_coda: 1, in_invio: 1, errore: 1, emesse_7g: 1, tolte_7g: 0 },
    })
    // Il menu si monta su ogni pagina del cockpit: non deve trascinarsi 1000 voci, i nomi degli
    // autori e le sedi dell'utente per disegnare un numero.
    expect(h.scuole).not.toHaveBeenCalled()
  })

  it('`?solo=conteggi` con il DB non migrato ⇒ {disponibile:false}', async () => {
    monta({ errori: { fatture_coda: { code: 'PGRST205' } } })
    const res = await GET(new Request('http://localhost/api/pagamenti/fattura/coda?solo=conteggi'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disponibile: false })
  })

  it('`?solo=` con un valore sconosciuto ⇒ 400 (zod), senza toccare il DB', async () => {
    const res = await GET(new Request('http://localhost/api/pagamenti/fattura/coda?solo=voci'))
    expect(res.status).toBe(400)
    expect(h.scuole).not.toHaveBeenCalled()
  })

  it('l’intestatario scritto a mano NON esce dalla GET (consegna 2b, D1)', async () => {
    // Dati SINTETICI (il cast di `FatturaButton-intestatario.test.tsx`).
    const persona = {
      tipo: 'persona',
      nome: 'Carlo',
      cognome: 'Perlini',
      codice_fiscale: 'PRLCRL85M41H501Y',
      indirizzo: 'Via delle Prove 1',
      cap: '80014',
      comune: 'Giugliano in Campania',
    }
    db.fatture_coda = [voce(1, { intestatario_scelto: persona }), voce(2)]
    const corpo = await (await GET(get())).json()
    // Presenza prima dell'assenza: le due voci ci sono.
    expect(corpo.voci.map((v: { id: string }) => v.id).sort()).toEqual([uuid(1), uuid(2)])
    for (const v of corpo.voci) expect(v).not.toHaveProperty('intestatario_scelto')
    const testo = JSON.stringify(corpo)
    expect(testo).not.toContain(persona.codice_fiscale)
    expect(testo).not.toContain(persona.cognome)
  })

  it('coda sospesa ⇒ stima_fine null', async () => {
    db.fatture_coda_stato = [{ id: 1, sospesa: true, sospesa_il: '2026-09-23T06:00:00.000Z' }]
    db.fatture_coda = [voce(1)]
    const corpo = await (await GET(get())).json()
    expect(corpo.stato.sospesa).toBe(true)
    expect(corpo.stima_fine).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST
// ═════════════════════════════════════════════════════════════════════════════

function saldati(...n: number[]) {
  db.pagamenti = n.map((i) => ({ id: uuid(i), stato: 'pagato', scuola_id: SEDE_A }))
}

describe('POST /coda — gate e validazione', () => {
  it('401 e 403 dal gate: nessuna RPC', async () => {
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))).status).toBe(401)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))).status).toBe(403)
    expect(rpcChiamate).toEqual([])
  })

  it('zod: 0 voci e 501 voci ⇒ 400; 500 voci passano', async () => {
    expect((await POST(post({ voci: [] }))).status).toBe(400)
    const molte = (n: number) => Array.from({ length: n }, (_, i) => ({ pagamento_id: uuid(i + 1) }))
    expect((await POST(post({ voci: molte(501) }))).status).toBe(400)
    expect(rpcChiamate).toEqual([])

    saldati(...Array.from({ length: 500 }, (_, i) => i + 1))
    const res = await POST(post({ voci: molte(500) }))
    expect(res.status).toBe(200)
    expect(h.scope).toHaveBeenCalledTimes(500)
    expect((rpcDi('fatture_coda_accoda')[0].args.p_voci as unknown[]).length).toBe(500)
  })
})

describe('POST /coda — scope di sede su OGNI voce', () => {
  it('una voce fuori sede (la terza) rifiuta tutto: niente accodamento', async () => {
    saldati(1, 2, 3, 4, 5)
    h.scope.mockImplementation(async (_sb: unknown, _u: unknown, id: string) =>
      id === uuid(3) ? NextResponse.json({ error: 'fuori sede' }, { status: 403 }) : null,
    )
    const res = await POST(post({ voci: [1, 2, 3, 4, 5].map((n) => ({ pagamento_id: uuid(n) })) }))
    expect(res.status).toBe(403)
    const controllati = h.scope.mock.calls.map((c) => c[2])
    expect(controllati).toEqual(expect.arrayContaining([1, 2, 3, 4, 5].map(uuid)))
    expect(rpcDi('fatture_coda_accoda')).toEqual([])
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })

  it('con più rifiuti vince quello della PRIMA voce nell’ordine dato', async () => {
    saldati(1, 2, 3)
    h.scope.mockImplementation(async (_sb: unknown, _u: unknown, id: string) => {
      if (id === uuid(2)) return NextResponse.json({ error: 'non trovato' }, { status: 404 })
      if (id === uuid(3)) return NextResponse.json({ error: 'fuori sede' }, { status: 403 })
      return null
    })
    const res = await POST(post({ voci: [1, 2, 3].map((n) => ({ pagamento_id: uuid(n) })) }))
    expect(res.status).toBe(404)
  })
})

describe('POST /coda — solo pagamenti saldati', () => {
  it('un pagamento non saldato ⇒ 400 PAGAMENTO_NON_SALDATO con gli id, e nessuna RPC', async () => {
    db.pagamenti = [
      { id: uuid(1), stato: 'pagato', scuola_id: SEDE_A },
      { id: uuid(2), stato: 'da_pagare', scuola_id: SEDE_A },
    ]
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }, { pagamento_id: uuid(2) }] }))
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe(CODICI_ERRORE_CODA.PAGAMENTO_NON_SALDATO)
    expect(corpo.data.pagamento_ids).toEqual([uuid(2)])
    expect(rpcDi('fatture_coda_accoda')).toEqual([])
  })
})

describe('POST /coda — accodamento e sveglia', () => {
  it('passa voci, autore e urgenza alla RPC, risponde col suo esito e sveglia il lavoratore', async () => {
    saldati(1, 2)
    const res = await POST(
      post({
        urgente: true,
        voci: [
          { pagamento_id: uuid(1), intestatario: { tipo: 'adult', adult_id: uuid(900) }, conferma_proposta: true },
          { pagamento_id: uuid(2), causale: 'Correzione a mano' },
          // Doppione: si tiene la prima occorrenza.
          { pagamento_id: uuid(1) },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ gruppo_id: uuid(8000), accodate: 2, gia_in_coda: [] })

    const [accoda] = rpcDi('fatture_coda_accoda')
    expect(accoda.args).toEqual({
      p_creato_da: STAFF,
      p_urgente: true,
      p_voci: [
        {
          pagamento_id: uuid(1),
          intestatario_scelto: { tipo: 'adult', adult_id: uuid(900) },
          conferma_proposta: true,
          causale_manuale: null,
          ordine_selezione: 0,
        },
        {
          pagamento_id: uuid(2),
          intestatario_scelto: null,
          conferma_proposta: false,
          causale_manuale: 'Correzione a mano',
          ordine_selezione: 1,
        },
      ],
    })
    await vi.waitFor(() => expect(rpcDi('fatture_coda_tick_http')).toHaveLength(1))
  })

  it('urgente assente ⇒ false', async () => {
    saldati(1)
    await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(rpcDi('fatture_coda_accoda')[0].args.p_urgente).toBe(false)
  })

  it('tutte già in coda (accodate 0) ⇒ risponde gli id, e nessuna sveglia inutile', async () => {
    saldati(1)
    monta({
      rpc: {
        fatture_coda_accoda: () => ({ data: { gruppo_id: uuid(8001), accodate: 0, gia_in_coda: [uuid(1)] }, error: null }),
      },
    })
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(await res.json()).toEqual({ gruppo_id: uuid(8001), accodate: 0, gia_in_coda: [uuid(1)] })
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })

  it('un errore della sveglia NON fa fallire l’accodamento', async () => {
    saldati(1)
    monta({ rpc: { fatture_coda_tick_http: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) } })
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(res.status).toBe(200)
  })
})

describe('POST /coda — DB non migrato e guasti', () => {
  it.each(['PGRST205', '42P01', 'PGRST202'])('RPC/tabella assente (%s) ⇒ 503 CODA_FATTURE_NON_DISPONIBILE', async (code) => {
    saldati(1)
    monta({ rpc: { fatture_coda_accoda: () => ({ data: null, error: { code } }) } })
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(res.status).toBe(503)
    const corpo = await res.json()
    expect(corpo.codice).toBe(CODICI_ERRORE_CODA.NON_DISPONIBILE)
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })

  it('un altro errore della RPC ⇒ 500 con codice, niente sveglia', async () => {
    saldati(1)
    monta({ rpc: { fatture_coda_accoda: () => ({ data: null, error: { code: '23514', message: 'check' } }) } })
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.SCRITTURA_FALLITA)
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })

  it('lettura dei pagamenti fallita ⇒ 500 LETTURA_FALLITA, nessun accodamento', async () => {
    saldati(1)
    monta({ errori: { pagamenti: { code: '57014' } } })
    const res = await POST(post({ voci: [{ pagamento_id: uuid(1) }] }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(rpcDi('fatture_coda_accoda')).toEqual([])
  })
})
