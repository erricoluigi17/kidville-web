import { beforeEach, describe, expect, it, vi } from 'vitest'

import { caricaVisibilitaFatture } from '@/lib/pagamenti/visibilita-fatture'

const logErrore = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logErrore: (...args: unknown[]) => logErrore(...args),
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

  it('col filtro spento non aggiunge restrizioni e non legge il ponte genitore', async () => {
    const { supabase, lette } = supabaseFinto({
      admin_settings: [{ scuola_id: SEDE_A, fatture_visibilita_attiva_il: null }],
    })

    const esito = await caricaVisibilitaFatture(
      supabase as never,
      { id: UTENTE, role: 'genitore', scuola_id: SEDE_A },
      SEDE_A,
    )

    expect(esito.esito).toBe('ok')
    if (esito.esito !== 'ok') return
    expect(esito.puoVedere(riga(null, null))).toBe(true)
    expect(esito.puoVedere(riga('quote_separate', PADRE))).toBe(true)
    expect(lette).toEqual(['admin_settings'])
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
