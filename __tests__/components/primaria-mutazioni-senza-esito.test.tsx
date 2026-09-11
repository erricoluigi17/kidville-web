import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// LE MUTAZIONI DEL COCKPIT PRIMARIA FALLIVANO IN SILENZIO — IN DUE MODI.
//
// ─── IL DIFETTO (misurato il 2026-09-09) ─────────────────────────────────────
//
// Sette manager di `admin/primaria` scrivevano `await fetch(...)` e basta:
// niente `res.ok`, niente `catch`, niente stato d'errore, niente log. In ognuno
// il pulsante «aggiungi» gestiva il rifiuto e «elimina»/«attiva» no — la firma
// della dimenticanza, non della scelta.
//
// I due modi di tacere non sono equivalenti, e questo file li misura entrambi:
//
//  1. CON STATO OTTIMISTICO — `ClassificazioneDocenti`. La casella si spunta
//     PRIMA della risposta e non torna più indietro. È il caso peggiore del
//     lotto perché i `gradi` del docente non restano lì: `OrarioManager` e
//     `DocentiMaterieManager` filtrano su `(d.gradi ?? []).includes('primaria')`,
//     quindi un salvataggio rifiutato mostra il docente come abilitato mentre
//     nelle tendine è SPARITO. Chi guarda lo schermo ha una sola spiegazione
//     disponibile, ed è quella sbagliata: «il sistema ha perso il docente».
//
//  2. SENZA OTTIMISMO — `MaterieManager`, l'eliminazione di una materia. Il
//     `load()` finale riporta l'elenco vero, quindi la riga rifiutata resta al
//     suo posto: identico a «il click non è arrivato». L'operatore riprova,
//     riprova, e non ha modo di sapere che è il server a dire di no.
//
// ─── COSA SI MISURA, E PERCHÉ COSÌ ───────────────────────────────────────────
//
// Ciò che l'utente LEGGE e VEDE: lo stato della casella, la riga ancora in
// elenco, il testo dell'avviso. Non quale funzione è stata chiamata — un lock
// sul nome di `muta` resterebbe verde anche buttandone via il risultato.
//
// E l'avviso deve NOMINARE LA RIGA. In un elenco lungo «errore di salvataggio»
// non dice a quale docente, o a quale materia, rifare il gesto: è la differenza
// fra un messaggio e un messaggio azionabile.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { ClassificazioneDocenti } from '@/components/features/admin/primaria/ClassificazioneDocenti'
import { MaterieManager } from '@/components/features/admin/primaria/MaterieManager'
import { ScrutinioGiudiziManager } from '@/components/features/admin/primaria/ScrutinioGiudiziManager'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const SEZIONE = '22222222-2222-4222-8222-222222222222'

/** Nome di fantasia: il repository è pubblico e in produzione ci sono persone vere. */
const DOCENTE = { id: '33333333-3333-4333-8333-333333333333', nome: 'Aurora', cognome: 'Verdi', gradi: [] as string[] }

const MATERIA = {
  id: '44444444-4444-4444-8444-444444444444',
  nome: 'Matematica',
  codice: 'matematica',
  e_civica: false,
  turno_mensa: false,
  ordine: 1,
  attiva: true,
}

