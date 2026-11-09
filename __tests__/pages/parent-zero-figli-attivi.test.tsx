import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'

/**
 * «I LEGAMI CI SONO, MA NESSUN FIGLIO È ATTIVO» — le pagine non devono girare per sempre.
 *
 * Dalla PR 4.4 un bambino ritirato, archiviato o senza sezione non è più un figlio attivo: `useParentIdentity` dà
 * `{ ready: true, studentId: null, inAttesa: true }`. Le pagine costruite su uno `studentId` partivano in caricamento e uscivano
 * dalla lettura senza spegnerlo, e `GuardiaSenzaFigli` copriva solo i genitori senza nessun legame. `BottomNav` lascia raggiungibili
 * Diario e Foto, quindi una famiglia ci arrivava al primo tocco.
 *
 * L'identità qui è quella VERA, con la sola fetch finta: un mock del hook proverebbe il mock.
 */

// Il router DEVE essere lo stesso oggetto a ogni render, come quello vero di Next: vedi `genitore-senza-figli.test.tsx`.
const mockRouter = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }
let mockSearch = new URLSearchParams()
let mockPathname = '/parent'

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
  useParams: () => ({}),
}))

import { useParentIdentity, invalidaFigliCache } from '@/lib/auth/use-parent-identity'
import { GuardiaSenzaFigli, eRottaSenzaFiglioAttivo } from '@/components/features/parent/GuardiaSenzaFigli'
import GalleriaPagina from '@/app/(dashboard)/parent/gallery/page'
import DiarioPagina from '@/app/(dashboard)/parent/diary/page'
import CompitiPagina from '@/app/(dashboard)/parent/compiti/page'
import LezioniPagina from '@/app/(dashboard)/parent/lezioni/page'
import NotePagina from '@/app/(dashboard)/parent/primaria/note/page'
import OrarioPagina from '@/app/(dashboard)/parent/primaria/orario/page'
import PagellePagina from '@/app/(dashboard)/parent/primaria/pagelle/page'
import ValutazioniPagina from '@/app/(dashboard)/parent/primaria/valutazioni/page'
import AvvisiPagina from '@/app/(dashboard)/parent/avvisi/page'
import NewsPagina from '@/app/(dashboard)/parent/news/page'
import ChatPagina from '@/app/(dashboard)/parent/chat/page'
import ModulisticaPagina from '@/app/(dashboard)/parent/modulistica/page'
import VotazioniPagina from '@/app/(dashboard)/parent/votazioni/page'
import catalogoIt from '../../messages/it/parentServizi.json'
import catalogoEn from '../../messages/en/parentServizi.json'

const fetchMock = vi.fn()
const risposta = (body: unknown) => ({ ok: true, json: async () => body })
const inAttesa = (motivo: string | null) => ({
  success: true,
  data: [],
  in_attesa: true,
  senza_figli: false,
  motivo_assenza: motivo,
})

/** Lo spinner, o la riga «Caricamento…» delle pagine della primaria. */
function inCaricamento(): boolean {
  return document.querySelector('.animate-spin') !== null || /caricamento/i.test(document.body.textContent ?? '')
}

const pannello = () => document.querySelector('[data-kv-senza-figli-attivi]')

/**
 * La sonda ha chiesto e ha letto la risposta, e React ha reso: senza, l'assenza del pannello sarebbe vera per forza.
 */
async function sondaFinita() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const PAGINE: Array<[string, ComponentType]> = [
  ['/parent/gallery', GalleriaPagina],
  ['/parent/diary', DiarioPagina],
  ['/parent/compiti', CompitiPagina],
  ['/parent/lezioni', LezioniPagina],
  ['/parent/primaria/note', NotePagina],
  ['/parent/primaria/orario', OrarioPagina],
  ['/parent/primaria/pagelle', PagellePagina],
  ['/parent/primaria/valutazioni', ValutazioniPagina],
]

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  invalidaFigliCache()
  window.localStorage.clear()
  window.localStorage.setItem('kv_user_id', 'P1')
  mockSearch = new URLSearchParams()
  mockPathname = '/parent'
  vi.stubGlobal('fetch', fetchMock)
})

