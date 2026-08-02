import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `POST /api/gallery` — il log di successo diceva CHE è stata pubblicata, non A
// QUANTE FAMIGLIE è stata annunciata.
//
// La foto è il contenuto; la notifica è il suo recapito. Con `n_destinatari`
// assente, «pubblicata e annunciata a 24 famiglie» e «pubblicata e annunciata a
// nessuno» sono la stessa riga di log — e il secondo caso è vivo in produzione:
// il 2026-07-31 ci sono alunni senza alcuna riga in `student_parents`, quindi
// `genitoriDiAlunni` su una foto che li tagga restituisce una lista più corta di
// quella dei bambini ritratti. Nessuno se ne accorge (AGENTS, regola 5).
//
// Le dipendenze di dominio sono mockate: l'oggetto sotto esame è la RIGA DI LOG,
// non la risoluzione della sede né il Privacy Lock, che hanno già i loro test.
// =============================================================================

/** Sede FINTA: nei test non entra mai un uuid di produzione (lock ). */
const SEDE = SEDE_A
const DOCENTE = '22222222-2222-4222-8222-222222222222'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  scuoleDiUtente: vi.fn(),
  alunniSenzaConsenso: vi.fn(),
  degradoSedeLecito: vi.fn(),
  notificaEvento: vi.fn(),
  genitoriDiAlunni: vi.fn(),
  genitoriDiClassi: vi.fn(),
  genitoriDiScuola: vi.fn(),
  insertEsiti: [] as Array<{ data: unknown; error: unknown }>,
  insertRecord: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  resolveScuoleAttive: h.resolveScuoleAttive,
  scuoleDiUtente: h.scuoleDiUtente,
}))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: h.alunniSenzaConsenso }))
vi.mock('@/lib/forms/degrado-sede', () => ({
  degradoSedeLecito: h.degradoSedeLecito,
  colonnaSedeAssente: (e: { code?: string } | null | undefined) =>
    ['PGRST204', '42703'].includes(e?.code ?? ''),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: h.genitoriDiAlunni,
  genitoriDiClassi: h.genitoriDiClassi,
  genitoriDiScuola: h.genitoriDiScuola,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      // Dal 2026-07-31 la POST verifica che ogni `tag_students` sia nei plessi di
      // chi pubblica, PRIMA del Privacy Lock: senza, il 422 «manca la liberatoria»
      // restituiva nome e cognome di minori di un'altra sede a chiunque ne
      // conoscesse l'uuid (collaudo privacy, rilievo F3). Qui i due alunni taggati
      // stanno nella sede del docente, quindi il controllo li lascia passare.
      if (tabella === 'alunni') {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.in = (colonna: string, valori: string[]) => {
          if (colonna === 'scuola_id') {
            return Promise.resolve({
              data: valori.includes(SEDE) ? [{ id: ALU_1 }, { id: ALU_2 }] : [],
              error: null,
            })
          }
          return q
        }
        return q
      }
      if (tabella !== 'galleria_media_v2') {
        throw new Error(`tabella non prevista da questo test: "${tabella}"`)
      }
      return {
        insert(record: Record<string, unknown>) {
          h.insertRecord.push({ ...record })
          const esito = h.insertEsiti.shift() ?? { data: { id: 'med-1' }, error: null }
          return { select: () => ({ single: async () => esito }) }
        },
      }
    },
  }),
}))

import { POST } from '@/app/api/gallery/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function righe(livello: string): Array<{ evento: string; campi: Record<string, unknown> }> {
  return log.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown> }))
}

const pubblicata = () =>
  righe('info').filter((r) => r.evento === 'galleria' && r.campi.esito === 'pubblicata')

beforeEach(() => {
  vi.clearAllMocks()
  h.insertEsiti = []
  h.insertRecord = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  // Serve al controllo di scope sui `tag_students`: senza, il mock ritorna
  // `undefined` e la route esce 500 prima ancora di pubblicare.
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.alunniSenzaConsenso.mockResolvedValue([])
  h.degradoSedeLecito.mockResolvedValue(false)
  h.notificaEvento.mockResolvedValue(undefined)
  h.genitoriDiAlunni.mockResolvedValue([])
  h.genitoriDiClassi.mockResolvedValue([])
  h.genitoriDiScuola.mockResolvedValue([])
})

describe('POST /api/gallery — il log di successo conta le famiglie annunciate', () => {
  it('foto con due bambini taggati e due famiglie raggiunte → `n_destinatari: 2`', async () => {
    h.genitoriDiAlunni.mockResolvedValue(['g1', 'g2'])

    const res = await POST(post({ file_url: 'https://x/y.jpg', tag_students: [ALU_1, ALU_2], scuola_id: SEDE }))

    expect(res.status).toBe(201)
    expect(pubblicata()).toHaveLength(1)
    expect(pubblicata()[0].campi).toMatchObject({
      operazione: 'gallery:POST',
      esito: 'pubblicata',
      sede_id: SEDE,
      nTag: 2,
      broadcast: false,
      n_destinatari: 2,
    })
  })

  it('due bambini taggati ma NESSUN tutore collegato → `n_destinatari: 0` con `nTag: 2`', async () => {
    // È la condizione viva in produzione, ed è tutto il punto: i due numeri accanto
    // raccontano il guasto («due bambini nella foto, zero famiglie avvisate»), mentre
    // il solo `nTag` racconterebbe un successo.
    h.genitoriDiAlunni.mockResolvedValue([])

    const res = await POST(post({ file_url: 'https://x/y.jpg', tag_students: [ALU_1, ALU_2], scuola_id: SEDE }))

    expect(res.status).toBe(201)
    expect(pubblicata()).toHaveLength(1)
    expect(pubblicata()[0].campi).toMatchObject({ nTag: 2, n_destinatari: 0 })
  })

  it('broadcast senza tag → il conteggio viene da `genitoriDiScuola`', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE } })
    h.genitoriDiScuola.mockResolvedValue(['g1', 'g2', 'g3'])

    const res = await POST(post({ file_url: 'https://x/y.jpg', is_broadcast: true, scuola_id: SEDE }))

    expect(res.status).toBe(201)
    expect(pubblicata()[0].campi).toMatchObject({ broadcast: true, nTag: 0, n_destinatari: 3 })
  })

  it('classi bersaglio → il conteggio viene da `genitoriDiClassi`, non dal numero di classi', async () => {
    h.genitoriDiClassi.mockResolvedValue(['g1'])

    const res = await POST(
      post({ file_url: 'https://x/y.jpg', target_classes: ['2 ANNI', '3 ANNI'], scuola_id: SEDE }),
    )

    expect(res.status).toBe(201)
    expect(pubblicata()[0].campi.n_destinatari).toBe(1)
  })
})
