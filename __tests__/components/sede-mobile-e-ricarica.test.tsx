import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { NextRequest } from 'next/server'

// =============================================================================
// W3-D — IL SELETTORE DI SEDE SUL TELEFONO, E IL CAMBIO SEDE CHE RICARICA.
//
// Due difetti con la stessa radice: la sede scelta non fa il giro.
//
// R73 — `<SedeSelector/>` era montato in UN solo posto, dentro l'header desktop
//   `hidden … lg:flex`. Sotto i 1024px (telefono e app nativa Capacitor, che è
//   una WebView a larghezza telefono) non c'era NIENTE per sceglierla: né in
//   `AdminTopBarMobile`, né nella bottom-nav, né nel bottom-sheet «Menu». Con
//   tre sedi in produzione la Direzione ha `sedeCorrente === null`, quindi tutte
//   le pagine con `SedeRequired` mostrano «Seleziona una sede» — un avviso che
//   chiede una cosa che in quella schermata è IMPOSSIBILE fare. E dal
//   2026-07-31 `resolveScuolaScrittura` risponde davvero 400 sulla sede
//   ambigua: dal telefono non era più possibile nemmeno SCRIVERE.
//
// R74 — `reFetchKey` era una convenzione, non un vincolo: referenziata in 2 soli
//   file su tutto il cockpit. Cambiando sede, dashboard, avvisi, messaggi,
//   staff, sezioni… restavano sui dati della sede precedente finché non si
//   ricaricava la pagina a mano. In home convivevano due numeri di alunni
//   diversi: il contatore dentro il selettore (deps `effettive`) si aggiornava,
//   la card KPI (deps `[ready, userId]`) no.
//
// Qui i provider sono quelli VERI (`AdminIdentityProvider` + `SedeProvider` +
// `SedeScopeBoundary` + `SedeRequired`) e il resolver server è quello VERO
// (`resolveScuolaScrittura` con il finto client che filtra davvero): finta è
// solo la rete. L'ultimo test chiude il giro — dal tocco sul telefono al cookie
// che il server legge per decidere in quale sede scrivere.
//
// Regola di questa famiglia di test (audit 2026-07-30, due falsi verdi): niente
// `not.toBe(…)` come controllo positivo. Si asserisce il valore atteso — la
// sede esatta, il conteggio esatto dei montaggi, lo stato esatto della risposta.
// =============================================================================

import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { AdminIdentityProvider } from '@/lib/context/admin-identity'
import { SedeProvider, SedeRequired, SedeScopeBoundary, useSediAttive } from '@/lib/context/sede-context'
import { AdminBottomNav } from '@/components/features/admin/AdminBottomNav'
import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import type { AppUser } from '@/lib/auth/require-staff'

// ── la Direzione multi-sede: tre plessi, come in produzione ──────────────────

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ADMIN_TRE_SEDI: AppUser = { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A }

const TRE_SEDI = [
  { id: SEDE_A, nome: NOME_SEDE_A },
  { id: SEDE_B, nome: NOME_SEDE_B },
  { id: SEDE_C, nome: NOME_SEDE_C },
]

/** Il finto client per il resolver server: il ponte `utenti_scuole` dell'admin. */
function supabaseDellAdmin() {
  return creaFintoSupabase(
    {
      utenti_scuole: [
        { utente_id: ID_ADMIN, scuola_id: SEDE_A },
        { utente_id: ID_ADMIN, scuola_id: SEDE_B },
        { utente_id: ID_ADMIN, scuola_id: SEDE_C },
      ],
    },
    [],
  )
}

/** La richiesta che il browser manderebbe: al resolver serve solo il cookie. */
function richiestaColCookieCorrente(): NextRequest {
  const valore = cookieSedi()
  return {
    cookies: {
      get: (nome: string) => (nome === 'sedi_attive' && valore !== null ? { value: valore } : undefined),
    },
  } as unknown as NextRequest
}

