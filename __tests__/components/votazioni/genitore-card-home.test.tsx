import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'

import { VotazioniCard } from '@/components/features/parent/home/VotazioniCard'
import type { SchedaGenitore, SchedeGenitoreRisposta } from '@/lib/votazioni/tipi'

// =============================================================================
// LA CARD IN HOME (Task 8) — compare SOLO quando c'è qualcosa da votare.
//
// Non rende NIENTE se `disponibile` è falso, se le schede sono 0 o se c'è un errore: una home che
// mostra un riquadro vuoto a ogni famiglia, ogni giorno, insegna a non guardarlo.
//
// 🔴 LA TRAPPOLA DI QUESTO FILE: «la card non c'è» è vero anche mentre la fetch è ancora in volo.
// Per provare un'assenza si aspetta PRIMA che la fetch sia stata chiamata E che il suo corpo sia
// stato letto, poi si lascia girare la coda dei microtask, e solo dopo si guarda. Il controllo
// positivo (2 schede → la card c'è) sta accanto per dimostrare che l'assenza non è un test cieco.
// =============================================================================

afterEach(cleanup)

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HREF = '/parent/votazioni?userId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function scheda(n: number, extra: Partial<SchedaGenitore> = {}): SchedaGenitore {
  return {
    votazioneId: uuid(10 + n),
    titolo: 'TEST Elezione',
    scadenza: '2026-11-20T17:00:00.000Z',
    ambito: 'classe',
    sectionId: uuid(20 + n),
    classeNome: `TEST CLASSE ${n}`,
    sedeNome: 'TEST Sede Nord',
    candidati: [{ utenteId: uuid(1), nome: 'TEST Alfa' }],
    sceltaAttuale: null,
    ...extra,
  }
}

const fetchOriginale = globalThis.fetch
type Chiamata = [string, RequestInit | undefined]

/**
 * Una fetch finta che segna QUANDO il corpo è stato letto: è il segnale che la risposta è stata
 * consegnata al componente, e che da lì in poi restano solo i microtask di React.
 */
function fetchFinta(esito: { stato?: number; corpo?: unknown; rigetta?: boolean }) {
  const stato = { chiamata: false, corpoLetto: false }
  const finta = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    stato.chiamata = true
    if (esito.rigetta) throw new TypeError('Failed to fetch')
    const codice = esito.stato ?? 200
    return {
      ok: codice >= 200 && codice < 300,
      status: codice,
      json: async () => {
        stato.corpoLetto = true
        return esito.corpo
      },
    } as unknown as Response
  })
  globalThis.fetch = finta as unknown as typeof globalThis.fetch
  return { finta, stato }
}

/** Lascia girare la coda dei microtask E un giro di macrotask, dentro `act`. */
const assesta = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

/** Aspetta che la fetch sia stata consegnata (o rigettata) e che React abbia smaltito tutto. */
async function aspettaLettura(stato: { chiamata: boolean; corpoLetto: boolean }, conCorpo: boolean) {
  await waitFor(() => expect(stato.chiamata).toBe(true))
  if (conCorpo) await waitFor(() => expect(stato.corpoLetto).toBe(true))
  await assesta()
}

beforeEach(() => {
  globalThis.fetch = fetchOriginale
})
afterEach(() => {
  globalThis.fetch = fetchOriginale
})

const monta = () => render(<VotazioniCard parentId={PARENT} href={HREF} />)

