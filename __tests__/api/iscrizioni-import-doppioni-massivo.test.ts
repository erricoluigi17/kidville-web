import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * IMPORT MASSIVO — IL BAMBINO GEMELLO NON DIVENTA UN SECONDO ALUNNO.
 *
 * ─── IL GUASTO, MISURATO IL 2026-09-14 ──────────────────────────────────────
 * Sette coppie di alunni doppi nella stessa sede: stesso nome, cognome e data di
 * nascita, codici fiscali diversi per un carattere. L'import riconosce un bambino
 * SOLO per codice identico, quindi il refuso passava da «bambino nuovo».
 *
 * Il cron è la strada che iscrive la grande maggioranza dei bambini, e lì non c'è
 * una persona davanti: il gemello NON si risolve da solo. La domanda va fra le
 * «da controllare» con il motivo scritto, e nessun alunno nasce — lo stesso posto e
 * la stessa forma del pre-flight sulla sezione inesistente.
 *
 * ⚠️ La prova che conta è la prima LETTA AL CONTRARIO: togliendo il pre-flight dalla
 * route `eseguiDomanda` verrebbe chiamata e quel test diventerebbe rosso.
 *
 * Il client è il finto che APPLICA i filtri: «un gemello in un'altra sede non ferma
 * niente» con un mock piatto sarebbe verde anche senza il filtro di sede.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione', 'cron']) }))

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: undefined as Record<string, { code: string; message?: string }> | undefined,
  lotto: [] as string[],
  sospensioni: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/supabase/server-client', () => {
  const crea = () =>
    creaFintoSupabase(h.db as DBFinto, [], {
      errori: h.errori,
      rpc: {
        iscrizioni_prendi_in_carico: () => ({ data: h.lotto, error: null }),
        iscrizioni_sospendi: (args) => {
          h.sospensioni.push(args)
          return { data: null, error: null }
        },
      },
    })
  return { createAdminClient: vi.fn(async () => crea()), createClient: vi.fn(async () => crea()) }
})

const lotto = vi.hoisted(() => ({
  caricaElenco: vi.fn(async () => ({ righe: [{ id: 'r1', classe: '3 ANNI', nome: 'ROSSI MARIO', riga: 2, retta: 180, rettaTesto: null }], caricatoIl: null })),
  caricaDecisioni: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/iscrizioni/import/lotto', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/lotto')>()
  return { ...vero, caricaElenco: lotto.caricaElenco, caricaDecisioni: lotto.caricaDecisioni }
})

// La decisione si pilota da qui: l'oggetto del file è ciò che succede DOPO un «invia».
vi.mock('@/lib/iscrizioni/import/analisi', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/analisi')>()
  return {
    ...vero,
    decidi: vi.fn(() => ({
      tipo: 'invia',
      assegnazioni: [{ indice: 0, nome: 'Mario', cognome: 'Rossi', classe: '3 ANNI', retta: 180, aCaricoDi: null }],
      referente: { nome: 'Anna', cognome: 'Bianchi', email: 'anna@example.test', codiceFiscale: null, ruolo: 'madre' },
    })),
  }
})

const esegui = vi.hoisted(() => ({
  eseguiDomanda: vi.fn(async () => ({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })),
}))
vi.mock('@/lib/iscrizioni/import/esegui', () => esegui)
vi.mock('@/lib/iscrizioni/import/inviti', () => ({
  invitiPrevisti: vi.fn(async () => 1),
  riprendiInvitiSospesi: vi.fn(async () => ({ spedite: 0, fallite: 0, rinviata: false })),
  emailSpediteOggi: vi.fn(async () => 0),
}))
vi.mock('@/lib/email/send', () => ({ sendEmailDetailed: vi.fn(async () => ({ ok: true, messageId: 'm-1' })) }))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: vi.fn(async () => ({ email: null, nome: 'Sede di prova' })) }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: vi.fn(async () => undefined) }))
vi.mock('@/lib/format/fiscal-date', () => ({ oggiFiscaleISO: () => '2026-08-25', annoFiscale: () => 2026 }))

import { POST } from '@/app/api/iscrizione/import-massivo/route'

const SEGRETO = 'segreto-di-prova'
const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'b2b2b2b2-0000-4000-8000-000000000002'
const DOMANDA = 'f0f0f0f0-0000-4000-8000-000000000010'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'

/** Valido (verificato in `validazione.test.ts`) — catastale Z999, di nessuno. */
const CF_VALIDO = 'XQQYKV19C07Z999T'
/** Lo stesso codice col carattere di controllo sbagliato. */
const CF_REFUSO = 'XQQYKV19C07Z999A'
const NATO_IL = '2019-03-07'

const req = (corpo: unknown) =>
  new Request('http://localhost/api/iscrizione/import-massivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': SEGRETO },
    body: JSON.stringify(corpo),
  })

