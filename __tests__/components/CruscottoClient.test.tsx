import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import itCruscotto from '../../messages/it/annoCruscotto.json'

// =============================================================================
// PR 4.7 · compito 4.7.3 · LA PAGINA «ANNO PROSSIMO, A CHE PUNTO SIAMO».
//
// La `fetch` finta risponde per URL, come le tre route vere: `cruscotto`, `moduli-mancanti`, `senza-firma-app`. Si prova ciò che la
// segreteria vede: i numeri, i collegamenti alla pagina Conferme col filtro giusto, gli stati (caricamento, errore con «Riprova»,
// anno non aperto, non disponibile) e l'elenco di chi non ha firmato in app a pagine. Nomi e uuid inventati.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  anno: { effettivo: { annoSedeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attivo: false, stato: 'iscrizioni_aperte' } } as unknown,
}))
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
}))

import { CruscottoClient } from '@/app/(dashboard)/admin/students/anno-prossimo/CruscottoClient'

const ANNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const M_DELEGA = '71717171-7171-4717-8717-717171717171'
const M_CARTACEO = '72727272-7272-4727-8727-727272727272'

type Risposta = { status: number; body: unknown }
const ok = (data: unknown): Risposta => ({ status: 200, body: { success: true, data } })

const CRUSCOTTO = {
  anno: { inizio: '2027-09-01', fine: '2028-08-31', stato: 'iscrizioni_aperte' },
  sezioni: [
    { section_id: 's1', nome: 'Sezione Prova A', fascia: 'infanzia', iscritti: 12 },
    { section_id: null, nome: null, fascia: null, iscritti: 2 },
  ],
  fasce: [
    { fascia: 'infanzia', iscritti: 12, posti: 10, oltre: true },
    { fascia: 'nido_1', iscritti: 3, posti: null, oltre: false },
  ],
  risposte: { confermati: 30, no: 4, non_risposto: 0, di_partenza: 34 },
  nuove: { totale: 6 },
  quota: {
    saldate: 10, da_pagare: 15, assenti: 5, senza_listino: 2, euro_incassati: 1234.5, euro_da_incassare: 2000, euro_assenti_stimati: 800,
    ritirati_con_voce: 1, euro_ritirati_incassati: 100,
  },
  incrocio: { moduli_senza_quota: 7, quota_senza_moduli: 0, entrambi: 8, nessuno_dei_due: 15, totale: 30, piu_voci: 2 },
  confronto: {
    ricostruito: true, giorno_anno_prima: '2026-11-09', anno_prima_etichetta: '2026/27',
    questo_anno: { domande: 40, conferme: 30 }, anno_prima: { domande: 35, conferme: 28 },
  },
}
const MODULI = [
  { modulo_id: M_DELEGA, codice: 'delega_ritiro', titolo: 'Delega al ritiro', lista: 'conferma', mancanti: 3, firma_in_app: true },
  { modulo_id: M_CARTACEO, codice: 'privacy_cartacea', titolo: 'Informativa cartacea', lista: 'nuova', mancanti: 0, firma_in_app: false },
]
const riga = (n: number) => ({ frequenza_id: `f${n}`, alunno_id: `a${n}`, nome: `NomeProva${n}`, cognome: `CognomeProva${n}`, classe: n === 1 ? 'Sezione Prova A' : null })

const s = {
  cruscotto: ok(CRUSCOTTO) as Risposta,
  moduli: ok({ moduli: MODULI }) as Risposta,
  totaleSenzaFirma: 3,
}
const fetchMock = vi.fn()

