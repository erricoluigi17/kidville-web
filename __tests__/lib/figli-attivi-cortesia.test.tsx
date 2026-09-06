import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

/**
 * «L'ISCRIZIONE È IN LAVORAZIONE» — la schermata che non fa sembrare un genitore
 * un utente senza figli.
 *
 * Dal 2026-09-05 l'app di famiglia non mostra più i figli senza classe, ritirati
 * o archiviati. Per QUATTRO account genitore in produzione quelli erano TUTTI i
 * figli: nascondere a secco, per loro, è un'app vuota senza spiegazione e senza
 * niente da fare. La differenza fra «non ho figli» e «i miei figli non sono
 * ancora visibili» la sa solo il server, e viaggia in `in_attesa`.
 *
 * ⚠️ E NON DEVE SCATTARE QUANDO LA RETE È GIÙ: anche lì `studentId` è `null` e
 * l'elenco è vuoto, ma mandare in segreteria chi è semplicemente offline è
 * peggio di non dire niente.
 */

const mockRouter = { replace: vi.fn(), refresh: vi.fn() }
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => '/parent',
}))

/**
 * `logClient` finto, `nomeErrore` VERO: l'ultimo blocco di questo file guarda che la home
 * non inghiotta più il guasto della lettura del nome, e ci vuole un posto dove le righe
 * si possano contare. Il resto del modulo resta quello vero — un mock intero avrebbe
 * spento anche la politica dei livelli, che è metà di ciò che si sta collaudando.
 */
const logClientFinto = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/client')>()
  return { ...reale, logClient: logClientFinto }
})

