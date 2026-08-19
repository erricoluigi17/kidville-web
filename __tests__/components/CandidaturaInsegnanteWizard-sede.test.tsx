import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { POSIZIONI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — L'ELENCO DELLE SEDI, E I TRE STATI CHE DEVONO RESTARE TRE.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE PRIMA ANCORA DEL RESTO ───────────────────────
 *
 * Perché il difetto che difende è già arrivato in produzione sul modulo
 * fratello, `/iscrizione`. Misurato il 2026-08-02: `GET /api/iscrizione/sedi`
 * rispondeva **429** (tetto 30 richieste ogni 10 minuti per IP — dietro il NAT
 * di una scuola o il CGNAT di un operatore mobile quell'IP lo condividono decine
 * di persone). Il wizard registrava il guasto e tirava dritto: `sedi` restava
 * vuoto, il passo della sede si decideva con `sedi.length`, e **un elenco vuoto
 * per errore era indistinguibile da «c'è una sede sola»**. Si compilava tutto e
 * si riceveva un 400 alla fine.
 *
 * Qui pesa ancora di più. `POST /api/iscrizione/insegnanti` pretende
 * `scuola_id` come uuid OBBLIGATORIO — è più severo della rotta d'iscrizione, e
 * ha ragione: con tre plessi, dedurre la sede significa archiviare la
 * candidatura nel posto sbagliato senza che nessuno se ne accorga. Senza sede
 * NON esiste nessun invio possibile: quindi il modulo non deve nemmeno
 * cominciare.
 *
 * ─── IL CONTRATTO ───────────────────────────────────────────────────────────
 * Tre stati DISTINTI, non due: **caricamento**, **elenco non ottenuto**,
 * **elenco ottenuto** (che può essere vuoto, o di una sede sola, o di più).
 * Solo il terzo — e solo se contiene almeno una sede — fa partire il modulo.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }

/** Il primo campo del modulo: la sua presenza dice «il modulo è cominciato». */
const PRIMO_CAMPO = 'Es. Maria'

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e la casella che questo file spunta per attraversare il modulo non
 * si chiama più «Infanzia (3-6)» ma «Insegnante — Infanzia (3-6)». ⚠️ Quel
 * trattino è un EM DASH (U+2014): ribattuto a mano con un trattino corto dà un
 * selettore che non trova niente, e il rosso che ne esce parla del wizard invece
 * che di questa riga. Qui il modulo si attraversa, non si collauda: la casella
 * serve solo a superare il passo, e ciò che questo file misura sono le sedi.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

/** La posizione che si spunta per attraversare il passo «profilo». */
const POSIZIONE_SCELTA = posizione('insegnante_infanzia')

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []

type Risposta =
  | { tipo: 'ok'; sedi: { id: string; nome: string }[] }
  | { tipo: 'corpo-strano' }
  | { tipo: 'http'; stato: number }
  | { tipo: 'rete' }

/** Esiti dell'INVIO, uno per tentativo; l'ultimo vale per tutti i successivi. */
type EsitoPost = { tipo: 'ok' } | { tipo: 'http'; stato: number; corpo: unknown }

/** `risposte[i]` = esito dell'i-esimo tentativo; l'ultima vale per tutti i successivi. */
function mockSedi(risposte: Risposta[], invii: EsitoPost[] = [{ tipo: 'ok' }]): void {
  let tentativo = 0
  let invio = 0
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/sedi')) {
      const r = risposte[Math.min(tentativo, risposte.length - 1)]
      tentativo += 1
      if (r.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
      if (r.tipo === 'http') {
        return Promise.resolve({ ok: false, status: r.stato, json: async () => ({ error: 'no' }) })
      }
      if (r.tipo === 'corpo-strano') {
        // 200 con un corpo che NON contiene l'elenco: l'elenco non è stato
        // OTTENUTO, e non va confuso con «non c'è nessuna sede».
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: r.sedi }) })
    }
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      const e = invii[Math.min(invio, invii.length - 1)]
      invio += 1
      if (e.tipo === 'http') {
        return Promise.resolve({ ok: false, status: e.stato, json: async () => e.corpo })
      }
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'x' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Il 400 che la rotta risponde quando `scuola_id` non è un plesso che riceve. */
const RIFIUTO_SEDE = {
  tipo: 'http' as const,
  stato: 400,
  corpo: { error: 'Indicare la sede della candidatura.', codice: 'SEDE_DA_SPECIFICARE' },
}

