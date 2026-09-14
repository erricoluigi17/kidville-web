import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/gdpr/richieste` — LA RICHIESTA DEL GENITORE LIBERA IL SUO ACCOUNT.
//
// È il canale in cui una famiglia chiede, con parole sue, «cancellate il mio
// account» (pagina pubblica `/cancellazione-account`). Dal 2026-09-14
// `anonimizzaParent` libera l'account per ultimo — ma SOLO se nessun bambino legato
// a quell'account è ancora vivo, cioè non anonimizzato.
//
// ⚠️ L'ORDINE, E PERCHÉ È LA PARTE CHE CONTA. Questa route anonimizzava il genitore
// PRIMA dei figli non iscritti. Con quell'ordine, al momento della decisione i figli
// della stessa richiesta avevano ancora `anonimizzato_il` a NULL: l'account risultava
// «con figli vivi» e non si liberava MAI — proprio nel canale in cui a chiederlo è la
// persona stessa. Ora prima i figli, poi il genitore.
//
// `anonimizzaParent`/`anonimizzaAlunno` sono mockate: qui interessano l'ORDINE e la
// SOMMA. La logica dell'account sta in `__tests__/lib/gdpr-oblio-account.test.ts`.
// =============================================================================

const PARENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
const DIRETTORE_ID = 'cccccccc-cccc-4ccc-8ccc-000000000001'

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const h = vi.hoisted(() => {
  const state = {
    richiesta: null as Riga | null,
    tabelle: {} as Record<string, Riga[]>,
    updates: [] as Array<{ table: string; patch: Riga }>,
  }
  return {
    state,
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    anonimizzaParent: vi.fn(),
    anonimizzaAlunno: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: h.logOk,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Filtro[] = []
      let patch: Riga | null = null
      const righe = () =>
        (h.state.tabelle[table] ?? []).filter((r) => filtri.every((f) => f.vals.some((v) => r[f.col] === v)))
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.contains = () => b
      b.not = () => b
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.update = (v: Riga) => { patch = v; return b }
      b.maybeSingle = async () =>
        table === 'richieste_cancellazione'
          ? { data: h.state.richiesta, error: null }
          : { data: righe()[0] ?? null, error: null }
      b.then = (res: (v: unknown) => unknown) => {
        if (patch) h.state.updates.push({ table, patch })
        return Promise.resolve({ data: righe(), error: null }).then(res)
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/richieste/route'

const esegui = () =>
  POST(new NextRequest('http://localhost/api/admin/gdpr/richieste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }),
  }))

const figlio = (id: string, stato = 'ritirato'): Riga => ({
  id, stato, anonimizzato_il: null, scuola_id: SEDE_A, documento_path: null, codice_fiscale: null, fiscal_code: null,
})

const esitoParent = (extra: Riga = {}) => ({
  newsVisualizzazioniRimosse: 0, pushSubscriptionsRimosse: 0, segnalazioniBonificate: 0,
  sospensioniBonificate: 0, provaConsensiScrubbate: 0, iscrizioniScrubbate: 0, fileRimossi: 0,
  fileNonRimossi: 0, notificheRimosse: 0, lettureFallite: 0, account: 'rimosso', ...extra,
})

const esitoAlunno = (extra: Riga = {}) => ({
  riconciliazione: 0, incassi: 0, cassa: 0, file: 0, fileNonRimossi: 0, segnalazioniBonificate: 0,
  sospensioniBonificate: 0, iscrizioniScrubbate: 0, fotoRimosse: 0, fotoSganciate: 0,
  presenzeBonificate: 0, notificheRimosse: 0, lettureFallite: 0, ...extra,
})

const riga = (esito: string) =>
  h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

const esitoScritto = () =>
  h.state.updates.find((u) => u.table === 'richieste_cancellazione')?.patch.esito as Riga | undefined

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: DIRETTORE_ID, role: 'admin', scuola_id: SEDE_A } })
  h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SEDE_A }
  h.state.tabelle = {
    utenti_scuole: [],
    student_parents: [{ parent_id: PARENT_ID, student_id: 'al-1' }, { parent_id: PARENT_ID, student_id: 'al-2' }],
    alunni: [figlio('al-1'), figlio('al-2')],
  }
  h.state.updates = []
  h.anonimizzaParent.mockResolvedValue(esitoParent())
  h.anonimizzaAlunno.mockResolvedValue(esitoAlunno())
})

describe('POST /api/admin/gdpr/richieste — l’account del genitore', () => {
  it('i figli non iscritti si anonimizzano PRIMA del genitore (altrimenti risultano vivi e l’account resta)', async () => {
    const res = await esegui()
    expect(res.status).toBe(200)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(2)
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    const ultimoFiglio = Math.max(...h.anonimizzaAlunno.mock.invocationCallOrder)
    const genitore = h.anonimizzaParent.mock.invocationCallOrder[0]
    expect(
      ultimoFiglio,
      'il genitore è stato anonimizzato prima dei figli: al momento della decisione i bambini ' +
        'risultano ancora vivi e l’account della famiglia non si libera mai',
    ).toBeLessThan(genitore)
  })

  it('il riordino non perde i conteggi: genitore e figli si sommano come prima', async () => {
    h.anonimizzaParent.mockResolvedValue(esitoParent({
      newsVisualizzazioniRimosse: 7, provaConsensiScrubbate: 1, segnalazioniBonificate: 2, sospensioniBonificate: 1,
      iscrizioniScrubbate: 1, fileRimossi: 3, fileNonRimossi: 0, notificheRimosse: 1,
    }))
    h.anonimizzaAlunno.mockResolvedValue(esitoAlunno({
      riconciliazione: 1, incassi: 1, cassa: 1, file: 5, segnalazioniBonificate: 1, sospensioniBonificate: 2,
      iscrizioniScrubbate: 1, fotoRimosse: 1, fotoSganciate: 1, presenzeBonificate: 3, notificheRimosse: 4,
    }))
    const json = await (await esegui()).json()
    expect(json).toMatchObject({
      parent: 1,
      alunni: 2,
      news_visualizzazioni_rimosse: 7,
      consensi_prova_bonificati: 1,
      riconciliazione_bonificati: 2,
      incassi_bonificati: 2,
      cassa_bonificati: 2,
      file_rimossi: 3 + 5 * 2,
      n_file_non_rimossi: 0,
      iscrizioni_scrubbate: 1 + 1 * 2,
      foto_rimosse: 2,
      foto_sganciate: 2,
      segnalazioni_bonificate: 2 + 1 * 2,
      sospensioni_bonificate: 1 + 2 * 2,
      presenze_bonificate: 6,
      notifiche_rimosse: 1 + 4 * 2,
      letture_fallite: 0,
    })
  })

  it('account liberato → lo dice l’esito scritto sulla richiesta, e l’oblio non è parziale', async () => {
    const json = await (await esegui()).json()
    expect(json).toMatchObject({ account_rimossi: 1, account_anonimizzati: 0, account_non_liberati: 0 })
    expect(esitoScritto()).toMatchObject({ account_rimossi: 1, account_non_liberati: 0 })
    expect(riga('oblio-parziale')).toBeFalsy()
  })

  it('account NON liberato → `account_non_liberati` sulla richiesta e `oblio-parziale` nel log', async () => {
    h.anonimizzaParent.mockResolvedValue(esitoParent({ account: 'non-riuscito' }))
    const json = await (await esegui()).json()
    expect(json.account_non_liberati).toBe(1)
    expect(esitoScritto()).toMatchObject({ account_non_liberati: 1 })
    const parziale = riga('oblio-parziale')
    expect(parziale, 'la richiesta si chiude «evasa» con email e nome della persona ancora lì').toBeTruthy()
    expect(parziale![1]).toBe('error')
    expect(parziale![2]).toMatchObject({ n_account_non_liberati: 1 })
  })
})