const risposta = (stato: number, corpo: unknown) => ({
  ok: stato >= 200 && stato < 300,
  status: stato,
  json: async () => corpo,
})

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('primaria · una mutazione rifiutata non lascia lo schermo aggiornato', () => {
  it('ClassificazioneDocenti: il 403 sui gradi riporta indietro la casella e nomina il docente', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(risposta(403, { error: 'Non hai accesso a questa sede.' }))
      }
      return Promise.resolve(risposta(200, { success: true, data: [DOCENTE] }))
    })

    render(<ClassificazioneDocenti scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Aurora Verdi')

    // Tre caselle per riga, nell'ordine dichiarato da GRADI: nido, infanzia, primaria.
    const caselle = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(caselle).toHaveLength(3)
    const primaria = caselle[2]!
    expect(primaria.checked).toBe(false)

    fireEvent.click(primaria)

    // L'avviso arriva, e dice A CHI rifare il gesto.
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Aurora Verdi')

    // E soprattutto: la casella NON resta spuntata su un dato che il database non ha.
    await waitFor(() => {
      expect((screen.getAllByRole('checkbox')[2] as HTMLInputElement).checked).toBe(false)
    })
  })

  // Il 403 qui sopra è riparato da DUE cose insieme — la ricarica e il ripristino
  // dell'elenco — e un test che le vede entrambe non dice quale delle due sta
  // lavorando. Con la rete giù `muta` NON ricarica (è nel suo contratto), quindi
  // resta esposto il solo ripristino: è l'unico modo di misurarlo davvero.
  it('ClassificazioneDocenti: con la rete giù la casella torna indietro lo stesso', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(risposta(200, { success: true, data: [DOCENTE] }))
    })

    render(<ClassificazioneDocenti scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Aurora Verdi')

    fireEvent.click(screen.getAllByRole('checkbox')[2] as HTMLInputElement)

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Aurora Verdi')
    await waitFor(() => {
      expect((screen.getAllByRole('checkbox')[2] as HTMLInputElement).checked).toBe(false)
    })
  })

  it('MaterieManager: il 500 sull’eliminazione si vede, e nomina la materia', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(risposta(500, { error: 'Errore interno' }))
      }
      if (url.includes('/materia-obiettivo')) return Promise.resolve(risposta(200, { success: true, data: [] }))
      if (url.includes('/obiettivi')) return Promise.resolve(risposta(200, { success: true, data: [] }))
      return Promise.resolve(risposta(200, { success: true, data: [MATERIA] }))
    })

    render(<MaterieManager sectionId={SEZIONE} sezione={{ name: '1A' }} userId={UTENTE} scuolaId={SEDE_A} />)
    await screen.findByText('Matematica')

    fireEvent.click(screen.getByLabelText('Elimina materia'))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Matematica')

    // La riga è ancora lì — ed è giusto che ci sia: il server l'ha rifiutata.
    // Il difetto non era la riga: era che nessuno lo diceva.
    expect(screen.getByText('Matematica')).toBeInTheDocument()
  })
})

// =============================================================================
// IL SECONDO GIRO: IL RIMEDIO CHE RIMETTEVA IN PIEDI IL DIFETTO.
//
// Il ripristino dello stato ottimistico era stato scritto salvando un'ISTANTANEA
// dell'intero stato prima della fetch (`const precedenti = docenti`) e
// rimettendola sul rifiuto. Con UNA SOLA scrittura in volo funziona; con DUE non
// funziona più, e sbaglia proprio nel verso peggiore: l'istantanea della seconda
// contiene GIÀ la modifica ottimistica della prima, mai salvata. Rimetterla
// significa RISCRIVERE a schermo un dato che il server ha rifiutato — cioè
// esattamente il difetto per cui questo lotto esiste, reintrodotto dalla sua
// stessa correzione.
//
// Due clic ravvicinati non sono un gesto esotico: le caselle non erano
// disabilitate durante il salvataggio, e una tendina la si sbaglia e la si
// ricorregge subito. Qui si misurano i due casi che l'istantanea non regge:
//
//  · DUE RIGHE DIVERSE in volo insieme (una spunta per docente): il ripristino
//    deve toccare SOLO la propria riga, e sullo stato CORRENTE, non su una copia
//    vecchia di un secondo;
//  · LA STESSA RIGA due volte: la seconda scrittura non deve nemmeno partire
//    finché la prima è in volo — è l'unico modo di non dover indovinare quale
//    delle due ha ragione.
//
// La rete giù (e il 403, per le tendine) è di nuovo la condizione necessaria:
// sul rifiuto del server `muta` RICARICA, e la ricarica maschererebbe il difetto
// rimettendo a posto lo schermo per un'altra via. In `MaterieManager` non lo
// maschera affatto — `ricarica` è `load`, che rilegge le MATERIE e non tocca mai
// `assoc` — ed è il motivo per cui lì basta un 403.
// =============================================================================

