import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import shared from '../../../messages/it/shared.json'
import { SettimanaDisponibilita } from '@/components/features/crm/disponibilita/SettimanaDisponibilita'
import { lunediDi, settimanaModificabile } from '@/lib/crm/settimane'

/**
 * CRM della segreteria · la griglia della settimana nella pagina delle disponibilità (Compito 8).
 *
 * ── COME SI PROVA ───────────────────────────────────────────────────────────────────
 * `fetch` è finto e risponde in base a metodo e percorso; ogni chiamata viene REGISTRATA col suo corpo, perché
 * ciò che conta è quello che la schermata MANDA al server (quale proprietario, quali fasce, per quale
 * settimana). Una chiamata a una rotta non prevista fa fallire il test.
 *
 * Il finto della GET fa quello che fa la route vera: normalizza il giorno chiesto al lunedì e dice se la
 * settimana si può ancora modificare (stesse funzioni di `src/lib/crm/settimane.ts`, già provate a parte).
 *
 * ── L'OROLOGIO ──────────────────────────────────────────────────────────────────────
 * Si congela solo `Date` (i timer restano veri, `findBy`/`waitFor` continuano a funzionare): «oggi» è
 * mercoledì 4 novembre 2026, quindi la settimana in corso comincia lunedì 2 novembre.
 *
 * ── I NOMI ──────────────────────────────────────────────────────────────────────────
 * Solo nomi di prova: nessuna persona vera, nessuna famiglia.
 */

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const PERSONE = [
  { id: P1, nome: 'Prima', cognome: 'Prova', ruolo: 'segreteria' },
  { id: P2, nome: 'Seconda', cognome: 'Prova', ruolo: 'admin' },
]

const OGGI = '2026-11-04'

// ── fetch finto ──────────────────────────────────────────────────────────────────────

interface Chiamata {
  metodo: string
  percorso: string
  query: URLSearchParams
  corpo: Record<string, unknown> | undefined
}
type Rotta = { metodo: string; percorso: RegExp; risposta: (c: Chiamata) => Response | Promise<Response> }

let chiamate: Chiamata[] = []
let rotte: Rotta[] = []
let nonPreviste: string[] = []

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })
const errore = (status: number, codice: string) => json({ error: 'Errore del server', codice }, status)

function rotta(metodo: string, percorso: RegExp, risposta: (c: Chiamata) => Response | Promise<Response> | unknown) {
  rotte.push({
    metodo,
    percorso,
    risposta: (c) => {
      const r = risposta(c)
      if (r instanceof Response || r instanceof Promise) return r as Response | Promise<Response>
      return json(r)
    },
  })
}

const quante = (metodo: string, percorso: RegExp) => chiamate.filter((c) => c.metodo === metodo && percorso.test(c.percorso))
const ultima = (metodo: string, percorso: RegExp) => quante(metodo, percorso).at(-1)
const letture = () => quante('GET', /\/api\/admin\/crm\/disponibilita$/)
const scritture = () => quante('PUT', /\/api\/admin\/crm\/disponibilita$/)

beforeEach(() => {
  chiamate = []
  rotte = []
  nonPreviste = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T09:00:00Z')) // mercoledì 4 novembre, 10:00 a Roma
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const c: Chiamata = {
        metodo,
        percorso: url.pathname,
        query: url.searchParams,
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      }
      if (url.pathname.startsWith('/api/logs')) return json({ ok: true })
      chiamate.push(c)
      const r = rotte.find((x) => x.metodo === metodo && x.percorso.test(url.pathname))
      if (!r) {
        nonPreviste.push(`${metodo} ${url.pathname}`)
        return json({ error: 'rotta non prevista nel test' }, 500)
      }
      return r.risposta(c)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  expect(nonPreviste).toEqual([])
})

// ── dati ─────────────────────────────────────────────────────────────────────────────

type Fascia = { giornoSettimana: number; oraInizio: string; oraFine: string; durataSlotMin: number }
type Proprietario = {
  utenteId: string | null
  origine: 'registrata' | 'ereditata' | 'nessuna'
  daSettimana: string | null
  fasce: ({ utenteId: string | null; settimana: string } & Fascia)[]
}

const conSettimana = (utenteId: string | null, settimana: string, fasce: Fascia[]) =>
  fasce.map((f) => ({ utenteId, settimana, ...f }))