describe('VotazioniCard · quando compare', () => {
  it('con 2 schede: titolo, «2 schede, scadenza …» e il link', async () => {
    fetchFinta({ corpo: { disponibile: true, schede: [scheda(1), scheda(2)] } satisfies SchedeGenitoreRisposta })
    monta()

    expect(await screen.findByText('Votazioni aperte')).toBeInTheDocument()
    // 17:00 UTC di novembre = 18:00 a Roma.
    expect(screen.getByText('2 schede, scadenza 20/11/2026, 18:00')).toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', HREF)
    expect(link).toHaveTextContent('Votazioni aperte')
  })

  it('con 1 scheda il plurale si accorda: «1 scheda», non «1 schede»', async () => {
    fetchFinta({ corpo: { disponibile: true, schede: [scheda(1)] } satisfies SchedeGenitoreRisposta })
    monta()
    expect(await screen.findByText('1 scheda, scadenza 20/11/2026, 18:00')).toBeInTheDocument()
  })

  it('la scadenza mostrata è la PIÙ VICINA fra le schede, comunque siano ordinate', async () => {
    fetchFinta({
      corpo: {
        disponibile: true,
        schede: [
          scheda(1, { scadenza: '2026-12-20T17:00:00.000Z' }),
          scheda(2, { scadenza: '2026-11-18T17:00:00.000Z' }),
          scheda(3, { scadenza: '2026-11-30T17:00:00.000Z' }),
        ],
      } satisfies SchedeGenitoreRisposta,
    })
    monta()
    expect(await screen.findByText('3 schede, scadenza 18/11/2026, 18:00')).toBeInTheDocument()
  })

  it('la scadenza è in ora di Roma: 22:30 UTC d’estate sono le 00:30 del giorno dopo', async () => {
    fetchFinta({
      corpo: { disponibile: true, schede: [scheda(1, { scadenza: '2026-07-15T22:30:00.000Z' })] } satisfies SchedeGenitoreRisposta,
    })
    monta()
    // Nel fuso del processo (UTC) uscirebbe «15/07/2026, 22:30».
    expect(await screen.findByText('1 scheda, scadenza 16/07/2026, 00:30')).toBeInTheDocument()
  })

  it('la fetch è una GET su /api/parent/votazioni con l’identità nell’header', async () => {
    const { finta } = fetchFinta({ corpo: { disponibile: true, schede: [scheda(1)] } satisfies SchedeGenitoreRisposta })
    monta()
    await screen.findByText('Votazioni aperte')

    expect(finta).toHaveBeenCalledTimes(1)
    const [url, init] = finta.mock.calls[0] as unknown as Chiamata
    expect(url).toBe('/api/parent/votazioni')
    expect(init?.headers).toMatchObject({ 'x-user-id': PARENT })
    expect(init?.method ?? 'GET').toBe('GET')
  })
})

describe('VotazioniCard · quando NON compare', () => {
  it('🔴 0 schede: non rende niente (e il controllo positivo sta nel test sopra)', async () => {
    const { stato } = fetchFinta({ corpo: { disponibile: true, schede: [] } satisfies SchedeGenitoreRisposta })
    const { container } = monta()

    await aspettaLettura(stato, true)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Votazioni aperte')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('🔴 disponibile: false (schema assente o DB non migrato): non rende niente', async () => {
    const { stato } = fetchFinta({ corpo: { disponibile: false, schede: [] } satisfies SchedeGenitoreRisposta })
    const { container } = monta()

    await aspettaLettura(stato, true)
    expect(container).toBeEmptyDOMElement()
  })

  it('🔴 disponibile: false anche se il corpo portasse delle schede: vince il «non disponibile»', async () => {
    const { stato } = fetchFinta({ corpo: { disponibile: false, schede: [scheda(1)] } satisfies SchedeGenitoreRisposta })
    const { container } = monta()

    await aspettaLettura(stato, true)
    expect(container).toBeEmptyDOMElement()
  })

  it('🔴 errore del server (500): non rende niente, e non mostra l’errore sulla home', async () => {
    const { stato } = fetchFinta({ stato: 500, corpo: { error: 'boom', codice: 'VOTAZIONE_OPERAZIONE_NON_RIUSCITA' } })
    const { container } = monta()

    await aspettaLettura(stato, false)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('🔴 rete caduta (la fetch rigetta): non rende niente', async () => {
    const { stato } = fetchFinta({ rigetta: true })
    const { container } = monta()

    await aspettaLettura(stato, false)
    expect(container).toBeEmptyDOMElement()
  })

  it('un corpo che non ha la forma del contratto non rompe la home', async () => {
    const { stato } = fetchFinta({ corpo: { qualcosaDiAltro: true } })
    const { container } = monta()

    await aspettaLettura(stato, true)
    expect(container).toBeEmptyDOMElement()
  })
})
