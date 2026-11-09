import { beforeEach, describe, expect, it, vi } from 'vitest'

import { redact } from '@/lib/logging/redact'
import { caricaVisibilitaFatture } from '@/lib/pagamenti/visibilita-fatture'

const logErrore = vi.fn()
const logEvento = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logErrore: (...args: unknown[]) => logErrore(...args),
  logEvento: (...args: unknown[]) => logEvento(...args),
}))

const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UTENTE = '11111111-1111-4111-8111-111111111111'
const MADRE = '22222222-2222-4222-8222-222222222222'
const PADRE = '33333333-3333-4333-8333-333333333333'
const TERZO = '55555555-5555-4555-8555-555555555555'

type RigaDb = Record<string, unknown>
type ErroreDb = { message: string; code?: string }

interface DbFinto {
  admin_settings?: RigaDb[]
  parents?: RigaDb[]
  utenti_scuole?: RigaDb[]
  errori?: Partial<Record<'admin_settings' | 'parents' | 'utenti_scuole', ErroreDb>>
}

function supabaseFinto(db: DbFinto) {
  const lette: string[] = []

  const supabase = {
    from(tabella: 'admin_settings' | 'parents' | 'utenti_scuole') {
      let filtri: Array<[string, unknown]> = []
      const query = {
        select() {
          return query
        },
        eq(colonna: string, valore: unknown) {
          filtri = [...filtri, [colonna, valore]]
          return query
        },
        async maybeSingle() {
          lette.push(tabella)
          const error = db.errori?.[tabella] ?? null
          if (error) return { data: null, error }
          const righe = (db[tabella] ?? []).filter((riga) =>
            filtri.every(([colonna, valore]) => riga[colonna] === valore),
          )
          return { data: righe[0] ?? null, error: null }
        },
      }
      return query
    },
  }

  return { supabase, lette }
}

const riga = (
  modalita_emissione: 'ordinaria' | 'quote_separate' | null,
  parent_registry_id: string | null,
) => ({
  id: '44444444-4444-4444-8444-444444444444',
  modalita_emissione,
  parent_registry_id,
})

describe('caricaVisibilitaFatture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('col filtro spento non nasconde lo storico, ma legge il ponte genitore: la quota dell’altro non si vede nemmeno così', async () => {
    const { supabase, lette } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: null }],
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore', scuola_id: SEDE_A },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
    expect(lette).toEqual(['admin_settings', 'parents'])
  })

  it('una fattura ordinaria intestata a un terzo resta visibile alla madre', async () => {
    const { supabase } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore' },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('ordinaria', TERZO))).toBe(true)
    expect(esito.puoVedere(riga(null, TERZO))).toBe(false)
  })

  it('con quote separate mostra solo la fattura del proprio parents.id', async () => {
    const { supabase } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore' },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
  })

  it('lo staff contabile nel proprio plesso vede tutte le righe senza leggere parents', async () => {
    const { supabase, lette } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(lette).toEqual(['admin_settings'])
  })

  it('un admin vede tutte le righe nella sede assegnata dal ponte utenti_scuole', async () => {
    const { supabase, lette } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_B, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      utenti_scuole: [{ utente_id: UTENTE, scuola_id: SEDE_B }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', scuola_id: SEDE_A },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(lette).toEqual(['admin_settings', 'utenti_scuole'])
  })

  it('lo staff-genitore fuori dal proprio plesso ricade sulla visibilita familiare', async () => {
    const { supabase } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_B, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      {
        id: UTENTE,
        role: 'genitore',
        ruoli: ['segreteria', 'genitore'],
        scuola_id: SEDE_A,
      },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
  })

  it('un errore nella lettura del bridge parents nega con 500 e viene loggato', async () => {
    const guasto = { code: '42501', message: 'permission denied' }
    const { supabase } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      errori: { parents: guasto },
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore' },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
    expect(await esito.response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'caricaVisibilitaFatture:parents', stato: 500 }),
      guasto,
    )
  })

  it('senza un record parents concede le ordinarie ma nessuna quota separata', async () => {
    const { supabase } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      parents: [],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore' },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('ordinaria', TERZO))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(false)
    expect(esito.puoVedere(riga(null, null))).toBe(false)
  })

  it('un errore sulle impostazioni nega con codice e non prosegue', async () => {
    const guasto = { code: '42501', message: 'settings denied' }
    const { supabase, lette } = supabaseFinto({ errori: { admin_settings: guasto } })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore' },
      SEDE_A,
      'singolo',
    )

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
    expect(await esito.response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(lette).toEqual(['admin_settings'])
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'caricaVisibilitaFatture:impostazioni', stato: 500 }),
      guasto,
    )
  })

  it('un errore sul ponte sedi nega con codice e non ricade sui privilegi familiari', async () => {
    const guasto = { code: '42501', message: 'bridge denied' }
    const { supabase, lette } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_B, fatture_visibilita_attiva_il: '2026-09-16T10:00:00Z' }],
      errori: { utenti_scuole: guasto },
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', ruoli: ['admin', 'genitore'], scuola_id: SEDE_A },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
    expect(await esito.response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(lette).toEqual(['admin_settings', 'utenti_scuole'])
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'caricaVisibilitaFatture:sedi', stato: 500 }),
      guasto,
    )
  })
})

