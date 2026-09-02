import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LA STESSA REGOLA SULLE DUE STRADE: UNA CLASSE SENZA SEZIONE NON ISCRIVE NESSUNO.
 *
 * `alunni.classe_sezione` si scrive come TESTO, e a risolvere `section_id` è il
 * trigger `sync_alunno_section_id()`, che cerca il nome dentro la STESSA
 * `scuola_id` confrontandolo senza spazi e senza maiuscole. Quando non lo trova
 * **lascia NULL e non solleva niente**: l'alunno risulta iscritto, e non compare
 * in appello, registro, classe.
 *
 * La via MANUALE (`admin/iscrizioni:PATCH`) rifiuta da sempre quel caso, con un
 * pre-flight che sta lì da mesi. La via AUTOMATICA — questo cron, che iscrive la
 * grande maggioranza dei bambini — non lo controllava.
 *
 * ─── IL PREZZO, MISURATO ────────────────────────────────────────────────────
 * Kidville Aversa, 2026-08-31. L'elenco della sede era un foglio Excel unico
 * chiamato `RETTE`, con i nomi delle sezioni scritti come righe in mezzo ai nomi
 * dei bambini: il lettore lo legge in Forma A — dove il nome del foglio È la
 * classe — e ha scritto `classe = 'RETTE'` su tutte e 117 le righe. `RETTE` non
 * è una sezione. Risultato: **73 bambini iscritti e invisibili a ogni registro**,
 * con **87 credenziali già spedite** alle loro famiglie. Gli stessi bambini,
 * passati per la via manuale, sarebbero stati fermati uno per uno.
 *
 * È la forma di guasto che questo progetto ha già pagato altrove: una regola
 * valida per due strade viveva in un posto solo.
 *
 * ─── COSA BLOCCA QUESTO FILE ────────────────────────────────────────────────
 *  1. classe che nella sede non esiste ⇒ `da_controllare`, e NON si scrive niente;
 *  2. spazi e maiuscole non contano (è la formula del trigger, non un'altra);
 *  3. il punto e la barra INVECE contano — `4 ANNI M.ROSARIA` non è `4 ANNI MROSARIA`;
 *  4. se le sezioni non si riescono a leggere NON si blocca: non sapere non può
 *     voler dire bocciare un'iscrizione (il DB E2E della CI non è migrato);
 *  5. sede senza nessuna sezione in archivio: idem, non si blocca;
 *  6. in prova a vuoto si conta ma non si sospende.
 *
 * ⚠️ La prova che conta è la n. 1 LETTA AL CONTRARIO: se qualcuno togliesse il
 * pre-flight dalla route, `eseguiDomanda` verrebbe chiamata e quel test
 * diventerebbe rosso. È l'unico modo di sapere che questo file sta guardando
 * qualcosa.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione', 'cron']) }))

const db = vi.hoisted(() => {
  const state = {
    elenchi: [] as Array<Record<string, unknown>>,
    domande: [] as Array<Record<string, unknown>>,
    lotto: [] as string[],
    /** Le sezioni della sede, come le vede PostgREST. */
    sezioni: [] as Array<Record<string, unknown>>,
    sezioniError: null as unknown,
    rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  }
  function client(): unknown {
    return {
      from(table: string) {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is', 'lt', 'lte', 'gte', 'update', 'delete']) {
          b[m] = () => b
        }
        const risolvi = (): { data: unknown; error: unknown } => {
          if (table === 'iscrizioni_elenco_caricamenti') return { data: state.elenchi, error: null }
          if (table === 'enrollment_submissions') return { data: state.domande, error: null }
          if (table === 'sections') return { data: state.sezioni, error: state.sezioniError }
          return { data: [], error: null }
        }
        b.maybeSingle = async () => risolvi()
        b.single = async () => risolvi()
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
        return b
      },
      rpc(nome: string, args: Record<string, unknown>) {
        state.rpc.push({ nome, args })
        const esito = nome === 'iscrizioni_prendi_in_carico'
          ? { data: state.lotto, error: null }
          : { data: null, error: null }
        return { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko) }
      },
    }
  }
  return { state, client }
})
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

const lotto = vi.hoisted(() => ({
  caricaElenco: vi.fn(async () => ({ righe: [{ id: 'r1', classe: 'RIGA', nome: 'RIGA UNICA', riga: 2, retta: 180, rettaTesto: null }], caricatoIl: null })),
  caricaDecisioni: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/iscrizioni/import/lotto', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/lotto')>()
  return { ...vero, caricaElenco: lotto.caricaElenco, caricaDecisioni: lotto.caricaDecisioni }
})

/** La classe assegnata è il perno di questi test: si pilota da qui. */
const analisi = vi.hoisted(() => ({
  classe: 'SEZIONE ESISTENTE',
  decidi: vi.fn(() => ({
    tipo: 'invia',
    assegnazioni: [{ indice: 0, nome: 'Bambina', cognome: 'Inventata', classe: analisi.classe, retta: 180, aCaricoDi: null }],
    referente: { nome: 'Genitore', cognome: 'Inventato', email: 'genitore@example.test', codiceFiscale: null, ruolo: 'madre' },
  })),
}))
vi.mock('@/lib/iscrizioni/import/analisi', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/analisi')>()
  return { ...vero, decidi: analisi.decidi }
})

const esegui = vi.hoisted(() => ({
  eseguiDomanda: vi.fn(async () => ({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })),
}))
vi.mock('@/lib/iscrizioni/import/esegui', () => esegui)

const inviti = vi.hoisted(() => ({
  invitiPrevisti: vi.fn(async () => 1),
  riprendiInvitiSospesi: vi.fn(async () => ({ spedite: 0, fallite: 0, rinviata: false })),
  emailSpediteOggi: vi.fn(async () => 0),
}))
vi.mock('@/lib/iscrizioni/import/inviti', () => inviti)

