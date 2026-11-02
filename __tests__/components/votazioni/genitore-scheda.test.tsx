import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { SchedaVoto } from '@/components/features/votazioni/genitore/SchedaVoto'
import type { SchedaGenitore, VotoRisposta } from '@/lib/votazioni/tipi'
import itShared from '../../../messages/it/shared.json'

// =============================================================================
// LA SCHEDA DEL GENITORE (Task 8) — una scheda sola, con la sua POST.
//
// Le API le scrive un altro agente: qui la fetch è finta e risponde con i TIPI del contratto
// (`VotoRisposta`, `{ error, codice }`). Nomi e id sono inventati: il repo è pubblico.
//
// ⚠️ Decisioni del titolare che i test sorvegliano:
//   · sulla scheda NESSUNA scritta sul fatto che la segreteria vede il voto;
//   · il genitore NON vede risultati né conteggi;
//   · il voto si può cambiare fino alla scadenza.
// =============================================================================

afterEach(cleanup)

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VOTAZIONE = '11111111-1111-4111-8111-111111111111'
const CLASSE = '22222222-2222-4222-8222-222222222222'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CAND_A = uuid(1)
const CAND_B = uuid(2)
const CAND_C = uuid(3)

function scheda(extra: Partial<SchedaGenitore> = {}): SchedaGenitore {
  return {
    votazioneId: VOTAZIONE,
    titolo: 'TEST Elezione dei rappresentanti',
    scadenza: '2026-11-20T17:00:00.000Z',
    ambito: 'classe',
    sectionId: CLASSE,
    classeNome: '3 ANNI A',
    sedeNome: 'TEST Sede Nord',
    candidati: [
      { utenteId: CAND_A, nome: 'TEST Alfa' },
      { utenteId: CAND_B, nome: 'TEST Beta' },
      { utenteId: CAND_C, nome: 'TEST Gamma' },
    ],
    sceltaAttuale: null,
    ...extra,
  }
}

/** Nove candidati: oltre gli 8 compare il campo di ricerca. */
function candidatiNumerosi(n: number): SchedaGenitore['candidati'] {
  return Array.from({ length: n }, (_, i) => ({
    utenteId: uuid(100 + i),
    nome: `TEST Genitore ${String(i + 1).padStart(2, '0')}`,
  }))
}

const fetchOriginale = globalThis.fetch
type Chiamata = [string, RequestInit | undefined]

/** Una fetch finta che risponde sempre allo stesso modo e ricorda le chiamate. */
function fetchCheRisponde(stato: number, corpo: unknown) {
  const finta = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return { ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo } as unknown as Response
  })
  globalThis.fetch = finta as unknown as typeof globalThis.fetch
  return finta
}

beforeEach(() => {
  globalThis.fetch = fetchOriginale
})
afterEach(() => {
  globalThis.fetch = fetchOriginale
})

const monta = (s: SchedaGenitore, onChiusa: (m: string) => void = () => {}) =>
  render(<SchedaVoto scheda={s} parentId={PARENT} onVotazioneChiusa={onChiusa} />)

const vota = () => screen.getByRole('button', { name: 'Vota' })

