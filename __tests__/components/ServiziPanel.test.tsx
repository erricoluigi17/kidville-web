import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

expect.extend(toHaveNoViolations)

// =============================================================================
// T10 — scheda «Servizi» della Contabilità: caricamento, stati vuoti, iscrizioni,
// e i DUE TEMPI di Termina / Modifica / Elimina (la route non scrive finché non si
// decide che cosa fare delle voci già generate fuori periodo).
// Nomi inventati: il repository è pubblico.
// =============================================================================

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { ServiziPanel } from '@/components/features/admin/pagamenti/ServiziPanel'

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'
const SEDE = 'bbbbcccc-2222-4222-8222-eeeeeeeeeeee'
const SERV = '22222222-2222-4222-8222-222222222222'
const ISCR1 = '33333333-3333-4333-8333-333333333331'
const ISCR2 = '33333333-3333-4333-8333-333333333332'
const A1 = '44444444-4444-4444-8444-444444444441' // Verdi Gianni: iscritto da ottobre 2026, senza fine
const A2 = '44444444-4444-4444-8444-444444444442' // Bianchi Lia: gennaio-giugno 2026, ritirata
const A3 = '44444444-4444-4444-8444-444444444443' // Gialli Rosa: libera
const V1 = '55555555-5555-4555-8555-555555555551'
const V2 = '55555555-5555-4555-8555-555555555552'
const V3 = '55555555-5555-4555-8555-555555555553'

const PER = 'Verdi Gianni, Pomeridiano, da ottobre 2026'
const NOME_TERMINA = `Termina: ${PER}`
const NOME_MODIFICA = `Modifica: ${PER}`
const NOME_ELIMINA = `Elimina: ${PER}`

const DATI = {
  servizi: [{ id: SERV, nome: 'Pomeridiano', slug: 'pomeridiano', scuola_id: SEDE, importo_mensile_default: 85.5 }],
  iscrizioni: [
    { id: ISCR1, alunno_id: A1, categoria_id: SERV, importo_mensile: 85.5, dal: '2026-10-01', al: null,
      alunno: { nome: 'Gianni', cognome: 'Verdi', classe_sezione: '1A', stato: 'iscritto' } },
    { id: ISCR2, alunno_id: A2, categoria_id: SERV, importo_mensile: 90, dal: '2026-01-01', al: '2026-06-01',
      alunno: { nome: 'Lia', cognome: 'Bianchi', classe_sezione: '2B', stato: 'ritirato' } },
  ],
}
const ALUNNI = [
  { id: A1, nome: 'Gianni', cognome: 'Verdi', classe_sezione: '1A' },
  { id: A2, nome: 'Lia', cognome: 'Bianchi', classe_sezione: '2B' },
  { id: A3, nome: 'Rosa', cognome: 'Gialli', classe_sezione: '1B' },
]
const VOCE = (id: string, mese: string, extra: Record<string, unknown> = {}) =>
  ({ id, periodo: mese, importo: 85.5, scadenza: `${mese}-10`, stato: 'da_pagare', sollecitata: false, ...extra })

type Risposta = { status: number; body: unknown }
const ok = (data: unknown): Risposta => ({ status: 200, body: { success: true, data } })

let getServizi: Risposta
let attesa: Promise<void> | null // se presente, le scritture restano in sospeso finché non si risolve
let scritture: Risposta[] // risposte consecutive a PATCH/DELETE/POST
let chiamate: { url: string; metodo: string; body: Record<string, unknown> | null }[]
const fetchMock = vi.fn()

function vedi(metodo: string) { return chiamate.filter((c) => c.metodo === metodo) }
function url(c: { url: string }) { return new URL(c.url, 'http://localhost') }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T10:00:00Z') })
  getServizi = ok(DATI)
  scritture = []
  attesa = null
  chiamate = []
  fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
    const metodo = init?.method ?? 'GET'
    chiamate.push({ url: u, metodo, body: init?.body ? JSON.parse(init.body) : null })
    let r: Risposta
    if (u.startsWith('/api/admin/students')) r = ok(ALUNNI)
    else if (metodo === 'GET') r = getServizi
    else { if (attesa) await attesa; r = scritture.shift() ?? ok({}) }
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function apri() {
  render(<ServiziPanel userId={USER} scuolaId={SEDE} />)
  await screen.findByRole('heading', { name: 'Pomeridiano' })
}

