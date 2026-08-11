import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { BadgeCoerenzaCf } from '@/components/features/anagrafica/BadgeCoerenzaCf'
import {
  LuogoNascitaFields,
  SIGLA_ESTERO,
  type ValoreLuogoNascita,
} from '@/components/features/anagrafica/LuogoNascitaFields'
import type { EsitoCoerenza } from '@/lib/fiscale/coerenza'

expect.extend(toHaveNoViolations)

// =============================================================================
// `LuogoNascitaFields` — la cascata provincia → comune.
//
// LE TRE COSE CHE UN CAMPO COSÌ SBAGLIA SEMPRE, e che qui si MISURANO:
//
//  1. IL VALORE IN ARCHIVIO SPARISCE. Il dataset è fermo al 2022; in produzione
//     ci sono record scritti a mano da anni. Un campo che azzera ciò che non
//     riconosce cancella un dato vero PER IL SOLO FATTO DI ESSERE APERTO — e chi
//     salva la scheda per un altro motivo si porta via il luogo di nascita senza
//     saperlo. §2 misura che il valore resti, sia marcato e sia spiegato.
//
//  2. IL COMUNE SI AZZERA ALL'APERTURA. È il difetto classico del pattern «reset
//     figlio quando cambia il padre»: scritto in un `useEffect`, non distingue il
//     cambio dell'UTENTE dal primo arrivo dei dati dal server. §3 misura le due
//     direzioni separatamente, ed è la ragione per cui in questo componente non
//     esiste nessun effetto che chiami `onChange`.
//
//  3. VINCE LA RISPOSTA PIÙ LENTA. Chi digita `NA` e poi `TO` lancia due
//     richieste: senza `AbortController` la tendina di Torino può mostrare i
//     comuni di Napoli. Nessun errore, nessun log — solo un codice fiscale
//     sbagliato mesi dopo. §5 rovescia deliberatamente l'ordine di arrivo.
//
// ⚠️ Nessun dato di persona in questo file (repository PUBBLICO): sono toponimi e
// codici catastali, cioè dati aperti dell'Agenzia delle Entrate.
//
// ─── COSA QUESTO BANCO NON PUÒ VEDERE ───────────────────────────────────────
// jsdom non impagina, non scorre e non sposta il fuoco al clic. Il collaudo della
// tastiera qui sotto misura ciò che il DOM sa dire (`aria-activedescendant`,
// `aria-expanded`, il valore scelto), non l'esperienza reale su un telefono.
// =============================================================================

interface ComuneFinto {
  belfiore: string
  nome: string
  sigla: string
  attivo: boolean
}

const NAPOLI: { comuni: ComuneFinto[] } = {
  comuni: [
    { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
    { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
    { belfiore: 'B455', nome: 'CASORIA', sigla: 'NA', attivo: true },
    { belfiore: 'D021', nome: 'CRISPANO SUPERIORE', sigla: 'NA', attivo: false },
  ],
}

const TORINO: { comuni: ComuneFinto[] } = {
  comuni: [
    { belfiore: 'L219', nome: 'TORINO', sigla: 'TO', attivo: true },
    { belfiore: 'F335', nome: 'MONCALIERI', sigla: 'TO', attivo: true },
  ],
}

const ESTERO: { comuni: ComuneFinto[] } = {
  comuni: [
    { belfiore: 'Z404', nome: 'ARGENTINA', sigla: 'EE', attivo: true },
    { belfiore: 'Z602', nome: 'MAROCCO', sigla: 'EE', attivo: true },
  ],
}

const VUOTO: ValoreLuogoNascita = { provincia: '', comune: '', belfiore: '', nazione: '' }

/** La spia sui log del client: un `catch` che non logga è un bug (AGENTS.md n.6). */
const logClientSpia = vi.fn()
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>()
  return { ...vero, logClient: (...a: unknown[]) => logClientSpia(...a) }
})

/**
 * Il banco: il componente è CONTROLLATO, quindi senza qualcuno che tenga il
 * valore non si può misurare né che la scelta arrivi né che il primo montaggio
 * lasci in pace ciò che c'era.
 */
function Banco({
  iniziale = VUOTO,
  spia,
  ...resto
}: {
  iniziale?: ValoreLuogoNascita
  spia?: (v: ValoreLuogoNascita) => void
  disabled?: boolean
  mostraNazione?: boolean
  errori?: Partial<Record<'provincia' | 'comune', string>>
}) {
  const [v, setV] = useState<ValoreLuogoNascita>(iniziale)
  return (
    <LuogoNascitaFields
      valore={v}
      onChange={(nuovo) => {
        spia?.(nuovo)
        setV(nuovo)
      }}
      idPrefisso="alunno"
      {...resto}
    />
  )
}