describe('SchedaVoto · scheda senza voto', () => {
  it('titolo di classe, scadenza in ora di Roma e «Vota» spento finché non si sceglie', () => {
    monta(scheda())

    expect(screen.getByRole('heading', { name: 'Rappresentante di classe — 3 ANNI A' })).toBeInTheDocument()
    // 17:00 UTC di novembre = 18:00 a Roma (ora solare).
    expect(screen.getByText('Si vota entro il 20 novembre 2026, alle 18:00')).toBeInTheDocument()
    expect(screen.queryByText(/Hai votato/)).not.toBeInTheDocument()

    expect(vota()).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    expect(vota()).toBeEnabled()
  })

  it('scheda istituto: il titolo nomina la sede, non la classe', () => {
    monta(scheda({ ambito: 'istituto', sectionId: null, classeNome: null }))
    expect(screen.getByRole('heading', { name: 'Rappresentante d’istituto — TEST Sede Nord' })).toBeInTheDocument()
  })

  it('i candidati sono un gruppo di radio che ha per nome il titolo della scheda', () => {
    monta(scheda())
    const gruppo = screen.getByRole('radiogroup', { name: 'Rappresentante di classe — 3 ANNI A' })
    expect(gruppo).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('🔴 nessuna scritta sul fatto che la segreteria vede il voto, e nessun risultato', () => {
    const { container } = monta(scheda({ sceltaAttuale: CAND_A }))
    // Decisione del titolare (02/11/2026): lo comunicano loro nell'avviso, non la scheda.
    expect(container.textContent ?? '').not.toMatch(/segreteria|segret|riservat|anonim|visibile/i)
    // Il genitore non vede risultati né conteggi: nessun «N voti» accanto ai nomi.
    expect(container.textContent ?? '').not.toMatch(/\d+\s+vot[io]\b/i)
  })
})

describe('SchedaVoto · il voto', () => {
  it('Vota: POST sull’id della votazione, con identità e senza elettore nel body', async () => {
    const finta = fetchCheRisponde(200, { ok: true, sceltaAttuale: CAND_B, cambiato: false } satisfies VotoRisposta)
    monta(scheda())

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(vota())

    expect(await screen.findByText('Voto registrato')).toBeInTheDocument()
    expect(finta).toHaveBeenCalledTimes(1)
    const [url, init] = finta.mock.calls[0] as unknown as Chiamata
    expect(url).toBe(`/api/parent/votazioni/${VOTAZIONE}/voto`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-user-id': PARENT })
    // L'elettore è sempre la sessione: nel body non c'è, e non c'è l'id dell'identità.
    expect(JSON.parse(String(init?.body))).toEqual({ ambito: 'classe', sectionId: CLASSE, candidatoId: CAND_B })

    // La riga «Hai votato» e il nuovo pulsante, spento perché la scelta è quella attuale.
    expect(screen.getByText('Hai votato: TEST Beta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Vota' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cambia voto' })).toBeDisabled()
  })

  it('scheda istituto: il body porta ambito «istituto» e sectionId nullo', async () => {
    const finta = fetchCheRisponde(200, { ok: true, sceltaAttuale: CAND_C, cambiato: false } satisfies VotoRisposta)
    monta(scheda({ ambito: 'istituto', sectionId: null, classeNome: null }))

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Gamma' }))
    fireEvent.click(vota())

    expect(await screen.findByText('Voto registrato')).toBeInTheDocument()
    const [, init] = finta.mock.calls[0] as unknown as Chiamata
    expect(JSON.parse(String(init?.body))).toEqual({ ambito: 'istituto', sectionId: null, candidatoId: CAND_C })
  })

  it('con un voto già dato: «Hai votato», «Cambia voto» spento sulla stessa scelta', () => {
    monta(scheda({ sceltaAttuale: CAND_A }))

    expect(screen.getByText('Hai votato: TEST Alfa')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'TEST Alfa' })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Vota' })).not.toBeInTheDocument()
    const cambia = screen.getByRole('button', { name: 'Cambia voto' })
    expect(cambia).toBeDisabled()

    // Scegliere un altro la accende; tornare sulla scelta attuale la rispegne.
    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    expect(cambia).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: 'TEST Alfa' }))
    expect(cambia).toBeDisabled()
  })

  it('Cambia voto: POST col nuovo candidato, poi «Hai votato» mostra il nuovo nome', async () => {
    const finta = fetchCheRisponde(200, { ok: true, sceltaAttuale: CAND_B, cambiato: true } satisfies VotoRisposta)
    monta(scheda({ sceltaAttuale: CAND_A }))

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cambia voto' }))

    expect(await screen.findByText('Hai votato: TEST Beta')).toBeInTheDocument()
    expect(screen.queryByText('Hai votato: TEST Alfa')).not.toBeInTheDocument()
    expect(screen.getByText('Voto registrato')).toBeInTheDocument()
    const [, init] = finta.mock.calls[0] as unknown as Chiamata
    expect(JSON.parse(String(init?.body)).candidatoId).toBe(CAND_B)
    expect(screen.getByRole('button', { name: 'Cambia voto' })).toBeDisabled()
  })

  it('un voto dato a un genitore che non è più in elenco non mostra un nome vuoto', () => {
    monta(scheda({ sceltaAttuale: uuid(999) }))
    expect(screen.getByText('Hai già votato un genitore che ora non è più nell’elenco.')).toBeInTheDocument()
    expect(screen.queryByText(/Hai votato:/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cambia voto' })).toBeDisabled()
  })
})

describe('SchedaVoto · la ricerca', () => {
  it('oltre 8 candidati compare «Cerca un genitore» e filtra', () => {
    monta(scheda({ candidati: candidatiNumerosi(9) }))

    const campo = screen.getByRole('searchbox', { name: 'Cerca un genitore' })
    expect(screen.getAllByRole('radio')).toHaveLength(9)

    fireEvent.change(campo, { target: { value: 'genitore 07' } })
    const rimasti = screen.getAllByRole('radio')
    expect(rimasti).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'TEST Genitore 07' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'TEST Genitore 01' })).not.toBeInTheDocument()

    // Svuotare il campo li riporta tutti.
    fireEvent.change(campo, { target: { value: '' } })
    expect(screen.getAllByRole('radio')).toHaveLength(9)
  })

  it('la ricerca ignora maiuscole e accenti', () => {
    monta(scheda({
      candidati: [
        ...candidatiNumerosi(8),
        { utenteId: uuid(500), nome: 'TEST Dall’Èra Zeno' },
      ],
    }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca un genitore' }), { target: { value: 'dall era' } })
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'TEST Dall’Èra Zeno' })).toBeInTheDocument()
  })

  it('nessuna corrispondenza: lo dice, invece di lasciare un vuoto', () => {
    monta(scheda({ candidati: candidatiNumerosi(9) }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca un genitore' }), { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText('Nessun genitore corrisponde alla ricerca.')).toBeInTheDocument()
  })

  it('fino a 8 candidati il campo non c’è', () => {
    monta(scheda({ candidati: candidatiNumerosi(8) }))
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })
})

describe('SchedaVoto · gli errori', () => {
  it('🔴 409 VOTAZIONE_CHIUSA: passa il messaggio tradotto al contenitore, che ricarica', async () => {
    fetchCheRisponde(409, { error: 'prosa del server, non si mostra', codice: 'VOTAZIONE_CHIUSA' })
    const onChiusa = vi.fn()
    monta(scheda(), onChiusa)

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(vota())

    await waitFor(() => expect(onChiusa).toHaveBeenCalledTimes(1))
    expect(onChiusa).toHaveBeenCalledWith(itShared.erroreVotazioneChiusa)
    // Non si dice «registrato» a chi non lo è, e la prosa del server non esce mai.
    expect(screen.queryByText('Voto registrato')).not.toBeInTheDocument()
    expect(screen.queryByText('prosa del server, non si mostra')).not.toBeInTheDocument()
    // Una scheda chiusa non si può più inviare: il pulsante resta spento fino alla ricarica.
    expect(vota()).toBeDisabled()
  })

  it('un altro rifiuto col codice dichiarato: frase di catalogo nella scheda, scelta invariata', async () => {
    fetchCheRisponde(400, { error: 'prosa del server', codice: 'VOTAZIONE_CANDIDATO_NON_VALIDO' })
    const onChiusa = vi.fn()
    monta(scheda({ sceltaAttuale: CAND_A }), onChiusa)

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cambia voto' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.erroreVotazioneCandidatoNonValido)
    expect(screen.queryByText('prosa del server')).not.toBeInTheDocument()
    expect(onChiusa).not.toHaveBeenCalled()
    // Il voto che c'era è ancora quello, e si può riprovare.
    expect(screen.getByText('Hai votato: TEST Alfa')).toBeInTheDocument()
    expect(screen.queryByText('Voto registrato')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cambia voto' })).toBeEnabled()
  })

  it('senza codice (500 muto): la frase generica del componente, mai la prosa', async () => {
    fetchCheRisponde(500, { error: 'duplicate key value violates unique constraint' })
    monta(scheda())

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(vota())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Non siamo riusciti a registrare il voto. Riprova.')
    expect(screen.queryByText(/duplicate key/)).not.toBeInTheDocument()
    expect(vota()).toBeEnabled()
  })

  it('rete caduta (la fetch rigetta): stessa frase generica, nessuna eccezione a schermo', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof globalThis.fetch
    monta(scheda())

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(vota())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Non siamo riusciti a registrare il voto. Riprova.')
    expect(screen.queryByText('Voto registrato')).not.toBeInTheDocument()
  })

  it('un secondo clic mentre il primo è in volo non manda una seconda POST', async () => {
    let sblocca: (r: Response) => void = () => {}
    const finta = vi.fn(
      () => new Promise<Response>((risolvi) => {
        sblocca = risolvi
      }),
    )
    globalThis.fetch = finta as unknown as typeof globalThis.fetch
    monta(scheda())

    fireEvent.click(screen.getByRole('radio', { name: 'TEST Beta' }))
    fireEvent.click(vota())
    fireEvent.click(screen.getByRole('button', { name: 'Invio in corso…' }))
    expect(finta).toHaveBeenCalledTimes(1)

    sblocca({ ok: true, status: 200, json: async () => ({ ok: true, sceltaAttuale: CAND_B, cambiato: false }) } as unknown as Response)
    expect(await screen.findByText('Voto registrato')).toBeInTheDocument()
  })
})

describe('SchedaVoto · la scadenza è in ora di Roma, in ogni stagione', () => {
  it('ora legale: 22:30 UTC di luglio sono le 00:30 del giorno DOPO a Roma', () => {
    // Se la data si leggesse nel fuso del processo (UTC) qui uscirebbe «15 luglio».
    monta(scheda({ scadenza: '2026-07-15T22:30:00.000Z' }))
    expect(screen.getByText('Si vota entro il 16 luglio 2026, alle 00:30')).toBeInTheDocument()
  })

  it('ora solare: 23:30 UTC di dicembre sono le 00:30 del giorno dopo', () => {
    monta(scheda({ scadenza: '2026-12-10T23:30:00.000Z' }))
    expect(screen.getByText('Si vota entro il 11 dicembre 2026, alle 00:30')).toBeInTheDocument()
  })
})