/** Il cookie `sedi_attive` come lo vede il browser (null se assente). */
function cookieSedi(): string | null {
  const voce = document.cookie.split('; ').find((c) => c.startsWith('sedi_attive='))
  if (!voce) return null
  return decodeURIComponent(voce.slice('sedi_attive='.length))
}

// ── la rete finta ────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ sedi: [] as { id: string; nome: string }[] }))

/** Ogni chiamata registra il cookie ATTIVO in quel momento: è ciò che il server legge. */
const chiamate: { url: string; cookie: string | null }[] = []
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  chiamate.length = 0
  h.sedi = TRE_SEDI
  document.cookie = 'sedi_attive=; path=/; max-age=0'
  fetchMock.mockImplementation((url: string) => {
    chiamate.push({ url: String(url), cookie: cookieSedi() })
    const u = String(url)
    const corpo = u.includes('/api/admin/sedi')
      ? h.sedi
      : u.includes('/api/primaria/me')
        ? { success: true, data: { ruolo: 'admin' } }
        : { studenti: { iscritti: 0 } }
    return Promise.resolve({ ok: true, status: 200, json: async () => corpo })
  })
  vi.stubGlobal('fetch', fetchMock)
})

// ── la pagina finta sotto la shell ───────────────────────────────────────────

/** Conteggi di montaggio/smontaggio: è così che si osserva un ri-caricamento. */
const vita = { montaggi: 0, smontaggi: 0 }

/**
 * Una pagina del cockpit come le peggiori di quelle vere: scarica la sua lista
 * UNA volta sola (`useEffect` con dipendenze `[]`, come `SectionsView`). Se il
 * cambio di sede non la rimonta, resta sui dati della sede precedente per
 * sempre.
 */
function PaginaCheScaricaUnaVolta() {
  const [caricata, setCaricata] = useState(false)
  useEffect(() => {
    vita.montaggi += 1
    void fetch('/api/admin/dashboard').then(() => setCaricata(true))
    return () => {
      vita.smontaggi += 1
    }
  }, [])
  return <div data-testid="pagina">{caricata ? 'lista' : 'attendo'}</div>
}

/** Una pagina di configurazione: mono-sede, quindi passa da `SedeRequired`. */
function PaginaMonoSede() {
  return <SedeRequired>{(scuolaId) => <div data-testid="configurazione">{scuolaId}</div>}</SedeRequired>
}

/**
 * Sonda sempre presente FUORI dal confine: dice quante sedi il provider ha
 * committato. Serve a `montaShell` per attendere il caricamento senza indovinare
 * i tempi — e, stando fuori dal confine, non altera i conteggi di montaggio.
 */
function SondaSedi() {
  const { sedi } = useSediAttive()
  return <div data-testid="sonda-sedi">{sedi.length}</div>
}

/** La shell mobile del cockpit: le due superfici <lg + il contenuto keyed. */
function ShellMobile({ children }: { children: React.ReactNode }) {
  return (
    <AccessibilityProvider>
      <AdminIdentityProvider>
        <SedeProvider>
          <AdminTopBarMobile />
          <SondaSedi />
          <main>
            <SedeScopeBoundary>{children}</SedeScopeBoundary>
          </main>
          <AdminBottomNav />
        </SedeProvider>
      </AdminIdentityProvider>
    </AccessibilityProvider>
  )
}

async function montaShell(children: React.ReactNode) {
  vita.montaggi = 0
  vita.smontaggi = 0
  const utils = render(<ShellMobile>{children}</ShellMobile>)
  // Le sedi accessibili sono state CARICATE E COMMITTATE: da qui in poi nessuna
  // asserzione dipende da un timing.
  await waitFor(() =>
    expect(Number(screen.getByTestId('sonda-sedi').textContent)).toBe(h.sedi.length),
  )
  return utils
}

/** Apre il bottom-sheet «Menu» della bottom-nav mobile: due tocchi, come farebbe un umano. */
async function apriMenuMobile() {
  fireEvent.click(screen.getByRole('button', { name: /menu/i }))
  return screen.findByRole('dialog')
}