/**
 * Risposte per sigla; una sigla non elencata risponde 500 (ed è il ramo d'errore).
 *
 * ⚠️ QUESTA FINTA ROUTE FILTRA DAVVERO I SOPPRESSI, e non è un dettaglio: prima
 * leggeva dalla URL la sola `provincia` e ignorava `includiSoppressi`, quindi il
 * test «un comune SOPPRESSO già in archivio è riconosciuto» passava IDENTICO con
 * o senza quel parametro — misurava la propria fixture, non il componente.
 * Togliendo `&includiSoppressi=1` dal componente falliva un test solo, ed era
 * l'asserzione sulla stringa della URL in §1: un lock di forma, utile, ma che non
 * dice niente su cosa vede l'utente. Ora il comportamento è protetto due volte.
 */
function fintaRete(risposte: Record<string, { comuni: ComuneFinto[] }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const sigla = /provincia=([A-Z]{2})/.exec(url)?.[1] ?? ''
    const corpo = risposte[sigla]
    if (corpo === undefined) return new Response('{"error":"no"}', { status: 500 })
    const tutti = /[?&]includiSoppressi=1(&|$)/.test(url)
    const comuni = tutti ? corpo.comuni : corpo.comuni.filter((c) => c.attivo)
    return new Response(JSON.stringify({ comuni }), { status: 200 })
  })
}

/** Apre la tendina di un Combobox dal suo pulsante «Mostra o nascondi l'elenco». */
function apri(campo: HTMLElement) {
  const contenitore = campo.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: 'Mostra o nascondi l’elenco' }))
}

const campoProvincia = () => screen.getByRole('combobox', { name: 'Provincia di nascita' })
const campoComune = () => screen.getByRole('combobox', { name: /Comune di nascita|Stato di nascita/ })

/**
 * L'avviso giallo, cercato per TESTO e non per ruolo: ogni `Combobox` porta con
 * sé la propria regione `aria-live` — che è anch'essa un `role="status"` — quindi
 * `getByRole('status')` in questa schermata ne trova tre. Cercare il ruolo qui
 * significherebbe misurare la live-region del campo invece dell'avviso.
 */
const avvisoArchivio = () => screen.queryByText(/Il luogo di nascita registrato/)

beforeEach(() => {
  logClientSpia.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── §1 · LA CASCATA ──────────────────────────────────────────────────────────

describe('§1 · la cascata provincia → comune, e il Belfiore che ne esce', () => {
  it('il comune è spento finché non c’è la provincia', () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco />)
    expect(campoComune()).toBeDisabled()
    expect(campoComune()).toHaveAttribute('placeholder', 'Scegli prima la provincia')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('scelta la provincia si chiede l’elenco, e la scelta del comune valorizza il Belfiore', async () => {
    const rete = fintaRete({ NA: NAPOLI })
    vi.stubGlobal('fetch', rete)
    const spia = vi.fn()
    render(<Banco spia={spia} />)

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))

    expect(spia).toHaveBeenCalledWith({ provincia: 'NA', comune: '', belfiore: '', nazione: 'Italia' })

    await waitFor(() => expect(rete).toHaveBeenCalledTimes(1))
    // Il dataset NON è nel bundle: si passa sempre dalla route, e i soppressi si
    // scaricano SEMPRE (la casella filtra ciò che si vede, non ciò che si chiede).
    expect(String(rete.mock.calls[0][0])).toBe('/api/anagrafiche/comuni?provincia=NA&includiSoppressi=1')

    await waitFor(() => expect(campoComune()).toBeEnabled())
    apri(campoComune())
    fireEvent.click(screen.getByRole('option', { name: 'GIUGLIANO IN CAMPANIA' }))

    expect(spia).toHaveBeenLastCalledWith({
      provincia: 'NA',
      comune: 'GIUGLIANO IN CAMPANIA',
      belfiore: 'E054',
      nazione: 'Italia',
    })
  })

  it('i soppressi restano nascosti finché non li si chiede, e la casella li mostra', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco iniziale={{ provincia: 'NA', comune: '', belfiore: '', nazione: 'Italia' }} />)

    await waitFor(() => expect(campoComune()).toBeEnabled())
    apri(campoComune())
    expect(screen.queryByRole('option', { name: 'CRISPANO SUPERIORE' })).toBeNull()

    // Il pannello resta aperto: un secondo clic sul chevron lo chiuderebbe, e la
    // voce sparirebbe per il motivo sbagliato.
    fireEvent.click(screen.getByLabelText('Mostra anche i comuni soppressi'))
    const soppresso = screen.getByRole('option', { name: 'CRISPANO SUPERIORE' })
    expect(soppresso).toBeInTheDocument()
    // Chi è nato in un comune estinto lo trova sotto il proprio gruppo, non
    // mescolato agli attivi.
    expect(soppresso.closest('[role="group"]')).toHaveAttribute('aria-label', 'Comuni soppressi')
  })
})