/** Apre «Termina», lascia l'ultimo mese predefinito e conferma. */
async function terminaVerdi() {
  fireEvent.click(screen.getByRole('button', { name: NOME_TERMINA }))
  fireEvent.click(await screen.findByRole('button', { name: 'Termina l’iscrizione' }))
}

describe('ServiziPanel — caricamento e stati vuoti', () => {
  it('schema non migrato: testo neutro, titolo presente, nessun errore', async () => {
    getServizi = ok({ non_disponibile: true })
    render(<ServiziPanel userId={USER} scuolaId={SEDE} />)
    expect(await screen.findByText('I servizi mensili non sono ancora disponibili su questo ambiente.')).toBeInTheDocument()
    expect(screen.getByText('Servizi mensili')).toBeInTheDocument()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('nessun servizio: invita ad attivare «Mensile» e rimanda alle Impostazioni con userId', async () => {
    getServizi = ok({ servizi: [], iscrizioni: [] })
    render(<ServiziPanel userId={USER} scuolaId={SEDE} />)
    expect(await screen.findByText(/Nessun servizio mensile: attiva «Mensile» su una categoria in Impostazioni/)).toBeInTheDocument()
    expect(screen.getByText('Servizi mensili')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Vai alle Impostazioni' })).toHaveAttribute('href', `/admin/impostazioni?userId=${USER}`)
  })

  it('la scheda mostra importo proposto, iscritti attivi, periodi, «Conclusa» e chi non è più iscritto', async () => {
    await apri()
    expect(screen.getByText(/Importo proposto: € 85,50/)).toBeInTheDocument()
    expect(screen.getByText(/1 iscritto questo mese/)).toBeInTheDocument()
    const righe = screen.getAllByRole('listitem')
    const verdi = righe.find((r) => /Verdi Gianni/.test(r.textContent ?? ''))!
    const bianchi = righe.find((r) => /Bianchi Lia/.test(r.textContent ?? ''))!
    expect(within(verdi).getByText(/85,50/)).toBeInTheDocument()
    expect(within(verdi).getByText('da ottobre 2026')).toBeInTheDocument()
    expect(within(verdi).queryByText('Conclusa')).toBeNull()
    expect(within(bianchi).getByText('gennaio 2026 – giugno 2026')).toBeInTheDocument()
    expect(within(bianchi).getByText('Conclusa')).toBeInTheDocument()
    expect(within(bianchi).getByText('Non più iscritto alla scuola')).toBeInTheDocument()
    // La sede va in OGNI chiamata.
    expect(chiamate[0].url).toContain(`scuola_id=${SEDE}`)
  })

  it('GET rifiutata: messaggio a schermo, log col solo stato (niente nomi), e «Riprova» rilegge', async () => {
    getServizi = { status: 403, body: { error: 'Non hai i permessi per questa sede.' } }
    render(<ServiziPanel userId={USER} scuolaId={SEDE} />)
    expect(await screen.findByText('Non hai i permessi per questa sede.')).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 403 }))
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/Verdi|Bianchi|permessi/)
    getServizi = ok(DATI)
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByRole('heading', { name: 'Pomeridiano' })).toBeInTheDocument()
  })

  it('nessuna violazione axe con la scheda aperta', async () => {
    await apri()
    // `region` (contenuto dentro i landmark) riguarda la pagina intera, non un pannello isolato;
    // il contrasto lo misura il lock sui token, non jsdom.
    expect(await axe(document.body, { rules: { region: { enabled: false }, 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})

describe('ServiziPanel — aggiunta di iscritti', () => {
  async function apriAggiungi() {
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi iscritti: Pomeridiano' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Gialli Rosa/ })).toBeInTheDocument())
  }

  it('POST con sede, categoria, bambini, importo «85,50» → 85.5 e mese; poi «1 bambino iscritto» e rilettura', async () => {
    scritture = [{ status: 201, body: { success: true, data: { creati: 1, ids: [ISCR1] } } }]
    await apriAggiungi()
    fireEvent.click(screen.getByRole('checkbox', { name: /Gialli Rosa/ }))
    fireEvent.change(screen.getByLabelText('Importo mensile (€)'), { target: { value: '85,50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    expect(await screen.findByText('1 bambino iscritto')).toBeInTheDocument()
    const post = vedi('POST')
    expect(post).toHaveLength(1)
    expect(post[0].body).toEqual({
      scuola_id: SEDE, categoria_id: SERV, alunno_ids: [A3], importo_mensile: 85.5, dal: '2026-10',
    })
    // L'elenco dei bambini usa il tetto condiviso e la sede.
    expect(chiamate.find((c) => c.url.startsWith('/api/admin/students'))!.url).toMatch(/scuola_id=.*&limit=\d+/)
    // Ricarica dopo la scrittura: una GET servizi iniziale e una dopo.
    await waitFor(() => expect(vedi('GET').filter((c) => c.url.startsWith('/api/pagamenti/servizi'))).toHaveLength(2))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('esclude dal selettore chi ha già un\'iscrizione che si sovrappone al periodo scelto', async () => {
    await apriAggiungi()
    // Periodo di partenza: da ottobre 2026 senza fine → Verdi (da ottobre 2026) è fuori, Bianchi (conclusa) no.
    expect(screen.queryByRole('checkbox', { name: /Verdi Gianni/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Bianchi Lia/ })).toBeInTheDocument()
    expect(screen.getByText(/1 bambino non compare perché ha già un’iscrizione/)).toBeInTheDocument()
    // Spostando il periodo su maggio-giugno 2026 si invertono: esce Bianchi, rientra Verdi.
    fireEvent.change(screen.getByLabelText('Dal mese'), { target: { value: '2026-05' } })
    fireEvent.change(screen.getByLabelText('Al mese (facoltativo)'), { target: { value: '2026-06' } })
    expect(screen.queryByRole('checkbox', { name: /Bianchi Lia/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Verdi Gianni/ })).toBeInTheDocument()
  })

  it('«al» prima di «dal»: errore a schermo e nessuna richiesta', async () => {
    await apriAggiungi()
    fireEvent.click(screen.getByRole('checkbox', { name: /Gialli Rosa/ }))
    fireEvent.change(screen.getByLabelText('Dal mese'), { target: { value: '2026-10' } })
    fireEvent.change(screen.getByLabelText('Al mese (facoltativo)'), { target: { value: '2026-09' } })
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    expect(await screen.findByText('Il mese di fine non può essere prima del mese di inizio.')).toBeInTheDocument()
    expect(vedi('POST')).toHaveLength(0)
  })

  it('importo non valido o nessun bambino scelto: nessuna richiesta', async () => {
    await apriAggiungi()
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    expect(await screen.findByText('Scegli almeno un bambino.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Gialli Rosa/ }))
    fireEvent.change(screen.getByLabelText('Importo mensile (€)'), { target: { value: '12,345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    expect(await screen.findByText(/Inserisci un importo maggiore di zero/)).toBeInTheDocument()
    expect(vedi('POST')).toHaveLength(0)
  })

  it('409 sovrapposta: il messaggio del catalogo resta nella finestra, che non si chiude', async () => {
    scritture = [{ status: 409, body: { error: 'x', codice: 'SERVIZIO_ISCRIZIONE_SOVRAPPOSTA', alunno_ids: [A3] } }]
    await apriAggiungi()
    fireEvent.click(screen.getByRole('checkbox', { name: /Gialli Rosa/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toMatch(/sovrappone/i))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', stato: 409 }))
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/Gialli|Rosa/)
  })
})

const DA_DECIDERE: Risposta = {
  status: 409,
  body: { codice: 'VOCI_FUTURE_DA_DECIDERE', data: { eliminabili: [VOCE(V1, '2026-11')], intoccabili: [] } },
}

describe('ServiziPanel — Termina, Modifica, Elimina a due tempi', () => {
  const DA_DECIDERE_CON_ELIMINABILI: Risposta = {
    status: 409,
    body: {
      error: 'Ci sono voci già generate fuori dal nuovo periodo: scegli cosa farne.', codice: 'VOCI_FUTURE_DA_DECIDERE',
      data: {
        eliminabili: [VOCE(V1, '2026-11'), VOCE(V2, '2026-12', { sollecitata: true })],
        intoccabili: [VOCE(V3, '2027-01', { stato: 'pagato', motivo: 'pagata' })],
      },
    },
  }

  it('Termina → 409 → finestra con eliminabili e intoccabili (con il motivo) → «Elimina» ripete la richiesta con gli id mostrati', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI, ok({ voci_eliminate: 2, voci_mantenute: 0, intoccabili: 1 })]
    await apri()
    await terminaVerdi()
    const dialogo = await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    expect(within(dialogo).getByText('2 voci non pagate e non fatturate')).toBeInTheDocument()
    expect(within(dialogo).getByText('1 voce che non si può eliminare')).toBeInTheDocument()
    expect(within(dialogo).getByText('Già pagata')).toBeInTheDocument()
    expect(within(dialogo).getByText('Eliminandola si perde anche lo storico dei solleciti.')).toBeInTheDocument()
    expect(within(dialogo).getByText(/Nov 2026 · scade il 10\/11\/2026/)).toBeInTheDocument()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Elimina le 2 voci non pagate e non fatturate' }))
    expect(await screen.findByText('Iscrizione aggiornata · 2 voci eliminate · 1 voce non eliminabile resta')).toBeInTheDocument()
    const patch = vedi('PATCH')
    expect(patch).toHaveLength(2)
    expect(patch[0].body).toEqual({ id: ISCR1, scuola_id: SEDE, al: '2026-10' })
    expect(patch[1].body).toEqual({ id: ISCR1, scuola_id: SEDE, al: '2026-10', voci_future: 'elimina', voci_ids: [V1, V2] })
    await waitFor(() => expect(vedi('GET').filter((c) => c.url.startsWith('/api/pagamenti/servizi'))).toHaveLength(2))
  })

  it('la finestra del secondo tempo non ha violazioni axe', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI]
    await apri()
    await terminaVerdi()
    const dialogo = await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    expect(await axe(dialogo, { rules: { region: { enabled: false }, 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })

  it('«Mantienile» invia «mantieni» e NESSUN voci_ids', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI, ok({ voci_eliminate: 0, voci_mantenute: 2, intoccabili: 1 })]
    await apri()
    await terminaVerdi()
    fireEvent.click(await screen.findByRole('button', { name: 'Mantienile' }))
    expect(await screen.findByText('Iscrizione aggiornata · 2 voci mantenute · 1 voce non eliminabile resta')).toBeInTheDocument()
    const secondo = vedi('PATCH')[1].body!
    expect(secondo.voci_future).toBe('mantieni')
    expect('voci_ids' in secondo).toBe(false)
  })

  it('«Annulla» non invia niente', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI]
    await apri()
    await terminaVerdi()
    const dialogo = await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vedi('PATCH')).toHaveLength(1)
  })

  it('Escape vale «Annulla»: niente seconda richiesta', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI]
    await apri()
    await terminaVerdi()
    await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vedi('PATCH')).toHaveLength(1)
  })

  it('senza voci eliminabili non c\'è il bottone «Elimina le …»: resta «Procedi», che invia «mantieni»', async () => {
    scritture = [
      { status: 409, body: { codice: 'VOCI_FUTURE_DA_DECIDERE', data: { eliminabili: [], intoccabili: [VOCE(V3, '2027-01', { stato: 'parziale', motivo: 'parziale' })] } } },
      ok({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 1 }),
    ]
    await apri()
    await terminaVerdi()
    const dialogo = await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    expect(within(dialogo).queryByRole('button', { name: /Elimina/ })).toBeNull()
    expect(within(dialogo).queryByRole('button', { name: 'Mantienile' })).toBeNull()
    expect(within(dialogo).getByText('Con un acconto')).toBeInTheDocument()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Procedi' }))
    await screen.findByText('Iscrizione aggiornata · 1 voce non eliminabile resta')
    expect(vedi('PATCH')[1].body).toMatchObject({ voci_future: 'mantieni' })
    expect('voci_ids' in vedi('PATCH')[1].body!).toBe(false)
  })

  it('Elimina iscrizione: conferma esplicita, DELETE con sede, secondo tempo con gli id nella query', async () => {
    scritture = [DA_DECIDERE_CON_ELIMINABILI, ok({ voci_eliminate: 2, voci_mantenute: 0, intoccabili: 1 })]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_ELIMINA }))
    expect(vedi('DELETE')).toHaveLength(0) // ancora nessuna richiesta: serve la conferma
    fireEvent.click(await screen.findByRole('button', { name: 'Elimina l’iscrizione' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Che cosa facciamo delle voci già generate?' })
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Elimina le 2 voci/ }))
    expect(await screen.findByText('Iscrizione eliminata · 2 voci eliminate · 1 voce non eliminabile resta')).toBeInTheDocument()
    const [primo, secondo] = vedi('DELETE').map(url)
    expect(primo.searchParams.get('id')).toBe(ISCR1)
    expect(primo.searchParams.get('scuola_id')).toBe(SEDE)
    expect(primo.searchParams.has('voci_future')).toBe(false)
    expect(secondo.searchParams.get('voci_future')).toBe('elimina')
    expect(secondo.searchParams.get('voci_ids')).toBe(`${V1},${V2}`)
  })

  it('errore dopo che le voci sono già state eliminate: l\'errore E «2 voci erano già state eliminate»', async () => {
    scritture = [
      DA_DECIDERE_CON_ELIMINABILI,
      { status: 500, body: { error: 'Scrittura non riuscita.', codice: 'SERVIZI_SCRITTURA_FALLITA', voci_eliminate: 2 } },
    ]
    await apri()
    await terminaVerdi()
    fireEvent.click(await screen.findByRole('button', { name: /^Elimina le 2 voci/ }))
    const avviso = await waitFor(() => {
      const a = screen.getAllByRole('alert').find((r) => /già state eliminate/.test(r.textContent ?? ''))
      expect(a).toBeTruthy()
      return a!
    })
    expect(avviso.textContent).toContain('2 voci erano già state eliminate.')
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 500 }))
    // L'elenco si rilegge comunque: parte delle voci non c'è più.
    await waitFor(() => expect(vedi('GET').filter((c) => c.url.startsWith('/api/pagamenti/servizi'))).toHaveLength(2))
  })

  it('Modifica: PATCH con importo, mese di inizio e fine nulla (al: null)', async () => {
    scritture = [ok({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 0 })]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_MODIFICA }))
    fireEvent.change(await screen.findByLabelText('Importo mensile (€)'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }))
    expect(await screen.findByText('Iscrizione aggiornata')).toBeInTheDocument()
    expect(vedi('PATCH')[0].body).toEqual({ id: ISCR1, scuola_id: SEDE, importo_mensile: 90, dal: '2026-10', al: null })
  })

  it('Termina con ultimo mese prima dell\'inizio: errore e nessuna richiesta', async () => {
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_TERMINA }))
    fireEvent.change(await screen.findByLabelText('Ultimo mese'), { target: { value: '2026-08' } })
    fireEvent.click(screen.getByRole('button', { name: 'Termina l’iscrizione' }))
    expect(await screen.findByText('Il mese di fine non può essere prima del mese di inizio.')).toBeInTheDocument()
    expect(vedi('PATCH')).toHaveLength(0)
  })
})

