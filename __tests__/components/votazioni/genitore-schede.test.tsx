import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { SchedeVotazione } from '@/components/features/votazioni/genitore/SchedeVotazione'
import type { SchedaGenitore, SchedeGenitoreRisposta, VotoRisposta } from '@/lib/votazioni/tipi'
import itShared from '../../../messages/it/shared.json'

// =============================================================================
// L'ELENCO DELLE SCHEDE (Task 8) — la pagina senza il guscio dell'identità.
//
// La fetch è finta e risponde con i TIPI del contratto (`SchedeGenitoreRisposta`, `VotoRisposta`,
// `{ error, codice }`). Il 409 «VOTAZIONE_CHIUSA» è il Review Focus 3 del piano: pagina aperta oltre
// la scadenza → il voto risponde 409, la UI lo dice, ricarica le schede e la scheda sparisce.
//
// ⚠️ Un `waitFor` su un'ASSENZA passa prima che i dati arrivino: dove si prova che qualcosa NON
// c'è, si aspetta prima la PRESENZA di qualcosa che arriva solo a lettura finita.
// =============================================================================

afterEach(cleanup)

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VOT_1 = '11111111-1111-4111-8111-111111111111'
const VOT_2 = '33333333-3333-4333-8333-333333333333'
const CLASSE_A = '22222222-2222-4222-8222-22222222222a'
const CLASSE_B = '22222222-2222-4222-8222-22222222222b'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function scheda(extra: Partial<SchedaGenitore> = {}): SchedaGenitore {
  return {
    votazioneId: VOT_1,
    titolo: 'TEST Elezione dei rappresentanti',
    scadenza: '2026-11-20T17:00:00.000Z',
    ambito: 'classe',
    sectionId: CLASSE_A,
    classeNome: '3 ANNI A',
    sedeNome: 'TEST Sede Nord',
    candidati: [
      { utenteId: uuid(1), nome: 'TEST Alfa' },
      { utenteId: uuid(2), nome: 'TEST Beta' },
    ],
    sceltaAttuale: null,
    ...extra,
  }
}

const TITOLO_CLASSE_A = 'Rappresentante di classe — 3 ANNI A'
const TITOLO_CLASSE_B = 'Rappresentante di classe — 4 ANNI B'
const TITOLO_ISTITUTO = 'Rappresentante d’istituto — TEST Sede Nord'

const fetchOriginale = globalThis.fetch
type Chiamata = [string, RequestInit | undefined]

function risposta(stato: number, corpo: unknown): Response {
  return { ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo } as unknown as Response
}

/**
 * Una fetch finta con le due strade della pagina: la GET dell'elenco (una risposta per ogni
 * chiamata, l'ultima si ripete) e la POST del voto.
 */
function fetchPagina(opzioni: {
  elenchi: Array<SchedeGenitoreRisposta | Response | Error>
  voto?: Response
}) {
  let nGet = 0
  const finta = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      return opzioni.voto ?? risposta(200, { ok: true, sceltaAttuale: uuid(2), cambiato: false } satisfies VotoRisposta)
    }
    expect(url).toBe('/api/parent/votazioni')
    const voce = opzioni.elenchi[Math.min(nGet, opzioni.elenchi.length - 1)]
    nGet++
    if (voce instanceof Error) throw voce
    return voce instanceof Object && 'ok' in voce && 'status' in voce ? (voce as Response) : risposta(200, voce)
  })
  globalThis.fetch = finta as unknown as typeof globalThis.fetch
  return finta
}

const chiamateGet = (finta: ReturnType<typeof fetchPagina>) =>
  finta.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST')

beforeEach(() => {
  globalThis.fetch = fetchOriginale
})
afterEach(() => {
  globalThis.fetch = fetchOriginale
})

const monta = () => render(<SchedeVotazione parentId={PARENT} />)

