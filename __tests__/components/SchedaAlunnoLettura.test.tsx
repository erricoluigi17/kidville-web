import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import servizi from '../../messages/it/teacherServizi.json'
import etichette from '../../messages/it/etichette.json'
import type { GenitoreScheda, Parentela, SchedaAlunnoDocente } from '@/lib/anagrafiche/docente/tipi'

const T = servizi as Record<string, string>
const E = etichette as Record<string, string>

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  }
})
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { SchedaAlunnoLettura } from '@/components/features/teacher/anagrafica/SchedaAlunnoLettura'

const ID = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ID2 = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

const MAMMA: GenitoreScheda = {
  nome: 'Mamma',
  cognome: 'Arcobaleno-E2E',
  parentela: 'madre',
  principale: true,
  telefoni: ['333 000 0000'],
  email: ['mamma@example.test'],
  codiceFiscale: 'TSTMMM80A41Z999Q',
}

const SCHEDA: SchedaAlunnoDocente = {
  id: ID,
  nome: 'Aurora',
  cognome: 'Arcobaleno-E2E',
  sesso: 'F',
  dataNascita: '2022-04-10',
  luogoNascita: { comune: 'Testville', provincia: 'TV', nazione: 'Italia' },
  cittadinanza: 'Italiana',
  codiceFiscale: 'TSTRCB22D50Z999Q',
  residenza: { indirizzo: null, civico: null, cap: null, comune: null, provincia: null },
  sezione: { id: 's', nome: 'Girasoli', grado: 'infanzia' },
  dataIscrizione: '2025-09-01',
  salute: { allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true, noteMediche: 'Riga uno\nRiga due', besDsa: false, usaPannolino: true },
  consensi: { privacy: true, fotoSito: false, fotoSocial: null },
  genitori: [MAMMA],
  delegati: [{ nome: 'Nonna', cognome: 'Arcobaleno-E2E', parentela: 'Nonna' }],
}

const SCHEDA2: SchedaAlunnoDocente = { ...SCHEDA, id: ID2, nome: 'Bruno', cognome: 'Baleno-E2E' }

const risposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response

/** Una risposta che arriva quando lo decide il test. */
const differita = () => {
  let risolvi!: (r: Response) => void
  const promessa = new Promise<Response>((r) => {
    risolvi = r
  })
  return { promessa, risolvi }
}

const fetchMock = vi.fn()

/** Monta la scheda con questa risposta e aspetta che sia a schermo. */
const apri = async (scheda: SchedaAlunnoDocente = SCHEDA) => {
  fetchMock.mockResolvedValue(risposta(200, scheda))
  const esito = render(<SchedaAlunnoLettura alunnoId={scheda.id} />)
  await screen.findByRole('heading', { level: 1, name: `${scheda.cognome} ${scheda.nome}` })
  return esito
}

const riquadro = (titolo: string) => screen.getByRole('region', { name: titolo })

/** Il `dd` della riga con questa etichetta, dentro un contenitore (un riquadro, una scheda genitore). */
const valore = (contenitore: HTMLElement, etichetta: string): HTMLElement => {
  const dt = within(contenitore).getByText(etichetta, { selector: 'dt' })
  const dd = dt.nextElementSibling as HTMLElement | null
  expect(dd?.tagName).toBe('DD')
  return dd as HTMLElement
}

/** Il sottotitolo (parentela · principale) di una scheda genitore, o `null` se non c'è. */
const sottotitolo = (scheda: HTMLElement) => scheda.querySelector('h3 + p')?.textContent ?? null

