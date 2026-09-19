import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/avvisi/[id]/risposte — LA LISTA D'ATTESA È UN ESITO FELICE.
//
// 🔴 `stato: 'in_attesa'` esce **200**, non un 4xx, e non è un dettaglio di
// forma: è la differenza fra «la tua richiesta è arrivata e sei in fila» e «la
// tua richiesta è stata respinta». La funzione di database restituisce
// `ok: true` proprio per dire la prima, e una route che trattasse il posto
// mancante come un errore racconterebbe la seconda a una famiglia che invece è
// in coda — e che, se in coda non si sapesse, non tornerebbe a controllare.
//
// ⚠️ E il `POSTI_ESAURITI` della funzione NON è questo caso. A chi non ha posto
// la RPC non lo restituisce mai: quel genitore finisce qui, con `ok:true`.
// L'unico caso in cui lo restituisce è chi è GIÀ ammesso e non riesce ad
// aumentare il numero — vedi l'ultimo test.
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
        // classe). Qui vanno coerenti: questo file misura la lista d'attesa, non
        // il gate — che ha i suoi casi in `avvisi-risposte-cerchio-sede.test.ts`.
        if (table === 'avvisi') {
          return { data: { author_id: 'aut-x', titolo: 'T', scuola_id: 'sc-1', target_scope: 'globale', target_classes: null } }
        }
        if (table === 'alunni') return { data: { scuola_id: 'sc-1', classe_sezione: '1A' } }
        if (table === 'utenti') return { data: { role: 'segreteria' } }
        return { data: null }
      }
      b.upsert = (rec: Record<string, unknown>) => ({
        select: () => ({ single: async () => ({ data: { id: 'r1', ...rec }, error: null }) }),
      })
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
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte — la lista d’attesa', () => {
  it('`stato: in_attesa` esce 200, NON un errore', async () => {
    h.esitoRpc = {
      ok: true, stato: 'in_attesa', numero: 4, prima_lettura: false, prima_risposta: true,
      riga: { id: 'r1', stato_adesione: 'in_attesa', numero_partecipanti: 4, in_coda_dal: '2026-09-19T10:00:00Z' },
    }

    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 4 }), ctx())

    expect(res.status, 'essere in coda non è un rifiuto: la richiesta è arrivata').toBe(200)
    const corpo = await res.json()
    // Il client deve poter distinguere «sei dentro» da «sei in fila»: senza
    // questo campo la schermata mostrerebbe «adesione confermata» a chi aspetta.
    expect(corpo.stato).toBe('in_attesa')
    expect(corpo.codice, 'un esito felice non porta un codice d’errore').toBeUndefined()
  })

  it('la coda non rivela MAI quanti posti restano', async () => {
    // Decisione vincolante del committente: al genitore il residuo non si mostra.
    h.esitoRpc = {
      ok: true, stato: 'in_attesa', numero: 4, prima_lettura: false, prima_risposta: true,
      riga: { id: 'r1', stato_adesione: 'in_attesa', numero_partecipanti: 4 },
    }
    const corpo = await (await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 4 }), ctx())).json()
    expect(corpo.occupati).toBeUndefined()
    expect(corpo.posti_totali).toBeUndefined()
  })

  it('chi è GIÀ ammesso e non riesce ad aumentare legge il suo numero, non il residuo', async () => {
    // 🔴 L'UNICO `POSTI_ESAURITI` che questa strada può produrre. La famiglia è
    // DENTRO con 2 persone e ne chiede 5: la modifica viene rifiutata e non le
    // viene tolto niente — «nessuna famiglia deve poter uscire dalla gita per
    // aver provato a portare la nonna». Il corpo porta ciò che HA, non ciò che
    // resta.
    h.esitoRpc = {
      ok: false, code: 'POSTI_ESAURITI',
      occupati: 9, posti_totali: 10, richiesti: 5,
      stato: 'ammessa', numero: 2,
    }

    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 5 }), ctx())
    expect(res.status).toBe(409)

    const corpo = await res.json()
    expect(corpo.codice).toBe('POSTI_ESAURITI')
    expect(corpo.stato, 'la famiglia è ancora dentro e deve poterlo leggere').toBe('ammessa')
    expect(corpo.numero, 'il numero che ha già, non quelli che restano').toBe(2)
    expect(corpo.occupati, 'al genitore i posti liberi non si mostrano mai').toBeUndefined()
    expect(corpo.posti_totali).toBeUndefined()
    expect(corpo.richiesti).toBeUndefined()
  })
})
