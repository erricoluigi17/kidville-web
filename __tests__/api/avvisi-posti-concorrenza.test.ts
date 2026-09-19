import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/avvisi/[id]/risposte — IL TETTO DEI POSTI NON SI CONTA QUI.
//
// ⚠️ CHE COSA QUESTO FILE **NON** DIMOSTRA, detto per primo perché è la cosa
// che chi rilegge potrebbe credere di avere e non ha.
//
// **Vitest non dimostra la serializzazione.** Non c'è un database, non ci sono
// due transazioni, non c'è un lock: due `POST` lanciati insieme in questo
// processo non collidono su niente, e un test che li lanciasse e li trovasse
// entrambi a 200 «proverebbe» esattamente quanto un test che non li lancia. La
// prova della serializzazione sta nella funzione di database — nel
// `SELECT … FROM avvisi WHERE id = … FOR UPDATE` e nel conteggio eseguito DOPO
// quel lock, come istruzione separata — e si potrebbe osservare solo su un
// Postgres vero, con due sessioni.
//
// QUELLO CHE QUESTO FILE DIMOSTRA, e che è il difetto vero da impedire, è che la
// route **deleghi**: che chiami `avviso_adesione_registra` con quegli argomenti
// e non conti i posti in TypeScript. Il ritorno al conteggio applicativo non si
// vedrebbe dallo status — una route che legge, somma e decide risponde 200
// esattamente come questa — e per questo le asserzioni sono sugli ARGOMENTI
// della chiamata e sulle tabelle NON lette, non sul colore della risposta.
//
// IL PRECEDENTE è `varia_saldo_ticket` (migrazione 20260907181116): il saldo
// letto, modificato e riscritto per valore assoluto. Due scritture concorrenti
// leggevano lo stesso numero e scrivevano lo stesso risultato, e il danno non
// era «saldo doppio» ma **incasso doppio e saldo singolo** — nessun errore,
// nessun log, e il numero che l'operatore guardava sembrava a posto. Qui la
// forma è identica: tetto 10, occupati 8, due famiglie da 2 nello stesso
// istante, e a scoprirlo è chi quel giorno conta le sedie.
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
  nRpc: 0,
  letture: [] as string[],
  scritture: [] as { tabella: string; riga: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireDocente: h.requireDocente }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // 🔴 IL FINTO LANCIA SU QUALUNQUE ALTRA `rpc`. È la rete contro la sostituzione
    // silenziosa: chi cambiasse il nome della funzione non troverebbe un verde.
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== 'avviso_adesione_registra') throw new Error(`rpc non emulata in questo finto: ${nome}`)
      h.nRpc += 1
      h.lastRpc = { nome, args }
      return Promise.resolve({ data: h.esitoRpc, error: null })
    },
    from(table: string) {
      h.letture.push(table)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        // ⚠️ Dal 2026-09-19 la route legge avviso e alunno PRIMA della RPC, per
        // verificare che quel bambino sia destinatario di quell'avviso (sede e
        // classe). Il finto li restituisce coerenti: qui si misura la delega del
        // conteggio dei posti al database, non il gate — che ha i suoi casi in
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
  h.nRpc = 0
  h.letture = []
  h.scritture = []
  h.esitoRpc = {
    ok: true, stato: 'ammessa', numero: 2, prima_lettura: false, prima_risposta: true,
    riga: { id: 'r1', stato_adesione: 'ammessa', numero_partecipanti: 2 },
  }
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte — i posti li conta il DATABASE', () => {
  it('invoca `avviso_adesione_registra` con ESATTAMENTE quegli argomenti', async () => {
    await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 2 }), ctx())

    // L'asserzione è QUESTA, non lo status: una route che contasse i posti da sé
    // risponderebbe 200 uguale, e il verde non direbbe niente.
    expect(h.lastRpc?.nome).toBe('avviso_adesione_registra')
    expect(h.lastRpc?.args).toEqual({
      p_avviso_id: AVVISO_ID,
      p_parent_id: PARENT_ID,
      p_student_id: STUDENT_ID,
      p_risposta: 'si',
      p_numero: 2,
    })
  })

  it('`p_ora` NON si manda: il termine si misura con l’orologio del DATABASE', async () => {
    // Due orologi (quello del processo Node e quello di Postgres) misurano lo
    // stesso termine in due modi, e nella finestra fra i due una adesione tardiva
    // passa o una in tempo viene respinta. Il default della funzione è `now()`.
    await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    // ⚠️ Prima di guardare le CHIAVI si pretende la chiamata: `Object.keys(undefined ?? {})`
    // è `[]`, e `[] non contiene 'p_ora'` è vero anche quando la RPC non è mai
    // partita. Senza questa riga il test sarebbe verde proprio nel caso in cui
    // qualcuno ha tolto la delega — che è il difetto che questo file sorveglia.
    expect(h.lastRpc, 'la RPC non è stata invocata affatto').not.toBeNull()
    expect(Object.keys(h.lastRpc?.args ?? {})).not.toContain('p_ora')
  })

  it('la route NON legge `avvisi_risposte` per contare i posti', async () => {
    // Il conteggio applicativo comincia sempre così: una `select` sulle risposte
    // dell'avviso, una somma, un `if`. Se ricompare, questa riga diventa rossa —
    // ed è il solo punto in cui il ritorno al calcolo in TypeScript è visibile.
    await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 2 }), ctx())
    expect(h.letture, 'la route sta rileggendo le risposte: sta per contarsi i posti da sola').not.toContain('avvisi_risposte')
    expect(h.scritture, 'la riga è stata scritta fuori dalla funzione che serializza').toEqual([])
  })

  it('UNA sola chiamata per richiesta: nessuna pre-lettura, nessun secondo giro', async () => {
    // La pre-lettura che c'era prima («esiste già una risposta?») non è sparita
    // per eleganza: fra quella `select` e l'`upsert` c'era una finestra TOCTOU in
    // cui due richieste dello stesso genitore concludevano entrambe «è la prima
    // volta», e l'autore dell'avviso riceveva due notifiche.
    await POST(req({ student_id: STUDENT_ID, risposta: 'si', numero_partecipanti: 2 }), ctx())
    expect(h.nRpc).toBe(1)
  })

  it('`prima_lettura`/`prima_risposta` arrivano dalla RPC, non da una query della route', async () => {
    h.esitoRpc = {
      ok: true, stato: 'ammessa', numero: 1, prima_lettura: false, prima_risposta: false,
      riga: { id: 'r1', stato_adesione: 'ammessa' },
    }
    await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    // Nessuna delle due è vera: l'autore non va notificato. Se la route si
    // ricalcolasse la condizione da sé, questa riga cadrebbe.
    expect(h.notificaEvento).not.toHaveBeenCalled()

    h.esitoRpc = {
      ok: true, stato: 'ammessa', numero: 1, prima_lettura: true, prima_risposta: true,
      riga: { id: 'r1', stato_adesione: 'ammessa' },
    }
    await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
  })
})