describe('primaria · due scritture in volo insieme non si riscrivono a vicenda', () => {
  /** Nomi di fantasia: il repository è pubblico. */
  const DOCENTE_B = { id: '66666666-6666-4666-8666-666666666666', nome: 'Bruno', cognome: 'Sereni', gradi: [] as string[] }

  const ITALIANO = { ...MATERIA, id: '77777777-7777-4777-8777-777777777777', nome: 'Italiano', codice: 'italiano', ordine: 2 }
  const OB_MAT = { id: 'o1', codice: 'M1', descrizione: 'Conta entro il venti', materia_codice: 'matematica' }
  const OB_ITA = { id: 'o2', codice: 'I1', descrizione: 'Legge a voce alta', materia_codice: 'italiano' }

  const caselle = () => screen.getAllByRole('checkbox') as HTMLInputElement[]
  const tendine = () => screen.getAllByRole('combobox') as HTMLSelectElement[]

  it('ClassificazioneDocenti: due docenti, due rifiuti — nessuna delle due spunte sopravvive', async () => {
    const rifiuta: ((errore: unknown) => void)[] = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise((_ok, ko) => { rifiuta.push(ko) })
      return Promise.resolve(risposta(200, { success: true, data: [DOCENTE, DOCENTE_B] }))
    })

    render(<ClassificazioneDocenti scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Bruno Sereni')

    // Sei caselle: tre per riga, nell'ordine nido · infanzia · primaria.
    expect(caselle()).toHaveLength(6)
    fireEvent.click(caselle()[2]!) // «primaria» di Aurora
    fireEvent.click(caselle()[5]!) // «primaria» di Bruno
    await waitFor(() => expect(rifiuta).toHaveLength(2))

    // Le due PATCH cadono nell'ordine in cui sono partite: la rete è giù, quindi
    // `muta` non ricarica e resta esposto il solo ripristino.
    await act(async () => {
      rifiuta[0]!(new TypeError('Failed to fetch'))
      rifiuta[1]!(new TypeError('Failed to fetch'))
    })

    // Nessuno dei due docenti risulta abilitato alla primaria: il database non
    // ha visto niente, e lo schermo deve dire la stessa cosa. Se una resta
    // spuntata, quel docente appare abilitato QUI ed è sparito dalle tendine di
    // `OrarioManager`/`DocentiMaterieManager`, che filtrano sui `gradi`.
    await waitFor(() => {
      expect(caselle().map((c) => c.checked)).toEqual([false, false, false, false, false, false])
    })
  })

  it('ClassificazioneDocenti: la stessa riga non parte due volte mentre la prima è in volo', async () => {
    const rifiuta: ((errore: unknown) => void)[] = []
    const patch = vi.fn()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patch()
        return new Promise((_ok, ko) => { rifiuta.push(ko) })
      }
      return Promise.resolve(risposta(200, { success: true, data: [DOCENTE] }))
    })

    render(<ClassificazioneDocenti scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Aurora Verdi')

    fireEvent.click(caselle()[2]!)
    fireEvent.click(caselle()[1]!) // secondo clic sulla STESSA riga, prima che la prima risponda
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))

    await act(async () => { rifiuta[0]!(new TypeError('Failed to fetch')) })

    await waitFor(() => {
      expect(caselle().map((c) => c.checked)).toEqual([false, false, false])
    })
    // E una volta risposto, la riga torna scrivibile.
    await waitFor(() => expect(caselle()[2]!.disabled).toBe(false))
  })

  it('MaterieManager: due tendine rifiutate con un 403 tornano ENTRAMBE indietro', async () => {
    const rispondi: ((r: unknown) => void)[] = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/materia-obiettivo')) {
        return new Promise((ok) => { rispondi.push(ok) })
      }
      if (url.includes('/materia-obiettivo')) return Promise.resolve(risposta(200, { success: true, data: [] }))
      if (url.includes('/obiettivi')) return Promise.resolve(risposta(200, { success: true, data: [OB_MAT, OB_ITA] }))
      return Promise.resolve(risposta(200, { success: true, data: [MATERIA, ITALIANO] }))
    })

    render(<MaterieManager sectionId={SEZIONE} sezione={{ name: '1A' }} userId={UTENTE} scuolaId={SEDE_A} />)
    await screen.findByText('Italiano')

    // Tre tendine: il livello del preset, poi una per materia.
    expect(tendine()).toHaveLength(3)
    fireEvent.change(tendine()[1]!, { target: { value: 'o1' } })
    fireEvent.change(tendine()[2]!, { target: { value: 'o2' } })
    await waitFor(() => expect(rispondi).toHaveLength(2))

    await act(async () => {
      rispondi[0]!(risposta(403, { error: 'Non hai accesso a questa sede.' }))
      rispondi[1]!(risposta(403, { error: 'Non hai accesso a questa sede.' }))
    })

    // Qui non c'è nessuna ricarica a rimediare: `load()` rilegge le materie e
    // non tocca `assoc`, che viene letto una volta sola al montaggio. Se il
    // ripristino sbaglia, la tendina resta su un obiettivo rifiutato finché non
    // si cambia classe.
    await waitFor(() => {
      expect([tendine()[1]!.value, tendine()[2]!.value]).toEqual(['', ''])
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Non hai accesso a questa sede.')
  })

  it('MaterieManager: la stessa tendina non parte due volte mentre la prima è in volo', async () => {
    // Qui il ripristino per chiave non basterebbe e non è un dettaglio: il
    // «valore di prima» del secondo cambio è il primo, che il server non ha
    // ancora accettato. L'unica risposta onesta è non far partire la seconda.
    const rispondi: ((r: unknown) => void)[] = []
    const post = vi.fn()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/materia-obiettivo')) {
        post()
        return new Promise((ok) => { rispondi.push(ok) })
      }
      if (url.includes('/materia-obiettivo')) return Promise.resolve(risposta(200, { success: true, data: [] }))
      if (url.includes('/obiettivi')) return Promise.resolve(risposta(200, { success: true, data: [OB_MAT, OB_ITA] }))
      return Promise.resolve(risposta(200, { success: true, data: [MATERIA, ITALIANO] }))
    })

    render(<MaterieManager sectionId={SEZIONE} sezione={{ name: '1A' }} userId={UTENTE} scuolaId={SEDE_A} />)
    await screen.findByText('Matematica')

    fireEvent.change(tendine()[1]!, { target: { value: 'o1' } })
    fireEvent.change(tendine()[1]!, { target: { value: '' } }) // ci si ripensa, ma la prima è ancora in volo
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))

    await act(async () => { rispondi[0]!(risposta(403, { error: 'Non hai accesso a questa sede.' })) })

    await waitFor(() => expect(tendine()[1]!.value).toBe(''))
    // E risposto il primo, la tendina torna scrivibile.
    await waitFor(() => expect(tendine()[1]!.disabled).toBe(false))
  })

  it('MaterieManager: una sola tendina rifiutata torna al valore di prima, non al vuoto', async () => {
    // Il caso semplice, che prima di oggi non era coperto da nessun test: la
    // riga `if (!ok) setAssoc(...)` si poteva CANCELLARE e la suite restava
    // verde. E il valore giusto non è «vuoto»: è quello che c'era.
    const rispondi: ((r: unknown) => void)[] = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/materia-obiettivo')) {
        return new Promise((ok) => { rispondi.push(ok) })
      }
      if (url.includes('/materia-obiettivo')) {
        return Promise.resolve(risposta(200, { success: true, data: [{ materia_id: MATERIA.id, obiettivo_id: 'o1' }] }))
      }
      if (url.includes('/obiettivi')) return Promise.resolve(risposta(200, { success: true, data: [OB_MAT, OB_ITA] }))
      return Promise.resolve(risposta(200, { success: true, data: [MATERIA, ITALIANO] }))
    })

    render(<MaterieManager sectionId={SEZIONE} sezione={{ name: '1A' }} userId={UTENTE} scuolaId={SEDE_A} />)
    await screen.findByText('Matematica')
    await waitFor(() => expect(tendine()[1]!.value).toBe('o1'))

    fireEvent.change(tendine()[1]!, { target: { value: '' } }) // «— nessuno —»
    await waitFor(() => expect(rispondi).toHaveLength(1))
    await act(async () => { rispondi[0]!(risposta(403, { error: 'Non hai accesso a questa sede.' })) })

    await waitFor(() => expect(tendine()[1]!.value).toBe('o1'))
  })
})

