import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// POST /api/avvisi/[id]/risposte — presa-visione/adesione del GENITORE.
// Falle chiuse: G4 (IDOR write anonima/altrui) + morosità (adesione = azione di servizio).
//  - requireUser (mai anonimo)
//  - parent_id DALLA SESSIONE (il body è ignorato → no spoofing)
//  - genitoreHasFiglio(parent_id, student_id) (no risposte per figli altrui)
//  - assertGenitoreNonSospeso (moroso bloccato)
//  - risposta ∈ {si,no}

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const STUDENT_ID = '22222222-2222-2222-2222-222222222222'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'

// ⚠️ DAL 2026-09-19 LA ROUTE NON FA PIÙ L'UPSERT: chiama
// `avviso_adesione_registra`, che decide termine, numero, tetto dei posti e lista
// d'attesa sotto un lock su `avvisi`. Le QUATTRO asserzioni di sicurezza di questo
// file non cambiano di una virgola — 401 anonimo, 403 IDOR, 403 moroso, e il
// `parent_id` preso dalla SESSIONE (difetto G4, già sfruttabile per forgiare prese
// visione e adesioni su minori) — perché nessuna di loro dipende da COME la riga
// viene scritta: dipendono dal fatto che non si arrivi mai a scriverla.
// È cambiato solo il TESTIMONE: da `lastUpsert` a `lastRpc`.
//
// ⚠️ E IL VECCHIO TESTIMONE È STATO SPOSTATO, non lasciato dov'era (2026-09-19).
// Quattro `expect(h.lastUpsert).toBeNull()` erano sopravvissuti nei rami 401/403/400:
// lì la route non arriva a fare NIENTE, quindi erano verdi comunque — decorazione
// accanto al testimone vivo, e la forma esatta di asserzione che non può diventare
// rossa. Ne resta UNA SOLA, sul ramo che va a buon fine, dove invece significa
// qualcosa: se qualcuno riportasse il conteggio dei posti in TypeScript con un
// `upsert`, quella riga lo vedrebbe. Le quattro asserzioni di SICUREZZA del file
// (401 anonimo, 403 IDOR, 403 moroso, `parent_id` dalla sessione) non sono state
// toccate: sono rette da `lastRpc` e dallo status, e quelle sì diventano rosse.
// ⚠️ E DAL 2026-09-19 LA ROUTE LEGGE ANCHE L'AVVISO E L'ALUNNO prima della RPC:
// un genitore con due figli in due plessi poteva rispondere a un avviso di una
// sede mandando lo `student_id` del figlio dell'ALTRA, e la riga veniva scritta.
// Il finto porta quindi due righe nuove — `h.avviso` e `h.alunno` — che di
// DEFAULT sono coerenti (stessa sede, avviso globale), così le cinque asserzioni
// storiche di questo file continuano a misurare ciò che misuravano. Il gate ha i
// suoi casi in `avvisi-risposte-cerchio-sede.test.ts`, dove quelle due righe si
// muovono.
const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  notificaEvento: vi.fn(),
  lastUpsert: null as Record<string, unknown> | null,
  lastRpc: null as { nome: string; args: Record<string, unknown> } | null,
  existing: null as unknown,
  avviso: null as Record<string, unknown> | null,
  alunno: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // 🔴 IL FINTO LANCIA SU UNA `rpc` CHE NON EMULA, di proposito. Se un giorno
    // qualcuno riportasse il conteggio dei posti in TypeScript — o cambiasse il
    // nome della funzione di database — un finto permissivo lo lascerebbe passare
    // verde per distrazione, che è la prima delle cinque forme di verde falso.
    // Qui il test si rompe e dice quale nome ha trovato.
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== 'avviso_adesione_registra') {
        throw new Error(`rpc non emulata in questo finto: ${nome}`)
      }
      h.lastRpc = { nome, args }
      // L'esito FELICE nella forma dichiarata dal `COMMENT ON FUNCTION` della
      // migrazione A2: `{ok, stato, numero, prima_lettura, prima_risposta, riga}`.
      return Promise.resolve({
        data: {
          ok: true,
          stato: args.p_risposta === 'si' ? 'ammessa' : null,
          numero: args.p_numero ?? null,
          prima_lettura: true,
          prima_risposta: args.p_risposta != null,
          riga: { id: 'r1', avviso_id: args.p_avviso_id, parent_id: args.p_parent_id, student_id: args.p_student_id },
        },
        error: null,
      })
    },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        if (table === 'avvisi_risposte') return { data: h.existing }
        if (table === 'avvisi') return { data: h.avviso }
        if (table === 'alunni') return { data: h.alunno }
        if (table === 'utenti') return { data: { role: 'segreteria' } }
        return { data: null }
      }
      b.upsert = (rec: Record<string, unknown>) => {
        h.lastUpsert = rec
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
  h.lastUpsert = null
  h.lastRpc = null
  h.existing = null
  h.avviso = { author_id: 'aut-x', titolo: 'T', scuola_id: 'sc-1', target_scope: 'globale', target_classes: null }
  h.alunno = { scuola_id: 'sc-1', classe_sezione: '1A' }
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte', () => {
  it('401 quando anonimo (requireUser nega)', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await POST(req({ student_id: STUDENT_ID }), ctx())
    expect(res.status).toBe(401)
    expect(h.lastRpc, 'gate saltato: la RPC è stata invocata lo stesso').toBeNull()
  })

  it('403 quando lo studente NON è figlio del genitore di sessione (IDOR)', async () => {
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await POST(req({ student_id: STUDENT_ID, parent_id: 'ALTRO' }), ctx())
    expect(res.status).toBe(403)
    expect(h.lastRpc, 'gate saltato: la RPC è stata invocata lo stesso').toBeNull()
  })

  it('403 quando il genitore è sospeso per morosità', async () => {
    h.assertGenitoreNonSospeso.mockResolvedValue(NextResponse.json({ error: 'sospeso' }, { status: 403 }))
    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(res.status).toBe(403)
    expect(h.lastRpc, 'gate saltato: la RPC è stata invocata lo stesso').toBeNull()
  })

  it('usa il parent_id dalla SESSIONE e ignora quello del body (no spoofing)', async () => {
    const res = await POST(req({ student_id: STUDENT_ID, parent_id: 'SPOOF', risposta: 'si' }), ctx())
    expect(res.status).toBe(200)
    // ⚠️ L'UNICA delle cinque asserzioni che ha dovuto cambiare FORMA, e la
    // ragione è che il testimone si è spostato: il `parent_id` non finisce più in
    // un `upsert` ma nel parametro `p_parent_id` della RPC. La cosa provata è la
    // stessa identica — l'identità viene dalla SESSIONE e quella del corpo è
    // ignorata (difetto G4) — e `lastUpsert` da solo sarebbe diventato
    // vacuamente `null`, cioè verde qualunque cosa la route scrivesse.
    expect(h.lastRpc?.args.p_parent_id).toBe(PARENT_ID)
    expect(h.lastRpc?.args.p_parent_id).not.toBe('SPOOF')
    expect(h.lastRpc?.args.p_risposta).toBe('si')
    expect(h.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), PARENT_ID, STUDENT_ID)
    // L'UNICO `lastUpsert` rimasto, ed è qui perché qui può diventare rosso: sul
    // percorso principale la riga la scrive la RPC sotto il lock, e un `upsert` di
    // ritorno significherebbe il tetto dei posti ricontato in TypeScript.
    expect(h.lastUpsert, 'il conteggio dei posti è tornato in TypeScript: la route ha fatto un upsert').toBeNull()
  })

  it('400 quando risposta non è si/no', async () => {
    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'forse' }), ctx())
    expect(res.status).toBe(400)
    expect(h.lastRpc, 'validazione saltata: la RPC è stata invocata lo stesso').toBeNull()
  })
})