import { useParentIdentity, invalidaFigliCache } from '@/lib/auth/use-parent-identity'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` azzera le CHIAMATE, non l'implementazione: un
  // `mockImplementation` scritto in un test sopravviverebbe a quello dopo. Qui
  // sotto ogni test la propria risposta, quindi si riparte davvero da zero.
  fetchMock.mockReset()
  // La cache dei figli è di MODULO: senza svuotarla il test successivo
  // riceverebbe la risposta finta del precedente.
  invalidaFigliCache()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  vi.stubGlobal('fetch', fetchMock)
})

const risposta = (body: unknown) => ({ ok: true, json: async () => body })

describe('useParentIdentity — `inAttesa`', () => {
  it('elenco vuoto e `in_attesa: true` ⇒ inAttesa vero', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true }))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.inAttesa).toBe(true)
    expect(result.current.studentId).toBeNull()
  })

  it('PROVA NEGATIVA — arriva un figlio visibile e la cortesia sparisce', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true }))
    const primo = renderHook(() => useParentIdentity())
    await waitFor(() => expect(primo.result.current.ready).toBe(true))
    expect(primo.result.current.inAttesa).toBe(true)

    invalidaFigliCache()
    fetchMock.mockResolvedValue(risposta({ success: true, data: [{ id: 'A' }], in_attesa: false }))
    const secondo = renderHook(() => useParentIdentity())
    await waitFor(() => expect(secondo.result.current.ready).toBe(true))
    expect(secondo.result.current.inAttesa).toBe(false)
    expect(secondo.result.current.studentId).toBe('A')
  })

  it('nessun figlio e nessun legame (`in_attesa` assente) ⇒ inAttesa FALSO', async () => {
    // Chi davvero non ha figli non deve leggere «stiamo completando l'iscrizione».
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [] }))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.inAttesa).toBe(false)
  })

  it('rete giù ⇒ inAttesa FALSO: l\'offline non è un\'iscrizione incompleta', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    window.localStorage.setItem('kv_student_id', 'noto')
    fetchMock.mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.inAttesa).toBe(false)
    expect(result.current.studentId, 'una cache buona non si butta per un blip di rete').toBe('noto')
  })

  it('endpoint non-ok ⇒ inAttesa FALSO (un 500 non è una segreteria da chiamare)', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.inAttesa).toBe(false)
  })

  it('la HOME mostra davvero la frase, e non un\'app vuota', async () => {
    // Il campo da solo non basta: fino a ieri la home non aveva nessun ramo per
    // questo caso, e il test che guarda solo l'hook sarebbe verde con la
    // schermata mai scritta. Qui si monta la pagina vera e si legge il testo del
    // catalogo italiano (`test/setup.ts` risolve le chiavi sui file reali).
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const it = await import('../../messages/it/parentServizi.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true }))

    render(<ParentHomePage />)
    await waitFor(() => expect(screen.getByText(it.default.inAttesaTitolo)).toBeTruthy())
    expect(screen.getByText(it.default.inAttesaTesto)).toBeTruthy()
    // E la home normale NON c'è: niente azioni rapide su un'app che non ha
    // ancora un bambino da mostrare.
    expect(screen.queryByText(/Assenza/i)).toBeNull()
  })

  it('PROVA NEGATIVA sulla home — con un figlio visibile la cortesia NON compare', async () => {
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const it = await import('../../messages/it/parentServizi.json')
    const itHome = await import('../../messages/it/home.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    // Mock PER ROTTA e non piatto: la home vera monta anche presenze, avvisi,
    // galleria, armadietto e agenda, e servire a tutte l'elenco dei figli
    // significa passare a una card un corpo che il suo endpoint non restituisce
    // mai (misurato: `PresenzeTodayCard` esplodeva su `oggi.stato`). Le altre
    // rotte rispondono «non disponibile», che è uno stato che quelle card devono
    // saper reggere: qui si collauda QUALE SCHERMATA compare, non le card.
    fetchMock.mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).includes('/api/parent/students')
          ? risposta({
              success: true,
              data: [{ id: 'A', nome: 'Primo', cognome: 'Prova', classe_sezione: '3 ANNI A' }],
              in_attesa: false,
            })
          : { ok: false, json: async () => ({}) },
      ),
    )

    render(<ParentHomePage />)

    /**
     * ⚠️ PRIMA LA PROVA POSITIVA, POI L'ASSENZA — e l'ordine È il test.
     *
     * Scritto al contrario — `await waitFor(() => expect(queryByText(titolo)).toBeNull())`
     * — questo test NON POTEVA FALLIRE: `waitFor` si accontenta del PRIMO giro, e al
     * primo giro l'identità è ancora in volo, quindi la cortesia non c'è comunque e
     * l'assenza si verifica da sé. Misurato: cambiando `if (ready && inAttesa)` in
     * `if (ready)` — cioè mostrando la cortesia AL POSTO della home a TUTTI i genitori
     * — tutti e 8 i test di questo file restavano VERDI.
     *
     * «Oggi a scuola» è la prova positiva giusta e non una qualsiasi: sta dietro
     * `parentId && studentId`, quindi compare SOLO a identità risolta e figlio
     * arrivato. `kv_student_id` non è in localStorage e non c'è `?id=` nell'URL: fino
     * alla risposta `studentId` è nullo, e quella sezione non esiste. Un titolo di
     * quelli incondizionati (l'agenda, il footer) sarebbe già a schermo al primo
     * giro, cioè ripeterebbe l'errore di prima con un'altra stringa.
     */
    await screen.findByText(itHome.default.titoloOggiAScuola)
    expect(screen.queryByText(it.default.inAttesaTitolo)).toBeNull()
    expect(screen.queryByText(it.default.inAttesaTesto)).toBeNull()
  })

  it('il MOTIVO arriva fino all\'hook: `archiviato` non è `senza-sezione`', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true, motivo_assenza: 'archiviato' }))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.motivoAssenza).toBe('archiviato')
  })

  it('un motivo che non è uno dei TRE vale `null`: la rete non sceglie le schermate', async () => {
    // Un valore nuovo lato server non deve poter mandare a schermo un ramo che
    // nessuno ha scritto: si ricade sulla frase generica, cioè su ieri.
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true, motivo_assenza: 'trasferito' }))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.inAttesa).toBe(true)
    expect(result.current.motivoAssenza).toBeNull()
  })

  it('con un figlio visibile il motivo NON sopravvive all\'elenco pieno', async () => {
    // Un motivo che resta valorizzato mentre i figli ci sono è solo un campo che
    // aspetta di essere letto per sbaglio: qui la cortesia non esiste proprio.
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({
      success: true, data: [{ id: 'A' }], in_attesa: false, motivo_assenza: 'archiviato',
    }))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.motivoAssenza).toBeNull()
  })

  it('la HOME di un figlio ARCHIVIATO non promette una classe che non arriverà', async () => {
    // ⚠️ IL CASO MISURATO IN PRODUZIONE IL 2026-09-06: dei 4 account senza figli
    // visibili, 3 hanno l'unico figlio senza sezione e 1 ce l'ha ARCHIVIATO. A
    // quest'ultimo l'app diceva «Stiamo completando l'iscrizione: appena la classe
    // è assegnata qui compare tutto» — un'iscrizione che non esiste e una classe
    // che non arriverà, sull'unica schermata che la sua app gli mostra.
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const it = await import('../../messages/it/parentServizi.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true, motivo_assenza: 'archiviato' }))

    render(<ParentHomePage />)
    await waitFor(() => expect(screen.getByText(it.default.nonPiuIscrittoTitolo)).toBeTruthy())
    expect(screen.getByText(it.default.nonPiuIscrittoTesto)).toBeTruthy()
    // La frase falsa non resta accanto a quella vera: si contraddirebbero da sole.
    expect(screen.queryByText(it.default.inAttesaTitolo)).toBeNull()
    expect(screen.queryByText(it.default.inAttesaTesto)).toBeNull()
    // La strada resta una e resta scritta: senza questa riga il testo potrebbe
    // diventare una condoglianza senza niente da fare.
    expect(it.default.nonPiuIscrittoTesto).toContain('segreteria')
  })

  it('la HOME di un figlio SENZA SEZIONE tiene la frase dell\'attesa: per lui è vera', async () => {
    // La prova che il ramo nuovo non si è mangiato quello vecchio — cioè i 3
    // account su 4 per cui «appena la classe è assegnata» è un'informazione giusta.
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const it = await import('../../messages/it/parentServizi.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: true, motivo_assenza: 'senza-sezione' }))

    render(<ParentHomePage />)
    await waitFor(() => expect(screen.getByText(it.default.inAttesaTitolo)).toBeTruthy())
    expect(screen.queryByText(it.default.nonPiuIscrittoTitolo)).toBeNull()
  })

  it('`fetchFigli` resta l\'elenco nudo: `ChildSwitcher` non cambia contratto', async () => {
    const { fetchFigli } = await import('@/lib/auth/use-parent-identity')
    fetchMock.mockResolvedValue(risposta({
      success: true,
      data: [{ id: 'A', nome: 'Primo', cognome: 'Prova', classe_sezione: '3 ANNI A' }],
      in_attesa: false,
    }))
    const lista = await fetchFigli('P1')
    expect(Array.isArray(lista)).toBe(true)
    expect(lista?.[0]).toMatchObject({ id: 'A', nome: 'Primo', classe_sezione: '3 ANNI A' })
  })
})

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IL `catch` CHE NON DICEVA NIENTE — AGENTS.md regola 6, sulla stessa `useEffect`.
 *
 * `fetch('/api/diary/students').…​.catch(() => {})` stava in questo file da prima di
 * questo lavoro, quattro righe sopra il ramo della cortesia. L'effetto pratico: se il
 * nome del bambino non si carica per un guasto di rete, la home saluta «Ciao!» invece che
 * per nome e non resta traccia di niente — cioè un guasto prende l'aspetto di una scelta
 * di prodotto, che è esattamente la firma del guasto delle email di credenziali.
 *
 * Le prove stanno QUI e non in un file proprio perché montare la home vera costa un
 * render lento: questo file la monta già, e due banchi che montano la stessa pagina
 * pagano due volte lo stesso prezzo per la stessa cosa.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
describe('home del genitore — il nome che non arriva lascia una riga, non il silenzio', () => {
  /** Il figlio c'è (quindi la home vera si monta), ma la lettura del nome fallisce. */
  const homeConNomeRotto = () =>
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/parent/students')) {
        return Promise.resolve(risposta({
          success: true,
          data: [{ id: 'A', nome: 'Primo', cognome: 'Prova', classe_sezione: '3 ANNI A' }],
          in_attesa: false,
        }))
      }
      if (url.includes('/api/diary/students')) return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve({ ok: false, json: async () => ({}) })
    })

  const righeNome = () =>
    logClientFinto.mock.calls.filter(
      (c) => typeof c[0]?.messaggio === 'string' && c[0].messaggio.includes('home-nome-figlio-non-letto'),
    )

  it('la lettura fallita del nome produce una riga di `warn`', async () => {
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const itHome = await import('../../messages/it/home.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    homeConNomeRotto()

    render(<ParentHomePage />)
    await screen.findByText(itHome.default.titoloOggiAScuola)
    await waitFor(() => expect(righeNome().length).toBeGreaterThan(0))

    const riga = righeNome()[0][0]
    // `warn` e non `error`: il nome è cosmetico e la pagina resta usabile. Non è
    // `info` perché il canale del client non ce l'ha — `/api/logs` lo rifiuta.
    expect(riga.livello).toBe('warn')
    expect(riga.evento).toBe('fetch')
    expect(riga.route).toBe('/parent')
  })

  it('nella riga niente URL e nessun id di minore: solo il NOME dell\'errore', async () => {
    // Il `message` di una fetch fallita si porta dietro l'indirizzo chiamato, e in
    // quell'indirizzo c'è `?id=<uuid del bambino>`. Passa solo `nomeErrore`.
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const itHome = await import('../../messages/it/home.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    homeConNomeRotto()

    render(<ParentHomePage />)
    await screen.findByText(itHome.default.titoloOggiAScuola)
    await waitFor(() => expect(righeNome().length).toBeGreaterThan(0))

    const testo = JSON.stringify(righeNome()[0][0])
    expect(testo).not.toContain('/api/diary/students')
    expect(testo).not.toContain('Primo')
  })

  it('col nome che arriva NON si logga niente: un logger loquace acceca', async () => {
    const { render, screen } = await import('@testing-library/react')
    const { default: ParentHomePage } = await import('@/app/(dashboard)/parent/page')
    const itHome = await import('../../messages/it/home.json')

    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/parent/students')) {
        return Promise.resolve(risposta({
          success: true,
          data: [{ id: 'A', nome: 'Primo', cognome: 'Prova', classe_sezione: '3 ANNI A' }],
          in_attesa: false,
        }))
      }
      if (url.includes('/api/diary/students')) {
        return Promise.resolve(risposta({ nome: 'Primo', classe_sezione: '3 ANNI A' }))
      }
      return Promise.resolve({ ok: false, json: async () => ({}) })
    })

    render(<ParentHomePage />)
    await screen.findByText(itHome.default.titoloOggiAScuola)
    expect(righeNome()).toHaveLength(0)
  })
})
