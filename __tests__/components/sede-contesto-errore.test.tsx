import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import itShared from '../../messages/it/shared.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * IL COCKPIT QUANDO L'ELENCO DELLE SEDI NON ARRIVA — e perché `[]` non basta.
 *
 * ─── IL DIFETTO, MISURATO (2026-08-12) ──────────────────────────────────────
 *
 * `SedeProvider` caricava le sedi accessibili così:
 *
 *     try { … if (res.ok) { list = … } } finally { setSedi(list) }
 *
 * Nessun `catch`, nessun log. Con la route che risponde non-`ok` (o con la rete
 * che lancia) `list` resta `[]`, e `[]` in quel contesto significa DUE cose
 * opposte: «non ho saputo quali sedi hai» e «non ne hai». Il codice le
 * confondeva, e chi ne pagava il prezzo era l'utente:
 *
 *  · `sedeCorrente` diventa `null` ⇒ ogni pagina sotto `SedeRequired`
 *    (pagamenti, mensa, modulistica, primaria, impostazioni, news, SIDI) mostra
 *    `SedeNotice`;
 *  · `SedeNotice` con `sedi.length <= 1` scrive «Hai più sedi attive. Scegline
 *    **una sola** dal menu in alto» — e i bottoni per sceglierla li dipinge solo
 *    se `sedi.length > 1`, quindi lì non ce n'è nemmeno uno;
 *  · il menu citato non esiste affatto: `SedeSelector` (`cockpit.tsx:570`) NON
 *    SI MONTA con `sedi.length <= 1`.
 *
 * Cioè: un guasto di rete si presentava come un'istruzione IMPOSSIBILE da
 * eseguire, senza una riga di log da nessuna parte. La difesa esisteva già a due
 * passi — `cockpit.tsx:538-545` chiama la STESSA route e il suo errore lo logga
 * con `logClient` — quindi due chiamate alla stessa API, una che parla e una
 * muta. È la violazione di AGENTS.md §6 nella sua forma peggiore: qui il `catch`
 * non c'è proprio, e il `finally` fa passare il guasto per uno stato normale.
 *
 * In più `void run()` non raccoglieva il rigetto: la promise rifiutata usciva
 * come `unhandledrejection` (`TypeError: Failed to fetch`) — e due spec E2E
 * pretendono `pageerror === []`, quindi un guasto di RETE sarebbe diventato un
 * rosso che accusa il pannello sbagliato.
 *
 * ─── IL CONTRATTO CHE QUESTO FILE DIFENDE ───────────────────────────────────
 *
 * Tre stati distinti, non due — è lo stesso contratto già scritto per il modulo
 * pubblico in `EnrollmentWizard-sedi-errore.test.tsx` (rilievo del 2026-08-02),
 * che qui mancava:
 *   1. UNA sede    → nessuna ambiguità: la pagina si apre su quella;
 *   2. DUE sedi    → si sceglie, con i bottoni, e la scelta è possibile;
 *   3. ERRORE      → lo si DICE («non è stato possibile leggere le tue sedi»),
 *                    lo si LOGGA, si offre «Riprova» — e la scelta già fatta
 *                    dall'utente non viene buttata via.
 *
 * I testi si leggono dal catalogo, non si ricopiano: un test che ricopia una
 * stringa d'interfaccia diventa rosso al primo apostrofo tipografico (lezione
 * pagata il 2026-08-08 sull'isolamento fra sedi).
 */

// ── i doppi: la rete è finta, il logger è spiato ─────────────────────────────

const h = vi.hoisted(() => ({ logClient: vi.fn() }))

// `nomeErrore` resta QUELLO VERO (è puro): così l'asserzione sul messaggio del
// log misura il nome di classe che uscirebbe davvero dal dispositivo, non il
// valore di ritorno di un finto.
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { AdminIdentityProvider } from '@/lib/context/admin-identity'
import { SedeProvider, SedeRequired, useSediAttive } from '@/lib/context/sede-context'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }

/** Come si comporta `GET /api/admin/sedi` al PROSSIMO tentativo. */
const rete = {
  modo: 'ok' as 'ok' | 'http' | 'rigetto',
  stato: 500,
  sedi: [ALFA, BETA] as Array<{ id: string; nome: string }>,
  tentativi: 0,
}