const regioneAnnunci = (dentro: HTMLElement) => dentro.closest('[aria-live="polite"]')

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SchedaAlunnoLettura — pronta', () => {
  it('mostra anagrafica e salute, e chiede la scheda senza cache', async () => {
    await apri()
    expect(fetchMock).toHaveBeenCalledWith(`/api/teacher/alunni/${ID}`, expect.objectContaining({ cache: 'no-store' }))
    expect(screen.getByText(T.anagraficaSolaLettura)).toBeTruthy()
    const dati = riquadro(T.anagraficaRiquadroDati)
    expect(valore(dati, T.anagraficaCampoSesso).textContent).toBe(T.anagraficaSessoF)
    expect(valore(dati, T.anagraficaCampoDataNascita).textContent).toBe('10/04/2022')
    expect(valore(dati, T.anagraficaCampoLuogoNascita).textContent).toBe('Testville (TV), Italia')
    expect(valore(dati, T.anagraficaCampoCodiceFiscale).textContent).toBe('TSTRCB22D50Z999Q')
  })

  it('il banner delle allergie prende il nome dal suo titolo, e i chip sono un elenco', async () => {
    await apri()
    const avviso = screen.getByRole('note', { name: T.anagraficaAvvisoAllergie })
    expect(avviso.hasAttribute('aria-label')).toBe(false)
    const titolo = document.getElementById(avviso.getAttribute('aria-labelledby') ?? '')
    expect(titolo?.textContent).toBe(T.anagraficaAvvisoAllergie)
    const chip = within(within(avviso).getByRole('list')).getAllByRole('listitem').map((li) => li.textContent)
    expect(chip).toHaveLength(2)
    expect(chip[0]).toContain(E.allergene_latte)
    expect(chip[1]).toBe('fragole')
  })

  it('Salute: con le allergie la riga «Allergie» mostra i chip', async () => {
    await apri()
    const allergie = valore(riquadro(T.anagraficaRiquadroSalute), T.anagraficaCampoAllergie)
    const chip = within(allergie).getAllByRole('listitem').map((li) => li.textContent)
    expect(chip[0]).toContain(E.allergene_latte)
    expect(chip[1]).toBe('fragole')
    expect(allergie.textContent).not.toContain(T.anagraficaNessunaAllergia)
  })

  it('Salute: senza allergie la riga dice «Nessuna allergia segnalata» e il banner non c’è', async () => {
    await apri({ ...SCHEDA, salute: { ...SCHEDA.salute, allergeni: [], allergieAltro: null, haAllergie: false } })
    const allergie = valore(riquadro(T.anagraficaRiquadroSalute), T.anagraficaCampoAllergie)
    expect(allergie.textContent).toBe(T.anagraficaNessunaAllergia)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('Salute: le note mediche conservano gli a capo, BES e pannolino dicono No/Sì', async () => {
    await apri()
    const salute = riquadro(T.anagraficaRiquadroSalute)
    const note = valore(salute, T.anagraficaCampoNoteMediche)
    expect(note.textContent).toBe('Riga uno\nRiga due')
    expect(note.className).toContain('whitespace-pre-line')
    expect(valore(salute, T.anagraficaCampoBes).textContent).toBe(T.anagraficaNo)
    expect(valore(salute, T.anagraficaCampoPannolino).textContent).toBe(T.anagraficaSi)
  })

  it('Consensi: privacy «Sì», foto sul sito «No», foto sui social «Non indicato»', async () => {
    await apri()
    const consensi = riquadro(T.anagraficaRiquadroConsensi)
    expect(valore(consensi, T.anagraficaCampoConsensoPrivacy).textContent).toBe(T.anagraficaSi)
    expect(valore(consensi, T.anagraficaCampoConsensoFotoSito).textContent).toBe(T.anagraficaNo)
    expect(valore(consensi, T.anagraficaCampoConsensoFotoSocial).textContent).toBe(T.anagraficaNonIndicato)
  })

  it('i campi assenti dicono «Non indicato»: esattamente quattro (tre di residenza, un consenso)', async () => {
    await apri()
    expect(screen.getAllByText(T.anagraficaNonIndicato)).toHaveLength(4)
    const residenza = riquadro(T.anagraficaRiquadroResidenza)
    expect(within(residenza).getAllByText(T.anagraficaNonIndicato)).toHaveLength(3)
  })

  it('Classe: la sezione e l’etichetta del suo grado', async () => {
    await apri()
    const classe = riquadro(T.anagraficaRiquadroClasse)
    expect(valore(classe, T.anagraficaCampoSezione).textContent).toBe('Girasoli')
    expect(valore(classe, T.anagraficaCampoGrado).textContent).toBe(T.anagraficaGradoInfanzia)
  })

  it('a scheda pronta la regione degli annunci resta focalizzabile: `sr-only`, mai `hidden`', async () => {
    const { container } = await apri()
    const regione = container.querySelector('[aria-live="polite"]') as HTMLElement
    expect(regione).not.toBeNull()
    const classi = regione.className.split(/\s+/)
    expect(classi).toContain('sr-only')
    expect(classi).not.toContain('hidden')
    expect(classi).not.toContain('empty:hidden')
  })

  it('un bambino senza sezione: sezione e grado «Non indicato»', async () => {
    await apri({ ...SCHEDA, sezione: null })
    const classe = riquadro(T.anagraficaRiquadroClasse)
    expect(valore(classe, T.anagraficaCampoSezione).textContent).toBe(T.anagraficaNonIndicato)
    expect(valore(classe, T.anagraficaCampoGrado).textContent).toBe(T.anagraficaNonIndicato)
    expect(screen.queryByText('Girasoli')).toBeNull()
  })

  it('telefono ed email sono toccabili', async () => {
    await apri()
    const tel = screen.getByRole('link', { name: /333 000 0000/ })
    expect(tel.getAttribute('href')).toBe('tel:3330000000')
    expect(screen.getByRole('link', { name: /mamma@example\.test/ }).getAttribute('href')).toBe('mailto:mamma@example.test')
  })

  it('Famiglia: la madre referente porta «Madre · Referente principale» e il suo codice fiscale', async () => {
    await apri()
    const [mamma] = within(riquadro(T.anagraficaRiquadroFamiglia)).getAllByTestId('scheda-genitore')
    expect(within(mamma).getByRole('heading', { level: 3 }).textContent).toBe('Arcobaleno-E2E Mamma')
    expect(sottotitolo(mamma)).toBe(`${T.anagraficaParentelaMadre} · ${T.anagraficaPrincipale}`)
    expect(valore(mamma, T.anagraficaCampoCodiceFiscale).textContent).toBe('TSTMMM80A41Z999Q')
  })

  it.each<[Parentela, string]>([
    ['padre', T.anagraficaParentelaPadre],
    ['delegato', T.anagraficaParentelaDelegato],
    ['altro', T.anagraficaParentelaAltro],
  ])('Famiglia: parentela «%s» ⇒ «%s», senza «Referente principale»', async (parentela, attesa) => {
    await apri({ ...SCHEDA, genitori: [{ ...MAMMA, parentela, principale: false }] })
    const [genitore] = within(riquadro(T.anagraficaRiquadroFamiglia)).getAllByTestId('scheda-genitore')
    expect(sottotitolo(genitore)).toBe(attesa)
  })

  it('Famiglia: parentela non registrata e niente recapiti ⇒ nessun sottotitolo, «Non indicato» su telefono ed email', async () => {
    await apri({ ...SCHEDA, genitori: [{ ...MAMMA, parentela: null, principale: false, telefoni: [], email: [] }] })
    const [genitore] = within(riquadro(T.anagraficaRiquadroFamiglia)).getAllByTestId('scheda-genitore')
    expect(sottotitolo(genitore)).toBeNull()
    expect(valore(genitore, T.anagraficaCampoTelefono).textContent).toBe(T.anagraficaNonIndicato)
    expect(valore(genitore, T.anagraficaCampoEmail).textContent).toBe(T.anagraficaNonIndicato)
    expect(within(genitore).queryByRole('link')).toBeNull()
  })

  it('Famiglia: nessun genitore ⇒ «Nessun genitore collegato»', async () => {
    await apri({ ...SCHEDA, genitori: [] })
    const famiglia = riquadro(T.anagraficaRiquadroFamiglia)
    expect(within(famiglia).getByText(T.anagraficaNessunGenitore)).toBeTruthy()
    expect(within(famiglia).queryAllByTestId('scheda-genitore')).toHaveLength(0)
  })

  it('Delegati: un elenco, col nome in evidenza e la parentela sotto (se c’è)', async () => {
    await apri({ ...SCHEDA, delegati: [...SCHEDA.delegati, { nome: 'Zio', cognome: 'Arcobaleno-E2E', parentela: null }] })
    const delegati = riquadro(T.anagraficaRiquadroDelegati)
    expect(delegati.querySelector('dt')).toBeNull()
    const voci = within(within(delegati).getByRole('list')).getAllByRole('listitem')
    expect(voci).toHaveLength(2)
    const nonna = within(voci[0]).getByText('Arcobaleno-E2E Nonna')
    expect(nonna.className).toContain('font-semibold')
    expect(within(voci[0]).getByText('Nonna').className).toContain('text-xs')
    expect(voci[1].textContent).toBe('Arcobaleno-E2E Zio')
  })

  it('Delegati: nessuno ⇒ «Nessun delegato al ritiro»', async () => {
    await apri({ ...SCHEDA, delegati: [] })
    expect(within(riquadro(T.anagraficaRiquadroDelegati)).getByText(T.anagraficaNessunDelegato)).toBeTruthy()
  })

  it('SOLA LETTURA: nessun campo modificabile, nessun salvataggio', async () => {
    const { container } = await apri()
    expect(container.querySelectorAll('input, textarea, select, [contenteditable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /salva|modifica|elimina/i })).toBeNull()
  })

  it('«Tutti gli alunni» torna all’elenco con i filtri di prima', async () => {
    window.sessionStorage.setItem('kv-teacher-alunni-ritorno', '?sezione=S1')
    await apri()
    fireEvent.click(screen.getByRole('link', { name: T.anagraficaIndietro }))
    expect(h.push).toHaveBeenCalledWith('/teacher/alunni?sezione=S1')
  })

  it('«Tutti gli alunni» resta fisso sotto l’AppBar: su una scheda lunga non si torna in cima per uscire', async () => {
    await apri()
    const classi = screen.getByRole('link', { name: T.anagraficaIndietro }).className.split(/\s+/)
    expect(classi).toEqual(expect.arrayContaining(['sticky', 'top-[var(--kv-appbar-h,0px)]', 'bg-kidville-cream']))
  })

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
    ['tasto centrale', { button: 1 }],
  ])('«Tutti gli alunni» con %s: il clic resta al browser (nuova scheda)', async (_nome, opzioni) => {
    await apri()
    const nonAnnullato = fireEvent.click(screen.getByRole('link', { name: T.anagraficaIndietro }), opzioni)
    expect(nonAnnullato).toBe(true)
    expect(h.push).not.toHaveBeenCalled()
  })
})