describe('SchedeVotazione · caricamento e stati', () => {
  it('mentre la GET è in volo dice che sta caricando; arrivati i dati mostra le schede', async () => {
    let consegna: (r: Response) => void = () => {}
    const finta = vi.fn(() => new Promise<Response>((risolvi) => {
      consegna = risolvi
    }))
    globalThis.fetch = finta as unknown as typeof globalThis.fetch
    monta()

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento delle votazioni…')
    expect(screen.queryByText(TITOLO_CLASSE_A)).not.toBeInTheDocument()

    consegna(risposta(200, { disponibile: true, schede: [scheda()] } satisfies SchedeGenitoreRisposta))
    expect(await screen.findByText(TITOLO_CLASSE_A)).toBeInTheDocument()
    expect(screen.queryByText('Caricamento delle votazioni…')).not.toBeInTheDocument()
  })

  it('la GET porta l’identità del genitore nell’header', async () => {
    const finta = fetchPagina({ elenchi: [{ disponibile: true, schede: [scheda()] }] })
    monta()
    await screen.findByText(TITOLO_CLASSE_A)

    expect(finta).toHaveBeenCalledTimes(1)
    const [url, init] = finta.mock.calls[0] as unknown as Chiamata
    expect(url).toBe('/api/parent/votazioni')
    expect(init?.headers).toMatchObject({ 'x-user-id': PARENT })
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('classe e istituto: una scheda ciascuna, nell’ordine del server', async () => {
    fetchPagina({
      elenchi: [{
        disponibile: true,
        schede: [
          scheda({ sectionId: CLASSE_A, classeNome: '3 ANNI A' }),
          scheda({ sectionId: CLASSE_B, classeNome: '4 ANNI B' }),
          scheda({ ambito: 'istituto', sectionId: null, classeNome: null }),
        ],
      }],
    })
    monta()

    const titoli = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent)
    expect(titoli).toEqual([TITOLO_CLASSE_A, TITOLO_CLASSE_B, TITOLO_ISTITUTO])
  })

  it('🔴 disponibile: false → «Non ci sono votazioni aperte», anche se arrivasse una scheda', async () => {
    // Il contratto dice `schede: []` quando `disponibile` è falso; la scheda qui dentro è la cintura:
    // se la UI guardasse solo l'elenco, mostrerebbe una scheda che il server ha dichiarato assente.
    fetchPagina({ elenchi: [{ disponibile: false, schede: [scheda()] }] })
    monta()
    expect(await screen.findByText('Non ci sono votazioni aperte')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: /Rappresentante/ })).not.toBeInTheDocument()
  })

  it('nessuna scheda → «Non ci sono votazioni aperte»', async () => {
    fetchPagina({ elenchi: [{ disponibile: true, schede: [] }] })
    monta()
    expect(await screen.findByText('Non ci sono votazioni aperte')).toBeInTheDocument()
    expect(screen.getByText('Quando la scuola aprirà una votazione, la troverai qui.')).toBeInTheDocument()
  })

  it('errore dichiarato (503): frase di catalogo dal codice, mai la prosa; «Riprova» rilegge', async () => {
    const finta = fetchPagina({
      elenchi: [
        risposta(503, { error: 'prosa italiana del server', codice: 'VOTAZIONI_NON_DISPONIBILI' }),
        { disponibile: true, schede: [scheda()] },
      ],
    })
    monta()

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.erroreVotazioniNonDisponibili)
    expect(screen.queryByText('prosa italiana del server')).not.toBeInTheDocument()
    expect(screen.queryByText('Non ci sono votazioni aperte')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText(TITOLO_CLASSE_A)).toBeInTheDocument()
    expect(chiamateGet(finta)).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('errore senza codice: la frase generica del componente', async () => {
    fetchPagina({ elenchi: [risposta(500, { error: 'relation "votazioni" does not exist' })] })
    monta()
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Non siamo riusciti a caricare le votazioni.')
    expect(screen.queryByText(/does not exist/)).not.toBeInTheDocument()
  })

  it('rete caduta: la frase generica, non una schermata vuota', async () => {
    fetchPagina({ elenchi: [new TypeError('Failed to fetch')] })
    monta()
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Non siamo riusciti a caricare le votazioni.')
  })
})