describe('caricaVisibilitaFatture sulla voce divisa: ognuno vede solo la propria', () => {
  const FILTRO_ACCESO = '2026-09-16T10:00:00Z'
  const conFiltro = (scuola: string, attivo: string | null) => ({
    admin_settings: [{ scuola_id: scuola, fatture_visibilita_attiva_il: attivo }],
  })
  const famiglia = { id: UTENTE, role: 'genitore' as const, scuola_id: SEDE_A }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filtro spento, famiglia: la propria sì; quella dell’altro, una senza registro e l’ordinaria dell’altro no', async () => {
    const { supabase, lette } = supabaseFinto({
      ...conFiltro(SEDE_A, null),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'split')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
    expect(esito.puoVedere(riga('quote_separate', null))).toBe(false)
    expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(false)
    expect(esito.puoVedere(riga('ordinaria', null))).toBe(false)
    expect(esito.puoVedere(riga(null, PADRE))).toBe(false)
    expect(lette).toEqual(['admin_settings', 'parents'])
  })

  it('filtro spento, famiglia: la modalità non conta, la propria si vede comunque sia classificata', async () => {
    const { supabase } = supabaseFinto({
      ...conFiltro(SEDE_A, null),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'split')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('ordinaria', MADRE))).toBe(true)
    expect(esito.puoVedere(riga(null, MADRE))).toBe(true)
  })

  it('filtro spento, senza un record `parents`: nessun documento della voce divisa', async () => {
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_A, null), parents: [] })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'split')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(false)
    expect(esito.puoVedere(riga('quote_separate', null))).toBe(false)
  })

  it('filtro spento, contabilità nel proprio plesso: tutte, senza leggere `parents` e senza la riga di log', async () => {
    const { supabase, lette } = supabaseFinto(conFiltro(SEDE_A, null))

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A },
      SEDE_A,
      'split',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(esito.puoVedere(riga('ordinaria', null))).toBe(true)
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(lette).toEqual(['admin_settings'])
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('filtro acceso: l’ordinaria dell’altro si vede sulla voce singola, sulla divisa no', async () => {
    const { supabase: suSingola } = supabaseFinto({
      ...conFiltro(SEDE_A, FILTRO_ACCESO),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })
    const { supabase: suDivisa } = supabaseFinto({
      ...conFiltro(SEDE_A, FILTRO_ACCESO),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const singola = await caricaVisibilitaFatture(suSingola as never, famiglia, SEDE_A, 'singolo')
    const divisa = await caricaVisibilitaFatture(suDivisa as never, famiglia, SEDE_A, 'split')

    expect(singola.esito).toBe('ok')
    expect(divisa.esito).toBe('ok')
    if (singola.esito !== 'ok' || divisa.esito !== 'ok') return
    expect(singola.puoVedere(riga('ordinaria', PADRE))).toBe(true)
    expect(divisa.puoVedere(riga('ordinaria', PADRE))).toBe(false)
    expect(divisa.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(divisa.puoVedere(riga('quote_separate', PADRE))).toBe(false)
  })

  it.each([null, FILTRO_ACCESO])('admin con la sede aggiuntiva (filtro %s): tutte', async (attivo) => {
    const { supabase, lette } = supabaseFinto({
      ...conFiltro(SEDE_B, attivo),
      utenti_scuole: [{ utente_id: UTENTE, scuola_id: SEDE_B }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', scuola_id: SEDE_A },
      SEDE_B,
      'split',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(esito.puoVedere(riga('ordinaria', null))).toBe(true)
    expect(lette).toEqual(['admin_settings', 'utenti_scuole'])
  })

  it('staff fuori perimetro: vale come una famiglia, solo la propria', async () => {
    const { supabase } = supabaseFinto({
      ...conFiltro(SEDE_B, null),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore', ruoli: ['segreteria', 'genitore'], scuola_id: SEDE_A },
      SEDE_B,
      'split',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(false)
  })

  it('un errore di lettura su `parents`: 500, anche a filtro spento', async () => {
    const guasto = { code: '42501', message: 'permission denied' }
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_A, null), errori: { parents: guasto } })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'split')

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
    expect(await esito.response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'caricaVisibilitaFatture:parents', stato: 500 }),
      guasto,
    )
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('un errore di lettura sul ponte delle sedi: 500, anche a filtro spento', async () => {
    const guasto = { code: '42501', message: 'bridge denied' }
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_B, null), errori: { utenti_scuole: guasto } })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', scuola_id: SEDE_A },
      SEDE_B,
      'split',
    )

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
  })

  it('una riga di log per chiamata, con le sole tre chiavi, e la redazione le lascia passare', async () => {
    const { supabase } = supabaseFinto({
      ...conFiltro(SEDE_A, null),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'split')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    esito.puoVedere(riga('quote_separate', MADRE))
    esito.puoVedere(riga('quote_separate', PADRE))

    expect(logEvento).toHaveBeenCalledTimes(1)
    const [canale, livello, campi, , opzioni] = logEvento.mock.calls[0] as [string, string, Record<string, unknown>, unknown, unknown]
    expect(canale).toBe('fattura')
    expect(livello).toBe('info')
    expect(opzioni).toEqual({ distingui: ['scuola_id'] })
    expect(Object.keys(campi).sort()).toEqual(['esito', 'operazione', 'scuola_id'])
    expect(campi.scuola_id).toBe(SEDE_A)
    expect(redact(campi)).toEqual(campi)
  })
})