const scheda = (over: Record<string, unknown> = {}) => ({
  id: ESISTENTE,
  scuola_id: SEDE,
  nome: 'Mario',
  cognome: 'Rossi',
  data_nascita: NATO_IL,
  codice_fiscale: CF_VALIDO,
  anonimizzato_il: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SEGRETO
  h.errori = undefined
  h.lotto = [DOMANDA]
  h.sospensioni = []
  h.db = {
    iscrizioni_elenco_caricamenti: [{ scuola_id: SEDE, attivo: true }],
    sections: [{ id: 'sez-1', scuola_id: SEDE, name: '3 ANNI' }],
    enrollment_submissions: [{
      id: DOMANDA,
      scuola_id: SEDE,
      status: 'pending',
      created_at: '2026-08-20T09:00:00Z',
      data: {
        children: [{ nome: 'Mario', cognome: 'Rossi', data_nascita: NATO_IL, codice_fiscale: CF_REFUSO }],
        adults: [{ first_name: 'Anna', last_name: 'Bianchi', email: 'anna@example.test', ruolo: 'madre' }],
      },
    }],
    alunni: [],
  }
})

describe('import massivo · il bambino gemello va fra le «da controllare»', () => {
  it('gemello in sede e codice non trovato ⇒ da_controllare con il motivo, e NESSUN alunno creato', async () => {
    h.db.alunni = [scheda()]
    const res = await POST(req({}))
    const body = (await res.json()) as { daControllare?: number; inviate?: number }

    // Letta al contrario: senza il pre-flight, qui l'alunno doppio nascerebbe.
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(0)
    expect(body.daControllare).toBe(1)
    expect(body.inviate).toBe(0)

    expect(h.sospensioni).toHaveLength(1)
    expect(h.sospensioni[0]).toMatchObject({ p_submission_id: DOMANDA, p_stato: 'da_controllare' })
    const motivo = String(h.sospensioni[0].p_motivo)
    expect(motivo).toContain('Rossi Mario')
    expect(motivo).toContain('stesso nome e la stessa data di nascita')
    expect(motivo).toContain('codice fiscale diverso')
    // Dice anche che cosa fare, non solo che cosa non va.
    expect(motivo).toMatch(/rifiutat|rifiuta/)
    expect(motivo).toContain('scheda esistente')
  })

  it('il log dice «possibile doppione» con uuid e indice, senza dati personali', async () => {
    h.db.alunni = [scheda()]
    await POST(req({}))
    const riga = log.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown> | undefined)?.esito === 'possibile-doppione',
    )
    expect(riga?.[0]).toBe('iscrizione')
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ entita: 'bambino', indice: 1, sede_id: SEDE, entita_id: DOMANDA, alunno_esistente_id: ESISTENTE })
    const scritto = JSON.stringify(riga?.[2])
    for (const dato of ['Mario', 'Rossi', CF_VALIDO, CF_REFUSO, NATO_IL]) expect(scritto).not.toContain(dato)
  })

  it('stesso codice fiscale IDENTICO (una re-iscrizione) ⇒ nessun blocco: la scheda la ritrova la ricerca per codice', async () => {
    h.db.alunni = [scheda({ codice_fiscale: `${CF_REFUSO}` })]
    await POST(req({}))
    expect(h.sospensioni).toHaveLength(0)
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(1)
  })

  it('il gemello sta in un\'ALTRA sede ⇒ nessun blocco da doppione', async () => {
    h.db.alunni = [scheda({ scuola_id: ALTRA_SEDE })]
    await POST(req({}))
    expect(h.sospensioni).toHaveLength(0)
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(1)
  })

  it('una scheda anonimizzata non è un gemello ⇒ nessun blocco', async () => {
    h.db.alunni = [scheda({ anonimizzato_il: '2026-09-02T10:00:00Z' })]
    await POST(req({}))
    expect(h.sospensioni).toHaveLength(0)
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(1)
  })

  it('lettura degli alunni fallita ⇒ NON si blocca: non sapere non è bocciare (ma resta nel log)', async () => {
    h.db.alunni = [scheda()]
    h.errori = { 'alunni:select': { code: '08006', message: 'connection failure' } }
    await POST(req({}))
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(1)
    expect(h.sospensioni).toHaveLength(0)
    const riga = log.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown> | undefined)?.esito === 'gemello-non-verificabile',
    )
    expect(riga?.[1]).toBe('error')
  })

  it('in prova a vuoto si conta ma non si sospende', async () => {
    h.db.alunni = [scheda()]
    const res = await POST(req({ dry_run: true }))
    const body = (await res.json()) as { daControllare?: number }
    expect(body.daControllare).toBe(1)
    expect(h.sospensioni).toHaveLength(0)
    expect(esegui.eseguiDomanda.mock.calls.length).toBe(0)
  })
})