describe('SchedaAlunnoLettura — non si apre', () => {
  it('403 ⇒ «non è in una delle tue classi»', async () => {
    fetchMock.mockResolvedValue(risposta(403, { codice: 'ANAGRAFICA_FUORI_SEZIONE' }))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNegato)).toBeTruthy()
  })

  it('404 ⇒ «Scheda non trovata»', async () => {
    fetchMock.mockResolvedValue(risposta(404, {}))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
  })

  it('401 ⇒ sessione scaduta, con il link all’accesso e senza «Riprova»', async () => {
    fetchMock.mockResolvedValue(risposta(401, { codice: 'NON_AUTENTICATO' }))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreSessione)).toBeTruthy()
    expect(screen.getByRole('link', { name: T.anagraficaAccedi }).getAttribute('href')).toBe('/auth/login')
    expect(screen.queryByRole('button', { name: T.anagraficaRiprova })).toBeNull()
    expect(screen.getByTestId('scheda-esito').getAttribute('data-esito')).toBe('sessione')
  })

  it.each(['', 'abc', `${ID}x`])('un id che non è un uuid («%s») non parte nemmeno', async (id) => {
    render(<SchedaAlunnoLettura alunnoId={id} />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('500 ⇒ errore con «Riprova», che ricarica davvero', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockResolvedValueOnce(risposta(200, SCHEDA))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    fireEvent.click(await screen.findByRole('button', { name: T.anagraficaRiprova }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', stato: 500 }))
  })

  it('caricamento ed esito stanno nella STESSA regione `aria-live`, montata da prima', async () => {
    const risposta500 = differita()
    fetchMock.mockReturnValue(risposta500.promessa)
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    const regione = regioneAnnunci(screen.getByText(T.anagraficaCaricamento))
    expect(regione).not.toBeNull()
    await act(async () => {
      risposta500.risolvi(risposta(500, {}))
    })
    expect(regioneAnnunci(await screen.findByText(T.anagraficaErroreLettura))).toBe(regione)
  })

  it('dopo «Riprova» il fuoco va sulla regione degli annunci, non su <body>', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockReturnValueOnce(differita().promessa)
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    fireEvent.click(await screen.findByRole('button', { name: T.anagraficaRiprova }))
    const regione = regioneAnnunci(await screen.findByText(T.anagraficaCaricamento)) as HTMLElement
    expect(document.activeElement).toBe(regione)
    expect(regione.getAttribute('tabindex')).toBe('-1')
  })

  it('senza rete ⇒ «Serve la connessione»', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreOffline)).toBeTruthy()
    expect(screen.getByRole('button', { name: T.anagraficaRiprova })).toBeTruthy()
  })

  it('rete giù ma «online» ⇒ errore, con un log `error`', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreLettura)).toBeTruthy()
    await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' })))
  })
})