// ── §2 · IL VALORE IN ARCHIVIO NON SI PERDE MAI ──────────────────────────────

describe('§2 · il valore in archivio fuori elenco resta, ed è MARCATO', () => {
  it('un comune che l’elenco non conosce resta scritto, in cima e con la nota', async () => {
    vi.stubGlobal('fetch', fintaRete({ CO: { comuni: [{ belfiore: 'C933', nome: 'COMO', sigla: 'CO', attivo: true }] } }))
    const spia = vi.fn()
    // `UGGIATE CON RONAGO` è un comune del 2024: il dataset è fermo al 2022 e non
    // ce l'ha. Non è un dato sbagliato — è un dato più nuovo dell'elenco.
    render(
      <Banco
        spia={spia}
        iniziale={{ provincia: 'CO', comune: 'UGGIATE CON RONAGO', belfiore: '', nazione: 'Italia' }}
      />,
    )

    await waitFor(() => expect(campoComune()).toBeEnabled())

    // 1. il testo è ancora nel campo, identico
    expect(campoComune()).toHaveValue('UGGIATE CON RONAGO')
    // 2. nessuno ha chiamato `onChange`: il componente non «corregge» niente
    expect(spia).not.toHaveBeenCalled()
    // 3. è in cima al listbox, selezionato e marcato
    apri(campoComune())
    const voci = screen.getAllByRole('option')
    expect(voci[0]).toHaveTextContent('UGGIATE CON RONAGO')
    expect(voci[0]).toHaveTextContent('valore in archivio, non riconosciuto')
    expect(voci[0]).toHaveAttribute('aria-selected', 'true')
    // 4. e accanto c'è la spiegazione, non solo un colore
    const avviso = avvisoArchivio()
    expect(avviso).not.toBeNull()
    expect(avviso?.textContent).toMatch(/non è verificabile/)
    expect(avviso?.closest('[role="status"]')).not.toBeNull()
  })

  it('vale anche per una PROVINCIA fuori elenco', async () => {
    vi.stubGlobal('fetch', fintaRete({ PL: { comuni: [] } }))
    // `PL` (Pola) è nel dataset storico ma non fra le 107 province di oggi.
    render(<Banco iniziale={{ provincia: 'PL', comune: '', belfiore: '', nazione: 'Italia' }} />)

    await waitFor(() => expect(avvisoArchivio()).not.toBeNull())
    expect(campoProvincia()).toHaveValue('PL')
    apri(campoProvincia())
    const voci = screen.getAllByRole('option')
    expect(voci[0]).toHaveTextContent('valore in archivio, non riconosciuto')
    expect(voci[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('un comune riconosciuto NON produce nessun avviso (il giallo dev’essere raro)', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())
    expect(avvisoArchivio()).toBeNull()
  })

  it('un comune SOPPRESSO già in archivio è riconosciuto, anche a casella spenta', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(
      <Banco iniziale={{ provincia: 'NA', comune: 'CRISPANO SUPERIORE', belfiore: 'D021', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(campoComune()).toBeEnabled())
    // Se i soppressi si filtrassero nella RICHIESTA invece che nella vista, questo
    // record sarebbe marcato «non riconosciuto» pur essendo perfettamente valido.
    // La finta route filtra sul serio: senza `includiSoppressi=1` questa riga è
    // rossa, e lo è per il motivo giusto (l'utente non vede più il proprio dato).
    expect(campoComune()).toHaveValue('CRISPANO SUPERIORE')
    expect(avvisoArchivio()).toBeNull()
  })

  // ── il caso di gran lunga più frequente: il Belfiore in archivio NON C'È ────
  // MISURATO in produzione l'11 agosto: `codice_belfiore_nascita` è NULL su 33
  // alunni su 33 e su 50 genitori su 50 (colonna nata ieri, migrazione senza
  // backfill), mentre 15 + 23 = 38 record hanno un comune scritto. Se il
  // riconoscimento pretendesse il Belfiore, quei 38 si aprirebbero TUTTI col
  // giallo — su comuni che nell'elenco ci sono.

  it('senza Belfiore in archivio il comune si riconosce dal NOME: niente giallo, niente doppione', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    // Esattamente una riga di produzione: comune scritto, Belfiore vuoto.
    render(<Banco spia={spia} iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    expect(avvisoArchivio()).toBeNull()
    expect(campoComune()).toHaveValue('NAPOLI')
    // La risoluzione è di sola LETTURA: la proprietà strutturale di §3 non si tocca.
    expect(spia).not.toHaveBeenCalled()

    apri(campoComune())
    // Una sola NAPOLI nella tendina: col fantasma ce ne sarebbero due, una
    // disabilitata e una scegliibile, e l'avviso direbbe che il comune «non
    // corrisponde a nessuna voce dell'elenco» mentre la voce sta due righe sotto.
    const napoli = screen.getAllByRole('option').filter((o) => (o.textContent ?? '').includes('NAPOLI'))
    expect(napoli).toHaveLength(1)
    expect(napoli[0]).toHaveAttribute('aria-selected', 'true')
    expect(napoli[0]).not.toHaveAttribute('aria-disabled')
  })

  it('la corrispondenza per nome è ESATTA: una troncatura resta fantasma', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    // `NAPO` è un valore vero dell'archivio (1 record). Un confronto per prefisso
    // lo scambierebbe per NAPOLI e scriverebbe H501 nel codice fiscale di
    // qualcuno: qui deve restare marcato, ed è per questo che il giallo esiste.
    render(<Banco iniziale={{ provincia: 'NA', comune: 'NAPO', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    expect(avvisoArchivio()).not.toBeNull()
    expect(campoComune()).toHaveValue('NAPO')
    apri(campoComune())
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('valore in archivio, non riconosciuto')
  })

  it('un comune SOPPRESSO nominato senza Belfiore resta visibile a casella spenta', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(
      <Banco iniziale={{ provincia: 'NA', comune: 'CRISPANO SUPERIORE', belfiore: '', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(campoComune()).toBeEnabled())
    // È la combinazione normale, non l'eccezione: comune estinto scritto a mano e
    // colonna del Belfiore vuota. Il filtro dei soppressi deve guardare il comune
    // RISOLTO, altrimenti la voce sparisce dalle opzioni e il campo torna bianco.
    expect(campoComune()).toHaveValue('CRISPANO SUPERIORE')
    expect(avvisoArchivio()).toBeNull()
  })

  it('⚠️ una PROVINCIA in minuscolo si mostra, e carica i comuni della sua sigla', async () => {
    const rete = fintaRete({ NA: NAPOLI })
    vi.stubGlobal('fetch', rete)
    const spia = vi.fn()
    // In archivio `birth_province` è minuscola su 4 record ('na' ×3, 'tr' ×1).
    // Passando al campo il valore GREZZO, l'etichetta non si risolve ('na' ≠ 'NA')
    // e il campo si apre BIANCO — senza nemmeno l'avviso, perché la sigla
    // normalizzata è riconosciuta benissimo. Un dato che c'è e non si vede.
    render(<Banco spia={spia} iniziale={{ provincia: 'na', comune: 'NAPOLI', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    expect(campoProvincia()).toHaveValue('Napoli (NA)')
    expect(String(rete.mock.calls[0][0])).toContain('provincia=NA')
    expect(avvisoArchivio()).toBeNull()
    expect(campoComune()).toHaveValue('NAPOLI')
    // Nessuna «correzione» automatica: in archivio resta 'na' finché non si
    // sceglie qualcosa. Il difetto era lo schermo, non il dato.
    expect(spia).not.toHaveBeenCalled()
  })
})

// ── §3 · L'AZZERAMENTO È INTERATTIVO, MAI AL MONTAGGIO ───────────────────────

describe('§3 · il comune si azzera solo al cambio INTERATTIVO di provincia', () => {
  it('cambiare provincia col mouse azzera comune e Belfiore', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI, TO: TORINO }))
    const spia = vi.fn()
    render(
      <Banco spia={spia} iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(campoComune()).toBeEnabled())

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Torino \(TO\)/ }))

    expect(spia).toHaveBeenCalledWith({ provincia: 'TO', comune: '', belfiore: '', nazione: 'Italia' })
  })

  it('⚠️ i dati che arrivano dall’archivio NON azzerano niente', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    // La scheda si apre vuota e i dati arrivano dopo, come da una fetch: è
    // esattamente lo scenario in cui il pattern «reset in useEffect» cancella il
    // luogo di nascita di un bambino senza che nessuno tocchi niente.
    function BancoEsterno() {
      const [v, setV] = useState<ValoreLuogoNascita>(VUOTO)
      return (
        <>
          <button
            type="button"
            onClick={() => setV({ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' })}
          >
            Arriva l’archivio
          </button>
          <LuogoNascitaFields
            valore={v}
            onChange={(nuovo) => {
              spia(nuovo)
              setV(nuovo)
            }}
            idPrefisso="alunno"
          />
        </>
      )
    }
    render(<BancoEsterno />)
    fireEvent.click(screen.getByRole('button', { name: 'Arriva l’archivio' }))

    await waitFor(() => expect(campoComune()).toBeEnabled())
    expect(campoProvincia()).toHaveValue('Napoli (NA)')
    expect(campoComune()).toHaveValue('NAPOLI')
    // La prova: nessun `onChange` è mai partito da solo.
    expect(spia).not.toHaveBeenCalled()
  })

  it('riscegliere la STESSA provincia non butta via il comune', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    render(
      <Banco spia={spia} iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(campoComune()).toBeEnabled())

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))

    expect(spia).not.toHaveBeenCalled()
    expect(campoComune()).toHaveValue('NAPOLI')
  })
})

// ── §4 · L'ESTERO ────────────────────────────────────────────────────────────

describe('§4 · nato all’estero', () => {
  it('con EE l’etichetta diventa «Stato di nascita» e la scelta compila `nazione`', async () => {
    const rete = fintaRete({ EE: ESTERO })
    vi.stubGlobal('fetch', rete)
    const spia = vi.fn()
    render(<Banco spia={spia} />)

    apri(campoProvincia())
    const estero = screen.getByRole('option', { name: /Stato estero/ })
    expect(estero.closest('[role="group"]')).toHaveAttribute('aria-label', 'Nato all’estero')
    fireEvent.click(estero)

    // Scegliendo l'estero la nazione si svuota: sarà la scelta dello stato a dirla.
    expect(spia).toHaveBeenCalledWith({ provincia: SIGLA_ESTERO, comune: '', belfiore: '', nazione: '' })

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Stato di nascita' })).toBeEnabled())
    expect(screen.queryByRole('combobox', { name: 'Comune di nascita' })).toBeNull()
    // La casella dei soppressi non ha senso fra gli stati esteri: non c'è.
    expect(screen.queryByLabelText('Mostra anche i comuni soppressi')).toBeNull()

    apri(screen.getByRole('combobox', { name: 'Stato di nascita' }))
    fireEvent.click(screen.getByRole('option', { name: 'MAROCCO' }))

    expect(spia).toHaveBeenLastCalledWith({
      provincia: SIGLA_ESTERO,
      comune: 'MAROCCO',
      belfiore: 'Z602',
      nazione: 'MAROCCO',
    })
  })

  it('la nazione si mostra, e si può spegnere con `mostraNazione={false}`', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const { rerender } = render(
      <Banco iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(campoComune()).toBeEnabled())
    expect(screen.getByText('Italia')).toBeInTheDocument()

    rerender(
      <Banco
        mostraNazione={false}
        iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }}
      />,
    )
    expect(screen.queryByText('Nazione di nascita:')).toBeNull()
  })
})

