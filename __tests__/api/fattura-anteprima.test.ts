import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/fattura/anteprima — «cosa uscirà davvero», prima di premere Emetti.
 *
 * ─── IL DIFETTO CHE QUESTA ROUTE ESISTE PER CHIUDERE ─────────────────────────
 * Il 2026-09-03 la fattura FPR 1948/26 è partita verso lo SDI con «Retta 09/2026»,
 * mentre la sede di Aversa aveva configurato «Pagamento retta del mese di {mese}
 * {anno}. Per il figlio minore {nome_completo} C. F. {codice_fiscale}». Il modale
 * «Emetti» precompilava la casella con la descrizione del pagamento e la spediva come
 * correzione manuale — che batte qualunque modello. Nessuno poteva vederlo.
 *
 * Il test che conta è quello marcato ANTI-DIVERGENZA: l'anteprima deve venire dallo
 * STESSO codice dell'emissione. Un'anteprima ricalcolata a parte mostrerebbe un testo
 * e ne spedirebbe un altro, e la segreteria approverebbe qualcosa che non esiste.
 */

const { PAG, SCUOLA, ALUNNO, UTENTE } = vi.hoisted(() => ({
  PAG: '85320395-0000-4000-8000-000000000001',
  SCUOLA: '429da920-0000-4000-8000-000000000002',
  ALUNNO: 'aaaaaaaa-0000-4000-8000-000000000003',
  UTENTE: 'bbbbbbbb-0000-4000-8000-000000000004',
}))

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  fuoriScope: null as unknown,
  /** La riga di `pagamenti` che il finto PostgREST restituisce. */
  pagamento: null as Record<string, unknown> | null,
  /** `admin_settings.fattura_causali_config`; `errSettings` simula la lettura fallita. */
  causaliConfig: {} as Record<string, unknown>,
  errSettings: null as unknown,
  nomeSede: 'Kidville Aversa',
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireStaff,
  requireDocente: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: async () => h.fuoriScope }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b = {
        select: () => b,
        eq: () => b,
        single: async () => ({ data: table === 'pagamenti' ? h.pagamento : null, error: null }),
        maybeSingle: async () => {
          if (table === 'admin_settings') {
            return h.errSettings
              ? { data: null, error: h.errSettings }
              : { data: { fattura_causali_config: h.causaliConfig }, error: null }
          }
          if (table === 'scuole') return { data: { nome: h.nomeSede }, error: null }
          return { data: h.pagamento, error: null }
        },
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/fattura/anteprima/route'
import { componiCausalePagamento } from '@/lib/aruba/causale-pagamento'
import { createAdminClient } from '@/lib/supabase/server-client'

const MODELLO_AVERSA =
  'Pagamento retta del mese di {mese} {anno}. Per il figlio minore {nome_completo} C. F. {codice_fiscale}'

function req(pagamentoId = PAG) {
  return new Request(`http://x/api/pagamenti/fattura/anteprima?pagamento_id=${pagamentoId}`, {
    headers: { 'x-user-id': UTENTE },
  })
}

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: UTENTE, ruolo: 'segreteria', scuola_id: SCUOLA } })
  h.fuoriScope = null
  h.errSettings = null
  h.causaliConfig = {}
  h.nomeSede = 'Kidville Aversa'
  h.pagamento = {
    id: PAG,
    descrizione: 'Retta 09/2026',
    importo: 300,
    stato: 'pagato',
    scadenza: '2026-09-05',
    periodo_competenza: '2026-09-01',
    scuola_id: SCUOLA,
    fattura_causale: null,
    categoria_id: 'cat-1',
    alunno_id: ALUNNO,
    payment_categories: { slug: 'retta' },
    alunni: { id: ALUNNO, nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA20A01Z999X' },
  }
})

