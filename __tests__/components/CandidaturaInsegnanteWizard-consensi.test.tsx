import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itCampi from '../../messages/it/parentForms.json'
import { CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — I CONSENSI, E LA RIGA CHE IL WIZARD FRATELLO AVEVA
 * DIMENTICATO.
 *
 * ─── IL DIFETTO CHE QUESTO FILE ESISTE PER IMPEDIRE ────────────────────────
 *
 * Su `/iscrizione` ogni pezzo dei consensi funzionava: la casella si spuntava,
 * la validazione bloccava chi non l'aveva spuntata, il server archiviava la
 * prova. Quello che non funzionava era il COLLEGAMENTO fra il penultimo passo e
 * l'ultimo: `handleSubmit` costruiva il payload con i soli bambini e adulti, e
 * le spunte venivano raccolte e buttate via un istante prima dell'invio. Il
 * server rifiutava — giustamente — una domanda senza presa visione, e a schermo
 * arrivava un errore generico su un modulo che sembrava compilato.
 *
 * Nessun test di quel wizard poteva vederlo: guardavano tutti lo SCHERMO. Il
 * difetto è stato trovato dal percorso end-to-end, cioè tardi. Qui la casella si
 * spunta E si guarda il corpo della richiesta.
 *
 * ─── PERCHÉ I CONSENSI SONO DUE, E UNO SOLO È OBBLIGATORIO ─────────────────
 *
 * La base giuridica della valutazione è l'art. 6.1.b GDPR (misure
 * precontrattuali su richiesta dell'interessato): chiedere il permesso di fare
 * la cosa che la persona ci ha appena chiesto di fare sarebbe una domanda senza
 * risposta possibile, e un consenso che non si può negare non è libero. Quel che
 * serve, e che qui è obbligatorio, è la PRESA VISIONE dell'informativa
 * (art. 13). Il consenso vero — facoltativo e revocabile — è quello sulla
 * CONSERVAZIONE della candidatura oltre la selezione.
 *
 * ─── E ANCHE IL «NO» DEVE VIAGGIARE ────────────────────────────────────────
 *
 * Il consenso facoltativo non spuntato parte come `false`, non come assente:
 * dentro `consents_log` «non gliel'ho chiesto» e «ha detto no» sono due fatti
 * diversi, e il secondo è quello su cui si regge la cancellazione a valutazione
 * conclusa.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

const OBBLIGATORIO = /informativa sulla privacy/i
const FACOLTATIVO = /Conservate la mia candidatura/i

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []

/** `rispostaPost` decide come si comporta l'invio. */
function mockRete(rispostaPost?: { stato: number; corpo: unknown }): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      if (rispostaPost) {
        return Promise.resolve({
          ok: false,
          status: rispostaPost.stato,
          json: async () => rispostaPost.corpo,
        })
      }
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Arriva al passo dei consensi compilando il minimo indispensabile. */
async function vaiAiConsensi(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  corpiInviati.length = 0
  mockRete()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('CandidaturaInsegnanteWizard — i consensi', () => {
  it('il passo dei consensi ha il SUO titolo, e i due blocchi del template', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    // Il titolo del passo dice il nome di QUESTO passo. Sul wizard fratello la
    // catena di ternari non aveva il ramo dei consensi e cadeva su quello
    // finale: la schermata su cui si presta un consenso si annunciava
    // «Riepilogo», ed è la prima cosa che uno screen reader legge arrivandoci.
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candConsensiTitolo })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: itPublic.candRiepilogo })).not.toBeInTheDocument()

    expect(CONSENSI_INSEGNANTI_FIELDS).toHaveLength(2)
    expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: FACOLTATIVO })).toBeInTheDocument()
  })

  it('IL CONSENSO OBBLIGATORIO BLOCCA: senza la presa visione non si arriva al riepilogo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    expect(await screen.findByText(itCampi.devAccettare)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candRiepilogoSede)).not.toBeInTheDocument()
    expect(corpiInviati).toHaveLength(0)
  })

  it('il consenso FACOLTATIVO non blocca: da solo, l’obbligatorio basta a proseguire', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(screen.queryByText(itCampi.devAccettare)).not.toBeInTheDocument()
  })

  it('I CONSENSI ENTRANO DAVVERO NEL PAYLOAD — ed è la riga che il wizard fratello aveva dimenticato', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('checkbox', { name: FACOLTATIVO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    // Uno per uno, per id: un `expect` sul solo obbligatorio passerebbe anche
    // col facoltativo buttato via.
    for (const f of CONSENSI_INSEGNANTI_FIELDS) {
      expect(dati[f.id], `il consenso «${f.id}» non è arrivato nel corpo del POST`).toBe(true)
    }
  })

  it('il «no» viaggia come `false`, non come assente: nella prova è un fatto, non un silenzio', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    expect(dati.presa_visione_informativa).toBe(true)
    expect(dati.consenso_conservazione_candidatura).toBe(false)
    expect(Object.hasOwn(dati, 'consenso_conservazione_candidatura')).toBe(true)
  })

  it('la spunta sopravvive al giro «Avanti → Indietro»: non si perde tornando a correggere', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeChecked())
  })

  it('se il SERVER rifiuta per un consenso mancante, si torna al passo dei consensi e lo si vede', async () => {
    // La rotta risponde `400 { consensi: [id] }` senza un testo: il testo giusto
    // ce l'ha già il client, ed è lo stesso che comparirebbe se la spunta
    // mancasse qui — una seconda formulazione per lo stesso rifiuto sarebbe due
    // frasi da mantenere per una cosa sola.
    mockRete({
      stato: 400,
      corpo: {
        error: 'Per proseguire è necessario dichiarare di aver letto l’informativa sulla privacy.',
        codice: 'CANDIDATURA_NON_INVIATA',
        consensi: ['presa_visione_informativa'],
      },
    })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // Si è tornati indietro di un passo, sul campo che il server ha respinto.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument())
    expect(screen.getByText(itCampi.devAccettare)).toBeInTheDocument()
    // E la prosa italiana del server non è finita a schermo.
    expect(screen.queryByText(/dichiarare di aver letto/)).not.toBeInTheDocument()
  })
})