// ── §5 · LE RICHIESTE SOVRAPPOSTE ────────────────────────────────────────────

describe('§5 · due richieste in volo: vince la SECONDA, non la più lenta', () => {
  it('la risposta superata viene annullata e non tocca la tendina', async () => {
    // Rete a rilascio manuale: si sceglie DELIBERATAMENTE di far tornare prima la
    // richiesta vecchia. Senza `AbortController` la tendina di Torino mostrerebbe
    // i comuni di Napoli — e nessuno lo vedrebbe finché un codice fiscale non
    // nasce sbagliato.
    const sbloccaggi: Array<{ sigla: string; risolvi: () => void; segnale: AbortSignal }> = []
    const rete = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const sigla = /provincia=([A-Z]{2})/.exec(String(input))?.[1] ?? ''
      return new Promise<Response>((res, rej) => {
        const segnale = init?.signal as AbortSignal
        segnale.addEventListener('abort', () => rej(new DOMException('annullata', 'AbortError')))
        sbloccaggi.push({
          sigla,
          segnale,
          risolvi: () =>
            res(new Response(JSON.stringify(sigla === 'NA' ? NAPOLI : TORINO), { status: 200 })),
        })
      })
    })
    vi.stubGlobal('fetch', rete)

    render(<Banco />)

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
    await waitFor(() => expect(sbloccaggi).toHaveLength(1))

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Torino \(TO\)/ }))
    await waitFor(() => expect(sbloccaggi).toHaveLength(2))

    // La prima è stata ANNULLATA nel momento in cui è partita la seconda.
    expect(sbloccaggi[0].segnale.aborted).toBe(true)
    expect(sbloccaggi[1].segnale.aborted).toBe(false)

    // Ordine di arrivo rovesciato: prima Torino, poi la vecchia Napoli.
    await act(async () => {
      sbloccaggi[1].risolvi()
      sbloccaggi[0].risolvi()
    })

    await waitFor(() => expect(campoComune()).toBeEnabled())
    apri(campoComune())
    expect(screen.getByRole('option', { name: 'MONCALIERI' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'NAPOLI' })).toBeNull()

    // …e NESSUN log. È la seconda metà dell'invariante, e senza di essa la guardia
    // `if (ac.signal.aborted) return` si può cancellare col banco tutto verde:
    // la promise annullata cadrebbe nel ramo `res === null` ed emetterebbe un
    // `warn` «anagrafiche-comuni-non-caricati:NA:AbortError» su un gesto
    // perfettamente normale — cambiare provincia. In un progetto in cui il
    // logging è parte della definizione di «fatto», è rumore che mangia il
    // segnale: si misura che il silenzio ci sia.
    expect(logClientSpia).not.toHaveBeenCalled()
  })
})