describe('SchedaAlunnoLettura — gare fra un bambino e l’altro', () => {
  it('la risposta del bambino di prima, arrivata DOPO il cambio di id, non sovrascrive quella nuova', async () => {
    const prima = differita()
    fetchMock.mockImplementation((url: string) =>
      url.endsWith(ID) ? prima.promessa : Promise.resolve(risposta(200, SCHEDA2)),
    )
    const { rerender } = render(<SchedaAlunnoLettura alunnoId={ID} />)
    rerender(<SchedaAlunnoLettura alunnoId={ID2} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Baleno-E2E Bruno' })).toBeTruthy()
    await act(async () => {
      prima.risolvi(risposta(200, SCHEDA))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Baleno-E2E Bruno' })).toBeTruthy()
  })

  it('cambiando bambino, la scheda vecchia non resta a schermo mentre arriva quella nuova', async () => {
    const seconda = differita()
    fetchMock.mockImplementation((url: string) =>
      url.endsWith(ID) ? Promise.resolve(risposta(200, SCHEDA)) : seconda.promessa,
    )
    const { rerender } = render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })
    rerender(<SchedaAlunnoLettura alunnoId={ID2} />)
    expect(screen.queryByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeNull()
    expect(screen.queryByText('TSTRCB22D50Z999Q')).toBeNull()
    expect(screen.getByText(T.anagraficaCaricamento)).toBeTruthy()
    await act(async () => {
      seconda.risolvi(risposta(200, SCHEDA2))
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Baleno-E2E Bruno' })).toBeTruthy()
  })
})
