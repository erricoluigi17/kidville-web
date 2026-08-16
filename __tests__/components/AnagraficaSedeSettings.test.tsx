import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itSettings from '../../messages/it/adminSettings.json'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// IL CAMPO CHE UN MESSAGGIO D'ERRORE PROMETTEVA E CHE NON ESISTEVA.
//
// I prestampati firmati dalla Scuola rifiutano di uscire dicendo «aggiungilo
// nelle impostazioni della sede». Fino al 2026-08-15 quella frase mandava in una
// schermata che non c'era: `zAnagraficaSede` non conosceva
// `legale_rappresentante`, nessun form lo raccoglieva, e siccome la
// normalizzazione RICOSTRUISCE l'oggetto dai soli campi noti, scriverlo a mano
// nel database non serviva — il primo salvataggio lo cancellava.
//
// Questi casi tengono ferme le tre cose che lo impediscono: il campo esiste, il
// suo valore parte davvero nel PATCH, e quello che il server risponde vince su
// quello che si è digitato.
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'

import { AnagraficaSedeSettings } from '@/components/features/admin/settings/AnagraficaSedeSettings'

/** La riga di `scuole` che il GET restituisce. */
let riga: Record<string, unknown> = {}
let rispostaPatch: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  riga = { id: SEDE_A, nome: 'Kidville Giugliano', citta: 'Giugliano in Campania', indirizzo: 'Via Roma 1', attiva: true, config: { anagrafica: { email: 'giugliano@kidville.it' } } }
  rispostaPatch = { ok: true, status: 200, body: { id: SEDE_A, nome: 'Kidville Giugliano', citta: 'Giugliano in Campania', indirizzo: 'Via Roma 1', config: { anagrafica: { legale_rappresentante: 'Errico Cesario', provincia: 'NA' } } } }
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') {
      return Promise.resolve({ ok: rispostaPatch.ok, status: rispostaPatch.status, json: async () => rispostaPatch.body })
    }
    if (String(url).includes('/api/admin/schools')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => [riga] })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

/** L'ultimo corpo inviato in PATCH. */
function ultimoPatch(): Record<string, unknown> | null {
  const chiamate = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  const ultima = chiamate[chiamate.length - 1]
  return ultima ? JSON.parse(String(ultima[1].body)) : null
}