describe('useParentIdentity — la forma del caso', () => {
  it('legami senza nessun figlio attivo ⇒ pronto, nessuno `studentId`, `inAttesa`', async () => {
    fetchMock.mockResolvedValue(risposta(inAttesa('ritirato')))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.studentId).toBeNull()
    expect(result.current.inAttesa).toBe(true)
    expect(result.current.senzaFigli).toBe(false)
  })
})

describe('le otto pagine che si costruiscono su uno `studentId`', () => {
  it.each(PAGINE)('%s: non resta in caricamento, mostra il pannello', async (rotta, Pagina) => {
    mockPathname = rotta
    fetchMock.mockResolvedValue(risposta(inAttesa('ritirato')))

    render(
      <GuardiaSenzaFigli>
        <Pagina />
      </GuardiaSenzaFigli>,
    )

    // Prima della risposta la pagina gira. Se il selettore non vedesse questo, la prova qui sotto non misurerebbe niente.
    expect(inCaricamento()).toBe(true)

    await waitFor(() => expect(inCaricamento()).toBe(false))
    expect(pannello()).not.toBeNull()
    expect(screen.getByRole('heading', { name: catalogoIt.nonPiuIscrittoTitolo })).toBeTruthy()
    expect(screen.getByRole('link', { name: catalogoIt.inAttesaPagamenti }).getAttribute('href')).toBe('/parent/pagamenti')
  })
})

// I pagamenti non ci sono: chiedono solo `userId`, e il `t` instabile del finto globale manda `StoricoPagamenti` in un giro
// infinito (è scritto in `pagamenti-senza-realtime.test.tsx`). Il passaggio della rotta lo prova il segnaposto più sotto.
describe('le pagine che passano: con la stessa identità non restano appese', () => {
  const CHE_PASSANO: Array<[string, ComponentType]> = [
    ['/parent/avvisi', AvvisiPagina],
    ['/parent/news', NewsPagina],
    ['/parent/chat', ChatPagina],
    ['/parent/modulistica', ModulisticaPagina],
    ['/parent/votazioni', VotazioniPagina],
  ]

  it.each(CHE_PASSANO)('%s: finisce di caricare, senza il pannello', async (rotta, Pagina) => {
    mockPathname = rotta
    // Il feed degli avvisi è un array nudo, tutto il resto la busta `{ success, data }`.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/parent/students')) return risposta(inAttesa('ritirato'))
      return risposta(url.startsWith('/api/avvisi') ? [] : { success: true, data: [] })
    })

    render(
      <GuardiaSenzaFigli>
        <Pagina />
      </GuardiaSenzaFigli>,
    )

    await sondaFinita()
    await waitFor(() => expect(inCaricamento()).toBe(false))
    expect(pannello()).toBeNull()
  })
})