// =============================================================================
// R73 — il selettore esiste anche sotto i 1024px
// =============================================================================

describe('R73 — la sede si sceglie anche dal telefono', () => {
  it('il bottom-sheet «Menu» elenca le sedi accessibili, e sceglierne una la rende la sede corrente', async () => {
    await montaShell(<PaginaMonoSede />)
    // Prima: tre sedi attive ⇒ la pagina di configurazione è bloccata.
    expect(screen.getByText('Seleziona una sede')).toBeInTheDocument()

    const sheet = await apriMenuMobile()
    // Le tre sedi accessibili, come bottoni raggiungibili col dito.
    for (const s of TRE_SEDI) {
      expect(within(sheet).getByRole('button', { name: new RegExp(s.nome) })).toBeInTheDocument()
    }

    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))

    // La pagina si sblocca CON LA SEDE SCELTA (non «una qualsiasi»).
    expect(await screen.findByTestId('configurazione')).toHaveTextContent(SEDE_B)
    expect(cookieSedi()).toBe(SEDE_B)
  })

  it('il bottom-sheet vive sotto i 1024px (`lg:hidden`): è la superficie mobile, non un doppione desktop', async () => {
    await montaShell(<PaginaMonoSede />)
    const sheet = await apriMenuMobile()
    const radice = sheet.closest('.lg\\:hidden')
    expect(radice).not.toBeNull()
  })

  it('«Tutte le sedi» rimette lo scope pieno e svuota il cookie', async () => {
    await montaShell(<PaginaMonoSede />)
    const sheet = await apriMenuMobile()
    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))
    expect(cookieSedi()).toBe(SEDE_B)

    fireEvent.click(within(sheet).getByRole('button', { name: /tutte le sedi/i }))
    expect(cookieSedi()).toBe('')
    expect(await screen.findByText('Seleziona una sede')).toBeInTheDocument()
  })

  it('la topbar mobile dice in quale sede stai lavorando', async () => {
    await montaShell(<PaginaMonoSede />)
    const bar = document.querySelector('header') as HTMLElement
    // Con tre sedi attive lo dice così: «Tutte le sedi».
    expect(within(bar).getByText(/tutte le sedi/i)).toBeInTheDocument()

    const sheet = await apriMenuMobile()
    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))
    await waitFor(() => expect(within(bar).getByText(NOME_SEDE_B)).toBeInTheDocument())
  })

  it('con UNA sola sede accessibile non c\'è niente da scegliere: nessun elenco di sedi', async () => {
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
    await montaShell(<PaginaMonoSede />)
    // Nessuna ambiguità: la pagina è già sbloccata sulla sede unica.
    expect(await screen.findByTestId('configurazione')).toHaveTextContent(SEDE_A)
    const sheet = await apriMenuMobile()
    expect(within(sheet).queryByRole('button', { name: /tutte le sedi/i })).toBeNull()
  })
})

// =============================================================================
// R73 (secondo pezzo) — l'avviso «Seleziona una sede» è azionabile
// =============================================================================

describe('R73 — l\'avviso «Seleziona una sede» si sblocca da solo', () => {
  it('offre un bottone per ciascuna sede e il click sblocca la pagina', async () => {
    await montaShell(<PaginaMonoSede />)
    const avviso = screen.getByText('Seleziona una sede').closest('div') as HTMLElement

    fireEvent.click(within(avviso).getByRole('button', { name: new RegExp(NOME_SEDE_C) }))

    expect(await screen.findByTestId('configurazione')).toHaveTextContent(SEDE_C)
    expect(cookieSedi()).toBe(SEDE_C)
  })
})

// =============================================================================
// R74 — cambiare sede ricarica davvero
// =============================================================================