describe('Impostazioni → Sede: il legale rappresentante ha finalmente un campo', () => {
  it('il campo esiste, e con lui gli estremi dell’autorizzazione al nido', async () => {
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    expect(await screen.findByLabelText(itSettings.scLegaleRappresentante)).toBeInTheDocument()
    for (const etichetta of [itSettings.scAutNumero, itSettings.scAutData, itSettings.scAutEnte]) {
      expect(screen.getByLabelText(etichetta)).toBeInTheDocument()
    }
  })

  it('quello che si digita parte davvero nel PATCH, insieme a ciò che c’era già', async () => {
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    const campo = await screen.findByLabelText(itSettings.scLegaleRappresentante)
    fireEvent.change(campo, { target: { value: 'Errico Cesario' } })
    fireEvent.change(screen.getByLabelText(itSettings.scAutNumero), { target: { value: '77/2024' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

    await waitFor(() => expect(ultimoPatch()).not.toBeNull())
    const corpo = ultimoPatch() as { id: string; anagrafica: Record<string, unknown> }
    expect(corpo.id).toBe(SEDE_A)
    expect(corpo.anagrafica.legale_rappresentante).toBe('Errico Cesario')
    expect(corpo.anagrafica.autorizzazione_nido).toMatchObject({ numero: '77/2024' })
    // L'email era già in configurazione e non si tocca: un form che rimanda solo
    // i campi che ha visto cancella in silenzio quelli che non mostra.
    expect(corpo.anagrafica.email).toBe('giugliano@kidville.it')
  })

  it('dopo il salvataggio si mostra ciò che il SERVER ha scritto, non ciò che si è digitato', async () => {
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    const provincia = await screen.findByLabelText(itSettings.scProvincia)
    fireEvent.change(provincia, { target: { value: 'na' } })
    // Questa riga non è di contorno: la prima versione del pannello rieseguiva
    // il GET a ogni render (la funzione di caricamento dipendeva da `t`) e
    // riscriveva sopra ciò che si stava digitando. Qui il valore digitato deve
    // essere ancora suo.
    expect((screen.getByLabelText(itSettings.scProvincia) as HTMLInputElement).value).toBe('na')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

    // Il server normalizza la sigla in maiuscolo: se il form restasse sulla
    // propria versione, mostrerebbe salvato un valore diverso da quello salvato.
    await waitFor(() => expect((screen.getByLabelText(itSettings.scProvincia) as HTMLInputElement).value).toBe('NA'))
    expect(await screen.findByText(itSettings.salvato)).toBeInTheDocument()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // L'ETICHETTA CHE CONTRADDICEVA IL DOCUMENTO
  //
  // Il terzo campo dell'autorizzazione chiedeva «Comune che l'ha rilasciata»,
  // sotto un titolo che diceva «Autorizzazione comunale al nido». Per due sedi su
  // tre la risposta giusta NON è un comune: è un Ambito socio-sanitario (spec
  // §2.1), e i valori corretti finiti in archivio il 2026-08-16 ci sono NONOSTANTE
  // l'etichetta, non grazie a essa. Alla prima ricompilazione l'etichetta vince
  // sulla decisione e il difetto torna, sul foglio che va all'INPS.
  // ───────────────────────────────────────────────────────────────────────────
  it('il campo chiede un ENTE, non un Comune, e accetta un Ambito socio-sanitario', async () => {
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    const campo = await screen.findByLabelText(itSettings.scAutEnte)
    expect(itSettings.scAutEnte).toMatch(/ambito socio-sanitario/i)
    expect(itSettings.scAutorizzazioneNido).not.toMatch(/comunale/i)

    fireEvent.change(campo, { target: { value: 'Ambito Socio-Sanitario C06 — Comune capofila Aversa' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))
    await waitFor(() => expect(ultimoPatch()).not.toBeNull())
    const corpo = ultimoPatch() as { anagrafica: { autorizzazione_nido: Record<string, unknown> } }
    expect(corpo.anagrafica.autorizzazione_nido.ente).toBe('Ambito Socio-Sanitario C06 — Comune capofila Aversa')
  })

  it('una riga salvata con la chiave vecchia mostra il suo valore, e non un campo vuoto', async () => {
    // Fra la rinomina e il primo salvataggio, le tre righe di produzione portano
    // ancora `comune`. Un form che le mostra vuote invita a ridigitare — e chi non
    // ridigita cancella, perché lo schema è lista bianca in scrittura.
    riga = {
      ...riga,
      config: { anagrafica: { autorizzazione_nido: { numero: '17', data: '2024-10-01', comune: 'Ambito Socio-Sanitario C06 — Comune capofila Aversa' } } },
    }
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    const campo = (await screen.findByLabelText(itSettings.scAutEnte)) as HTMLInputElement
    expect(campo.value).toBe('Ambito Socio-Sanitario C06 — Comune capofila Aversa')
  })

  it('a chi non è Direzione il 403 si DICE, non si nasconde', async () => {
    rispostaPatch = { ok: false, status: 403, body: { error: 'vietato' } }
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    await screen.findByLabelText(itSettings.scLegaleRappresentante)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))
    expect(await screen.findByText(itSettings.scAzioneRiservata)).toBeInTheDocument()
  })

  it('una sede fuori dallo scope non è un errore di rete, e si distingue', async () => {
    riga = { id: 'altra-sede', nome: 'Kidville Cesa', config: {} }
    render(<AnagraficaSedeSettings userId={USER} scuolaId={SEDE_A} />)
    expect(await screen.findByText(itSettings.anSedeNonInScope)).toBeInTheDocument()
  })
})
