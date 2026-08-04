import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// T11-F5 — il troncamento dell'elenco alunni era SILENZIOSO.
//
// Dieci pagine admin chiedono `GET /api/admin/students?limit=1000`. La route
// clampa a 1000 e fa `.range(offset, offset+limit-1)`: fin qui è corretto. Il
// difetto è ciò che succede quando le righe superano il tetto — cioè
// NIENTE. Nessun errore, nessun header, nessuna riga di log: l'elenco torna
// tagliato e la pagina disegna una scuola più piccola di quella che c'è.
//
// GRAVITÀ, misurata e non dedotta: al 2026-08-04 in produzione ci sono ~32
// alunni. Il troncamento è LATENTE, non attivo. Perciò qui NON si costruisce
// una UI paginata — sarebbe lavoro sprecato oggi — ma si rende il troncamento
// IMPOSSIBILE DA IGNORARE il giorno in cui esisterà la 1001-esima riga:
//
//   · `X-Total-Count` col totale ESATTO (count exact), sempre;
//   · una riga di log a livello `warn` quando le righe rese sono esattamente
//     il tetto E il totale è maggiore.
//
// I test sono di comportamento: il finto PostgREST affetta davvero il `range`
// e dichiara un `count` proprio, slegato dalla pagina.
// =============================================================================

const SEDE = 'sc-1'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  righe: [] as Record<string, unknown>[],
  countDichiarato: null as number | null,
  opzioniSelect: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/anagrafiche/parents', () => ({ linkOrCreateParent: vi.fn() }))
vi.mock('@/lib/pagamenti/scadenze', () => ({ riallineaScadenzeRetteFuture: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [] }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: async () => [SEDE],
  assertAlunnoInScope: async () => null,
}))

// Spia sul solo `logEvento`, lasciando reale tutto il resto del logger:
// `withRoute` e i moduli attorno continuano a funzionare come in produzione.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from() {
      let from = 0
      let to = Number.POSITIVE_INFINITY
      // PostgREST restituisce `count` SOLO se lo si è chiesto: senza
      // `{count:'exact'}` il totale non esiste. Lo stub deve comportarsi così,
      // se no «togliere il count esatto» resterebbe verde per finta.
      let contaEsatto = false
      const b: Record<string, unknown> = {}
      b.select = (_c?: string, opts?: unknown) => {
        h.opzioniSelect.push(opts)
        if ((opts as { count?: string })?.count === 'exact') contaEsatto = true
        return b
      }
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.range = (a: number, z: number) => {
        from = a
        to = z
        return b
      }
      const lista = () => {
        const fine = Number.isFinite(to) ? to + 1 : from + 1000
        return {
          data: h.righe.slice(from, fine),
          error: null,
          count: contaEsatto ? (h.countDichiarato ?? h.righe.length) : null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => ({ data: null, error: null })
      b.single = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/students/route'
import { HEADER_TOTALE, LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione'

const chiedi = (qs = '') =>
  GET(new Request(`http://localhost/api/admin/students${qs}`) as never)

const alunno = (i: number) => ({
  id: `al-${i}`,
  scuola_id: SEDE,
  nome: `N${i}`,
  cognome: `C${i}`,
  data_nascita: '2021-01-01',
  codice_fiscale: `CF${i}`,
  classe_sezione: '3 ANNI',
  stato: 'iscritto',
  section_id: 'sez-1',
  note_mediche: null,
})

/** Le sole chiamate a `logEvento` che parlano di troncamento. */
const avvisiTroncamento = () =>
  h.logEvento.mock.calls.filter(
    (c) => String((c[2] as { esito?: string })?.esito ?? '').includes('tronc'),
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = []
  h.countDichiarato = null
  h.opzioniSelect = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
})

describe('GET /api/admin/students — il troncamento non è più silenzioso', () => {
  it('1000 righe rese su 1400 totali ⇒ `X-Total-Count: 1400` e un log a livello warn', async () => {
    h.righe = Array.from({ length: 1000 }, (_, i) => alunno(i))
    h.countDichiarato = 1400

    const res = await chiedi(`?limit=${LIMITE_ELENCO_ALUNNI}`)
    expect(res.status).toBe(200)

    // Il VALORE dell'header, non la sua presenza: un header che ripete la
    // lunghezza della pagina (1000) non direbbe niente a nessuno.
    expect(res.headers.get(HEADER_TOTALE)).toBe('1400')

    const avvisi = avvisiTroncamento()
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0][1]).toBe('warn')
    expect(avvisi[0][2]).toMatchObject({
      operazione: 'admin/students:GET',
      rese: 1000,
      totale: 1400,
    })
  })

  it('CONTROLLO NEGATIVO — 32 righe su 32 (la produzione di oggi) ⇒ nessun avviso', async () => {
    h.righe = Array.from({ length: 32 }, (_, i) => alunno(i))

    const res = await chiedi(`?limit=${LIMITE_ELENCO_ALUNNI}`)
    expect(res.headers.get(HEADER_TOTALE)).toBe('32')
    expect(avvisiTroncamento()).toHaveLength(0)
  })

  it('CONTROLLO NEGATIVO — pagina piena ma NIENTE oltre (50 su 50) ⇒ nessun avviso', async () => {
    // Il caso che smaschera un avviso scritto male: `rese === limit` da solo
    // non è troncamento. Serve anche che il totale sia maggiore.
    h.righe = Array.from({ length: 50 }, (_, i) => alunno(i))

    await chiedi('?limit=50')
    expect(avvisiTroncamento()).toHaveLength(0)
  })

  it('il totale è il `count` ESATTO del database, non la lunghezza della pagina', async () => {
    h.righe = Array.from({ length: 10 }, (_, i) => alunno(i))
    h.countDichiarato = 777

    const res = await chiedi('?limit=10')
    expect(res.headers.get(HEADER_TOTALE)).toBe('777')
    expect(h.opzioniSelect.some((o) => (o as { count?: string })?.count === 'exact')).toBe(true)
  })

  it('l\'ultima pagina di un elenco troncato non riavvisa (offset 1000 di 1400)', async () => {
    h.righe = Array.from({ length: 1400 }, (_, i) => alunno(i))
    h.countDichiarato = 1400

    await chiedi(`?limit=${LIMITE_ELENCO_ALUNNI}&offset=1000`)
    // 400 righe rese ≠ tetto: la finestra è arrivata in fondo, niente da dire.
    expect(avvisiTroncamento()).toHaveLength(0)
  })
})
