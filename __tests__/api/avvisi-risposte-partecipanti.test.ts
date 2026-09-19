import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/avvisi/[id]/risposte — IL NUMERO DI PARTECIPANTI.
//
// Due difese, e non sono la stessa:
//
//  · `zNumeroPartecipanti` è la difesa di CAMPO — intero, fra 1 e il tetto
//    assoluto della colonna. Vive in zod e scatta PRIMA della RPC: `2.5`
//    arriverebbe a una `smallint` e produrrebbe un 22P02, cioè un 500.
//  · L'intervallo dell'AVVISO (`numero_min`/`numero_max`) e l'obbligo di
//    indicarlo (`chiedi_numero`) sono un rapporto fra DUE campi e una riga
//    padre: li decide `avviso_adesione_registra`, non questa route.
//
// Il test prova che la route non confonde le due: non si inventa un intervallo
// proprio, e non si inventa un valore quando il campo manca.
// =============================================================================

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const STUDENT_ID = '22222222-2222-2222-2222-222222222222'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  notificaEvento: vi.fn(),
  esitoRpc: null as unknown,
  lastRpc: null as { nome: string; args: Record<string, unknown> } | null,
  scritture: [] as { tabella: string; riga: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireDocente: h.requireDocente }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== 'avviso_adesione_registra') throw new Error(`rpc non emulata in questo finto: ${nome}`)
      h.lastRpc = { nome, args }
      return Promise.resolve({ data: h.esitoRpc, error: null })
    },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        // ⚠️ Dal 2026-09-19 la route legge avviso e alunno PRIMA della RPC, per
        // verificare che quel bambino sia destinatario di quell'avviso (sede e
        // classe). Qui vanno coerenti: questo file misura il numero di
        // partecipanti, non il gate — che ha i suoi casi in
        // `avvisi-risposte-cerchio-sede.test.ts`.
        if (table === 'avvisi') {
          return { data: { author_id: 'aut-x', titolo: 'T', scuola_id: 'sc-1', target_scope: 'globale', target_classes: null } }
        }
        if (table === 'alunni') return { data: { scuola_id: 'sc-1', classe_sezione: '1A' } }
        if (table === 'utenti') return { data: { role: 'segreteria' } }
        return { data: null }
      }
      b.upsert = (rec: Record<string, unknown>) => {
        h.scritture.push({ tabella: table, riga: rec })
        return { select: () => ({ single: async () => ({ data: { id: 'r1', ...rec }, error: null }) }) }
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/avvisi/[id]/risposte/route'

const ctx = (id = AVVISO_ID) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => ({
  url: `http://test/api/avvisi/${AVVISO_ID}/risposte`,
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
}) as never

const OK = {
  ok: true, stato: 'ammessa', numero: 3, prima_lettura: false, prima_risposta: true,
  riga: { id: 'r1', stato_adesione: 'ammessa', numero_partecipanti: 3 },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.lastRpc = null
  h.scritture = []
  h.esitoRpc = OK
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte — il numero di partecipanti', () => {
  it('numero ASSENTE con la bandierina accesa → 400 e NESSUNA riga', async () => {
    // `chiedi_numero` è acceso sull'avviso: la funzione di database lo sa, la
    // route no. Il rifiuto arriva da lì e la route lo traduce.
    h.esitoRpc = { ok: false, code: 'NUMERO_RICHIESTO', numero_min: 1, numero_max: 6 }

    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('NUMERO_PARTECIPANTI_RICHIESTO')
    expect(h.scritture, 'una riga è stata scritta nonostante il numero mancasse').toEqual([])
  })

  it('il campo mancante viaggia come `null`, non inventato a 1', async () => {
    // ⚠️ La differenza fra «assente» e «uguale a prima» è PORTANTE: la funzione
    // di database conserva il numero già raccolto quando non gliene arriva uno,
    // e ne pretende uno nuovo solo se il chiamante lo ha davvero mandato. Se la
    // route riempisse il vuoto con un default, quella distinzione morirebbe qui.
    await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(h.lastRpc?.args.p_numero).toBeNull()
  })

  it('il numero indicato arriva alla RPC COM’È: la route non impone un intervallo proprio', async () => {
    // Sette persone. Su un avviso con `numero_min`/`numero_max` a NULL non c'è
    // nessun vincolo da far valere, e la route non deve inventarne uno: passa il
    // valore e rispetta l'esito.
    await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 7 }), ctx())
    expect(h.lastRpc?.args.p_numero).toBe(7)
    expect(h.lastRpc?.args.p_risposta).toBe('si')
  })

  it('fuori intervallo dell’AVVISO → 400, e la frase è quella dell’intervallo', async () => {
    h.esitoRpc = { ok: false, code: 'NUMERO_FUORI_INTERVALLO', numero_min: 1, numero_max: 4 }

    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 9 }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('NUMERO_PARTECIPANTI_FUORI_INTERVALLO')
    expect(h.scritture).toEqual([])
  })

  it('la difesa di CAMPO scatta PRIMA della RPC (zero, decimale, oltre il tetto)', async () => {
    // Questi tre non devono nemmeno raggiungere il database: `0` e `2.5`
    // sfonderebbero il `CHECK` della colonna, e un 22P02 uscirebbe come 500 —
    // cioè un guasto del server per uno sbaglio di digitazione.
    for (const numero of [0, 2.5, 100000]) {
      h.lastRpc = null
      const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: numero }), ctx())
      expect(res.status, `numero ${numero} avrebbe dovuto essere rifiutato da zod`).toBe(400)
      expect(h.lastRpc, `numero ${numero} è arrivato fino alla RPC`).toBeNull()
    }
  })
})