/** Tre proprietari, uno per ognuna delle tre origini possibili. */
function proprietariDi(lunedi: string, ereditataDa = '2026-10-05'): Proprietario[] {
  return [
    {
      utenteId: null,
      origine: 'registrata',
      daSettimana: lunedi,
      fasce: conSettimana(null, lunedi, [
        { giornoSettimana: 1, oraInizio: '09:00', oraFine: '12:00', durataSlotMin: 45 },
        { giornoSettimana: 5, oraInizio: '15:00', oraFine: '17:30', durataSlotMin: 30 },
      ]),
    },
    {
      utenteId: P1,
      origine: 'ereditata',
      daSettimana: ereditataDa,
      fasce: conSettimana(P1, lunedi, [{ giornoSettimana: 2, oraInizio: '09:00', oraFine: '13:00', durataSlotMin: 45 }]),
    },
    { utenteId: P2, origine: 'nessuna', daSettimana: null, fasce: [] },
  ]
}

function preparaSettimana(proprietari: (lunedi: string) => Proprietario[] = proprietariDi) {
  rotta('GET', /\/api\/admin\/crm\/disponibilita$/, (c) => {
    const lunedi = lunediDi(c.query.get('settimana') ?? '')
    return {
      data: { settimana: lunedi, modificabile: settimanaModificabile(lunedi, OGGI), proprietari: proprietari(lunedi), persone: PERSONE },
      io: { id: P1, ruolo: 'segreteria' },
    }
  })
}

async function monta() {
  render(<SettimanaDisponibilita scuolaId={SEDE_A} />)
  await screen.findByRole('table')
}

/** La riga della griglia di un proprietario, dal nome che si legge nell'intestazione di riga. */
const riga = (nome: RegExp) => screen.getByRole('rowheader', { name: nome }).closest('tr') as HTMLElement

/** Le sette caselle dei giorni (da lunedì a domenica) di una riga, senza la casella dei comandi. */
const caselle = (r: HTMLElement) => within(r).getAllByRole('cell').slice(0, 7)

const SETTIMANA_CORRENTE = 'Settimana: 2 novembre – 8 novembre 2026'

async function apriDialogo(nome: string) {
  fireEvent.click(screen.getByRole('button', { name: `Modifica gli orari: ${nome}` }))
  return screen.findByRole('dialog', { name: `Orari: ${nome}` })
}

// ═════════════════════════════════════════════════════════════════════════════════════
// La griglia
// ═════════════════════════════════════════════════════════════════════════════════════

