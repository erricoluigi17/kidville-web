import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Vista genitore delle presenze primaria: lista dei soli stati negativi ──────
// (assenze/ritardi/uscite) + RIEPILOGO con COUNT per stato (incluso `presente`),
// così un bambino presente non è più indistinguibile da un appello non fatto.
// Auth via requireParentOfStudent (IDOR-safe); lettura service-role su `presenze`.
//
// Il mock distingue la query-lista (`.in('stato', [...])`) dalle query-conteggio
// (`.select('id', { count:'exact', head:true }).eq('stato', X)`) e ritorna il
// count per lo stato filtrato — così l'asserzione non dipende dall'ordine di call.

const h = vi.hoisted(() => {
  const state = {
    listResult: { data: null as unknown, error: null as unknown },
    counts: {} as Record<string, number>,
    countError: null as unknown,
    /** Le colonne chieste dalla query-LISTA (A5): il flag deve essere fra queste. */
    colonneLista: null as string | null,
  }
  function makeClient() {
    return {
      from(table: string) {
        const ctx: { head: boolean; stato?: string } = { head: false }
        const qb: Record<string, unknown> = {}
        qb.select = (_cols: string, opts?: { head?: boolean; count?: string }) => {
          if (opts?.head) ctx.head = true
          else if (table === 'presenze') state.colonneLista = _cols
          return qb
        }
        qb.eq = (col: string, val: string) => {
          if (col === 'stato') ctx.stato = val
          return qb
        }
        // `or` è il filtro sulla SORGENTE aggiunto da Q4 (`limitaAiFatti`): il
        // tetto `data <= oggi` non può escludere una riga che cade su OGGI.
        // Senza il metodo la catena esplode e la rotta risponde 500 — cioè un
        // rosso che non parla del merito.
        for (const m of ['in', 'order', 'limit', 'gte', 'lte', 'or']) qb[m] = () => qb
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          if (table !== 'presenze') return Promise.resolve({ data: null, count: null, error: null }).then(res, rej)
          const out = ctx.head
            ? { data: null, count: state.counts[ctx.stato ?? ''] ?? null, error: state.countError }
            : state.listResult
          return Promise.resolve(out).then(res, rej)
        }
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const auth = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: auth.requireParentOfStudent }))

import { GET } from '@/app/api/parent/primaria/assenze/route'
import { NextRequest, NextResponse } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/parent/primaria/assenze${qs}`, {
    headers: { 'x-user-id': 'u-1' },
  })
}

const NEG = [
  { id: 'p1', data: '2026-05-10', stato: 'assente', orario_entrata: null, orario_uscita: null, giustificata: false, giustificazione_testo: null, giustificata_il: null, note_appello: null, assenza_oraria_giustificata: false },
  { id: 'p2', data: '2026-05-08', stato: 'ritardo', orario_entrata: '2026-05-08T08:40:00Z', orario_uscita: null, giustificata: true, giustificazione_testo: 'traffico', giustificata_il: '2026-05-08T10:00:00Z', note_appello: null, assenza_oraria_giustificata: false },
  { id: 'p3', data: '2026-05-02', stato: 'uscita_anticipata', orario_entrata: null, orario_uscita: '2026-05-02T12:30:00Z', giustificata: false, giustificazione_testo: null, giustificata_il: null, note_appello: 'visita medica', assenza_oraria_giustificata: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.state.listResult = { data: [], error: null }
  h.state.counts = {}
  h.state.countError = null
  h.state.colonneLista = null
  auth.requireParentOfStudent.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' }, response: null })
})

describe('GET /api/parent/primaria/assenze', () => {
  it('401 senza sessione', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await GET(req('?studentId=a-1'))
    expect(res.status).toBe(401)
  })

  it('403 se il figlio non è del genitore (IDOR)', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
    const res = await GET(req('?studentId=a-2'))
    expect(res.status).toBe(403)
  })

  it('400 senza studentId', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
  })

  it('riepilogo: conta presente/assente/ritardo/uscita con COUNT per stato', async () => {
    h.state.counts = { presente: 152, assente: 4, ritardo: 2, uscita_anticipata: 1 }
    h.state.listResult = { data: NEG, error: null }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.riepilogo).toEqual({ presente: 152, assente: 4, ritardo: 2, uscita_anticipata: 1 })
  })

  it('la lista dei negativi resta invariata nel contenuto', async () => {
    h.state.counts = { presente: 100, assente: 1, ritardo: 1, uscita_anticipata: 1 }
    h.state.listResult = { data: NEG, error: null }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(body.data).toEqual(NEG)
  })

  it('degrada a 0/[] se le query falliscono (E2E DB non migrato)', async () => {
    h.state.listResult = { data: null, error: { code: '42P01', message: 'relation "presenze" does not exist' } }
    h.state.countError = { code: '42P01' }
    h.state.counts = {}
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.riepilogo).toEqual({ presente: 0, assente: 0, ritardo: 0, uscita_anticipata: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// T31 — UN 200 CHE NON DICE SE HA LETTO È UN 200 CHE MENTE
//
// La lettura fallita era LOGGATA — e va bene — ma la risposta restava
// `200 {success:true, data:[]}`: dal client, «non l'ho potuto leggere» e «non ne
// hai» sono la stessa identica risposta. La schermata mostrava «nessuna assenza»
// e quattro zeri a un genitore il cui figlio poteva averne dieci.
//
// La forma è quella già scelta dalla rotta sorella (`comunicateLette`): il campo
// dice se quel pezzo è stato letto. Il client lo tratta come guasto SOLO quando
// vale esplicitamente `false`.
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET — la risposta dichiara se ha letto davvero (T31)', () => {
  it('lettura riuscita: `letto` e `riepilogoLetto` sono veri', async () => {
    h.state.listResult = { data: [], error: null }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.letto).toBe(true)
    expect(body.riepilogoLetto).toBe(true)
  })

  it('lettura FALLITA: 200 formalmente buono, ma `letto` è false', async () => {
    h.state.listResult = { data: null, error: { code: '42703', message: 'column does not exist' } }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    // Senza questo campo il client non ha NIENTE per distinguere i due casi:
    // `success: true` e `data: []` sono identici in entrambi.
    expect(body.letto, 'la risposta deve dichiarare di non aver letto').toBe(false)
  })

  it('riepilogo non contato: `riepilogoLetto` è false — quattro zeri sono una frase', async () => {
    h.state.listResult = { data: [], error: null }
    h.state.countError = { code: '42P01', message: 'relation does not exist' }
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.riepilogoLetto).toBe(false)
  })

  it('il messaggio grezzo di PostgREST non esce mai verso il genitore', async () => {
    h.state.listResult = { data: null, error: { code: '42703', message: 'column presenze.pippo does not exist' } }
    const res = await GET(req('?studentId=a-1'))
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('does not exist')
    expect(corpo).not.toContain('pippo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// A5 — IL GENITORE VEDE LA NOTA DEL RITARDO / DELL'USCITA GIUSTIFICATI
//
// Il docente può segnare un ritardo o un'uscita anticipata come «giustificati»
// (es. terapia): lo stato resta quello vero, ma quelle ore non contano. La pagina
// del genitore deve poterlo DIRE, quindi la rotta restituisce anche il flag
// `assenza_oraria_giustificata` — sempre booleano, e vero solo sui due stati in
// cui ha senso (lo stesso vincolo del trigger nel DB).
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET — assenza_oraria_giustificata (A5)', () => {
  const riga = (o: Record<string, unknown>) => ({
    id: 'x', data: '2026-09-25', stato: 'ritardo', orario_entrata: '2026-09-25T10:05:00', orario_uscita: null,
    giustificata: false, giustificazione_testo: null, giustificata_il: null, note_appello: 'terapia',
    assenza_oraria_giustificata: true, ...o,
  })

  it('la colonna è chiesta al DB: senza, il flag non arriverebbe mai al genitore', async () => {
    h.state.listResult = { data: [], error: null }
    await GET(req('?studentId=a-1'))
    expect(h.state.colonneLista).toContain('assenza_oraria_giustificata')
    // la nota era già restituita e resta tale
    expect(h.state.colonneLista).toContain('note_appello')
  })

  it('ritardo e uscita giustificati: il flag esce vero, con la nota', async () => {
    h.state.listResult = {
      data: [riga({ id: 'r1' }), riga({ id: 'u1', stato: 'uscita_anticipata', note_appello: 'logopedia' })],
      error: null,
    }
    const body = await (await GET(req('?studentId=a-1'))).json()
    expect(body.data.map((r: { id: string; assenza_oraria_giustificata: unknown; note_appello: unknown }) =>
      [r.id, r.assenza_oraria_giustificata, r.note_appello])).toEqual([
      ['r1', true, 'terapia'],
      ['u1', true, 'logopedia'],
    ])
  })

  it('sempre booleano: null o assente dal DB escono come false, mai undefined', async () => {
    const senza = riga({ id: 's1' }) as Record<string, unknown>
    delete senza.assenza_oraria_giustificata
    h.state.listResult = { data: [riga({ id: 'n1', assenza_oraria_giustificata: null }), senza], error: null }
    const body = await (await GET(req('?studentId=a-1'))).json()
    expect(body.data.map((r: { assenza_oraria_giustificata: unknown }) => r.assenza_oraria_giustificata)).toEqual([false, false])
  })

  it('un flag vero su un\'assenza piena non esce vero: si giustificano solo ritardo e uscita', async () => {
    h.state.listResult = { data: [riga({ id: 'a1', stato: 'assente', orario_entrata: null })], error: null }
    const body = await (await GET(req('?studentId=a-1'))).json()
    expect(body.data[0].assenza_oraria_giustificata).toBe(false)
    // la nota del docente sull'assenza resta visibile come prima
    expect(body.data[0].note_appello).toBe('terapia')
  })
})