// =============================================================================
// IL TERZO CASO: L'IBRIDO — QUELLO CHE MOSTRAVA L'ERRORE E LO REGISTRAVA LO
// STESSO.
//
// `ScrutinioGiudiziManager.salva` scriveva `setMsg(r.ok ? … : …)`, e un rigo
// PRIMA scriveva comunque lo stato ottimistico. Avviso rosso in cima, e sotto
// `testi` che dichiarava salvato un testo che il database non aveva.
//
// Non è un difetto estetico, perché `testi` non è decorazione: è il valore con
// cui `onBlur` confronta per decidere se risalvare. Registrato il rifiuto come
// se fosse riuscito, il tentativo successivo sullo stesso campo veniva scartato
// come «non è cambiato niente» — l'avviso diceva «riprova» e il codice,
// riprovando, non faceva più niente. È così che si misura qui: contando le POST.
// =============================================================================

describe('ScrutinioGiudiziManager · un salvataggio rifiutato non si registra come riuscito', () => {
  const PERIODO = { id: '55555555-5555-4555-8555-555555555555', nome: 'Primo quadrimestre', anno_scolastico: '2026/2027' }
  const SEZIONE_1A = { id: SEZIONE, name: '1A', school_type: 'primaria' }

  // ⚠️ QUI LA RETE È GIÙ, E NON È UN DETTAGLIO DELLO SCENARIO. Su un rifiuto del
  // server `muta` RICARICA, e la ricarica da sola rimetterebbe a posto `testi`
  // anche lasciando dentro la scrittura ottimistica: il test sarebbe verde con e
  // senza la correzione. Con la rete giù non si ricarica niente — è documentato
  // nel contratto di `creaMuta` — e resta esposta l'unica cosa che qui si vuole
  // misurare: che lo stato NON venga scritto quando il server non ha accettato.
  // (Verificato rimettendo la riga vecchia: il test torna rosso.)
  it('la rete giù si vede, nomina materia e voto, e il secondo tentativo riparte davvero', async () => {
    const post = vi.fn()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        post()
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      if (url.includes('/scrutinio-periodi')) return Promise.resolve(risposta(200, { success: true, data: [PERIODO] }))
      if (url.includes('/scrutinio-giudizio')) return Promise.resolve(risposta(200, { success: true, data: [] }))
      if (url.includes('/primaria/giudizi')) return Promise.resolve(risposta(200, { success: true, data: { scala: [{ etichetta: 'Avanzato', ordine: 1 }] } }))
      if (url.includes('/admin/sections')) return Promise.resolve(risposta(200, [SEZIONE_1A]))
      if (url.includes('/primaria/materie')) return Promise.resolve(risposta(200, { success: true, data: [{ ...MATERIA }] }))
      return Promise.resolve(risposta(200, { success: true, data: [] }))
    })

    render(<ScrutinioGiudiziManager scuolaId={SEDE_A} userId={UTENTE} />)
    const campo = await screen.findByPlaceholderText('Testo del giudizio per questo voto…')

    fireEvent.change(campo, { target: { value: 'Padroneggia il calcolo scritto.' } })
    fireEvent.blur(campo)

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Matematica')
    expect(avviso.textContent).toContain('Avanzato')
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))

    // Stesso testo, secondo tentativo: DEVE ripartire. Prima non ripartiva,
    // perché il rifiuto era stato registrato come se fosse andato a buon fine.
    fireEvent.blur(campo)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  })
})