describe('GeneraServiziMese', () => {
  const ANTEPRIMA_DIREZIONE = ok({ periodo: '2026-10-01', voci: 3, totale: 256.5, per_servizio: [{ categoria_id: SERV, nome: 'Pomeridiano', voci: 3, totale: 256.5 }] })
  const ANTEPRIMA_SEGRETERIA = ok({ periodo: '2026-10-01', voci: 3, per_servizio: [{ categoria_id: SERV, nome: 'Pomeridiano', voci: 3 }] })
  let anteprima: Risposta
  let genera: Risposta

  beforeEach(() => {
    anteprima = ANTEPRIMA_DIREZIONE
    genera = ok({ periodo: '2026-10', generati: 3 })
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
      if (u.startsWith('/api/pagamenti/genera-servizi')) {
        const metodo = init?.method ?? 'GET'
        chiamate.push({ url: u, metodo, body: init?.body ? JSON.parse(init.body) : null })
        const r = metodo === 'POST' ? genera : anteprima
        return { ok: r.status < 400, status: r.status, json: async () => r.body }
      }
      return base(u, init)
    })
  })

  it('anteprima con totale (Direzione): voci per servizio e totale', async () => {
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    expect(await screen.findByText('Totale: € 256,50')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Genera 3 voci' })).toBeEnabled()
    const q = url(chiamate.find((c) => c.url.startsWith('/api/pagamenti/genera-servizi'))!)
    expect(q.searchParams.get('periodo')).toBe('2026-10')
    expect(q.searchParams.get('scuola_id')).toBe(SEDE)
  })

  it('anteprima senza totale (segreteria): nessuna cifra complessiva', async () => {
    anteprima = ANTEPRIMA_SEGRETERIA
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    expect(await screen.findByRole('button', { name: 'Genera 3 voci' })).toBeInTheDocument()
    expect(screen.getByText(/Pomeridiano/, { selector: 'li *, li' })).toBeInTheDocument()
    expect(screen.queryByText(/Totale:/)).toBeNull()
  })

  it('0 voci: «Genera» disabilitato e il perché a schermo', async () => {
    anteprima = ok({ periodo: '2026-10-01', voci: 0, per_servizio: [] })
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    expect(await screen.findByText('Nessuna voce da generare per questo mese')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Genera 0 voci' })).toBeDisabled()
  })

  it('POST con mese e sede → «3 voci generate», poi l\'anteprima si aggiorna', async () => {
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Genera 3 voci' }))
    anteprima = ok({ periodo: '2026-10-01', voci: 0, per_servizio: [] })
    expect(await screen.findByText('3 voci generate')).toBeInTheDocument()
    expect(vedi('POST')[0].body).toEqual({ periodo: '2026-10', scuola_id: SEDE })
    expect(await screen.findByText('Nessuna voce da generare per questo mese')).toBeInTheDocument()
  })

  it('errore del server: il testo del catalogo e un log senza dati personali', async () => {
    genera = { status: 400, body: { error: 'x', codice: 'SEDE_DI_COLLAUDO' } }
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Genera 3 voci' }))
    expect(await screen.findByText('La generazione non è consentita su una sede di collaudo.')).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 400, messaggio: 'servizi-generazione-respinta:SEDE_DI_COLLAUDO' }))
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/Verdi|Bianchi|Pomeridiano|256/)
  })
})

