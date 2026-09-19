import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/avvisi/[id]/risposte — IL TERMINE.
//
// Due casi, e il secondo è quello che rende vero il primo.
//
//  1. Dopo la scadenza per aderire, un `si` viene RIFIUTATO con 409 e **non
//     scrive niente**. Non «scrive e poi segnala»: non scrive.
//
//  2. La sola PRESA VISIONE dopo quella stessa scadenza — ma prima che l'avviso
//     sparisca dalla bacheca — PASSA. È il caso che dà senso al primo: un
//     rifiuto messo troppo in alto (nella route, sopra la funzione di database)
//     bloccherebbe anche la lettura, e l'elenco «chi non ha letto l'avviso»
//     diventerebbe una bugia — ci finirebbe dentro chi l'ha letto davvero, solo
//     tardi. Leggere tardi non è aderire.
//
// La regola vive in `avviso_adesione_registra`, che controlla il termine SOLO
// se `p_risposta IS NOT NULL`. Questo test verifica che la route non ne aggiunga
// una propria sopra: manda `p_risposta: null` e rispetta l'esito che riceve.
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
    // 🔴 LANCIA su una `rpc` che non emula: se qualcuno riportasse la decisione
    // del termine in TypeScript, o rinominasse la funzione, questo finto non lo
    // coprirebbe in silenzio.
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
        // classe). Qui vanno coerenti: questo file misura il TERMINE, che resta
        // interamente della funzione di database — il gate ha i suoi casi in
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

beforeEach(() => {
  vi.clearAllMocks()
  h.lastRpc = null
  h.scritture = []
  h.esitoRpc = null
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte — il termine per aderire', () => {
  it('409 ADESIONE_SCADUTA quando il termine è passato, e NESSUNA riga viene scritta', async () => {
    h.esitoRpc = { ok: false, code: 'TERMINE_SCADUTO', termine: '2026-09-01T12:00:00Z' }

    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(res.status).toBe(409)

    const corpo = await res.json()
    expect(corpo.codice, 'il client deve poter tradurre il rifiuto: senza codice legge la prosa del server').toBe('ADESIONE_SCADUTA')

    // Non «scrive e poi segnala»: non scrive. L'unico canale di scrittura di
    // questa route è la RPC, e quella ha risposto `ok:false`.
    expect(h.scritture, 'una riga è stata scritta nonostante il rifiuto').toEqual([])
  })

  it('la PRESA VISIONE dopo il termine per aderire PASSA (leggere tardi non è aderire)', async () => {
    // L'avviso è ancora in bacheca, le adesioni sono chiuse. La funzione di
    // database, in questo caso, non guarda affatto il termine.
    h.esitoRpc = {
      ok: true, stato: null, numero: null, prima_lettura: true, prima_risposta: false,
      riga: { id: 'r1', avviso_id: AVVISO_ID, parent_id: PARENT_ID, student_id: STUDENT_ID },
    }

    const res = await POST(req({ student_id: STUDENT_ID }), ctx())
    expect(res.status, 'un rifiuto messo sopra la RPC bloccherebbe anche la sola lettura').toBe(200)

    // ⚠️ L'ASSERZIONE CHE FA IL LAVORO. `null` e non `undefined`: è il valore che
    // dice alla funzione «sto solo leggendo», ed è ciò che le fa saltare il
    // controllo del termine. Se la route mandasse `'si'` per difetto, o
    // rifiutasse da sé prima di chiamare, questa riga diventa rossa.
    expect(h.lastRpc?.args.p_risposta).toBeNull()
    expect(h.lastRpc?.nome).toBe('avviso_adesione_registra')
  })

  it('la route non conosce le scadenze: rispetta l’esito che riceve, qualunque sia', async () => {
    // Stesso corpo della richiesta, due esiti opposti dalla funzione di
    // database, due risposte opposte dalla route. È la prova che la decisione
    // NON è qui: se la route avesse una propria idea del termine, uno dei due
    // giri non potrebbe cambiare colore.
    h.esitoRpc = {
      ok: true, stato: 'ammessa', numero: null, prima_lettura: false, prima_risposta: true,
      riga: { id: 'r1', stato_adesione: 'ammessa' },
    }
    expect((await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())).status).toBe(200)

    h.esitoRpc = { ok: false, code: 'TERMINE_SCADUTO' }
    expect((await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())).status).toBe(409)
  })
})
