/**
 * `POST /api/attendance/daily` non segna presenze sui bambini di un'altra sede.
 *
 * IL DIFETTO (collaudo backend del 2026-07-31, rilievo F1 — **bloccante**).
 * L'handler POST aveva il solo gate di ruolo (`requireDocente`), prendeva
 * `alunno_id` dal corpo e faceva l'upsert leggendo la sede dall'anagrafica
 * dell'alunno. Nessun controllo di scope. Il tester l'ha dimostrato con scritture
 * vere in produzione, poi rimosse:
 *
 *   segreteria di AVERSA → POST {alunno_id: <bambino di GIUGLIANO>, stato:'presente'}
 *   → 200 {"id":"6275d6d2-…","scuola_id":"d53b0fbc-…"}   (la sede di Giugliano)
 *
 * Ripetuto identico con l'educator di Aversa. E con `stato:'assente'` la route
 * spedisce anche la notifica «tuo figlio è stato segnato assente» ai genitori
 * dell'altra sede: il danno non resta nel database.
 *
 * PERCHÉ IL LOCK NON L'AVEVA VISTO. Il file **importa** `assertClasseNomeInScope`
 * e `resolveScuoleAttive` (riga 5) e li usa **solo nella GET**. Il coverage-lock
 * cercava l'import a livello di FILE, non per handler: un import in cima amnistiava
 * tutti i metodi HTTP sotto. La GET era stata corretta, la POST no, e il lock è
 * rimasto verde. È esattamente il punto cieco che la riscrittura per-handler chiude.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31): togliendo `assertAlunnoInScope` dalla
 * POST, il primo caso qui sotto torna 200 e la scrittura viene registrata — cioè
 * il test diventa rosso su entrambe le asserzioni, lo status e la mutazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  assertClasseNomeInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  restringiASedeRichiesta: vi.fn(),
  notificaEvento: vi.fn(),
  scritture: [] as Array<{ tabella: string; valori: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: h.assertClasseNomeInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: h.restringiASedeRichiesta }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: vi.fn() }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'neq']) qb[m] = () => qb
      qb.maybeSingle = async () =>
        tabella === 'alunni'
          ? { data: { nome: 'X', scuola_id: 'sede-giugliano', section_id: 'sez-1' }, error: null }
          : { data: null, error: null }
      qb.single = async () => ({ data: { id: 'riga-1' }, error: null })
      qb.upsert = (v: unknown) => { h.scritture.push({ tabella, valori: v }); return qb }
      qb.insert = (v: unknown) => { h.scritture.push({ tabella, valori: v }); return qb }
      qb.update = (v: unknown) => { h.scritture.push({ tabella, valori: v }); return qb }
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { POST } from '@/app/api/attendance/daily/route'

const ALUNNO_ALTRA_SEDE = '11111111-1111-4111-8111-111111111111'

function richiesta(corpo: unknown): NextRequest {
  return new NextRequest('http://localhost/api/attendance/daily', {
    method: 'POST',
    body: JSON.stringify(corpo),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.requireDocente.mockResolvedValue({ user: { id: 'u-aversa', role: 'segreteria', scuola_id: 'sede-aversa' } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/attendance/daily — lo scope di sede vale anche in scrittura', () => {
  it('alunno di un\'altra sede ⇒ la risposta di rifiuto passa e NESSUNA presenza viene scritta', async () => {
    // È il caso che il 31/07 rispondeva 200 scrivendo su Giugliano.
    h.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'alunno fuori dal tuo plesso' }, { status: 403 }),
    )
    const res = await POST(richiesta({ alunno_id: ALUNNO_ALTRA_SEDE, data: '2026-01-04', stato: 'presente' }))

    expect(res.status).toBe(403)
    // La mutazione è ciò che conta: uno status giusto con la riga scritta sarebbe
    // comunque un difetto.
    expect(h.scritture).toEqual([])
    // …e nessuna notifica «tuo figlio è assente» ai genitori dell'altra sede.
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('lo scope viene interrogato con l\'alunno del corpo, prima di qualunque scrittura', async () => {
    await POST(richiesta({ alunno_id: ALUNNO_ALTRA_SEDE, data: '2026-01-04', stato: 'presente' }))
    expect(h.assertAlunnoInScope).toHaveBeenCalledTimes(1)
    expect(h.assertAlunnoInScope.mock.calls[0][2]).toBe(ALUNNO_ALTRA_SEDE)
  })

  it('alunno nel proprio scope ⇒ la presenza si scrive (il gate non blocca il lavoro vero)', async () => {
    const res = await POST(richiesta({ alunno_id: ALUNNO_ALTRA_SEDE, data: '2026-01-04', stato: 'presente' }))
    expect(res.status).toBe(200)
    expect(h.scritture.some((s) => s.tabella === 'presenze')).toBe(true)
  })
})