describe('GET /api/pagamenti/fattura/anteprima', () => {
  it('rende il MODELLO della categoria, non la descrizione del pagamento', async () => {
    h.causaliConfig = { retta: MODELLO_AVERSA }
    const res = await GET(req())
    const j = await res.json()

    expect(res.status).toBe(200)
    expect(j.data.origine).toBe('categoria')
    expect(j.data.causale).toBe(
      'Pagamento retta del mese di settembre 2026. Per il figlio minore Mario Rossi C. F. RSSMRA20A01Z999X'
    )
    // È il difetto vero, detto per esteso: NON la nuda descrizione.
    expect(j.data.causale).not.toBe('Retta 09/2026')
  })

  it('senza modelli configurati ricade sul modello di FABBRICA, non su un errore', async () => {
    h.causaliConfig = {}
    const j = await (await GET(req())).json()
    expect(j.data.origine).toBe('fabbrica')
    expect(j.data.causale).toContain('a favore')
    expect(j.data.causale).toContain('Mario Rossi')
  })

  it('la riga «Predefinito» vale quando la categoria non ha la sua', async () => {
    h.causaliConfig = { default: 'Contributo {descrizione} - {nome_completo}' }
    const j = await (await GET(req())).json()
    expect(j.data.origine).toBe('predefinito')
    expect(j.data.causale).toBe('Contributo Retta 09/2026 - Mario Rossi')
  })

  it('una correzione scritta a mano si dichiara come tale', async () => {
    h.causaliConfig = { retta: MODELLO_AVERSA }
    h.pagamento!.fattura_causale = 'Saldo iscrizione — accordo del 12/09'
    const j = await (await GET(req())).json()
    expect(j.data.origine).toBe('manuale')
    expect(j.data.causale).toBe('Saldo iscrizione — accordo del 12/09')
  })

  it('misura la lunghezza SUL TRACCIATO, non sulla stringa a schermo', async () => {
    // `€` diventa `EUR` nella translitterazione FatturaPA: 1 carattere → 3.
    h.causaliConfig = { retta: '{importo}' }
    const j = await (await GET(req())).json()
    expect(j.data.causale).toContain('€')
    expect(j.data.limite).toBe(200)
    expect(j.data.lunghezza).toBeGreaterThan(j.data.causale.length)
    expect(j.data.eccede).toBe(false)
  })

  it('segnala quando la causale RESA eccede i 200 caratteri del campo 2.1.1.11', async () => {
    h.causaliConfig = { retta: 'X'.repeat(250) }
    const j = await (await GET(req())).json()
    expect(j.data.eccede).toBe(true)
  })

  it('FAIL-CLOSED: config illeggibile → 503, mai un ripiego silenzioso', async () => {
    h.errSettings = { code: '42501', message: 'permission denied' }
    const res = await GET(req())
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.error).toContain('modelli di causale')
  })

  it('rispetta lo scope di sede: il 403 di `assertPagamentoInScope` esce così com’è', async () => {
    const { NextResponse } = await import('next/server')
    h.fuoriScope = NextResponse.json({ error: 'fuori sede' }, { status: 403 })
    const res = await GET(req())
    expect(res.status).toBe(403)
  })

  it('pagamento inesistente → 404, non una causale inventata', async () => {
    h.pagamento = null
    const res = await GET(req())
    expect(res.status).toBe(404)
  })

  it('ANTI-DIVERGENZA: l’anteprima è la STESSA stringa che compone l’emissione', async () => {
    h.causaliConfig = { retta: MODELLO_AVERSA }
    const dallaRoute = (await (await GET(req())).json()).data.causale

    // `componiCausalePagamento` è il codice che `emettiFatturaPagamento` chiama al
    // punto 4: se un giorno la route ricalcolasse per conto suo, questa uguaglianza
    // si romperebbe — ed è l'unico modo per accorgersene senza emettere davvero.
    const supabase = await createAdminClient()
    const dallEmissione = await componiCausalePagamento(
      supabase as never,
      h.pagamento as never,
    )
    expect(dallEmissione.ok).toBe(true)
    if (dallEmissione.ok) expect(dallaRoute).toBe(dallEmissione.causale)
  })
})