describe('SettimanaDisponibilita · la griglia', () => {
  it('mostra la riga della sede e una per persona, con «uguale alla settimana del …» per le ereditate', async () => {
    preparaSettimana()
    await monta()

    // La richiesta dichiara la sede e chiede la settimana in corso (il lunedì di mercoledì 4).
    const richiesta = letture()[0]
    expect(richiesta.query.get('scuolaId')).toBe(SEDE_A)
    expect(richiesta.query.get('settimana')).toBe('2026-11-02')

    // Sette giorni, da lunedì a domenica, ognuno con la sua data.
    const giorni = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(giorni.slice(1, 8)).toEqual([
      'Lunedì2 novembre',
      'Martedì3 novembre',
      'Mercoledì4 novembre',
      'Giovedì5 novembre',
      'Venerdì6 novembre',
      'Sabato7 novembre',
      'Domenica8 novembre',
    ])

    // Una riga per la sede e una per ogni persona, nell'ordine che dà il server.
    const proprietari = screen.getAllByRole('rowheader').map((r) => r.textContent ?? '')
    expect(proprietari).toHaveLength(3)
    expect(proprietari[0]).toMatch(/^Sede/)
    expect(proprietari[1]).toMatch(/^Prima Prova/)
    expect(proprietari[2]).toMatch(/^Seconda Prova/)

    // L'origine, accanto al nome: modificata qui, uguale a un'altra settimana, mai impostata.
    // Il confronto è sul testo intero dell'intestazione: nella stessa settimana l'anno NON si scrive.
    expect(proprietari).toEqual([
      'Sedemodificata questa settimana',
      'Prima Provauguale alla settimana del 5 ottobre',
      'Seconda Provanon ancora impostata',
    ])

    // Le fasce stanno nel loro giorno, come «9:00–12:00»; i giorni senza fasce sono vuoti.
    const sede = caselle(riga(/^Sede/))
    expect(within(sede[0]).getByText('9:00–12:00')).toBeTruthy()
    expect(within(sede[4]).getByText('15:00–17:30')).toBeTruthy()
    expect(sede[1].textContent).toBe('—')
    const prima = caselle(riga(/^Prima Prova/))
    expect(within(prima[1]).getByText('9:00–13:00')).toBeTruthy()
    expect(caselle(riga(/^Seconda Prova/)).every((c) => c.textContent === '—')).toBe(true)
  })

  it('una settimana ereditata da un altro anno porta l’anno nella data', async () => {
    preparaSettimana((lunedi) => proprietariDi(lunedi, '2025-12-29'))
    await monta()
    expect(screen.getByRole('rowheader', { name: /^Prima Prova/ }).textContent).toBe('Prima Provauguale alla settimana del 29 dicembre 2025')
  })

  it('‹ e › cambiano settimana e rileggono; «Questa settimana» torna a oggi', async () => {
    preparaSettimana()
    await monta()
    expect(screen.getByRole('table', { name: SETTIMANA_CORRENTE })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    // La tabella cambia nome solo quando la lettura nuova è arrivata: è il segnale che ha riletto.
    await screen.findByRole('table', { name: 'Settimana: 26 ottobre – 1 novembre 2026' })
    expect(letture().at(-1)?.query.get('settimana')).toBe('2026-10-26')

    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    // 19 ottobre: prima del cambio d'ora del 25. Sommare 7×24 ore avrebbe sbagliato giorno.
    await screen.findByRole('table', { name: 'Settimana: 19 ottobre – 25 ottobre 2026' })
    expect(letture().at(-1)?.query.get('settimana')).toBe('2026-10-19')

    fireEvent.click(screen.getByRole('button', { name: 'Settimana successiva' }))
    await screen.findByRole('table', { name: 'Settimana: 26 ottobre – 1 novembre 2026' })
    expect(letture().at(-1)?.query.get('settimana')).toBe('2026-10-26')

    fireEvent.click(screen.getByRole('button', { name: 'Settimana successiva' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settimana successiva' }))
    await screen.findByRole('table', { name: 'Settimana: 9 novembre – 15 novembre 2026' })

    fireEvent.click(screen.getByRole('button', { name: 'Questa settimana' }))
    await screen.findByRole('table', { name: SETTIMANA_CORRENTE })
    expect(letture().at(-1)?.query.get('settimana')).toBe('2026-11-02')
  })

  it('settimana passata: nessun bottone Modifica', async () => {
    preparaSettimana()
    await monta()
    // Quella in corso si modifica: un bottone per la sede e uno per ogni persona, e nessun avviso.
    expect(screen.getAllByRole('button', { name: /^Modifica/ })).toHaveLength(3)
    expect(screen.queryByText('Le settimane passate non si modificano')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    // Si aspetta ciò che deve comparire, poi si guarda l'assenza: un'assenza «subito» è vera anche prima che arrivi la lettura.
    expect(await screen.findByText('Le settimane passate non si modificano')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^Modifica/ })).toHaveLength(0)
    // La griglia si legge lo stesso: le fasce di quella settimana restano visibili.
    expect(within(caselle(riga(/^Sede/))[0]).getByText('9:00–12:00')).toBeTruthy()

    // E tornando avanti i bottoni tornano.
    fireEvent.click(screen.getByRole('button', { name: 'Questa settimana' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Modifica/ })).toHaveLength(3))
    expect(screen.queryByText('Le settimane passate non si modificano')).toBeNull()
  })

  it('mentre arriva un’altra settimana la tabella è quella vecchia e «Modifica» è spento', async () => {
    let ritarda = false
    let rispondi: (r: Response) => void = () => {}
    rotta('GET', /\/api\/admin\/crm\/disponibilita$/, (c) => {
      if (ritarda) return new Promise<Response>((ok) => { rispondi = ok })
      const lunedi = lunediDi(c.query.get('settimana') ?? '')
      return json({
        data: { settimana: lunedi, modificabile: true, proprietari: proprietariDi(lunedi), persone: PERSONE },
        io: { id: P1, ruolo: 'segreteria' },
      })
    })
    await monta()

    ritarda = true
    fireEvent.click(screen.getByRole('button', { name: 'Settimana successiva' }))
    await waitFor(() => expect(letture()).toHaveLength(2))
    // La tabella mostra ancora la settimana di prima, attenuata: non si apre un dialogo su di lei.
    expect(screen.getByRole('table', { name: SETTIMANA_CORRENTE })).toBeTruthy()
    const bottoni = screen.getAllByRole('button', { name: /^Modifica/ }) as HTMLButtonElement[]
    expect(bottoni).toHaveLength(3)
    expect(bottoni.every((b) => b.disabled)).toBe(true)

    rispondi(json({ data: { settimana: '2026-11-09', modificabile: true, proprietari: proprietariDi('2026-11-09'), persone: PERSONE }, io: { id: P1, ruolo: 'segreteria' } }))
    await screen.findByRole('table', { name: 'Settimana: 9 novembre – 15 novembre 2026' })
    expect((screen.getAllByRole('button', { name: /^Modifica/ }) as HTMLButtonElement[]).every((b) => !b.disabled)).toBe(true)
  })

  it('503: dice che il CRM non è disponibile, senza una griglia vuota e senza «Riprova»', async () => {
    rotta('GET', /\/api\/admin\/crm\/disponibilita$/, () => errore(503, 'CRM_NON_INSTALLATO'))
    render(<SettimanaDisponibilita scuolaId={SEDE_A} />)

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(shared.erroreCrmNonInstallato)
    expect(screen.queryByRole('table')).toBeNull()
    // Riprovare non cambia nulla se le tabelle non ci sono.
    expect(screen.queryByRole('button', { name: 'Riprova' })).toBeNull()
  })

  it('una lettura fallita lo dice e «Riprova» rilegge', async () => {
    let riuscita = false
    rotta('GET', /\/api\/admin\/crm\/disponibilita$/, () =>
      riuscita
        ? json({ data: { settimana: '2026-11-02', modificabile: true, proprietari: proprietariDi('2026-11-02'), persone: PERSONE }, io: { id: P1, ruolo: 'segreteria' } })
        : errore(500, 'ERRORE_INTERNO'),
    )
    render(<SettimanaDisponibilita scuolaId={SEDE_A} />)

    await screen.findByRole('alert')
    expect(screen.queryByRole('table')).toBeNull()
    riuscita = true
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await screen.findByRole('table')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════
// Il dialogo
// ═════════════════════════════════════════════════════════════════════════════════════

describe('SettimanaDisponibilita · salvare una settimana', () => {
  it('Salva manda la PUT con tutte le fasce del proprietario e utenteId null per la sede', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => ({ data: { settimanaId: 'x', settimana: '2026-11-02', utenteId: null } }))
    await monta()

    const dialogo = await apriDialogo('Sede')
    // Il dialogo parte dalle fasce che la sede ha in quella settimana, e dice fino a quando vale.
    expect(within(dialogo).getByText('Vale da questa settimana in poi, finché non la cambi di nuovo')).toBeTruthy()
    const da = within(dialogo).getAllByLabelText('Dalle') as HTMLInputElement[]
    expect(da.map((i) => i.value)).toEqual(['09:00', '15:00'])

    // Si cambia una fascia esistente...
    fireEvent.change(within(dialogo).getAllByLabelText('Alle')[1], { target: { value: '18:00' } })
    // ...e se ne aggiunge una: parte da lunedì, 9:00–13:00, slot da 45 minuti.
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aggiungi una fascia' }))
    expect(within(dialogo).getAllByLabelText('Giorno')).toHaveLength(3)
    expect((within(dialogo).getAllByLabelText('Giorno')[2] as HTMLSelectElement).value).toBe('1')
    expect((within(dialogo).getAllByLabelText('Dalle')[2] as HTMLInputElement).value).toBe('09:00')
    expect((within(dialogo).getAllByLabelText('Alle')[2] as HTMLInputElement).value).toBe('13:00')
    expect((within(dialogo).getAllByLabelText('Durata di uno slot')[2] as HTMLSelectElement).value).toBe('45')
    fireEvent.change(within(dialogo).getAllByLabelText('Giorno')[2], { target: { value: '3' } })
    fireEvent.change(within(dialogo).getAllByLabelText('Dalle')[2], { target: { value: '14:00' } })
    fireEvent.change(within(dialogo).getAllByLabelText('Alle')[2], { target: { value: '16:00' } })
    fireEvent.change(within(dialogo).getAllByLabelText('Durata di uno slot')[2], { target: { value: '30' } })

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(scritture()).toHaveLength(1)
    expect(ultima('PUT', /\/disponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A,
      settimana: '2026-11-02',
      utenteId: null,
      fasce: [
        { giornoSettimana: 1, oraInizio: '09:00', oraFine: '12:00', durataSlotMin: 45 },
        { giornoSettimana: 5, oraInizio: '15:00', oraFine: '18:00', durataSlotMin: 30 },
        { giornoSettimana: 3, oraInizio: '14:00', oraFine: '16:00', durataSlotMin: 30 },
      ],
    })
    // E la settimana si è riletta.
    expect(letture().length).toBeGreaterThanOrEqual(2)
  })

  it('una persona che eredita salva COPIANDO le fasce ereditate: una scrittura sola', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => ({ data: { settimanaId: 'x', settimana: '2026-11-02', utenteId: P1 } }))
    await monta()

    const dialogo = await apriDialogo('Prima Prova')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(scritture()).toHaveLength(1)
    expect(ultima('PUT', /\/disponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A,
      settimana: '2026-11-02',
      utenteId: P1,
      fasce: [{ giornoSettimana: 2, oraInizio: '09:00', oraFine: '13:00', durataSlotMin: 45 }],
    })
  })

  it('una settimana mai impostata parte senza righe; si aggiunge e si toglie', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => ({ data: { settimanaId: 'x', settimana: '2026-11-02', utenteId: P2 } }))
    await monta()

    const dialogo = await apriDialogo('Seconda Prova')
    expect(within(dialogo).queryByLabelText('Dalle')).toBeNull()
    expect(within(dialogo).getByText('Nessuna fascia')).toBeTruthy()

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aggiungi una fascia' }))
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aggiungi una fascia' }))
    expect(within(dialogo).getAllByLabelText('Dalle')).toHaveLength(2)
    // Toglie la prima: resta una riga sola.
    fireEvent.change(within(dialogo).getAllByLabelText('Giorno')[1], { target: { value: '4' } })
    fireEvent.click(within(dialogo).getAllByRole('button', { name: /^Elimina la fascia/ })[0])
    expect(within(dialogo).getAllByLabelText('Dalle')).toHaveLength(1)

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('PUT', /\/disponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A,
      settimana: '2026-11-02',
      utenteId: P2,
      fasce: [{ giornoSettimana: 4, oraInizio: '09:00', oraFine: '13:00', durataSlotMin: 45 }],
    })
  })

  it('tolte tutte le righe, Salva manda una settimana volutamente vuota', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => ({ data: { settimanaId: 'x', settimana: '2026-11-02', utenteId: P1 } }))
    await monta()

    const dialogo = await apriDialogo('Prima Prova')
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Elimina la fascia/ }))
    expect(within(dialogo).queryByLabelText('Dalle')).toBeNull()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('PUT', /\/disponibilita$/)?.corpo?.fasce).toEqual([])
  })

  it('un’ora di fine che non segue quella di inizio non parte', async () => {
    preparaSettimana()
    await monta()
    const dialogo = await apriDialogo('Sede')
    fireEvent.change(within(dialogo).getAllByLabelText('Alle')[0], { target: { value: '08:00' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toContain('L’ora di fine deve essere dopo quella di inizio.')
    expect(scritture()).toHaveLength(0)
  })

  it('mentre la richiesta è in volo Salva è spento, e un secondo clic non ne manda un’altra', async () => {
    preparaSettimana()
    let rispondi: (r: Response) => void = () => {}
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => new Promise<Response>((ok) => { rispondi = ok }))
    await monta()

    const dialogo = await apriDialogo('Sede')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(scritture()).toHaveLength(1))

    const inVolo = within(dialogo).getByRole('button', { name: 'Un momento…' }) as HTMLButtonElement
    expect(inVolo.disabled).toBe(true)
    fireEvent.click(inVolo)
    fireEvent.submit(dialogo.querySelector('form') as HTMLFormElement)
    expect(scritture()).toHaveLength(1)

    rispondi(json({ data: { settimanaId: 'x', settimana: '2026-11-02', utenteId: null } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(scritture()).toHaveLength(1)
  })

  it('409 SETTIMANA_PASSATA resta nel dialogo come alert', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => errore(409, 'SETTIMANA_PASSATA'))
    await monta()

    const dialogo = await apriDialogo('Sede')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))

    const avviso = await within(dialogo).findByRole('alert')
    expect(avviso.textContent).toContain(shared.erroreCrmSettimanaPassata)
    // Il dialogo non si è chiuso, le righe sono ancora lì, e Salva si può premere di nuovo.
    expect(screen.getByRole('dialog', { name: 'Orari: Sede' })).toBeTruthy()
    expect(within(dialogo).getAllByLabelText('Dalle')).toHaveLength(2)
    await waitFor(() => expect((within(dialogo).getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(false))
    // Nessuna rilettura: non è andato a buon fine niente.
    expect(letture()).toHaveLength(1)
  })

  it('422 FASCE_SOVRAPPOSTE resta nel dialogo con il suo testo', async () => {
    preparaSettimana()
    rotta('PUT', /\/api\/admin\/crm\/disponibilita$/, () => errore(422, 'FASCE_SOVRAPPOSTE'))
    await monta()

    const dialogo = await apriDialogo('Sede')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toContain(shared.erroreCrmFasceSovrapposte)
    expect(screen.getByRole('dialog', { name: 'Orari: Sede' })).toBeTruthy()
  })

  it('«Annulla» chiude senza chiamare il server', async () => {
    preparaSettimana()
    await monta()
    const dialogo = await apriDialogo('Sede')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(scritture()).toHaveLength(0)
  })
})