// ── §6 · L'ERRORE DELLA RETE SI VEDE E SI LOGGA ──────────────────────────────

describe('§6 · l’errore della fetch si mostra in pagina e lascia traccia', () => {
  it('un 500 diventa un messaggio d’errore visibile e una riga di log', async () => {
    vi.stubGlobal('fetch', fintaRete({}))
    render(<Banco iniziale={{ provincia: 'NA', comune: '', belfiore: '', nazione: 'Italia' }} />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Non è stato possibile caricare l’elenco dei comuni')
    // Mai `alert()`: l'errore sta in pagina. E mai un catch muto: c'è il log.
    expect(logClientSpia).toHaveBeenCalledTimes(1)
    expect(logClientSpia.mock.calls[0][0]).toMatchObject({
      livello: 'warn',
      evento: 'fetch',
      stato: 500,
    })
    expect(logClientSpia.mock.calls[0][0].messaggio).toContain('anagrafiche-comuni-non-caricati:NA')
  })

  it('la rete giù (fetch che rifiuta) è un caso a sé, e si logga col NOME dell’errore', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    render(<Banco iniziale={{ provincia: 'NA', comune: '', belfiore: '', nazione: 'Italia' }} />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(logClientSpia.mock.calls[0][0].messaggio).toBe('anagrafiche-comuni-non-caricati:NA:TypeError')
    // Nessun dato personale nel log: solo la sigla e la classe dell'errore.
    expect(logClientSpia.mock.calls[0][0].messaggio).not.toMatch(/[a-z]{6}\d{2}/i)
  })

  it('quando la rete fallisce si mostra l’errore, NON l’avviso «valore in archivio»', async () => {
    // Due messaggi diversi per due cose diverse: se il rosso della rete e il
    // giallo dell'archivio comparissero insieme, chi legge non saprebbe quale dei
    // due riguarda il proprio dato.
    vi.stubGlobal('fetch', fintaRete({}))
    render(<Banco iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(avvisoArchivio()).toBeNull()
    // …e il valore resta comunque scritto nel campo.
    expect(campoComune()).toHaveValue('NAPOLI')
  })
})

// ── §7 · ERRORI DI VALIDAZIONE DEL CHIAMANTE ─────────────────────────────────

describe('§7 · gli errori passati dal form sono testo, non solo un bordo rosso', () => {
  it('ogni errore è annunciato e collegato al proprio campo', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco errori={{ provincia: 'Indica la provincia di nascita', comune: 'Indica il comune di nascita' }} />)

    const messaggi = screen.getAllByRole('alert').map((e) => e.textContent)
    expect(messaggi).toEqual(['Indica la provincia di nascita', 'Indica il comune di nascita'])

    expect(campoProvincia()).toHaveAttribute('aria-invalid', 'true')
    const descritto = campoProvincia().getAttribute('aria-describedby')
    expect(document.getElementById(descritto as string)).toHaveTextContent('Indica la provincia di nascita')
  })

  /**
   * ─── L'AVVISO GIALLO SI SENTE, NON SOLO SI VEDE ───────────────────────────
   * Questa era una promessa scritta e non mantenuta: l'`id` dell'avviso veniva
   * costruito, veniva reso in pagina, e non era il bersaglio di NESSUN
   * `aria-describedby`. Chi legge con uno screen reader arrivava sul campo di un
   * record fuori elenco e sentiva soltanto il valore — «UGGIATE CON RONAGO» —
   * mentre la spiegazione («qui non è verificabile») galleggiava scollegata più
   * in basso, cioè leggibile solo a chi guarda lo schermo.
   *
   * Si misura come §5 di `BadgeCoerenzaCf.test.tsx`: non che l'attributo ci sia,
   * ma che l'`id` a cui punta RISOLVA davvero sull'elemento giusto.
   */
  it('l’avviso «valore in archivio» descrive il campo del COMUNE, e l’id risolve davvero', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco iniziale={{ provincia: 'NA', comune: 'BORGO CHE NON C’È', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(avvisoArchivio()).not.toBeNull())

    const descritto = campoComune().getAttribute('aria-describedby') ?? ''
    expect(descritto).toContain('alunno-avviso-archivio')
    // Non basta che l'attributo ci sia: l'`id` deve RISOLVERE, e risolvere
    // sull'avviso — non su un elemento qualsiasi rimasto in pagina.
    expect(document.getElementById('alunno-avviso-archivio')).toHaveTextContent(
      /Il luogo di nascita registrato/,
    )

    // …e la provincia, che è regolare, NON si porta dietro una spiegazione che
    // parla del comune: descrivere un campo sano con l'avviso di un altro è
    // rumore, ed è il modo in cui gli avvisi smettono di essere ascoltati.
    expect(campoProvincia().getAttribute('aria-describedby') ?? '').not.toContain('avviso-archivio')
  })

  it('quando è la PROVINCIA a essere fuori elenco, l’avviso descrive lei', async () => {
    // `PL` (Pola) come in §2: sta nel dataset storico e la route risponde, ma non
    // è fra le 107 province di oggi. Serve una risposta VALIDA — con un elenco
    // in errore l'avviso non si accende affatto (vince il `role="alert"`).
    vi.stubGlobal('fetch', fintaRete({ PL: { comuni: [] } }))
    render(<Banco iniziale={{ provincia: 'PL', comune: '', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(avvisoArchivio()).not.toBeNull())

    expect(campoProvincia().getAttribute('aria-describedby') ?? '').toContain('alunno-avviso-archivio')
    expect(document.getElementById('alunno-avviso-archivio')).toHaveTextContent(
      /Il luogo di nascita registrato/,
    )
  })

  it('errore e avviso convivono sullo stesso campo: `aria-describedby` è una LISTA', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(
      <Banco
        iniziale={{ provincia: 'NA', comune: 'BORGO CHE NON C’È', belfiore: '', nazione: 'Italia' }}
        errori={{ comune: 'Indica il comune di nascita' }}
      />,
    )
    await waitFor(() => expect(avvisoArchivio()).not.toBeNull())

    const ids = (campoComune().getAttribute('aria-describedby') ?? '').split(' ').filter((s) => s !== '')
    expect(ids).toEqual(['alunno-comune-errore', 'alunno-avviso-archivio'])
    // Tutti e due i riferimenti esistono: un `aria-describedby` che punta a un
    // `id` non reso è peggio dell'assenza, perché sembra a posto.
    for (const idRif of ids) expect(document.getElementById(idRif)).not.toBeNull()
  })

  it('senza errore e senza avviso non resta un `aria-describedby` vuoto', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())
    expect(campoComune().getAttribute('aria-describedby')).toBeNull()
    expect(campoProvincia().getAttribute('aria-describedby')).toBeNull()
  })
})

