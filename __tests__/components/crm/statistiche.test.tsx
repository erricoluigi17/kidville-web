import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { StatisticheCrm } from '@/components/features/crm/statistiche/StatisticheCrm'
import type {
  ConfrontoSede,
  RigaPersonaNominata,
  RispostaStatistiche,
  TotaleStatistiche,
} from '@/lib/crm/statistiche'

/**
 * CRM della segreteria · Compito 6.2 — la schermata delle statistiche.
 *
 * Il server è finto (`fetch`), i numeri nelle risposte sono scelti a mano e il test misura SOLO ciò che la
 * schermata ne fa: due colonne separate per verificati e a mano, il trattino al posto di un rapporto senza
 * denominatore (mai `NaN`, mai `Infinity`), la riga dell'assistente AI e quella del collega non più in
 * elenco, la nota sui «non attribuiti», le scorciatoie di periodo, il confronto fra sedi solo per l'admin.
 */

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  fetch: vi.fn(),
  log: vi.fn(),
}))

vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => h.ruolo }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log }))

const ALFA = '00000000-0000-4000-8000-0000000000a1'
const BETA = '00000000-0000-4000-8000-0000000000a2'
const EX = '00000000-0000-4000-8000-0000000000a3'

const VUOTO: TotaleStatistiche = {
  fissati: 0,
  svolti: 0,
  nonPresentati: 0,
  tassoPresentazione: null,
  bambiniVisitati: 0,
  iscrittiVerificati: 0,
  iscrittiAMano: 0,
  closeRate: null,
  azioniDovute: 0,
  azioniInTempo: 0,
  followUpInTempo: null,
}

/** Una riga con i numeri dati e tutto il resto a zero/trattino. */
const riga = (persona: RigaPersonaNominata['persona'], numeri: Partial<TotaleStatistiche>): RigaPersonaNominata => ({
  ...VUOTO,
  ...numeri,
  persona,
})

const ALFA_RIGA = riga(
  { id: ALFA, nome: 'Alfa', cognome: 'Prova' },
  {
    fissati: 6,
    svolti: 5,
    nonPresentati: 1,
    tassoPresentazione: 5 / 6,
    bambiniVisitati: 4,
    iscrittiVerificati: 1,
    iscrittiAMano: 2,
    closeRate: 3 / 4,
    azioniDovute: 3,
    azioniInTempo: 1,
    followUpInTempo: 1 / 3,
  },
)
// Visita svolta ma nessun iscritto e nessun richiamo: i rapporti senza denominatore arrivano `null`.
const BETA_RIGA = riga(
  { id: BETA, nome: 'Beta', cognome: 'Prova' },
  { fissati: 0, svolti: 0, bambiniVisitati: 2, iscrittiVerificati: 0, iscrittiAMano: 0, closeRate: 0 },
)
const AI_RIGA = riga('ai', { fissati: 3, svolti: 2, nonPresentati: 1, tassoPresentazione: 2 / 3 })
const EX_RIGA = riga({ id: EX, nome: '', cognome: '' }, { fissati: 1, svolti: 1, tassoPresentazione: 1 })

const TOTALE: TotaleStatistiche = {
  ...VUOTO,
  fissati: 10,
  svolti: 8,
  nonPresentati: 2,
  tassoPresentazione: 0.8,
  bambiniVisitati: 6,
  iscrittiVerificati: 1,
  iscrittiAMano: 2,
  closeRate: 0.5,
  azioniDovute: 3,
  azioniInTempo: 1,
  followUpInTempo: 1 / 3,
}

function risposta(extra: Partial<RispostaStatistiche> = {}): RispostaStatistiche {
  return {
    scuolaId: SEDE_A,
    dal: '2026-02-01',
    al: '2026-02-28',
    righe: [ALFA_RIGA, BETA_RIGA, EX_RIGA, AI_RIGA],
    totale: TOTALE,
    ritardoMedianoGiorni: 3.5,
    nonAttribuiti: { visite: 0, bambini: 0 },
    ...extra,
  }
}

const ok = (dati: RispostaStatistiche) =>
  new Response(JSON.stringify({ data: dati }), { status: 200, headers: { 'content-type': 'application/json' } })

/** Gli URL con cui la schermata ha chiamato il server, come oggetti. */
const chiamate = (): URL[] => h.fetch.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost'))