/** Un uuid ben formato che NON è nessuna delle sedi: il link vecchio, o ritoccato. */
const SEDE_IGNOTA = '11111111-1111-4111-8111-111111111111'

/** Nessuna parte del modulo è stata dipinta: non c'è niente da compilare. */
function nienteDaCompilare(): void {
  expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: itPublic.candAvanti })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: itPublic.candInvia })).not.toBeInTheDocument()
}

/** Compila i tre passi obbligatori e si ferma sul riepilogo. */
async function compilaFinoAlRiepilogo(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText(PRIMO_CAMPO), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'laurea_triennale' } })
  fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
}

/** Come sopra, e preme «Invia candidatura». */
async function compilaEInvia(): Promise<void> {
  await compilaFinoAlRiepilogo()
  fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
}

/** Il testo che il riepilogo mostra sotto «Sede scelta». */
function sedeNelRiepilogo(): string {
  const etichetta = screen.getByText(itPublic.candRiepilogoSede)
  return etichetta.parentElement?.querySelectorAll('p')[1]?.textContent ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  corpiInviati.length = 0
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('CandidaturaInsegnanteWizard — i tre stati dell’elenco sedi', () => {
  it('CARICAMENTO: nessun passo è dipinto finché la forma non è decisa, e l’attesa è annunciata', async () => {
    // Qui non si può assertare «il pannello cambia»: si asserisce l'INVARIANTE
    // che rende impossibile il difetto — finché la forma dei passi non è
    // definitiva, non si dipinge NIENTE. Col difetto, il primo campo era già lì
    // e il passo della sede compariva dopo, sotto le mani di chi scriveva.
    let sblocca: (() => void) | null = null
    const attesa = new Promise<void>((r) => {
      sblocca = r
    })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return attesa.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [ALFA, BETA, GAMMA] }),
        }))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    // Il testo per chi non vede la rotellina: un'attesa muta è indistinguibile
    // da una pagina rotta.
    expect(screen.getByText(itPublic.candCaricamento)).toBeInTheDocument()
    nienteDaCompilare()

    sblocca!()

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
  })

  it('PRONTO: tre sedi e nessun ?sede= → il primo passo è la scelta della sede', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: NOME_SEDE_C })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
    // Nessun «Indietro» = la sede è davvero il PRIMO passo.
    // ⚠️ Dall'11/08/2026 il comando NON è più «disabilitato»: non viene reso
    // affatto. Disabilitato voleva dire `opacity-30` su testo `text-kidville-sub`,
    // cioè 1,3:1 sul crema — un comando che non si può leggere e non si può
    // premere, che si legge come interfaccia rotta invece che come «da qui non
    // si torna indietro».
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()
  })

  it('«Avanti» senza aver scelto la sede: non avanza, e lo dice', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    expect(await screen.findByText(itPublic.candSedeErrore)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
  })

  it('sede scelta: si prosegue, la scelta resta tornando indietro, e il POST porta quel suo elenco di sedi', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_B }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await compilaEInvia()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([BETA.id])
    // Il riepilogo aveva mostrato il NOME del plesso, non il suo uuid.
    expect(screen.queryByText(BETA.id)).not.toBeInTheDocument()
  })

  it('ERRORE 429 (rate-limit): lo dice in pagina, offre «Riprova», e non fa cominciare niente', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())
    // Annunciato: chi usa uno screen reader lo sente senza andarlo a cercare.
    expect(screen.getByRole('alert')).toHaveTextContent(itPublic.candSediErroreTitolo)
    expect(screen.getByText(itPublic.candSediErroreCorpo)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itPublic.candSediRiprova })).toBeInTheDocument()
    nienteDaCompilare()

    // `!r.ok` NON lancia: senza il controllo esplicito questo caso sarebbe muto,
    // ed è esattamente com'è passato inosservato in produzione.
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 429 }),
    )
  })

  it('ERRORE 500: stesso trattamento del 429 — non è una risposta valida, è un guasto', async () => {
    mockSedi([{ tipo: 'http', stato: 500 }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())
    nienteDaCompilare()
  })

  it('ERRORE rete giù (la fetch RIGETTA): il modulo non parte alla cieca, e il guasto è loggato', async () => {
    mockSedi([{ tipo: 'rete' }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())
    nienteDaCompilare()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch' }),
    )
  })

  it('ERRORE 200 con un corpo di forma inattesa: «elenco non ottenuto», non «nessuna sede»', async () => {
    // `null` non è `[]`. Trattare un corpo senza `data` come un elenco vuoto è
    // lo stesso difetto del 429 con un'altra faccia.
    mockSedi([{ tipo: 'corpo-strano' }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())
    expect(screen.queryByText(itPublic.candSediVuoteTitolo)).not.toBeInTheDocument()
    nienteDaCompilare()
  })

  it('«Riprova» ritenta davvero: con l’elenco in mano il modulo riparte dalla SEDE', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candSediRiprova }))

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    // L'errore superato sparisce: un avviso che resta è un avviso che si impara
    // a ignorare.
    expect(screen.queryByText(itPublic.candSediErroreTitolo)).not.toBeInTheDocument()
  })

  it('«Riprova» che fallisce di nuovo: si resta sull’errore, ancora riprovabile', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candSediRiprova }))

    await waitFor(() => expect(screen.getByRole('button', { name: itPublic.candSediRiprova })).toBeInTheDocument())
    nienteDaCompilare()
  })

  it('ELENCO VUOTO ma OTTENUTO: non c’è nessuna sede, la candidatura non si può cominciare', async () => {
    // La rotta pretende `scuola_id`: senza nemmeno un plesso non esiste invio
    // possibile. La frase è la SUA, non quella del guasto — qui l'elenco è
    // arrivato, e dire «non riusciamo a caricare le sedi» manderebbe a
    // controllare una connessione che non ha nessun problema.
    mockSedi([{ tipo: 'ok', sedi: [] }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediVuoteTitolo)).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(itPublic.candSediVuoteTitolo)
    expect(screen.getByText(itPublic.candSediVuoteCorpo)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candSediErroreTitolo)).not.toBeInTheDocument()
    nienteDaCompilare()
  })

  it('ELENCO VUOTO: NIENTE «Riprova» — un pulsante che ripete la stessa risposta insegna a non fidarsi', async () => {
    mockSedi([{ tipo: 'ok', sedi: [] }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByText(itPublic.candSediVuoteTitolo)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: itPublic.candSediRiprova })).not.toBeInTheDocument()
  })

  it('UNA SOLA SEDE: nessun passo di scelta, ma la sede viaggia lo stesso nel POST', async () => {
    // È la riga che manca più facilmente: senza il passo di scelta è comodo
    // credere che non ci sia niente da decidere, e `scuola_id` partirebbe
    // `undefined` — cioè un 400 dopo tutto il modulo compilato.
    mockSedi([{ tipo: 'ok', sedi: [GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()

    await compilaEInvia()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([GAMMA.id])
  })

  it('?sede= CONFERMATO dall’elenco: nessun passo di scelta, e il riepilogo dice il NOME', async () => {
    // L'elenco si chiede lo stesso, ed è il motivo per cui il nome del plesso si
    // può scrivere: fino all'11/08/2026 col link targato la fetch non partiva
    // affatto e il riepilogo mostrava «Sede scelta —», cioè un trattino come
    // unico fatto della schermata che precede l'invio.
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()

    await compilaFinoAlRiepilogo()
    expect(sedeNelRiepilogo()).toBe(NOME_SEDE_A)
    expect(sedeNelRiepilogo()).not.toBe('—')
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([SEDE_A])
  })

  it('?sede= SMENTITO dall’elenco: il passo sede torna PRIMA che si sia compilato niente', async () => {
    // Il vicolo cieco misurato l'11/08/2026, chiuso alla radice: un link
    // «targato» su un plesso disattivato (o sulla sede di collaudo, o ritoccato
    // a mano) portava a compilare quattro passi per poi ricevere un 400 che
    // ordinava di scegliere una sede che sullo schermo non esisteva — zero
    // `radio` in pagina. Adesso l'elenco smentisce il link al primo schermo, e
    // chi apre il volantino vecchio sceglie senza nemmeno accorgersene.
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeInTheDocument())
    // Niente è stato ancora compilato: non c'è nessun dato da salvare e nessuna
    // spiegazione da dare — c'è solo un passo in più, al suo posto.
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candErroreInvioTitolo)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_B }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await compilaEInvia()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    // L'uuid del link NON parte: partirebbe per essere rifiutato.
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([BETA.id])
  })

  it('?sede= smentito e UNA sola sede: nessun passo inutile, e parte quella vera', async () => {
    mockSedi([{ tipo: 'ok', sedi: [GAMMA] }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await compilaFinoAlRiepilogo()
    expect(sedeNelRiepilogo()).toBe(NOME_SEDE_C)
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([GAMMA.id])
  })

  it('?sede= con l’elenco NON ottenuto: il modulo parte lo stesso, e il riepilogo non è un trattino', async () => {
    // La proprietà che il ramo «niente fetch» proteggeva, e che resta vera:
    // nessun guasto dell'elenco può impedire una candidatura. Il nome del plesso
    // però non si può sapere — e allora non si scrive un uuid, né un trattino:
    // si dice da dove viene la sede.
    mockSedi([{ tipo: 'http', stato: 500 }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candSediErroreTitolo)).not.toBeInTheDocument()

    await compilaFinoAlRiepilogo()
    expect(sedeNelRiepilogo()).toBe(itPublic.candRiepilogoSedeDalLink)
    expect(sedeNelRiepilogo()).not.toBe('—')
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([SEDE_A])
  })

  it('400 SEDE_DA_SPECIFICARE: il passo sede RICOMPARE, i dati restano, il secondo invio passa', async () => {
    // L'ultima rete, per il caso che la validazione all'apertura non può
    // coprire: l'elenco non si è potuto leggere (429/500/rete), il link è stato
    // creduto, e il server lo rifiuta a modulo compilato. Prima dell'11/08/2026
    // qui finiva tutto: il pannello diceva «Specificare la sede a cui si
    // riferisce questa operazione» — una frase da cockpit che ordina un'azione —
    // e invitava a ripremere «Invia candidatura», che avrebbe dato la stessa
    // risposta per sempre. `radio` disponibili per obbedire: 0.
    mockSedi(
      // Il primo tentativo dell'elenco fallisce (così il link viene creduto), il
      // secondo — quello che parte DOPO il rifiuto — riesce.
      [{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }],
      [RIFIUTO_SEDE, { tipo: 'ok' }],
    )
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([SEDE_IGNOTA])

    // ⚠️ IL CONTROLLO CHE CONTA: la frase e i comandi per obbedirle stanno sulla
    // STESSA schermata.
    const radio = await screen.findByRole('checkbox', { name: NOME_SEDE_B })
    expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument()
    expect(screen.getByText(itPublic.candSedeRifiutataNota)).toBeInTheDocument()
    // E NON la nota generica, che direbbe di ripremere un bottone che darebbe la
    // stessa risposta.
    expect(screen.queryByText(itPublic.candErroreInvioDatiSalvi)).not.toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', evento: 'fetch', stato: 400 }),
    )

    fireEvent.click(radio)
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    // I dati compilati sono ancora tutti lì: non si ricomincia da capo.
    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toHaveValue('Ines'))
    expect(screen.getByPlaceholderText('Es. mario.rossi@email.com')).toHaveValue('aspirante@example.test')
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA })).toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(sedeNelRiepilogo()).toBe(NOME_SEDE_B)
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(2))
    expect((corpiInviati[1] as { scuole_ids?: string[] }).scuole_ids).toEqual([BETA.id])
    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
  })

  it('400 SEDE_DA_SPECIFICARE con UNA sola sede: il passo compare lo stesso, e la frase è vera', async () => {
    // Senza questa regola la frase «scegli la sede qui sopra» comparirebbe
    // davanti a nessuna scelta: con un plesso solo `mostraSede` sarebbe falso e
    // il rifiuto tornerebbe muto. Dopo un rifiuto sulla sede il passo si mostra
    // SEMPRE — è l'unico modo perché ciò che si legge e ciò che si può fare
    // coincidano.
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [GAMMA] }], [RIFIUTO_SEDE, { tipo: 'ok' }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_C })).toBeInTheDocument())
    expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument()
  })

  it('?sede= VUOTO vale come ASSENTE: la sede si sceglie, e il POST la porta', async () => {
    // `/lavora-con-noi?sede=` produce la stringa vuota, non `null`: se valesse
    // «sede già decisa», si sceglierebbe un plesso e l'invio partirebbe senza.
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard sedeId="" />)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await compilaEInvia()
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([ALFA.id])
  })

  it('accessibilità: ogni sede è una casella dello stesso gruppo, con la propria etichetta', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)

    const radio = await screen.findByRole('checkbox', { name: NOME_SEDE_A })
    const altro = screen.getByRole('checkbox', { name: NOME_SEDE_C })
    // Stesso `name`: le frecce della tastiera scorrono il gruppo.
    expect((radio as HTMLInputElement).name).toBe((altro as HTMLInputElement).name)
    fireEvent.click(radio)
    expect((radio as HTMLInputElement).checked).toBe(true)
  })

  /*
   * ─── LA RETE RESIDUA DEVE REGGERE ANCHE QUANDO IL SECONDO TENTATIVO FALLISCE ─
   *
   * I due collaudi qui sotto coprono il caso per cui il ramo `SEDE_DA_SPECIFICARE`
   * è stato scritto, e che fino al 2026-08-11 NON copriva.
   *
   * La causa documentata per cui il link viene creduto è il 429 di
   * `GET /api/iscrizione/sedi`, e quel tetto dura DIECI MINUTI: il tentativo che
   * parte subito dopo il rifiuto cade quasi certamente nella stessa finestra.
   * Prima della correzione, `riprovaSedi()` riportava `statoSedi` a `caricamento`,
   * `formaDecisa` tornava falso e l'INTERO ramo dei passi — l'unico che contiene
   * il pannello `erroreInvio` — veniva smontato: chi aveva compilato quattro passi
   * leggeva «Non riusciamo a caricare le sedi / Controlla la connessione»,
   * cioè (a) nessuna parola sul fatto che l'invio era fallito, (b) nessuna sulla
   * sede del collegamento, (c) la colpa data a una connessione che non ne ha, e
   * (d) un bottone che avrebbe ripetuto lo stesso 429 per dieci minuti.
   */

  it('400 SEDE_DA_SPECIFICARE e l’elenco fallisce ANCORA: il modulo compilato NON si smonta', async () => {
    mockSedi(
      // 429 all'apertura (il link viene creduto), 429 di nuovo dopo il rifiuto
      // — è la finestra da dieci minuti, non un caso di scuola — e solo al terzo
      // tentativo l'elenco arriva.
      [{ tipo: 'http', stato: 429 }, { tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }],
      [RIFIUTO_SEDE, { tipo: 'ok' }],
    )
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()
    await waitFor(() => expect(corpiInviati).toHaveLength(1))

    // 1. L'INVIO È FALLITO, e la schermata lo dice.
    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    // 2. IL MOTIVO è la sede del collegamento — non «controlla la connessione».
    expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument()
    // 3. I DATI SONO ANCORA QUI, e la nota è quella dell'attesa: dire «scegli la
    //    sede qui sopra» davanti a un elenco che non è arrivato sarebbe un ordine
    //    che non si può eseguire — lo stesso difetto, un livello più sotto.
    expect(screen.getByText(itPublic.candSedeRifiutataNotaAttesa)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candSedeRifiutataNota)).not.toBeInTheDocument()
    // 4. IL MODULO È ANCORA UN MODULO: la barra dei comandi è in pagina.
    //    «Indietro» no — e la sua ASSENZA è essa stessa la prova che il rifiuto
    //    ha riportato al PRIMO passo: dall'11/08/2026 quel comando non viene
    //    reso a `indice === 0` invece di comparire spento a 1,3:1.
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()

    // Il guasto dell'elenco si dice DENTRO il passo «sede», col suo «Riprova»:
    // è vero, ed è la sola cosa che si può fare adesso.
    expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument()
    // Ma «Avanti» non promette un passaggio che non c'è: senza nemmeno una sede
    // da scegliere premerlo darebbe solo «Scegli una sede per proseguire».
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candSediRiprova }))

    // Terzo tentativo: l'elenco arriva, il passo diventa una scelta vera e la
    // nota torna quella che nomina un'azione possibile.
    const radio = await screen.findByRole('checkbox', { name: NOME_SEDE_B })
    expect(screen.getByText(itPublic.candSedeRifiutataNota)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candSediErroreTitolo)).not.toBeInTheDocument()

    fireEvent.click(radio)
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    // NIENTE è andato perduto: i quattro passi sono ancora compilati.
    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toHaveValue('Ines'))
    expect(screen.getByPlaceholderText('Es. mario.rossi@email.com')).toHaveValue('aspirante@example.test')
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA })).toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
    await waitFor(() => expect(corpiInviati).toHaveLength(2))
    expect((corpiInviati[1] as { scuole_ids?: string[] }).scuole_ids).toEqual([BETA.id])
    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
  })

  it('durante il ri-caricamento dopo il rifiuto la pagina NON diventa una rotellina', async () => {
    // Su una connessione lenta, chi ha appena premuto «Invia» vedeva sparire
    // tutto — modulo, spiegazione, comandi — e restare la sola rotellina
    // «Caricamento delle sedi…»: il «pannello che si chiude sotto le dita» in
    // versione tastiera/schermo. L'attesa è un fatto del passo «sede», non della
    // pagina: la forma dei passi ORMAI è decisa, il passo sede ci sarà comunque.
    let sblocca: (() => void) | null = null
    const attesa = new Promise<void>((r) => {
      sblocca = r
    })
    let tentativo = 0
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        tentativo += 1
        if (tentativo === 1) {
          return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'no' }) })
        }
        return attesa.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [ALFA, BETA] }),
        }))
      }
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        corpiInviati.push(JSON.parse(String(init.body)))
        return Promise.resolve({ ok: false, status: 400, json: async () => RIFIUTO_SEDE.corpo })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)
    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument())

    // L'attesa è annunciata e VISIBILE, ma accanto alla spiegazione, non al posto
    // suo: le due cose stanno sulla stessa schermata.
    expect(screen.getByText(itPublic.candCaricamento)).toBeInTheDocument()
    expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument()
    // I comandi ci sono ancora; «Indietro» no, perché si è tornati al primo
    // passo e lì non viene reso (vedi il collaudo del rifiuto, poco sopra).
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeInTheDocument()

    sblocca!()

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.getByText(itPublic.candSedeRifiutataNota)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candCaricamento)).not.toBeInTheDocument()
  })

  /*
   * ─── E LA SPIEGAZIONE DEVE ANDARSENE QUANDO SMETTE DI ESSERE VERA ──────────
   *
   * Il pannello del rifiuto vive nel ramo dei passi, cioè in TUTTI: `notaErrore`
   * si decide sullo stato dell'ELENCO (`sedeSceglibile`), non sul fatto che il
   * selettore della sede sia davvero a schermo. Con due o più plessi il caso non
   * si vede — per passare bisogna toccare una casella, e l'`onChange` della casella
   * spegne l'avviso. Con UNA sola sede la casella è auto-spuntato
   * (`if (lista.length === 1) setSedeScelta(...)`), «Avanti» si preme senza
   * toccarlo, e la nota «Scegli la sede qui sopra» arrivava intatta nel passo
   * «I tuoi dati», dove di sedi non ce n'è nessuna: lo stesso ordine
   * ineseguibile, un passo più avanti.
   */
  it('rifiuto con UNA sola sede: «Avanti» senza toccare la casella si porta via il pannello del rifiuto', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [GAMMA] }], [RIFIUTO_SEDE, { tipo: 'ok' }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()

    // Il plesso è uno solo: la casella è GIÀ spuntato, e non c'è nessun gesto da
    // fare sopra di esso.
    const radio = await screen.findByRole('checkbox', { name: NOME_SEDE_C })
    expect(radio).toBeChecked()
    expect(screen.getByText(itPublic.candSedeRifiutataNota)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
    // ⚠️ IL CONTROLLO CHE CONTA: qui il selettore della sede non c'è…
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    // …e quindi non ci deve essere nemmeno la frase che ordina di usarlo.
    expect(screen.queryByText(itPublic.candSedeRifiutataNota)).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candSedeRifiutataCorpo)).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candErroreInvioTitolo)).not.toBeInTheDocument()
  })

  /*
   * ─── DI CHI È LA COLPA: DEL COLLEGAMENTO, O DELLA SEDE SCELTA ──────────────
   *
   * `SEDE_DA_SPECIFICARE` non arriva solo dal link targato. `GET
   * /api/iscrizione/sedi` e la `POST` applicano lo stesso `sediReali`, ma non
   * nello stesso istante: un plesso disattivato mentre si compilava — o la corsa
   * fra le due chiamate — produce lo stesso 400 su una sede scelta a schermo, da
   * un elenco che il server aveva appena servito.
   */
  it('rifiuto della sede SCELTA (nessun link): non si accusa un collegamento che non esiste', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA] }], [RIFIUTO_SEDE, { tipo: 'ok' }])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_B }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candSedeRifiutataCorpoScelta)).toBeInTheDocument())
    // Chi non ha mai aperto un link targato non deve sentirsi dire che il suo
    // collegamento è vecchio: il link diffuso è UNO solo per tutte e tre le sedi.
    expect(screen.queryByText(itPublic.candSedeRifiutataCorpo)).not.toBeInTheDocument()
    // Il passo «sede» è comunque quello davanti, e la scelta è da rifare.
    //
    // ⚠️ `waitFor` e non `getBy` diretto: dopo il rifiuto il wizard RICARICA l'elenco
    // delle sedi, e finché quella richiesta è in volo non dipinge nessuna casella — è la
    // stessa regola per cui non dipinge nessun passo prima di sapere che forma avrà la
    // procedura. Senza l'attesa questo caso misura l'istante sbagliato: fallisce non
    // perché la scelta sia rimasta selezionata, ma perché l'elenco non è ancora
    // tornato, e chi legge il rosso cercherebbe il difetto nel posto sbagliato.
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).not.toBeChecked()
    })
  })

  it('rifiuto della sede DEL LINK: la frase resta quella del collegamento', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [ALFA, BETA] }], [RIFIUTO_SEDE, { tipo: 'ok' }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument())
    expect(screen.queryByText(itPublic.candSedeRifiutataCorpoScelta)).not.toBeInTheDocument()
  })

  /*
   * ─── IL FUOCO, SUL PERCORSO DI FALLIMENTO ──────────────────────────────────
   *
   * ⚠️ Questo collaudo NON dimostra il difetto: jsdom non lo riproduce. Chi
   * preme «Invia candidatura» ha il fuoco su quel bottone; il rifiuto riporta a
   * `indice = 0` e lì lo stesso bottone diventa `disabled` finché l'elenco non
   * torna. Un browser vero toglie il fuoco a un elemento che si disabilita e lo
   * lascia cadere su `<body>`; jsdom no — misurato, dopo il rifiuto
   * `document.activeElement` restava il BUTTON «Avanti», ed è il motivo per cui
   * la suite verde non diceva niente su questo punto. Quello che si può
   * asserire, e che vale in entrambi i mondi, è dove il fuoco viene POSATO.
   */
  it('dopo il rifiuto il fuoco è sul pannello che spiega, non su un bottone che si spegne', async () => {
    // Il secondo tentativo dell'elenco fallisce ancora: è la finestra in cui
    // «Avanti» è disabilitato e «Indietro» pure (`indice === 0`).
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'http', stato: 429 }], [RIFIUTO_SEDE])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument())

    const pannello = screen
      .getAllByRole('alert')
      .find((n) => n.textContent?.includes(itPublic.candErroreInvioTitolo))
    expect(pannello, 'il pannello d’errore d’invio deve essere in pagina').toBeDefined()
    expect(document.activeElement).toBe(pannello)
    // Raggiungibile col fuoco, MAI col Tab: non si aggiunge una tappa alla
    // tabulazione di chi non ha perso niente.
    expect(pannello).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeDisabled()
    expect(screen.queryByRole('button', { name: itPublic.candIndietro })).not.toBeInTheDocument()
  })

  it('ELENCO VUOTO dopo il rifiuto: lo dice DENTRO il modulo, senza buttare via ciò che è compilato', async () => {
    // L'elenco torna, ed è vuoto: nessun plesso riceve candidature. All'apertura
    // questo fa non cominciare il modulo (ed è giusto); a modulo COMPILATO no —
    // lì la stessa schermata cancellerebbe quattro passi di lavoro per dare una
    // notizia che si può dare accanto ad essi.
    mockSedi(
      [{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: [] }],
      [RIFIUTO_SEDE],
    )
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_IGNOTA} />)

    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candSediVuoteTitolo)).toBeInTheDocument())
    expect(screen.getByText(itPublic.candSedeRifiutataCorpo)).toBeInTheDocument()
    expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument()
    // Nessun «Riprova»: ricaricare darebbe la stessa risposta.
    expect(screen.queryByRole('button', { name: itPublic.candSediRiprova })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeDisabled()
  })
})