// ── §8 · TASTIERA E ACCESSIBILITÀ ────────────────────────────────────────────

describe('§8 · la tastiera basta da sola, e axe non trova violazioni', () => {
  it('si sceglie provincia e comune senza mai usare il mouse', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    render(<Banco spia={spia} />)

    const prov = campoProvincia()
    prov.focus()
    // Si filtra digitando, poi si evidenzia con la freccia e si conferma con Invio.
    fireEvent.change(prov, { target: { value: 'Napoli' } })
    fireEvent.keyDown(prov, { key: 'ArrowDown' })
    expect(prov).toHaveAttribute('aria-expanded', 'true')
    expect(prov.getAttribute('aria-activedescendant')).not.toBeNull()
    fireEvent.keyDown(prov, { key: 'Enter' })
    expect(spia).toHaveBeenCalledWith({ provincia: 'NA', comune: '', belfiore: '', nazione: 'Italia' })

    await waitFor(() => expect(campoComune()).toBeEnabled())
    const com = campoComune()
    com.focus()
    fireEvent.change(com, { target: { value: 'casoria' } })
    fireEvent.keyDown(com, { key: 'ArrowDown' })
    fireEvent.keyDown(com, { key: 'Enter' })
    expect(spia).toHaveBeenLastCalledWith({
      provincia: 'NA',
      comune: 'CASORIA',
      belfiore: 'B455',
      nazione: 'Italia',
    })
  })

  it('l’opzione fantasma non si può SCEGLIERE con la tastiera (è già il valore)', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    render(<Banco spia={spia} iniziale={{ provincia: 'NA', comune: 'BORGO CHE NON C’È', belfiore: '', nazione: 'Italia' }} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    apri(campoComune())
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(spia).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-disabled', 'true')
  })

  it('nessuna violazione axe, con l’avviso giallo acceso', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const { container } = render(
      <Banco iniziale={{ provincia: 'NA', comune: 'BORGO CHE NON C’È', belfiore: '', nazione: 'Italia' }} />,
    )
    await waitFor(() => expect(avvisoArchivio()).not.toBeNull())
    expect(await axe(container)).toHaveNoViolations()
  })

  it('`disabled` spegne tutto, casella compresa', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Banco disabled iniziale={{ provincia: 'NA', comune: 'NAPOLI', belfiore: 'H501', nazione: 'Italia' }} />)
    await waitFor(() => expect(screen.getByLabelText('Mostra anche i comuni soppressi')).toBeInTheDocument())
    expect(campoProvincia()).toBeDisabled()
    expect(campoComune()).toBeDisabled()
    expect(screen.getByLabelText('Mostra anche i comuni soppressi')).toBeDisabled()
  })
})