/** Le intestazioni «foglia» della tabella (la seconda riga di `thead`), nell'ordine delle celle numeriche. */
const intestazioniNumeri = (): string[] =>
  Array.from(document.querySelectorAll('thead tr:nth-child(2) th')).map((th) => th.textContent ?? '')

/** Il valore della cella di una persona sotto una colonna, trovata PER NOME della colonna e non per posizione. */
function cella(persona: string, colonna: string): string {
  const riga = screen.getByRole('row', { name: new RegExp(persona) })
  const indice = intestazioniNumeri().indexOf(colonna)
  expect(indice, `colonna «${colonna}» non trovata`).toBeGreaterThanOrEqual(0)
  const celle = Array.from(riga.querySelectorAll('td'))
  return celle[indice]?.textContent ?? ''
}

beforeEach(() => {
  h.ruolo = 'segreteria'
  h.fetch.mockReset()
  h.log.mockReset()
  h.fetch.mockImplementation(async () => ok(risposta()))
  vi.stubGlobal('fetch', h.fetch)
  // Solo `Date`: i timer veri servono a `waitFor`. Febbraio 2026 → periodo predefinito 01–28/02.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-10T12:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('StatisticheCrm · richiesta', () => {
  it('chiede la sede e il mese in corso, in giorni di Roma', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Per persona')
    const [prima] = chiamate()
    expect(prima.pathname).toBe('/api/admin/crm/statistiche')
    expect(prima.searchParams.get('scuolaId')).toBe(SEDE_A)
    expect(prima.searchParams.get('dal')).toBe('2026-02-01')
    expect(prima.searchParams.get('al')).toBe('2026-02-28')
    expect(prima.searchParams.has('confronto')).toBe(false)
  })

  it('con un id di sede illeggibile non chiede niente', async () => {
    render(<StatisticheCrm scuolaId="non-un-uuid" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Per persona')).toBeNull()
  })

  it('le scorciatoie ricalcolano il periodo e lo richiedono', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Per persona')
    expect(screen.getByRole('button', { name: 'Questo mese' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Mese scorso' }))
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    expect(chiamate()[1].searchParams.get('dal')).toBe('2026-01-01')
    expect(chiamate()[1].searchParams.get('al')).toBe('2026-01-31')
    expect(screen.getByRole('button', { name: 'Mese scorso' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Da settembre' }))
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3))
    // Febbraio 2026 cade nell'anno scolastico che è partito a settembre 2025.
    expect(chiamate()[2].searchParams.get('dal')).toBe('2025-09-01')
    expect(chiamate()[2].searchParams.get('al')).toBe('2026-02-28')
  })

  it('un primo giorno dopo l’ultimo non parte e lo dice', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Per persona')
    fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-03-05' } })
    expect((await screen.findByRole('alert')).textContent).toContain('non può venire dopo')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Per persona')).toBeNull()
  })

  it('una data lasciata a metà non chiede niente e non segnala niente', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Per persona')
    fireEvent.change(screen.getByLabelText('Al'), { target: { value: '' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('una risposta arrivata in ritardo per un periodo vecchio non scavalca quello nuovo', async () => {
    let rilascia: (r: Response) => void = () => {}
    h.fetch.mockImplementationOnce(() => new Promise<Response>((r) => (rilascia = r)))
    h.fetch.mockImplementationOnce(async () => ok(risposta({ righe: [BETA_RIGA] })))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mese scorso' }))
    await screen.findByText('Prova Beta')
    // La prima richiesta (febbraio) risponde dopo, con un'altra persona: non deve comparire.
    rilascia(ok(risposta({ righe: [ALFA_RIGA] })))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('Prova Alfa')).toBeNull()
    expect(screen.getByText('Prova Beta')).toBeTruthy()
  })
})

describe('StatisticheCrm · numeri', () => {
  it('la schermata mostra verificati e a mano in due colonne', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')

    const intestazioni = intestazioniNumeri()
    expect(intestazioni).toContain('Iscritti verificati')
    expect(intestazioni).toContain('Iscritti a mano')
    expect(intestazioni.indexOf('Iscritti verificati')).not.toBe(intestazioni.indexOf('Iscritti a mano'))
    // Due numeri DIVERSI nella stessa riga: se fossero sommati ne uscirebbe uno solo.
    expect(cella('Prova Alfa', 'Iscritti verificati')).toBe('1')
    expect(cella('Prova Alfa', 'Iscritti a mano')).toBe('2')
  })

  it('ogni colonna porta il numero giusto sulla riga giusta', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    expect(cella('Prova Alfa', 'Concluse')).toBe('6')
    expect(cella('Prova Alfa', 'Svolte')).toBe('5')
    expect(cella('Prova Alfa', 'Non presentati')).toBe('1')
    expect(cella('Prova Alfa', 'Presentazione')).toBe('83%')
    expect(cella('Prova Alfa', 'Bambini visitati')).toBe('4')
    expect(cella('Prova Alfa', 'Chiusura')).toBe('75%')
    expect(cella('Prova Alfa', 'Scaduti')).toBe('3')
    expect(cella('Prova Alfa', 'In tempo')).toBe('1')
    expect(cella('Prova Alfa', '% in tempo')).toBe('33%')
    expect(cella('Prova Beta', 'Bambini visitati')).toBe('2')
  })

  it('un rapporto senza denominatore è un trattino, mai NaN o Infinity; lo zero vero resta 0%', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Beta')
    expect(cella('Prova Beta', 'Presentazione')).toBe('—')
    expect(cella('Prova Beta', '% in tempo')).toBe('—')
    // Due bambini visitati e nessun iscritto: qui il denominatore c'è, ed è davvero 0%.
    expect(cella('Prova Beta', 'Chiusura')).toBe('0%')
    const testo = document.body.textContent ?? ''
    // Parole intere: «annullate» contiene «null» e non è un difetto.
    expect(testo).not.toMatch(/\b(?:NaN|Infinity|undefined|null)\b/)
  })

  it('senza nessuna visita i quattro riquadri dicono trattino', async () => {
    h.fetch.mockImplementation(async () =>
      ok(risposta({ righe: [], totale: VUOTO, ritardoMedianoGiorni: null })),
    )
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    expect(await screen.findByText(/Nessuna visita conclusa/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    const riquadri = ['Tasso di presentazione', 'Tasso di chiusura', 'Dal contatto alla visita', 'Richiami in tempo']
    for (const etichetta of riquadri) {
      const valore = screen.getByText(etichetta).previousElementSibling
      expect(valore?.textContent, etichetta).toContain('—')
    }
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)
  })

  it('i quattro riquadri riportano il totale della sede e la mediana in giorni', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    const valoreDi = (etichetta: string) => screen.getByText(etichetta).previousElementSibling?.textContent ?? ''
    expect(valoreDi('Tasso di presentazione')).toContain('80%')
    expect(valoreDi('Tasso di chiusura')).toContain('50%')
    expect(valoreDi('Dal contatto alla visita')).toContain('3,5 giorni')
    expect(valoreDi('Richiami in tempo')).toContain('33%')
  })

  it('la riga del totale sta in fondo e usa le stesse colonne', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    const piede = document.querySelector('tfoot tr') as HTMLElement
    expect(within(piede).getByText('Totale della sede')).toBeTruthy()
    const celle = Array.from(piede.querySelectorAll('td')).map((c) => c.textContent)
    expect(celle).toHaveLength(intestazioniNumeri().length)
    expect(celle[intestazioniNumeri().indexOf('Concluse')]).toBe('10')
    expect(celle[intestazioniNumeri().indexOf('Iscritti a mano')]).toBe('2')
  })
})

describe('StatisticheCrm · persone', () => {
  it('l’assistente AI compare solo se il server manda la sua riga, e va per ultima', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    const nomi = Array.from(document.querySelectorAll('tbody th')).map((th) => th.textContent)
    expect(nomi).toEqual(['Prova Alfa', 'Prova Beta', 'Collega non più in elenco', 'Assistente AI'])

    cleanup()
    h.fetch.mockImplementation(async () => ok(risposta({ righe: [ALFA_RIGA] })))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    expect(screen.queryByText('Assistente AI')).toBeNull()
  })

  it('un collega senza nome si mostra con la frase, mai con l’uuid', async () => {
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Collega non più in elenco')
    expect(document.body.textContent).not.toContain(EX)
    expect(document.body.textContent).not.toContain(ALFA)
  })

  it('la nota dei non attribuiti compare solo se sono più di zero', async () => {
    h.fetch.mockImplementation(async () => ok(risposta({ nonAttribuiti: { visite: 2, bambini: 1 } })))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    const nota = await screen.findByRole('note')
    expect(nota.textContent).toContain('2 visite svolte')
    expect(nota.textContent).toContain('1 bambino')

    cleanup()
    h.fetch.mockImplementation(async () => ok(risposta({ nonAttribuiti: { visite: 1, bambini: 0 } })))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    const nota1 = await screen.findByRole('note')
    expect(nota1.textContent).toContain('1 visita svolta')
    expect(nota1.textContent).toContain('0 bambini')

    cleanup()
    h.fetch.mockImplementation(async () => ok(risposta()))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('StatisticheCrm · confronto fra sedi', () => {
  const CONFRONTO: ConfrontoSede[] = [
    { scuolaId: SEDE_A, nome: 'Sede Prova A', totale: TOTALE, ritardoMedianoGiorni: 3.5 },
    { scuolaId: SEDE_B, nome: 'Sede Prova B', totale: { ...VUOTO, fissati: 4, svolti: 4, tassoPresentazione: 1 }, ritardoMedianoGiorni: null },
  ]

  it('l’admin lo chiede e lo vede, una riga per sede', async () => {
    h.ruolo = 'admin'
    h.fetch.mockImplementation(async () => ok(risposta({ confronto: CONFRONTO })))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    expect(await screen.findByText('Confronto fra le sedi')).toBeTruthy()
    const ultima = chiamate().at(-1)!
    expect(ultima.searchParams.get('confronto')).toBe('1')

    const tabella = screen.getByRole('table', { name: /Totali per sede/ })
    expect(within(tabella).getByText('Sede Prova A')).toBeTruthy()
    const rigaB = within(tabella).getByRole('row', { name: /Sede Prova B/ })
    const celle = Array.from(rigaB.querySelectorAll('td')).map((c) => c.textContent)
    // concluse 4, presentazione 100%, … ritardo senza dati → trattino, richiami senza dati → trattino
    expect(celle[0]).toBe('4')
    expect(celle[1]).toBe('100%')
    expect(celle[6]).toBe('—')
    expect(celle[7]).toBe('—')
  })

  it('la segreteria non lo chiede e non lo vede', async () => {
    h.ruolo = 'segreteria'
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    expect(chiamate().every((u) => !u.searchParams.has('confronto'))).toBe(true)
    expect(screen.queryByText('Confronto fra le sedi')).toBeNull()
  })

  it('finché il ruolo non è noto non lo chiede', async () => {
    h.ruolo = ''
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByText('Prova Alfa')
    expect(chiamate().every((u) => !u.searchParams.has('confronto'))).toBe(true)
  })
})

describe('StatisticheCrm · errori', () => {
  it('un 500 senza corpo dice la frase generica e permette di riprovare', async () => {
    h.fetch.mockImplementationOnce(async () => new Response(null, { status: 500 }))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Non riesco a leggere le statistiche')
    expect(screen.queryByRole('table')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText('Prova Alfa')).toBeTruthy()
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('un rifiuto con un codice dichiarato mostra la frase del catalogo, non quella generica', async () => {
    h.fetch.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'x', codice: 'SOLO_ADMIN' }), { status: 403 }),
    )
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).not.toContain('Non riesco a leggere')
    expect(avviso.textContent?.trim().length).toBeGreaterThan('Riprova'.length)
  })

  it('senza rete (offline) lo dice, e non scrive nel log', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    h.fetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch')
    })
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    expect((await screen.findByRole('alert')).textContent).toContain('senza connessione')
    expect(h.log).not.toHaveBeenCalled()
    online.mockRestore()
  })

  it('con la rete su ma la fetch caduta lo registra, senza dati personali', async () => {
    h.fetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch')
    })
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    await screen.findByRole('alert')
    expect(h.log).toHaveBeenCalledTimes(1)
    const evento = JSON.stringify(h.log.mock.calls[0][0])
    expect(evento).not.toContain('Prova')
    expect(evento).not.toContain(SEDE_A)
  })

  it('una risposta 200 senza la forma attesa è un errore, non una tabella vuota', async () => {
    h.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ data: { sbagliato: true } }), { status: 200 }))
    render(<StatisticheCrm scuolaId={SEDE_A} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Non riesco a leggere le statistiche')
    expect(h.log).toHaveBeenCalledTimes(1)
  })
})
