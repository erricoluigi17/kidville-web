import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { INSEGNANTE_FIELDS, GRADI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — LE FASCE D'ETÀ, e il fatto che siano PIÙ D'UNA.
 *
 * ─── PERCHÉ È UN CAMPO SOLO, E PERCHÉ NON HA VALIDAZIONE PROPRIA ───────────
 *
 * `gradi` è dichiarato nel template come `type: 'checkbox'` con
 * `required: true`, e quel tipo è GIÀ multi-valore: `FieldRenderer` lo rende con
 * un `Controller` il cui valore è un array (default `[]`), e `validateField` —
 * tramite `eVuoto()` — considera vuota una checkbox il cui valore non è un array
 * o è un array vuoto. Quindi «almeno una fascia» esiste già, sul client e sul
 * server, con la STESSA funzione. Una validazione scritta a mano qui sarebbe una
 * seconda regola per lo stesso vincolo: due regole per una cosa sola divergono,
 * ed è la lezione che questo repo ha già pagato.
 *
 * ─── PERCHÉ LA SCELTA È MULTIPLA ───────────────────────────────────────────
 *
 * Chi ha lavorato al nido e all'infanzia si propone per tutte e due. Costringere
 * a sceglierne una fa perdere alla segreteria proprio l'informazione con cui
 * smista la candidatura — e non c'è modo di recuperarla dopo.
 *
 * ─── E L'ARRAY DEVE ARRIVARE FINO AL CORPO DEL POST ────────────────────────
 *
 * La casella spuntata sullo schermo non serve a niente se poi il payload non la
 * porta: è esattamente il difetto già pagato sui CONSENSI del wizard fratello,
 * dove ogni pezzo funzionava e il collegamento fra penultimo e ultimo passo no.
 * `POST /api/iscrizione/insegnanti` valida `data.gradi` con uno `z.enum(...).min(1)`:
 * un array che non parte è un 400 su un modulo compilato per intero.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []

function mockRete(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Compila il passo «I tuoi dati» e passa al profilo. Il link è già targato. */
async function vaiAlProfilo(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'laurea_triennale' } })
}