// ── §9 · IL CAMPO E IL BADGE, SULLO STESSO RECORD ────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL TEST CHE NON ESISTEVA, E CHE È IL PUNTO DI TUTTO IL PERIMETRO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LuogoNascitaFields.test.tsx` misurava il campo. `BadgeCoerenzaCf.test.tsx`
 * misurava il badge. Nessuno dei due li guardava INSIEME — e la contraddizione
 * viveva esattamente lì, nello spazio fra i due banchi di prova.
 *
 * Il record è il più frequente che ci sia in produzione: codice fiscale scritto,
 * comune scritto, `codice_belfiore_nascita` NULL. Sono 36 righe vere su 83
 * (14 alunni + 22 genitori, MISURATO l'11 agosto), perché la migrazione che ha
 * creato la colonna non fa backfill. Su ognuna di quelle 36 righe il pannello
 * diceva due cose opposte sulla stessa persona:
 *
 *   · il campo Luogo risolveva il comune per nome, lo mostrava SCELTO, aria pulita;
 *   · il badge, due sezioni sopra, dipingeva il giallo «manca il comune di nascita».
 *
 * Il comune non mancava: stava lì sotto, e chi guardava lo vedeva. Un pannello che
 * dice due cose diverse sullo stesso dato è precisamente il difetto che questo
 * perimetro dichiara di combattere.
 *
 * ⚠️ L'ESITO SI COSTRUISCE A MANO, e non è pigrizia: per far restituire a
 * `verificaCoerenza` il GIALLO servirebbe un codice fiscale con la checksum
 * VALIDA (un codice malformato esce dal ramo precedente ed è ROSSO), e in un
 * repository pubblico non se ne scrive nessuno — potrebbe essere di qualcuno.
 * L'esito qui sotto è quello che `coerenza.ts` produce per questo record, e la
 * riga che lo produce è una sola: `if (belfiore === null) nonVerificabili.push('luogo-nascita')`.
 */
const ESITO_BELFIORE_MANCANTE: EsitoCoerenza = {
  coerente: true,
  motivi: [],
  nonVerificabili: ['luogo-nascita'],
  codiceAtteso: null,
  codiceEsaminato: 'AAAAAA00A00A000A',
}

function Pannello({ spia }: { spia?: (v: ValoreLuogoNascita) => void }) {
  return (
    <>
      <BadgeCoerenzaCf id="badge-prova" esito={ESITO_BELFIORE_MANCANTE} />
      <Banco
        spia={spia}
        iniziale={{ provincia: 'NA', comune: 'GIUGLIANO IN CAMPANIA', belfiore: '', nazione: 'Italia' }}
      />
    </>
  )
}

/** Il badge per `id`: in questa schermata ci sono più `role="status"` (le regioni live dei Combobox). */
const badge = () => document.getElementById('badge-prova') as HTMLElement

describe('§9 · il campo e il badge, sullo stesso record, non si contraddicono', () => {
  it('il campo riconosce il comune e il badge NON dice che il comune manca', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    render(<Pannello />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    // Il campo: comune riconosciuto per nome, scelto, senza avvisi.
    expect(campoComune()).toHaveValue('GIUGLIANO IN CAMPANIA')
    expect(avvisoArchivio()).toBeNull()

    // Il badge: giallo, perché il codice catastale davvero non c'è…
    expect(badge()).toHaveTextContent('Non verificabile')
    // …ma NON dice più che manca il comune, che è lì sotto e si vede.
    expect(badge().textContent).not.toContain('manca il comune di nascita')
    expect(badge().textContent).toContain('manca il codice catastale del comune di nascita')
  })

  it('il badge nomina l’AZIONE, e l’azione nominata scrive davvero il Belfiore', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const spia = vi.fn()
    render(<Pannello spia={spia} />)
    await waitFor(() => expect(campoComune()).toBeEnabled())

    // La frase dice di scegliere il comune dall'elenco. Che quella sia l'azione
    // giusta non si dà per buono: si esegue. Prima non c'era nessun indizio, e
    // l'unico gesto che spegne il giallo è riscegliere dalla tendina la stessa
    // voce già mostrata — l'unica cosa che nessuno penserebbe mai di fare.
    expect(badge().textContent).toContain('scegli il comune dall’elenco del luogo di nascita per registrarlo')

    apri(campoComune())
    fireEvent.click(screen.getByRole('option', { name: 'GIUGLIANO IN CAMPANIA' }))

    expect(spia).toHaveBeenCalledWith({
      provincia: 'NA',
      comune: 'GIUGLIANO IN CAMPANIA',
      belfiore: 'E054',
      nazione: 'Italia',
    })
  })

  it('nessuna violazione axe col campo e il badge montati insieme', async () => {
    vi.stubGlobal('fetch', fintaRete({ NA: NAPOLI }))
    const { container } = render(<Pannello />)
    await waitFor(() => expect(campoComune()).toBeEnabled())
    expect(await axe(container)).toHaveNoViolations()
  })
})