describe('ServiziPanel — correzioni della revisione', () => {
  const S2 = '22222222-2222-4222-8222-222222222299'
  const iscr = (id: string, cat: string, dal: string, al: string | null) => ({
    id, alunno_id: A1, categoria_id: cat, importo_mensile: 80, dal, al,
    alunno: { nome: 'Gianni', cognome: 'Verdi', classe_sezione: '1A', stato: 'iscritto' },
  })

  it('stesso bambino in due servizi e due volte nello stesso: ogni nome accessibile è UNICO', async () => {
    getServizi = ok({
      servizi: [DATI.servizi[0], { id: S2, nome: 'Doposcuola', slug: null, scuola_id: null, importo_mensile_default: null }],
      iscrizioni: [
        iscr('a0000000-0000-4000-8000-000000000001', SERV, '2026-01-01', '2026-06-01'),
        iscr('a0000000-0000-4000-8000-000000000002', SERV, '2026-10-01', null),
        iscr('a0000000-0000-4000-8000-000000000003', S2, '2026-10-01', null),
      ],
    })
    render(<ServiziPanel userId={USER} scuolaId={SEDE} />)
    await screen.findByRole('heading', { name: 'Doposcuola' })
    const nomi = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
      .filter((n) => /^(Modifica|Termina|Elimina):/.test(n))
    expect(nomi.length).toBeGreaterThanOrEqual(8) // 3 righe: Modifica+Elimina ×3, Termina ×2 (la conclusa no)
    expect(new Set(nomi).size).toBe(nomi.length)
    for (const n of nomi) expect(screen.getAllByRole('button', { name: n })).toHaveLength(1)
  })

  it('le iscrizioni stanno in ordine di cognome e nome, poi di inizio', async () => {
    await apri()
    const testo = screen.getAllByRole('listitem').map((r) => r.textContent ?? '')
    expect(testo.findIndex((x) => x.includes('Bianchi Lia'))).toBeLessThan(testo.findIndex((x) => x.includes('Verdi Gianni')))
  })

  it('«Termina» non c\'è sulle iscrizioni concluse e non può allungare quelle in corso', async () => {
    getServizi = ok({ servizi: DATI.servizi, iscrizioni: [DATI.iscrizioni[1], { ...DATI.iscrizioni[0], al: '2026-12-01' }] })
    await apri()
    expect(screen.queryByRole('button', { name: /^Termina: Bianchi Lia/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Termina: Verdi Gianni/ }))
    // Predefinito: il mese corrente (prima della fine attuale). Spostarlo DOPO la fine è rifiutato.
    expect(await screen.findByLabelText('Ultimo mese')).toHaveValue('2026-10')
    fireEvent.change(screen.getByLabelText('Ultimo mese'), { target: { value: '2027-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Termina l’iscrizione' }))
    expect(await screen.findByText(/non può essere dopo la fine attuale/)).toBeInTheDocument()
    expect(vedi('PATCH')).toHaveLength(0)
  })

  it('Escape con la scrittura in sospeso NON chiude la finestra, e i bottoni sono disabilitati', async () => {
    let sblocca!: () => void
    attesa = new Promise<void>((r) => { sblocca = r })
    scritture = [ok({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 0 })]
    await apri()
    await terminaVerdi()
    await waitFor(() => expect(vedi('PATCH')).toHaveLength(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Termina l’iscrizione' })).toBeDisabled()
    sblocca()
    expect(await screen.findByText('Iscrizione aggiornata')).toBeInTheDocument()
  })

  it('aggiunta con la POST in sospeso: «Iscrivi» e «Annulla» disabilitati', async () => {
    let sblocca!: () => void
    attesa = new Promise<void>((r) => { sblocca = r })
    scritture = [{ status: 201, body: { success: true, data: { creati: 1, ids: [] } } }]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi iscritti: Pomeridiano' }))
    expect(screen.getByText('Caricamento dei bambini…')).toBeInTheDocument() // subito, prima che l'elenco arrivi
    fireEvent.click(await screen.findByRole('checkbox', { name: /Gialli Rosa/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iscrivi' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeDisabled()
    sblocca()
    expect(await screen.findByText('1 bambino iscritto')).toBeInTheDocument()
  })

  it('modalità «Tutti»: chi ha un\'iscrizione sovrapposta resta fuori dalla POST', async () => {
    scritture = [{ status: 201, body: { success: true, data: { creati: 2, ids: [] } } }]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi iscritti: Pomeridiano' }))
    await screen.findByRole('checkbox', { name: /Gialli Rosa/ })
    fireEvent.click(screen.getByRole('button', { name: /^Tutti/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Iscrivi' }))
    expect(await screen.findByText('2 bambini iscritti')).toBeInTheDocument()
    const ids = (vedi('POST')[0].body as { alunno_ids: string[] }).alunno_ids
    expect([...ids].sort()).toEqual([A2, A3].sort())
    expect(ids).not.toContain(A1)
  })

  it('dopo un\'eliminazione riuscita il focus sta sul titolo della scheda', async () => {
    scritture = [ok({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 0 })]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_ELIMINA }))
    fireEvent.click(await screen.findByRole('button', { name: 'Elimina l’iscrizione' }))
    expect(await screen.findByText('Iscrizione eliminata')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Pomeridiano' })).toHaveFocus())
  })

  it('Modifica che riceve il 409: la seconda richiesta ripete importo, dal e al', async () => {
    scritture = [DA_DECIDERE, ok({ voci_eliminate: 0, voci_mantenute: 1, intoccabili: 0 })]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_MODIFICA }))
    fireEvent.change(await screen.findByLabelText('Importo mensile (€)'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('Al mese (facoltativo)'), { target: { value: '2027-06' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mantienile' }))
    await screen.findByText('Iscrizione aggiornata · 1 voce mantenuta')
    const [uno, due] = vedi('PATCH').map((c) => c.body)
    expect(uno).toEqual({ id: ISCR1, scuola_id: SEDE, importo_mensile: 90, dal: '2026-10', al: '2027-06' })
    expect(due).toEqual({ ...uno, voci_future: 'mantieni' })
  })

  it('un nuovo clic su un\'azione azzera l\'esito precedente', async () => {
    scritture = [ok({ voci_eliminate: 0, voci_mantenute: 0, intoccabili: 0 })]
    await apri()
    fireEvent.click(screen.getByRole('button', { name: NOME_MODIFICA }))
    fireEvent.click(await screen.findByRole('button', { name: 'Salva' }))
    expect(await screen.findByText('Iscrizione aggiornata')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NOME_ELIMINA }))
    expect(screen.queryByText('Iscrizione aggiornata')).toBeNull()
  })
})

describe('GeneraServiziMese — gara fra anteprima e mese', () => {
  it('cambiando il mese l\'anteprima decade; il successo resta a schermo anche se la rilettura fallisce', async () => {
    let letture = 0
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
      if (u.startsWith('/api/pagamenti/genera-servizi')) {
        const metodo = init?.method ?? 'GET'
        chiamate.push({ url: u, metodo, body: init?.body ? JSON.parse(init.body) : null })
        if (metodo === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, data: { periodo: '2026-10', generati: 3 } }) }
        letture += 1
        if (letture > 1) return { ok: false, status: 500, json: async () => ({ error: 'x', codice: 'SERVIZI_ANTEPRIMA_FALLITA' }) }
        return { ok: true, status: 200, json: async () => ok({ periodo: '2026-10-01', voci: 3, per_servizio: [{ categoria_id: SERV, nome: 'Pomeridiano', voci: 3 }] }).body }
      }
      return base(u, init)
    })
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Genera 3 voci' }))
    expect(await screen.findByText('3 voci generate')).toBeInTheDocument()
    await waitFor(() => expect(letture).toBe(2))
    expect(screen.getByText('3 voci generate')).toBeInTheDocument()
    expect(vedi('POST')[0].body).toEqual({ periodo: '2026-10', scuola_id: SEDE })
    // Cambiare il mese fa sparire l'anteprima: non si può generare un mese mai visto.
    fireEvent.change(screen.getByLabelText('Mese'), { target: { value: '2026-11' } })
    expect(screen.queryByRole('button', { name: /^Genera/ })).toBeNull()
  })

  it('un\'anteprima di un altro mese non abilita «Genera» e non genera quel mese', async () => {
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
      if (u.startsWith('/api/pagamenti/genera-servizi')) {
        chiamate.push({ url: u, metodo: init?.method ?? 'GET', body: null })
        return { ok: true, status: 200, json: async () => ok({ periodo: '2026-09-01', voci: 4, per_servizio: [] }).body }
      }
      return base(u, init)
    })
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    expect(await screen.findByRole('button', { name: 'Genera 4 voci' })).toBeDisabled()
    expect(vedi('POST')).toHaveLength(0)
  })

  it('un 200 senza il numero delle voci generate mostra l\'errore, non «0 voci generate»', async () => {
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string, init?: { method?: string; body?: string }) => {
      if (u.startsWith('/api/pagamenti/genera-servizi')) {
        const metodo = init?.method ?? 'GET'
        chiamate.push({ url: u, metodo, body: null })
        if (metodo === 'POST') return { ok: true, status: 200, json: async () => { throw new Error('corpo illeggibile') } }
        return { ok: true, status: 200, json: async () => ok({ periodo: '2026-10-01', voci: 3, per_servizio: [] }).body }
      }
      return base(u, init)
    })
    await apri()
    fireEvent.click(screen.getByRole('button', { name: 'Anteprima' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Genera 3 voci' }))
    expect(await screen.findByText('Non siamo riusciti a generare le voci.')).toBeInTheDocument()
    expect(screen.queryByText('0 voci generate')).toBeNull()
  })
})