describe('SchedeVotazione · il voto dentro la pagina', () => {
  it('il voto va sull’id della votazione della scheda votata, non su quello della prima', async () => {
    const finta = fetchPagina({
      elenchi: [{
        disponibile: true,
        schede: [
          scheda({ votazioneId: VOT_1, sectionId: CLASSE_A, classeNome: '3 ANNI A' }),
          scheda({ votazioneId: VOT_2, sectionId: CLASSE_B, classeNome: '4 ANNI B' }),
        ],
      }],
    })
    monta()
    const gruppoB = await screen.findByRole('radiogroup', { name: TITOLO_CLASSE_B })
    const radioB = gruppoB.querySelector('input[type="radio"]') as HTMLInputElement
    fireEvent.click(radioB)
    // Il pulsante «Vota» della SECONDA scheda: ce ne sono due, quello giusto è nella sua sezione.
    const sezioneB = gruppoB.closest('section') as HTMLElement
    fireEvent.click(sezioneB.querySelector('button') as HTMLButtonElement)

    await screen.findByText('Voto registrato')
    const post = finta.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST') as unknown as Chiamata
    expect(post[0]).toBe(`/api/parent/votazioni/${VOT_2}/voto`)
    expect(JSON.parse(String(post[1]?.body)).sectionId).toBe(CLASSE_B)
    // L'altra scheda non è stata toccata: un solo «Voto registrato», una sola riga «Hai votato».
    expect(screen.getAllByText('Voto registrato')).toHaveLength(1)
    expect(screen.getAllByText(/^Hai votato:/)).toHaveLength(1)
  })

  it('🔴 409 VOTAZIONE_CHIUSA (Review Focus 3): lo dice, ricarica, la scheda sparisce', async () => {
    const finta = fetchPagina({
      elenchi: [
        { disponibile: true, schede: [scheda()] },
        // La seconda lettura arriva DOPO la scadenza: la votazione non è più aperta.
        { disponibile: true, schede: [] },
      ],
      voto: risposta(409, { error: 'La votazione è chiusa', codice: 'VOTAZIONE_CHIUSA' }),
    })
    monta()

    fireEvent.click(await screen.findByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vota' }))

    // Si aspetta la PRESENZA dello stato «nessuna votazione», che esiste solo a ricarica fatta:
    // «la scheda non c'è» sarebbe vero anche prima, con la POST ancora in volo.
    expect(await screen.findByText('Non ci sono votazioni aperte')).toBeInTheDocument()
    expect(chiamateGet(finta)).toHaveLength(2)
    expect(screen.queryByText(TITOLO_CLASSE_A)).not.toBeInTheDocument()
    // Il messaggio sopravvive alla scheda che lo ha provocato: è del contenitore, non della scheda.
    expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreVotazioneChiusa)
  })

  it('409 con altre schede ancora aperte: quella chiusa sparisce, le altre restano', async () => {
    fetchPagina({
      elenchi: [
        {
          disponibile: true,
          schede: [
            scheda({ votazioneId: VOT_1, sectionId: CLASSE_A, classeNome: '3 ANNI A' }),
            scheda({ votazioneId: VOT_2, sectionId: CLASSE_B, classeNome: '4 ANNI B' }),
          ],
        },
        { disponibile: true, schede: [scheda({ votazioneId: VOT_2, sectionId: CLASSE_B, classeNome: '4 ANNI B' })] },
      ],
      voto: risposta(409, { error: 'x', codice: 'VOTAZIONE_CHIUSA' }),
    })
    monta()

    const gruppoA = await screen.findByRole('radiogroup', { name: TITOLO_CLASSE_A })
    fireEvent.click(gruppoA.querySelector('input[type="radio"]') as HTMLInputElement)
    fireEvent.click((gruppoA.closest('section') as HTMLElement).querySelector('button') as HTMLButtonElement)

    await waitFor(() => expect(screen.queryByText(TITOLO_CLASSE_A)).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: TITOLO_CLASSE_B })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreVotazioneChiusa)
  })

  it('un voto riuscito NON ricarica l’elenco: la scheda aggiorna da sé la sua riga', async () => {
    const finta = fetchPagina({ elenchi: [{ disponibile: true, schede: [scheda()] }] })
    monta()

    fireEvent.click(await screen.findByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vota' }))

    expect(await screen.findByText('Hai votato: TEST Beta')).toBeInTheDocument()
    expect(chiamateGet(finta)).toHaveLength(1)
  })
})