const mail = vi.hoisted(() => ({ sendEmailDetailed: vi.fn(async () => ({ ok: true, messageId: 'm-1' })) }))
vi.mock('@/lib/email/send', () => mail)
const contesto = vi.hoisted(() => ({ risolviContestoSede: vi.fn(async () => ({ email: 'segreteria@example.test', nome: 'Sede di prova' })) }))
vi.mock('@/lib/email/contesto', () => contesto)
vi.mock('@/lib/format/fiscal-date', () => ({ oggiFiscaleISO: () => '2026-08-25', annoFiscale: () => 2026 }))

import { POST } from '@/app/api/iscrizione/import-massivo/route'

const SEGRETO = 'segreto-di-prova'
const SEDE = '11111111-1111-1111-1111-111111111111'

function req(corpo: unknown): Request {
  return new Request('http://localhost/api/iscrizione/import-massivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': SEGRETO },
    body: JSON.stringify(corpo),
  })
}

/** Una domanda inventata: nomi di fantasia e domini `.test`, il repo è pubblico. */
function domanda(id: string): Record<string, unknown> {
  return {
    id,
    scuola_id: SEDE,
    created_at: '2026-07-01T09:00:00Z',
    data: {
      children: [{ nome: 'Bambina', cognome: 'Inventata', data_nascita: '2022-04-05' }],
      adults: [{ first_name: 'Genitore', last_name: 'Inventato', email: 'genitore@example.test', ruolo: 'madre' }],
    },
  }
}

function sospensioni(): Array<Record<string, unknown>> {
  return db.state.rpc.filter((c) => c.nome === 'iscrizioni_sospendi').map((c) => c.args)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SEGRETO
  supa.createAdminClient.mockImplementation(() => db.client())
  supa.createClient.mockImplementation(() => db.client())
  db.state.elenchi = [{ scuola_id: SEDE, attivo: true }]
  db.state.domande = [domanda('d-1')]
  db.state.lotto = ['d-1']
  db.state.sezioni = [{ name: 'SEZIONE ESISTENTE' }, { name: '4 ANNI M.ROSARIA' }]
  db.state.sezioniError = null
  db.state.rpc = []
  analisi.classe = 'SEZIONE ESISTENTE'
})

describe('import massivo · la classe assegnata deve esistere nella sede', () => {
  it('classe che nella sede non esiste ⇒ da_controllare, e NON scrive niente', async () => {
    analisi.classe = 'RETTE'

    const res = await POST(req({}))
    const body = (await res.json()) as { daControllare?: number; inviate?: number }

    // La prova che conta, e va letta al contrario: togliendo il pre-flight dalla
    // route questa riga diventa rossa. È l'unico modo di sapere che il file guarda.
    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()

    expect(body.daControllare).toBe(1)
    expect(body.inviate).toBe(0)

    const sosp = sospensioni()
    expect(sosp).toHaveLength(1)
    expect(sosp[0].p_stato).toBe('da_controllare')
    expect(String(sosp[0].p_motivo)).toContain('RETTE')
    expect(String(sosp[0].p_motivo)).toContain('appello')
  })

  it('il log dice cosa è successo, senza il nome della classe né quello del bambino', async () => {
    analisi.classe = 'RETTE'
    await POST(req({}))

    const riga = log.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown> | undefined)?.esito === 'sezione-inesistente-in-sede',
    )
    expect(riga).toBeDefined()
    const campi = (riga?.[2] ?? {}) as Record<string, unknown>
    expect(riga?.[1]).toBe('error')
    expect(campi.sede_id).toBe(SEDE)
    expect(campi.quantita).toBe(1)
    // A Cesa una sezione porta il nome di battesimo di un'insegnante: fuori dai log.
    expect(JSON.stringify(campi)).not.toContain('RETTE')
    expect(JSON.stringify(campi)).not.toContain('Inventata')
  })

  it('spazi e maiuscole non contano: è la formula del trigger, non un\'altra', async () => {
    analisi.classe = '  sezione   esistente  '

    await POST(req({}))

    expect(sospensioni()).toHaveLength(0)
    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
  })

  it('il punto invece conta: «4 ANNI MROSARIA» non è «4 ANNI M.ROSARIA»', async () => {
    // `normalizzaNomeSezione` toglie SOLO gli spazi. Se qui passasse, vorrebbe
    // dire che qualcuno ha usato `normalizzaNome` al posto suo — e il trigger,
    // che il punto lo tiene, lascerebbe comunque `section_id` NULL.
    analisi.classe = '4 ANNI MROSARIA'

    await POST(req({}))

    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()
    expect(sospensioni()[0]?.p_stato).toBe('da_controllare')
  })

  it('sezioni non leggibili ⇒ NON si blocca: non sapere non è bocciare', async () => {
    db.state.sezioniError = { code: '42P01', message: 'relation "sections" does not exist' }

    await POST(req({}))

    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(sospensioni()).toHaveLength(0)
    // Schema assente = ambiente diverso, non guasto: `info`, non `error`.
    const riga = log.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown> | undefined)?.esito === 'sezioni-non-leggibili',
    )
    expect(riga?.[1]).toBe('info')
  })

  it('sede senza nessuna sezione in archivio ⇒ NON si blocca', async () => {
    db.state.sezioni = []

    await POST(req({}))

    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(sospensioni()).toHaveLength(0)
  })

  it('in prova a vuoto si conta ma non si sospende', async () => {
    analisi.classe = 'RETTE'

    const res = await POST(req({ dry_run: true }))
    const body = (await res.json()) as { daControllare?: number }

    expect(body.daControllare).toBe(1)
    expect(sospensioni()).toHaveLength(0)
    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()
  })
})