// La divisione in due documenti la decide `genitori_separati`, non `tipo`: `intestatari.ts` divide anche una voce
// `singolo` o `rata`, e la riga di `pagamenti` resta di quel tipo. Il titolare: «ognuno riceve solo la propria fattura».
describe('caricaVisibilitaFatture su ogni altra voce: la quota dell’altro non si vede, perché la divisione non dipende dal tipo', () => {
  const FILTRO_ACCESO = '2026-09-16T10:00:00Z'
  const conFiltro = (scuola: string, attivo: string | null) => ({
    admin_settings: [{ scuola_id: scuola, fatture_visibilita_attiva_il: attivo }],
  })
  const famiglia = { id: UTENTE, role: 'genitore' as const, scuola_id: SEDE_A }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['singolo', 'rata', 'padre', null, undefined])(
    'filtro spento e voce %s: anche una voce non `split` può avere due documenti, quindi la quota dell’altro no; la propria, l’ordinaria e la non classificata sì',
    async (tipo) => {
      const { supabase, lette } = supabaseFinto({
        ...conFiltro(SEDE_A, null),
        parents: [{ id: MADRE, auth_user_id: UTENTE }],
      })

      const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, tipo)

      expect(esito.esito).toBe('ok')
      if (esito.esito !== 'ok') return
      expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
      expect(esito.puoVedere(riga('quote_separate', null))).toBe(false)
      expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
      expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(true)
      expect(esito.puoVedere(riga('ordinaria', null))).toBe(true)
      expect(esito.puoVedere(riga(null, PADRE))).toBe(true)
      expect(esito.puoVedere(riga(null, null))).toBe(true)
      expect(lette).toEqual(['admin_settings', 'parents'])
      expect(logEvento).not.toHaveBeenCalled()
    },
  )

  it('filtro spento, senza un record `parents`: nessuna quota, e niente delle ordinarie e delle non classificate si nasconde', async () => {
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_A, null), parents: [] })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'singolo')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(false)
    expect(esito.puoVedere(riga('quote_separate', null))).toBe(false)
    expect(esito.puoVedere(riga('ordinaria', MADRE))).toBe(true)
    expect(esito.puoVedere(riga(null, null))).toBe(true)
  })

  it('filtro acceso: resta com’era, la non classificata si nasconde e la quota vale solo col proprio `parents.id`', async () => {
    const { supabase } = supabaseFinto({
      ...conFiltro(SEDE_A, FILTRO_ACCESO),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'singolo')

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(true)
    expect(esito.puoVedere(riga(null, MADRE))).toBe(false)
    expect(logEvento).not.toHaveBeenCalled()
  })

  it.each(['segreteria', 'coordinator', 'admin'] as const)(
    'filtro spento, %s nel proprio plesso: tutte, perché la consegna la fa lei, e nessuna lettura in più',
    async (role) => {
      const { supabase, lette } = supabaseFinto(conFiltro(SEDE_A, null))

      const esito = await caricaVisibilitaFatture(
        supabase as never,
        { id: UTENTE, role, scuola_id: SEDE_A },
        SEDE_A,
        'singolo',
      )

      expect(esito.esito).toBe('ok')
      if (esito.esito !== 'ok') return
      expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
      expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
      expect(esito.puoVedere(riga('ordinaria', null))).toBe(true)
      expect(esito.puoVedere(riga(null, null))).toBe(true)
      expect(lette).toEqual(['admin_settings'])
    },
  )

  it('filtro spento, admin con la sede aggiuntiva: tutte, e `parents` non si legge', async () => {
    const { supabase, lette } = supabaseFinto({
      ...conFiltro(SEDE_B, null),
      utenti_scuole: [{ utente_id: UTENTE, scuola_id: SEDE_B }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', scuola_id: SEDE_A },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(lette).toEqual(['admin_settings', 'utenti_scuole'])
  })

  it('filtro spento, staff fuori perimetro: lavorare in un’altra sede non apre la quota dell’altro genitore', async () => {
    const { supabase, lette } = supabaseFinto({
      ...conFiltro(SEDE_B, null),
      parents: [{ id: MADRE, auth_user_id: UTENTE }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga('quote_separate', MADRE))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(false)
    expect(esito.puoVedere(riga('ordinaria', PADRE))).toBe(true)
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(lette).toEqual(['admin_settings', 'parents'])
  })

  it('filtro spento, errore di lettura su `parents`: 500, perché un guasto non diventa un consenso', async () => {
    const guasto = { code: '42501', message: 'permission denied' }
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_A, null), errori: { parents: guasto } })

    const esito = await caricaVisibilitaFatture(supabase as never, famiglia, SEDE_A, 'singolo')

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
    expect(await esito.response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'caricaVisibilitaFatture:parents', stato: 500 }),
      guasto,
    )
  })

  it('filtro spento, errore di lettura sul ponte delle sedi: 500', async () => {
    const guasto = { code: '42501', message: 'bridge denied' }
    const { supabase } = supabaseFinto({ ...conFiltro(SEDE_B, null), errori: { utenti_scuole: guasto } })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'admin', scuola_id: SEDE_A },
      SEDE_B,
      'singolo',
    )

    expect(esito.esito).toBe('errore')
    if (esito.esito !== 'errore') return
    expect(esito.response.status).toBe(500)
  })
})
