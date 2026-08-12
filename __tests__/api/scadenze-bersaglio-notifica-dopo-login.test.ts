import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { areaFromPath, isAreaAllowed } from '@/lib/auth/active-role'

/**
 * IL BERSAGLIO DELLA NOTIFICA DEVE SOPRAVVIVERE AL LOGIN.
 *
 * ─── IL DIFETTO, E PERCHÉ NESSUN TEST LO VEDEVA ─────────────────────────────
 *
 * `/admin/staff?tab=scadenze&stato=scaduto` è il collegamento che il cron
 * notturno mette nella notifica alla segreteria: apre il cruscotto delle
 * scadenze CON IL FILTRO GIÀ APPLICATO. Il pannello lo legge benissimo, e tre
 * test lo dimostrano — montando la pagina con la query già in mano.
 *
 * Il percorso VERO è un altro, ed è quello normale per un avviso notturno letto
 * la mattina: arriva la notifica, la segretaria clicca, **la sessione è
 * scaduta**, il middleware la manda al login. E lì il bersaglio si perdeva:
 * `url.searchParams.set('next', pathname)` portava il solo percorso, senza
 * query. MISURATO il 2026-08-12:
 *
 *   curl -o /dev/null -w '%{redirect_url}' 'http://localhost:3100/admin/staff?tab=scadenze'
 *   → http://localhost:3100/auth/login?tab=scadenze&next=%2Fadmin%2Fstaff
 *
 * Due cose sbagliate insieme: `next` senza la query (dopo il login si atterra
 * sulla linguetta «Personale», senza filtro) e la query ORIGINALE riversata
 * addosso alla pagina di login, che non è sua.
 *
 * Una notifica che, dopo il login, chiede di ritrovare a mano la riga di cui
 * parlava è una notifica che si impara a ignorare: la prima volta si cerca, la
 * seconda si rimanda, la terza non si apre più. A quel punto l'allarme esiste e
 * non serve a niente — la forma di guasto peggiore, perché tutto sembra
 * funzionare.
 *
 * ─── COSA MISURA QUESTO FILE, e cosa NO ─────────────────────────────────────
 *
 * Qui si misura la SECONDA metà della catena: il middleware VERO, con la rete
 * sotto controllo. Che il cron mandi il link col filtro è misurato dall'altra
 * parte (`scadenze-documenti-cron.test.ts`, che asserisce la stringa esatta e ha
 * il lock «il link PORTA da qualche parte»); che il pannello lo legga è misurato
 * da `admin-staff-tab-scadenze.test.tsx`. Questo file chiude l'anello in mezzo,
 * che è l'unico pezzo che nessuno guardava.
 */

/** L'utente che GoTrue restituirebbe. Nessun dato personale: uuid e campi di protocollo. */
const SESSIONE_ASSENTE = { status: 401, corpo: { message: 'invalid claim: missing sub claim' } }

let fetchVero: typeof globalThis.fetch
let log: ReturnType<typeof vi.spyOn>
let err: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchVero = globalThis.fetch
  // Il middleware scrive a mano `KV_EVT … esito=redirect-login` (è uno dei tre
  // file esentati da `no-console`): qui la riga si cattura invece di stamparla.
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  err = vi.spyOn(console, 'error').mockImplementation(() => {})
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(SESSIONE_ASSENTE.corpo), {
      status: SESSIONE_ASSENTE.status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = fetchVero
  vi.restoreAllMocks()
  vi.resetModules()
})

/** Il middleware vero, importato dopo che la rete è sotto controllo. */
async function reindirizza(percorso: string): Promise<URL> {
  const { middleware } = await import('@/middleware')
  const res = await middleware(new NextRequest(`https://app.kidville.it${percorso}`))
  const destinazione = res.headers.get('location')
  expect(destinazione, `«${percorso}» non ha prodotto nessun redirect`).toBeTruthy()
  return new URL(destinazione!)
}

const BERSAGLIO = '/admin/staff?tab=scadenze&stato=scaduto'

describe('il bersaglio della notifica sopravvive al login', () => {
  it('`next` porta il percorso COMPLETO, query compresa', async () => {
    const login = await reindirizza(BERSAGLIO)
    expect(login.pathname).toBe('/auth/login')
    expect(
      login.searchParams.get('next'),
      'dopo il login si atterra sulla linguetta «Personale» senza filtro: la notifica è rotta',
    ).toBe(BERSAGLIO)
    expect(log.mock.calls.length + err.mock.calls.length).toBeGreaterThan(0)
  })

  it('la pagina di login NON eredita i parametri della pagina protetta', async () => {
    const login = await reindirizza(BERSAGLIO)
    // Prima qui arrivava `?tab=scadenze&next=%2Fadmin%2Fstaff`: `tab` è un
    // parametro di un'ALTRA pagina, e un domani il login potrebbe reagirci.
    expect([...login.searchParams.keys()]).toEqual(['next'])
  })

  it('quel `next` è accettato dal gate del login per chi riceve l’avviso', () => {
    // `destinazione()` (login/page.tsx) onora `?next=` solo se l'area è coerente
    // col ruolo attivo: senza questa coppia il valore verrebbe scartato e si
    // atterrerebbe sulla home del ruolo — cioè il filtro si perderebbe lo stesso,
    // un passo più in là.
    const area = areaFromPath(BERSAGLIO)
    expect(area, 'il gate del login non riconosce l’area: `next` verrebbe scartato').toBe('admin')
    for (const ruolo of ['segreteria', 'admin', 'coordinator']) {
      expect(isAreaAllowed(ruolo, area!), `«${ruolo}» non potrebbe atterrare sul bersaglio`).toBe(true)
    }
  })

  it('un percorso SENZA query resta identico a prima: nessuna regressione', async () => {
    // È la forma che l'E2E asserisce (`**/auth/login?next=%2Fadmin`): la query
    // vuota non deve diventare un `?` appeso in coda.
    const login = await reindirizza('/admin')
    expect(login.searchParams.get('next')).toBe('/admin')
    expect(login.search).toBe('?next=%2Fadmin')
  })

  it('`next` resta RELATIVO: un host esterno non entra dalla query', async () => {
    // Controprova sul rischio che questa modifica introdurrebbe se fosse scritta
    // male: ciò che finisce in `next` viene dalla richiesta, non da un parametro
    // che qualcuno ci ha messo dentro, e resta un percorso del nostro sito.
    const login = await reindirizza('/admin/staff?next=https://evil.invalid/rubata')
    const next = login.searchParams.get('next') ?? ''
    expect(next.startsWith('/admin/staff')).toBe(true)
    expect(areaFromPath(next)).toBe('admin')
  })
})