function risposta(url: string): Risposta {
  if (url.includes('/cruscotto')) return s.cruscotto
  if (url.includes('/moduli-mancanti')) return s.moduli
  if (url.includes('/senza-firma-app')) {
    const pagina = Number(new URL(url, 'http://localhost').searchParams.get('pagina') ?? '1')
    // pagine da 2 per provare «Mostra altri» senza 50 righe: la route vera ne dà al massimo 50
    const tutte = Array.from({ length: s.totaleSenzaFirma }, (_, i) => riga(i + 1))
    return ok({ totale: s.totaleSenzaFirma, pagina, limite: 2, righe: tutte.slice((pagina - 1) * 2, pagina * 2) })
  }
  return { status: 404, body: { error: 'non previsto' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.anno = { effettivo: { annoSedeId: ANNO, attivo: false, stato: 'iscrizioni_aperte' } }
  s.cruscotto = ok(CRUSCOTTO)
  s.moduli = ok({ moduli: MODULI })
  s.totaleSenzaFirma = 3
  fetchMock.mockImplementation((url: string) => {
    const r = risposta(String(url))
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const chiamate = (parte: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(parte))

describe('CruscottoClient — i numeri', () => {
  it('mostra caricamento, poi i cinque blocchi con i numeri del server', async () => {
    render(<CruscottoClient />)
    expect(screen.getByText(itCruscotto.caricamento)).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: itCruscotto.postiTitolo })).toBeInTheDocument()
    for (const titolo of [itCruscotto.risposteTitolo, itCruscotto.quoteTitolo, itCruscotto.incrocioTitolo, itCruscotto.confrontoTitolo]) {
      expect(screen.getByRole('heading', { name: titolo })).toBeInTheDocument()
    }
    expect(screen.getByText(/12 iscritti su 10 posti/)).toBeInTheDocument()
    expect(screen.getByText(itCruscotto.postiOltre)).toBeInTheDocument()
    expect(screen.getByText(/3 iscritti, posti non indicati/)).toBeInTheDocument()
    expect(screen.getByText('Sezione Prova A')).toBeInTheDocument()
    expect(screen.getByText(itCruscotto.sezioneSenza)).toBeInTheDocument()
  })

  it('gli importi sono in euro con la lingua della pagina; la stima è dichiarata tale e non si somma agli incassi', async () => {
    render(<CruscottoClient />)
    expect(await screen.findByText(/Incassati: 1234,50/)).toBeInTheDocument()
    expect(screen.getByText(/Da incassare: 2000,00/)).toBeInTheDocument()
    expect(screen.getByText(/È una stima/)).toBeInTheDocument()
    // la quota di un ritirato con la voce ancora attaccata ha la sua riga, distinta dalle assenti
    expect(screen.getByText(/ha ancora una voce di pagamento che la famiglia vede/)).toBeInTheDocument()
    expect(screen.getByText(/la quota non si può generare/)).toBeInTheDocument()
  })

  it('senza stima e senza ritirati con voce, quelle due righe non ci sono', async () => {
    s.cruscotto = ok({ ...CRUSCOTTO, quota: { ...CRUSCOTTO.quota, euro_assenti_stimati: 0, ritirati_con_voce: 0, senza_listino: 0 } })
    render(<CruscottoClient />)
    await screen.findByText(/Incassati/)
    expect(screen.queryByText(/È una stima/)).toBeNull()
    expect(screen.queryByText(/famiglia vede/)).toBeNull()
  })

  it('il confronto dice il giorno e, se ricostruito, che è approssimato', async () => {
    render(<CruscottoClient />)
    expect(await screen.findByText(/9 novembre/)).toBeInTheDocument()
    expect(screen.getByText(itCruscotto.confrontoRicostruito)).toBeInTheDocument()
    expect(screen.getByText(/2026\/27: 35 domande, 28 conferme/)).toBeInTheDocument()
  })

  it('senza anno prima, il confronto lo dice invece di inventare numeri', async () => {
    s.cruscotto = ok({ ...CRUSCOTTO, confronto: null })
    render(<CruscottoClient />)
    expect(await screen.findByText(itCruscotto.confrontoVuoto)).toBeInTheDocument()
  })
})

describe('CruscottoClient — i collegamenti alla pagina Conferme', () => {
  it('un numero con una lista porta alla pagina Conferme col filtro giusto; un numero a zero non ha il collegamento', async () => {
    render(<CruscottoClient />)
    await screen.findByRole('heading', { name: itCruscotto.incrocioTitolo })
    const href = (etichetta: string) =>
      (screen.getByRole('link', { name: `${etichetta}: ${itCruscotto.apriLista}` }) as HTMLAnchorElement).getAttribute('href')
    expect(href(itCruscotto.rispostaConfermati)).toBe('/admin/students/conferme?conferma=confermato')
    expect(href(itCruscotto.rispostaNo)).toBe('/admin/students/conferme?conferma=no')
    expect(href(itCruscotto.incrocioModuliSenzaQuota)).toBe('/admin/students/conferme?conferma=moduli_senza_quota')
    // non_risposto è 0 e quota_senza_moduli è 0: niente collegamento a una lista vuota
    expect(screen.queryByRole('link', { name: `${itCruscotto.rispostaNonRisposto}: ${itCruscotto.apriLista}` })).toBeNull()
    expect(screen.queryByRole('link', { name: `${itCruscotto.incrocioQuotaSenzaModuli}: ${itCruscotto.apriLista}` })).toBeNull()
    // le nuove iscrizioni portano alla loro vista
    const nuove = screen.getAllByRole('link', { name: itCruscotto.apriLista }).map((a) => a.getAttribute('href'))
    expect(nuove).toContain('/admin/students/conferme?vista=nuove')
  })

  it('un modulo che manca porta all’elenco giusto: la lista «nuova» apre la vista delle nuove', async () => {
    s.moduli = ok({ moduli: [{ ...MODULI[1], mancanti: 4 }] })
    render(<CruscottoClient />)
    const link = await screen.findByRole('link', { name: itCruscotto.moduloApriMancanti })
    expect(link.getAttribute('href')).toBe('/admin/students/conferme?vista=nuove&conferma=mancano_moduli')
  })
})

describe('CruscottoClient — gli stati', () => {
  it('anno non aperto (409): messaggio, senza «Riprova»', async () => {
    s.cruscotto = { status: 409, body: { error: 'ANNO_NON_APERTO' } }
    render(<CruscottoClient />)
    expect(await screen.findByRole('alert')).toHaveTextContent(itCruscotto.annoNonAperto)
    expect(screen.queryByRole('button', { name: itCruscotto.riprova })).toBeNull()
  })

  it('database indietro (503): «Non disponibile»', async () => {
    s.cruscotto = { status: 503, body: { error: 'x' } }
    render(<CruscottoClient />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Non disponibile/)
  })

  it('errore (500): messaggio e «Riprova» rilegge davvero', async () => {
    s.cruscotto = { status: 500, body: { error: 'x' } }
    render(<CruscottoClient />)
    await screen.findByRole('alert')
    const prima = chiamate('/cruscotto').length
    s.cruscotto = ok(CRUSCOTTO)
    fireEvent.click(screen.getByRole('button', { name: itCruscotto.riprova }))
    expect(await screen.findByRole('heading', { name: itCruscotto.postiTitolo })).toBeInTheDocument()
    expect(chiamate('/cruscotto').length).toBeGreaterThan(prima)
  })

  it('senza un anno scelto, o con l’anno in corso, non si legge niente', async () => {
    h.anno = null
    const { unmount } = render(<CruscottoClient />)
    expect(screen.getByText(itCruscotto.nessunAnno)).toBeInTheDocument()
    unmount()
    h.anno = { effettivo: { annoSedeId: ANNO, attivo: true, stato: 'corrente' } }
    render(<CruscottoClient />)
    expect(screen.getByText(itCruscotto.annoAttivo)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('CruscottoClient — chi non ha firmato in app', () => {
  it('il pulsante c’è solo per i moduli con la firma in app, e non legge niente finché non si apre', async () => {
    render(<CruscottoClient />)
    await screen.findByText('Delega al ritiro')
    expect(screen.getAllByRole('button', { name: itCruscotto.firmaMostra })).toHaveLength(1)
    expect(chiamate('/senza-firma-app')).toHaveLength(0)
  })

  it('apre l’elenco con i nomi della pagina e «Mostra altri» carica la successiva', async () => {
    render(<CruscottoClient />)
    await screen.findByText('Delega al ritiro')
    fireEvent.click(screen.getByRole('button', { name: itCruscotto.firmaMostra }))
    expect(await screen.findByText('CognomeProva1 NomeProva1')).toBeInTheDocument()
    expect(screen.getByText('CognomeProva2 NomeProva2')).toBeInTheDocument()
    expect(screen.queryByText('CognomeProva3 NomeProva3')).toBeNull()
    const url = String(chiamate('/senza-firma-app')[0][0])
    expect(url).toContain(`modulo_id=${M_DELEGA}`)
    expect(url).toContain('limite=50')
    fireEvent.click(screen.getByRole('button', { name: itCruscotto.firmaAltri }))
    expect(await screen.findByText('CognomeProva3 NomeProva3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itCruscotto.firmaAltri })).toBeNull()
  })

  it('l’elenco vuoto dice che hanno firmato tutti', async () => {
    s.totaleSenzaFirma = 0
    render(<CruscottoClient />)
    await screen.findByText('Delega al ritiro')
    fireEvent.click(screen.getByRole('button', { name: itCruscotto.firmaMostra }))
    const riquadro = (await screen.findByText(itCruscotto.firmaVuoto)).closest('div') as HTMLElement
    expect(within(riquadro).getByText(itCruscotto.firmaVuoto)).toBeInTheDocument()
  })
})