describe('CandidaturaInsegnanteWizard — la scelta MULTIPLA delle sedi', () => {
  it('due sedi si spuntano insieme, e restano spuntate', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)
    const a = await screen.findByRole('checkbox', { name: ALFA.nome })
    const b = screen.getByRole('checkbox', { name: BETA.nome })
    fireEvent.click(a)
    fireEvent.click(b)
    await waitFor(() => expect(a).toBeChecked())
    expect(b).toBeChecked()
  })

  it('il POST porta ENTRAMBE le sedi, nell’ordine dell’elenco e non del clic', async () => {
    // L'ordine conta: la PRIMA diventa `candidature_insegnanti.scuola_id`, la
    // sede di primo arrivo. Se dipendesse dall'ordine dei clic, due candidature
    // identiche produrrebbero righe diverse.
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA, GAMMA] }])
    render(<CandidaturaInsegnanteWizard />)
    const b = await screen.findByRole('checkbox', { name: BETA.nome })
    fireEvent.click(b)
    fireEvent.click(screen.getByRole('checkbox', { name: ALFA.nome }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await compilaEInvia()
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect((corpiInviati[0] as { scuole_ids?: string[] }).scuole_ids).toEqual([ALFA.id, BETA.id])
  })

  it('🔴 TOGLIERE L’ULTIMA SPUNTA NON SPEGNE L’AVVISO', async () => {
    // Coi radio «sceglierne uno» e «averne uno» erano lo stesso fatto, e toccare
    // una card bastava a spegnere l'errore. Con le caselle non lo sono più:
    // togliere l'ultima spunta riporta il passo esattamente nello stato che
    // l'avviso descrive, e spegnerlo lì direbbe che il problema è risolto nel
    // momento in cui si è appena ricreato.
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA] }])
    render(<CandidaturaInsegnanteWizard />)
    const a = await screen.findByRole('checkbox', { name: ALFA.nome })

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    expect(await screen.findByText(itPublic.candSedeErrore)).toBeInTheDocument()

    fireEvent.click(a) // spuntare È la risposta all'avviso: si spegne
    await waitFor(() => expect(screen.queryByText(itPublic.candSedeErrore)).toBeNull())

    fireEvent.click(a) // …e toglierla lo riaccende
    expect(await screen.findByText(itPublic.candSedeErrore)).toBeInTheDocument()
  })

  it('togliere UNA di DUE spunte non riaccende niente: una sede resta', async () => {
    mockSedi([{ tipo: 'ok', sedi: [ALFA, BETA] }])
    render(<CandidaturaInsegnanteWizard />)
    const a = await screen.findByRole('checkbox', { name: ALFA.nome })
    const b = screen.getByRole('checkbox', { name: BETA.nome })
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    expect(await screen.findByText(itPublic.candSedeErrore)).toBeInTheDocument()
    fireEvent.click(a)
    fireEvent.click(b)
    await waitFor(() => expect(screen.queryByText(itPublic.candSedeErrore)).toBeNull())
    fireEvent.click(a)
    expect(screen.queryByText(itPublic.candSedeErrore)).toBeNull()
  })
})