const fetchMock = vi.fn((url: string) => {
  const u = String(url)
  if (!u.includes('/api/admin/sedi')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })
  }
  rete.tentativi += 1
  if (rete.modo === 'rigetto') return Promise.reject(new TypeError('Failed to fetch'))
  if (rete.modo === 'http') {
    return Promise.resolve({ ok: false, status: rete.stato, json: async () => ({ error: 'boom' }) })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: rete.sedi }) })
})

/** Il cookie `sedi_attive` come lo vede il browser (null se assente). */
function cookieSedi(): string | null {
  const voce = document.cookie.split('; ').find((c) => c.startsWith('sedi_attive='))
  if (!voce) return null
  return decodeURIComponent(voce.slice('sedi_attive='.length))
}

beforeEach(() => {
  vi.clearAllMocks()
  rete.modo = 'ok'
  rete.stato = 500
  rete.sedi = [ALFA, BETA]
  rete.tentativi = 0
  document.cookie = 'sedi_attive=; path=/; max-age=0'
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── la pagina sotto la guardia ───────────────────────────────────────────────

/** Una pagina di configurazione vera: mono-sede, quindi passa da `SedeRequired`. */
function PaginaMonoSede() {
  return <SedeRequired cosa="la contabilità">{(scuolaId) => <div data-testid="pannello">{scuolaId}</div>}</SedeRequired>
}

/** Sonda fuori dalla guardia: dice quanti tentativi ha visto il provider. */
function Sonda() {
  const { sedi, errore, loading } = useSediAttive()
  return <div data-testid="sonda">{`${loading ? 'carico' : 'fermo'}|${sedi.length}|${errore ? 'errore' : 'ok'}`}</div>
}

async function monta() {
  const utils = render(
    <AdminIdentityProvider>
      <SedeProvider>
        <Sonda />
        <PaginaMonoSede />
      </SedeProvider>
    </AdminIdentityProvider>,
  )
  // Il caricamento è FINITO: da qui in poi nessuna asserzione dipende dai tempi.
  await waitFor(() => expect(screen.getByTestId('sonda').textContent).toMatch(/^fermo\|/))
  return utils
}

/** Gli eventi passati a `logClient`, nella forma che interessa alle asserzioni. */
function eventiLoggati(): Array<{ livello?: string; messaggio?: string; stato?: number }> {
  return h.logClient.mock.calls.map((c) => c[0] as { livello?: string; messaggio?: string; stato?: number })
}

// =============================================================================
// CASO 1 — UNA sede: non c'è niente da scegliere
// =============================================================================

describe('una sola sede accessibile', () => {
  it('apre la pagina su quella sede, senza avvisi e senza log d\'errore', async () => {
    rete.sedi = [ALFA]
    await monta()

    expect(screen.getByTestId('pannello')).toHaveTextContent(SEDE_A)
    expect(screen.queryByText(itShared.selezionaUnaSede)).toBeNull()
    expect(screen.queryByText(itShared.sedeNoticeErroreTitolo)).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
    expect(screen.getByTestId('sonda')).toHaveTextContent('fermo|1|ok')
  })
})

// =============================================================================
// CASO 2 — DUE sedi: si sceglie, e la scelta è possibile
// =============================================================================

describe('due sedi accessibili', () => {
  it('chiede di scegliere e offre un bottone per ciascuna sede', async () => {
    await monta()

    expect(screen.getByText(itShared.selezionaUnaSede)).toBeInTheDocument()
    expect(screen.getByText(itShared.sedeNoticeScegliQui, { exact: false })).toBeInTheDocument()
    expect(screen.queryByTestId('pannello')).toBeNull()

    const gruppo = screen.getByRole('group', { name: itShared.selezionaUnaSede })
    for (const s of [ALFA, BETA]) {
      expect(within(gruppo).getByRole('button', { name: s.nome })).toBeInTheDocument()
    }
  })

  it('scegliendo una sede la pagina si apre su QUELLA sede', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: NOME_SEDE_B }))

    expect(await screen.findByTestId('pannello')).toHaveTextContent(SEDE_B)
    expect(cookieSedi()).toBe(SEDE_B)
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

// =============================================================================
// CASO 3 — ERRORE: la route risponde male, o la rete lancia
// =============================================================================

describe('l\'elenco delle sedi non arriva', () => {
  it('la route risponde 500: lo dice, invece di chiedere una scelta impossibile', async () => {
    rete.modo = 'http'
    rete.stato = 500
    await monta()

    // Ciò che l'utente NON deve più leggere: l'istruzione impossibile.
    expect(screen.queryByText(itShared.sedeNoticeCorpo, { exact: false })).toBeNull()
    expect(screen.queryByText(itShared.sedeNoticeScegliQui, { exact: false })).toBeNull()

    // Ciò che legge adesso: il guasto, detto, e un rimedio che ha senso.
    expect(screen.getByText(itShared.sedeNoticeErroreTitolo)).toBeInTheDocument()
    expect(screen.getByText(itShared.sedeNoticeErroreCorpo, { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itShared.sedeNoticeRiprova })).toBeInTheDocument()
    expect(screen.getByTestId('sonda')).toHaveTextContent('fermo|0|errore')
  })

  it('la route risponde 500: il guasto finisce nei log, con lo stato', async () => {
    rete.modo = 'http'
    rete.stato = 500
    await monta()

    expect(h.logClient).toHaveBeenCalledTimes(1)
    const [evento] = eventiLoggati()
    expect(evento.livello).toBe('error')
    expect(evento.stato).toBe(500)
    expect(String(evento.messaggio)).toContain('sedi')
  })

  it('la rete lancia: stesso schermo, log col nome dell\'errore, e NESSUN rigetto non raccolto', async () => {
    const rigetti: unknown[] = []
    const spia = (motivo: unknown) => rigetti.push(motivo)
    process.on('unhandledRejection', spia)
    try {
      rete.modo = 'rigetto'
      await monta()

      expect(screen.getByText(itShared.sedeNoticeErroreTitolo)).toBeInTheDocument()
      expect(h.logClient).toHaveBeenCalledTimes(1)
      expect(String(eventiLoggati()[0].messaggio)).toContain('TypeError')

      // Il rigetto di `run()` deve essere RACCOLTO: `void run()` lo lasciava
      // uscire come `unhandledrejection`, e nella WebView quello diventa un
      // `pageerror` che accusa la pagina invece della rete.
      await new Promise((r) => setTimeout(r, 20))
      expect(rigetti).toEqual([])
    } finally {
      process.off('unhandledRejection', spia)
    }
  })

  it('«Riprova» ricarica davvero: tornata la rete, l\'avviso torna quello della scelta', async () => {
    rete.modo = 'http'
    await monta()
    expect(rete.tentativi).toBe(1)

    rete.modo = 'ok'
    fireEvent.click(screen.getByRole('button', { name: itShared.sedeNoticeRiprova }))

    expect(await screen.findByText(itShared.sedeNoticeScegliQui, { exact: false })).toBeInTheDocument()
    expect(rete.tentativi).toBe(2)
    expect(screen.getByTestId('sonda')).toHaveTextContent('fermo|2|ok')
  })

  it('il guasto NON cancella la sede che l\'utente aveva già scelto', async () => {
    // L'utente lavora da mesi su una sede sola: il cookie dura un anno.
    document.cookie = `sedi_attive=${SEDE_B}; path=/`
    rete.modo = 'http'
    await monta()

    // Durante il guasto la pagina è bloccata — ma la scelta non è persa.
    expect(screen.getByText(itShared.sedeNoticeErroreTitolo)).toBeInTheDocument()

    rete.modo = 'ok'
    fireEvent.click(screen.getByRole('button', { name: itShared.sedeNoticeRiprova }))

    // Ritrova la SUA sede, non l'ambiguità: la potatura del cookie stantìo si fa
    // solo su un elenco ATTENDIBILE, e `[]` per errore non lo è.
    expect(await screen.findByTestId('pannello')).toHaveTextContent(SEDE_B)
  })
})