describe('GuardiaSenzaFigli — zero figli attivi', () => {
  const montaSegnaposto = () =>
    render(
      <GuardiaSenzaFigli>
        <p>contenuto della pagina</p>
      </GuardiaSenzaFigli>,
    )

  it.each([
    ['ritirato', 'nonPiuIscritto'],
    ['archiviato', 'nonPiuIscritto'],
    ['senza-sezione', 'inAttesa'],
    [null, 'inAttesa'],
  ] as const)('motivo %s: la frase è quella di %s', async (motivo, prefisso) => {
    mockPathname = '/parent/diary'
    fetchMock.mockResolvedValue(risposta(inAttesa(motivo)))
    montaSegnaposto()

    const titolo = prefisso === 'nonPiuIscritto' ? catalogoIt.nonPiuIscrittoTitolo : catalogoIt.inAttesaTitolo
    const testo = prefisso === 'nonPiuIscritto' ? catalogoIt.nonPiuIscrittoTesto : catalogoIt.inAttesaTesto
    expect(await screen.findByRole('heading', { name: titolo })).toBeTruthy()
    expect(screen.getByText(testo)).toBeTruthy()
    expect(screen.queryByText('contenuto della pagina')).toBeNull()
  })

  it.each([
    '/parent',
    '/parent/pagamenti',
    '/parent/chat',
    '/parent/avvisi',
    '/parent/news',
    '/parent/news/digest/abc',
    '/parent/modulistica',
    '/parent/forms/abc',
    '/parent/votazioni',
    '/parent/profilo',
    '/parent/onboarding',
  ])('%s funziona senza un figlio scelto: la pagina resta', async (rotta) => {
    mockPathname = rotta
    fetchMock.mockResolvedValue(risposta(inAttesa('ritirato')))
    montaSegnaposto()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // La sonda deve aver letto la risposta, altrimenti l'assenza del pannello è vera per forza.
    await new Promise((r) => setTimeout(r, 0))
    expect(pannello()).toBeNull()
    expect(screen.getByText('contenuto della pagina')).toBeTruthy()
  })

  it('OFFLINE ⇒ la pagina: l\'assenza di una risposta non è «nessun figlio attivo»', async () => {
    mockPathname = '/parent/diary'
    // PR 4.5.11: con un bambino già noto (cache del telefono) la pagina resta; senza nessuno noto il guardiano mostra «Non riesco a
    // verificare l'iscrizione» con il pulsante (`GuardiaSenzaFigli-ingresso-futuro.test.tsx`), mai una rotella senza fine.
    window.localStorage.setItem('kv_student_id', 'S1')
    fetchMock.mockRejectedValue(new Error('rete giù'))
    montaSegnaposto()

    await sondaFinita()
    expect(pannello()).toBeNull()
    expect(screen.getByText('contenuto della pagina')).toBeTruthy()
  })

  it('un figlio visibile ⇒ la pagina, anche se il server mandasse `in_attesa`', async () => {
    mockPathname = '/parent/diary'
    fetchMock.mockResolvedValue(risposta({ ...inAttesa('ritirato'), data: [{ id: 'S1', nome: 'Finto' }] }))
    montaSegnaposto()

    await sondaFinita()
    expect(pannello()).toBeNull()
    expect(screen.getByText('contenuto della pagina')).toBeTruthy()
  })

  it('PRIMA della risposta si vede già la pagina: nessun lampo di pannello per chi ha figli', () => {
    mockPathname = '/parent/diary'
    fetchMock.mockReturnValue(new Promise(() => {}))
    montaSegnaposto()

    expect(pannello()).toBeNull()
    expect(screen.getByText('contenuto della pagina')).toBeTruthy()
  })

  it('zero legami su una rotta che passa ⇒ resta il pannello di sempre, col link al profilo', async () => {
    mockPathname = '/parent/pagamenti'
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], in_attesa: false, senza_figli: true }))
    montaSegnaposto()

    expect(await screen.findByRole('heading', { name: catalogoIt.senzaFigliTitolo })).toBeTruthy()
    expect(document.querySelector('[data-kv-senza-figli]')).not.toBeNull()
    expect(pannello()).toBeNull()
    expect(screen.getByRole('link', { name: catalogoIt.senzaFigliProfilo }).getAttribute('href')).toBe('/parent/profilo')
  })

  it('il link ai pagamenti ha la sua frase in italiano e in inglese', () => {
    expect(catalogoIt.inAttesaPagamenti).toBe('Vai ai pagamenti')
    expect(catalogoEn.inAttesaPagamenti).toBe('Go to payments')
  })
})

describe('eRottaSenzaFiglioAttivo', () => {
  it.each([
    '/parent',
    '/parent/pagamenti',
    '/parent/pagamenti/abc',
    '/parent/chat',
    '/parent/avvisi',
    '/parent/news',
    '/parent/news/digest',
    '/parent/news/digest/abc',
    '/parent/modulistica',
    '/parent/forms/abc',
    '/parent/votazioni',
    '/parent/profilo',
    '/parent/onboarding',
  ])('%s sì', (rotta) => {
    expect(eRottaSenzaFiglioAttivo(rotta)).toBe(true)
  })

  it.each([
    '/parent/gallery',
    '/parent/diary',
    '/parent/compiti',
    '/parent/lezioni',
    '/parent/locker',
    '/parent/mensa',
    '/parent/attendance',
    '/parent/primaria',
    '/parent/primaria/assenze',
    '/parent/primaria/note',
    '/parent/primaria/orario',
    '/parent/primaria/pagelle',
    '/parent/primaria/valutazioni',
    // Una rotta che comincia allo stesso modo è un'altra rotta: il confronto si ferma alla barra.
    '/parent/pagamentix',
    '/parent/newsletter',
    '/parentela',
    '/admin',
  ])('%s no', (rotta) => {
    expect(eRottaSenzaFiglioAttivo(rotta)).toBe(false)
  })

  it('senza un percorso: no', () => {
    expect(eRottaSenzaFiglioAttivo(null)).toBe(false)
  })
})