describe('R74 — il cambio sede rimonta il contenuto del cockpit', () => {
  it('la pagina che scarica una volta sola viene SMONTATA e RIMONTATA al cambio sede', async () => {
    await montaShell(<PaginaCheScaricaUnaVolta />)
    await screen.findByText('lista')
    expect(vita.montaggi).toBe(1)
    expect(vita.smontaggi).toBe(0)

    const sheet = await apriMenuMobile()
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))
    })

    expect(vita.smontaggi).toBe(1)
    expect(vita.montaggi).toBe(2)
  })

  it('il caricamento iniziale delle sedi NON rimonta nulla: si rimonta solo quando l\'utente sceglie', async () => {
    await montaShell(<PaginaCheScaricaUnaVolta />)
    await screen.findByText('lista')
    // Le sedi arrivano dopo il primo render (fetch asincrona) e fanno cambiare
    // `effettive` da [] a tre id: se la chiave del confine fosse `reFetchKey`
    // grezza, ogni pagina del cockpit si ri-scaricherebbe due volte a ogni
    // apertura.
    expect(vita.montaggi).toBe(1)
    expect(vita.smontaggi).toBe(0)
  })

  it('la nuova scarica parte DOPO che il cookie è cambiato: il server la vede già nella sede giusta', async () => {
    await montaShell(<PaginaCheScaricaUnaVolta />)
    await screen.findByText('lista')
    const primaScarica = chiamate.filter((c) => c.url.includes('/api/admin/dashboard'))
    expect(primaScarica).toHaveLength(1)
    expect(primaScarica[0].cookie).toBeNull()

    const sheet = await apriMenuMobile()
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))
    })

    const scariche = chiamate.filter((c) => c.url.includes('/api/admin/dashboard'))
    expect(scariche).toHaveLength(2)
    expect(scariche[1].cookie).toBe(SEDE_B)
  })
})

// =============================================================================
// Il giro completo: dal tocco sul telefono alla decisione del server
// =============================================================================

describe('la sede scelta sul telefono arriva fino alla query', () => {
  it('prima della scelta il server rifiuta la scrittura con 400; dopo la scelta scrive in quella sede', async () => {
    const supabase = supabaseDellAdmin()
    await montaShell(<PaginaMonoSede />)

    // Nessuna sede scelta: sul telefono, prima di W3-D, era uno stato senza uscita.
    const prima = await resolveScuolaScrittura(richiestaColCookieCorrente(), supabase, ADMIN_TRE_SEDI)
    expect(prima.scuolaId).toBeUndefined()
    expect(prima.response?.status).toBe(400)

    const sheet = await apriMenuMobile()
    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_C) }))

    const dopo = await resolveScuolaScrittura(richiestaColCookieCorrente(), supabase, ADMIN_TRE_SEDI)
    expect(dopo.response).toBeUndefined()
    expect(dopo.scuolaId).toBe(SEDE_C)
  })

  it('anche le LETTURE si restringono alla sede scelta sul telefono', async () => {
    const supabase = supabaseDellAdmin()
    await montaShell(<PaginaMonoSede />)

    // Senza scelta: lo scope di lettura è tutte e tre le sedi accessibili.
    expect(await resolveScuoleAttive(richiestaColCookieCorrente(), supabase, ADMIN_TRE_SEDI)).toEqual([
      SEDE_A,
      SEDE_B,
      SEDE_C,
    ])

    const sheet = await apriMenuMobile()
    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(NOME_SEDE_B) }))

    expect(await resolveScuoleAttive(richiestaColCookieCorrente(), supabase, ADMIN_TRE_SEDI)).toEqual([SEDE_B])
  })
})

// =============================================================================
// Il confine è una proprietà del contesto, non della pagina
// =============================================================================

describe('SedeScopeBoundary', () => {
  it('espone il contesto ai figli (non è una barriera di provider)', async () => {
    function Spia() {
      const { sedi } = useSediAttive()
      return <div data-testid="spia">{sedi.length}</div>
    }
    await montaShell(<Spia />)
    await waitFor(() => expect(screen.getByTestId('spia')).toHaveTextContent('3'))
  })
})