/** Consensi + riepilogo + invio. */
async function concludi(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
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

describe('CandidaturaInsegnanteWizard — le fasce d’insegnamento', () => {
  it('le tre fasce del template sono tutte offerte, come caselle a scelta multipla', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    // L'elenco è quello dell'enum `school_type_enum` (nido/infanzia/primaria):
    // una quarta voce inventata qui prenderebbe `22P02` all'INSERT.
    expect(GRADI_OPTIONS).toHaveLength(3)
    for (const o of GRADI_OPTIONS) {
      const casella = screen.getByRole('checkbox', { name: String(o.label) })
      expect(casella).toHaveAttribute('type', 'checkbox')
      expect(casella).not.toBeChecked()
    }
  })

  it('ALMENO UNA è obbligatoria: senza, «Avanti» non passa e lo dice sotto il campo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    // La frase è quella di `validateField`, la stessa che userebbe il server.
    expect(await screen.findByText('Campo obbligatorio')).toBeInTheDocument()
    // E non si è passati oltre: i consensi non sono stati raggiunti.
    expect(screen.queryByRole('checkbox', { name: /informativa sulla privacy/i })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Nido (0-3)' })).toBeInTheDocument()
    // Nessun invio è partito: un modulo che non passa la validazione non chiama la rotta.
    expect(corpiInviati).toHaveLength(0)
  })

  it('spuntata una fascia si prosegue, e spuntandone due restano due', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    expect(screen.getByRole('checkbox', { name: 'Nido (0-3)' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Primaria (6-11)' }))

    expect(screen.getByRole('checkbox', { name: 'Nido (0-3)' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Primaria (6-11)' })).toBeChecked()
    // La terza non si è spuntata da sola: è una scelta multipla, non un radio.
    expect(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' })).not.toBeChecked()
  })

  it('togliere la spunta all’unica fascia rimette il blocco: non resta un consenso fantasma', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    expect(screen.getByRole('checkbox', { name: 'Nido (0-3)' })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    expect(await screen.findByText('Campo obbligatorio')).toBeInTheDocument()
  })

  it('L’ARRAY ARRIVA NEL CORPO DEL POST, con tutte le fasce spuntate e con i loro valori d’enum', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Primaria (6-11)' }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await concludi()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    expect(Array.isArray(dati.gradi)).toBe(true)
    // I VALORI dell'enum, non le etichette: `gradi` è `school_type_enum[]`, e
    // «Nido (0-3)» all'INSERT prenderebbe `22P02`.
    expect(dati.gradi).toEqual(['nido', 'primaria'])
    // E il resto del passo viaggia insieme, altrimenti il server rifiuta tutto.
    expect(dati.titolo_studio).toBe('laurea_triennale')
    expect(dati.nome).toBe('Ines')
  })

  it('il riepilogo mostra le fasce scelte con l’etichetta che si è letta spuntandole', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoFasce)).toBeInTheDocument())
    expect(screen.getByText('Infanzia (3-6)')).toBeInTheDocument()
    expect(screen.queryByText('Nido (0-3)')).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candRiepilogoNessunaFascia)).not.toBeInTheDocument()
  })

  /**
   * ⚠️ IL CONTROLLO STRUTTURALE, e non è pignoleria.
   *
   * Questo modulo NON rende tutti i campi del template: `cv_path` è escluso di
   * proposito (nessuna rotta di caricamento produce oggi il prefisso
   * `candidature/` che `POST /api/iscrizione/insegnanti` pretende, quindi
   * offrirlo vorrebbe dire far caricare un curriculum per poi respingerlo).
   *
   * Un'esclusione del genere è innocua SOLO finché il campo è facoltativo. Il
   * server valida il template INTERO con `validatePage`: un campo obbligatorio
   * non reso è un modulo che viene rifiutato a ogni invio, da chiunque, per un
   * campo che nessuno può vedere — e nessun test di comportamento se ne
   * accorgerebbe, perché il rifiuto arriva dal server.
   */
  it('ogni campo OBBLIGATORIO del template è davvero reso da qualche parte nel modulo', async () => {
    // I passi si smontano l'uno dopo l'altro (react-hook-form conserva i valori,
    // non il DOM): il censimento si fa passo per passo, mentre si attraversa.
    const visti = new Set<string>()
    const censisci = (): void => {
      for (const f of INSEGNANTE_FIELDS) {
        if (document.getElementById(f.id) !== null) visti.add(f.id)
        // I tipi a gruppo (checkbox multi-valore) non hanno un `id` sul
        // contenitore: si riconoscono dalle loro opzioni.
        else if ((f.options ?? []).some((o) => screen.queryByRole('checkbox', { name: String(o.label) }) !== null)) {
          visti.add(f.id)
        }
      }
    }

    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    censisci()
    await vaiAlProfilo()
    censisci()

    const obbligatori = INSEGNANTE_FIELDS.filter((f) => f.required).map((f) => f.id)
    expect(obbligatori.length).toBeGreaterThan(0)
    expect(
      obbligatori.filter((id) => !visti.has(id)),
      'un campo obbligatorio non reso è un modulo che il server rifiuta a ogni invio, ' +
        'per un campo che chi compila non può nemmeno vedere',
    ).toEqual([])
    // Controllo positivo: il censimento vede davvero i campi (senza, la riga qui
    // sopra sarebbe verde su un insieme vuoto per un errore di scansione).
    expect(visti.size).toBeGreaterThanOrEqual(obbligatori.length)
    // E l'unica esclusione dichiarata è quella, ed è FACOLTATIVA.
    expect(visti.has('cv_path')).toBe(false)
    expect(INSEGNANTE_FIELDS.find((f) => f.id === 'cv_path')?.required ?? false).toBe(false)
  })
})
