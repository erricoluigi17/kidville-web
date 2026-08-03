import { describe, it, expect, vi, beforeEach } from 'vitest'

// T11-F2 — LOCK: `GET /api/avvisi` non deve più interrogare il database
// UNA VOLTA PER AVVISO.
//
// Il difetto misurato il 2026-08-03: `autoreEStats` girava dentro un `.map()`,
// tre `count` su `avvisi_risposte` più una lettura di `utenti` per ogni avviso
// (cinque nel ramo genitore, con le risposte del genitore). Il `Promise.all`
// esterno le parallelizzava, quindi il cronometro non se ne accorgeva e i test
// nemmeno: nessuna asserzione contava le query.
//
// Questo file conta le query per tabella e le confronta con un TETTO ASSOLUTO,
// non con «meno di prima». Un tetto relativo lascerebbe passare una regressione
// che moltiplica per dieci restando sotto il vecchio numero.
//
// LA PROVA CHE IL LOCK È VIVO: il test gira due volte lo STESSO scenario, con 3
// avvisi e con 30. Se il conteggio delle query cambiasse fra i due, saremmo
// tornati al comportamento per-avviso — ed è l'unica manomissione che conta.

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  avvisi: [] as Array<Record<string, unknown>>,
  risposte: [] as Array<Record<string, unknown>>,
  alunni: [] as Array<Record<string, unknown>>,
  utenti: [] as Array<Record<string, unknown>>,
  /** Query per tabella: è il dato che questo file esiste per misurare. */
  query: {} as Record<string, number>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiScuola: vi.fn(), genitoriDiClassi: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
// La firma degli allegati è un'altra storia (e ha il suo test): qui deve solo
// non aggiungere query al conteggio.
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      h.query[tabella] = (h.query[tabella] ?? 0) + 1
      const st = { ids: [] as string[], parent: null as string | null }
      const dati = () => {
        if (tabella === 'avvisi') return h.avvisi
        if (tabella === 'alunni') return h.alunni
        if (tabella === 'utenti') return h.utenti.filter((u) => st.ids.includes(u.id as string))
        if (tabella === 'avvisi_risposte') {
          return h.risposte.filter(
            (r) => st.ids.includes(r.avviso_id as string) && (st.parent === null || r.parent_id === st.parent),
          )
        }
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = (_c: string, v: unknown) => { st.parent = v as string; return b }
      b.in = (_c: string, v: string[]) => { st.ids = v; return b }
      b.not = () => b
      b.limit = () => b
      b.range = async (da: number, a: number) => {
        const tutte = dati()
        return { data: tutte.slice(da, a + 1), count: tutte.length, error: null }
      }
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: dati(), error: null }).then(onF, onR)
      return b
    },
  }),
}))

import { GET } from '@/app/api/avvisi/route'

const req = () => ({
  url: 'http://test/api/avvisi',
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams() },
  cookies: { get: () => undefined },
}) as never

/** N avvisi tutti di autori diversi: il caso peggiore per la lettura in blocco. */
function preparaAvvisi(n: number) {
  h.avvisi = Array.from({ length: n }, (_, i) => ({
    id: `av-${i}`, author_id: `aut-${i}`, titolo: `T${i}`, contenuto: 'c',
    tipo: 'presa_visione', target_scope: 'globale', target_classes: null,
    scadenza: null, attachment_url: null, created_at: '2026-08-01',
  }))
  h.utenti = Array.from({ length: n }, (_, i) => ({
    id: `aut-${i}`, first_name: `Nome${i}`, last_name: `Cognome${i}`, role: 'educator',
    nome: null, cognome: null, ruolo: null,
  }))
  // Risposte con conteggi DIVERSI fra i due avvisi provati, così un'aggregazione
  // che confondesse gli avvisi fra loro non resterebbe verde.
  h.risposte = [
    { avviso_id: 'av-0', parent_id: PARENT_ID, student_id: 's1', letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01' },
    { avviso_id: 'av-0', parent_id: 'altro', student_id: 's9', letto_il: '2026-08-01', risposta: 'si', risposto_il: '2026-08-01' },
    { avviso_id: 'av-0', parent_id: 'terzo', student_id: 's8', letto_il: '2026-08-01', risposta: 'no', risposto_il: '2026-08-01' },
    { avviso_id: 'av-1', parent_id: 'altro', student_id: 's7', letto_il: null, risposta: 'no', risposto_il: null },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.query = {}
  h.alunni = [{ id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: 'sc-1' }]
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.getFigliDiGenitore.mockResolvedValue(['s1'])
})

describe('GET /api/avvisi — ramo staff: le query non crescono con gli avvisi', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  })

  it('30 avvisi di 30 autori diversi: 1 lettura risposte + 1 lettura autori', async () => {
    preparaAvvisi(30)
    const res = await GET(req())
    expect(res.status).toBe(200)
    // TETTO ASSOLUTO. Col difetto erano 90 e 30.
    expect(h.query.avvisi_risposte).toBe(1)
    expect(h.query.utenti).toBe(1)
    expect(h.query.avvisi).toBe(1)
  })

  it('il conteggio delle query è IDENTICO con 3 e con 30 avvisi', async () => {
    preparaAvvisi(3)
    await GET(req())
    const conTre = { ...h.query }

    h.query = {}
    preparaAvvisi(30)
    await GET(req())
    const conTrenta = { ...h.query }

    expect(conTrenta).toEqual(conTre)
  })

  it('i conteggi restano ESATTI e distinti per avviso', async () => {
    preparaAvvisi(30)
    const res = await GET(req())
    const j = (await res.json()) as Array<{ id: string; stats: Record<string, number>; author: Record<string, string> }>
    const a0 = j.find((a) => a.id === 'av-0')!
    const a1 = j.find((a) => a.id === 'av-1')!
    const a2 = j.find((a) => a.id === 'av-2')!
    expect(a0.stats).toEqual({ letti: 3, adesioni_si: 2, adesioni_no: 1 })
    expect(a1.stats).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 1 })
    expect(a2.stats).toEqual({ letti: 0, adesioni_si: 0, adesioni_no: 0 })
    // L'autore giusto sul proprio avviso: la lettura in blocco deve riassociare,
    // non distribuire il primo a tutti.
    expect(a0.author).toEqual({ first_name: 'Nome0', last_name: 'Cognome0', role: 'educator' })
    expect(a2.author).toEqual({ first_name: 'Nome2', last_name: 'Cognome2', role: 'educator' })
  })
})

describe('GET /api/avvisi — ramo genitore: il percorso più caldo', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  })

  it('30 avvisi: 2 letture su avvisi_risposte (statistiche + risposte proprie), non 150', async () => {
    preparaAvvisi(30)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.query.avvisi_risposte).toBe(2)
    expect(h.query.utenti).toBe(1)
  })

  it('`my_response` resta quella del genitore, non di un\'altra famiglia', async () => {
    preparaAvvisi(30)
    const res = await GET(req())
    const j = (await res.json()) as Array<{ id: string; my_response: { risposta: string | null } | null }>
    // Su av-0 il genitore ha risposto 'si' per s1; su av-0 ci sono anche le
    // righe di altre due famiglie, che NON devono entrare nella sua risposta.
    expect(j.find((a) => a.id === 'av-0')!.my_response?.risposta).toBe('si')
    // Su av-1 ha risposto solo un'altra famiglia: per lui è ancora senza risposta.
    expect(j.find((a) => a.id === 'av-1')!.my_response?.risposta).toBeNull()
  })
})
