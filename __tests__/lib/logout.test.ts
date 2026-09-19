import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// doLogout(): chiude la sessione (endpoint + signOut), azzera il badge, spegne
// l'opt-in biometrico, svuota la cache di lettura offline, ripulisce l'identità
// applicativa in localStorage e riporta al login. Ogni passo è best-effort.

const signOut = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signOut } }),
}))

const impostaBadgeNonLette = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/native/badge', () => ({ impostaBadgeNonLette }))

const svuotaCacheLocale = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/offline/pulizia-cache', () => ({ svuotaCacheLocale }))

import { doLogout } from '@/lib/auth/logout'

const KV_KEYS = ['kv_user_id', 'kv_user_role', 'kv_parent_id', 'kv_student_id', 'kv_teacher_id']

/**
 * Le voci del grado per figlio, `kv_grado_<uuid>`. Scritte a mano e non
 * importate dal modulo, per la stessa ragione di
 * `__tests__/lib/grado-figlio-memorizzato.test.tsx`: la chiave è un contratto
 * con i dispositivi già in giro, e un test che importasse la costante
 * seguirebbe una rinomina invece di accorgersene.
 *
 * DUE e non una: `togliGradi` raccoglie prima e cancella dopo perché
 * `removeItem` dentro il giro rinumera gli indici di `key(i)`. Con una sola voce
 * quel bug non si vedrebbe. Gli uuid sono inventati (repo pubblico).
 */
const GRADI = [
  ['kv_grado_11111111-1111-4111-8111-111111111111', 'primaria'],
  ['kv_grado_22222222-2222-4222-8222-222222222222', 'nido'],
] as const

describe('doLogout', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn(async () => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { href: '' })
    for (const k of KV_KEYS) localStorage.setItem(k, 'x')
    localStorage.setItem('kv_altro', 'resta')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // `restoreAllMocks` e non solo `clearAllMocks`: qui sotto si spia
    // `Storage.prototype.removeItem` facendolo LANCIARE, e uno spione lasciato
    // in piedi renderebbe rosso il test successivo per una ragione che non è
    // sua.
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('chiama /api/auth/logout, signOut, pulisce le chiavi kv_* e reindirizza al login', async () => {
    await doLogout()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
    expect(signOut).toHaveBeenCalledTimes(1)
    for (const k of KV_KEYS) expect(localStorage.getItem(k)).toBeNull()
    // Non tocca chiavi non-identità.
    expect(localStorage.getItem('kv_altro')).toBe('resta')
    expect(location.href).toBe('/auth/login')
  })

  it('reindirizza al login anche se endpoint e signOut falliscono', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    signOut.mockRejectedValueOnce(new Error('boom'))
    await doLogout()
    expect(localStorage.getItem('kv_user_id')).toBeNull()
    expect(location.href).toBe('/auth/login')
  })

  // ── I tre difetti trovati sul telefono ──────────────────────────────────────

  it('SPEGNE l’opt-in biometrico: altrimenti il gate blocca la schermata di LOGIN', async () => {
    // È il difetto che chiudeva l'utente fuori dall'app: il flag sopravviveva al
    // logout, e al riavvio l'overlay copriva il login. «Esci» non lo spegneva,
    // quindi il recupero era solo la disinstallazione.
    localStorage.setItem('kv_biometric_optin', '1')
    await doLogout()
    expect(localStorage.getItem('kv_biometric_optin')).toBeNull()
  })

  it('azzera il badge dell’icona PRIMA del redirect', async () => {
    await doLogout()
    expect(impostaBadgeNonLette).toHaveBeenCalledWith(0)
    // L'ordine conta: dopo `location.href` la hard navigation cancella qualunque
    // lavoro in volo, e il badge resterebbe quello dell'utente precedente.
    const ordineBadge = impostaBadgeNonLette.mock.invocationCallOrder[0]
    const ordineFetch = fetchMock.mock.invocationCallOrder[0]
    expect(ordineBadge).toBeGreaterThan(ordineFetch)
    expect(location.href).toBe('/auth/login')
  })

  it('svuota la cache di lettura offline: sono dati di minori sul dispositivo', async () => {
    await doLogout()
    expect(svuotaCacheLocale).toHaveBeenCalledTimes(1)
  })

  it('esce comunque se badge o pulizia cache falliscono', async () => {
    impostaBadgeNonLette.mockRejectedValueOnce(new Error('plugin assente'))
    svuotaCacheLocale.mockRejectedValueOnce(new Error('indexeddb ko'))
    await doLogout()
    expect(location.href).toBe('/auth/login')
  })

  // ── IL GRADO DI OGNI FIGLIO: la pulizia che non era protetta da niente ──────
  //
  // `logout.ts` chiama `dimenticaTuttiIGradi()` invece di ricopiare il prefisso
  // `kv_grado_` dentro `LOCAL_KEYS`, e il commento accanto difende quella scelta
  // da una RINOMINA della chiave. Ma dalla sparizione della CHIAMATA — o dal suo
  // spostamento DOPO `window.location.href`, che la hard navigation cancella —
  // non la difendeva niente: misurato il 2026-09-19, disattivando quella riga
  // `__tests__/{lib,pages,ui,components}` restava verde su 670 file e 10.032
  // test. È la stessa forma del difetto della push raccontato in `logout.ts`
  // («un fix che sembra esserci e non c'è»), e qui vale altrettanto: nel
  // suffisso della chiave c'è l'uuid di un minore, su telefoni e tablet che
  // passano di mano.
  //
  // NON si mocka `@/lib/auth/use-child-school-type`: un finto che conta le
  // chiamate resterebbe verde anche se la funzione vera non togliesse niente. Si
  // seminano le voci vere e si guarda il `localStorage`.
  it('TOGLIE il grado memorizzato di OGNI figlio: nella chiave c’è l’uuid di un minore', async () => {
    for (const [chiave, grado] of GRADI) localStorage.setItem(chiave, grado)

    await doLogout()

    for (const [chiave] of GRADI) {
      expect(
        localStorage.getItem(chiave),
        `la voce ${chiave} è sopravvissuta al logout: l'uuid di un minore resta sul dispositivo ` +
          'di chi è appena uscito',
      ).toBeNull()
    }
    // E non è una scopa: porta via le proprie voci, non tutto il localStorage.
    expect(localStorage.getItem('kv_altro')).toBe('resta')
    expect(
      location.href,
      'la pulizia dei gradi ha fermato l’uscita: un passo best-effort è diventato un blocco',
    ).toBe('/auth/login')
  })

  it('lo storage che lancia durante la pulizia dei gradi non ferma l’uscita', async () => {
    // Finestra privata, storage negato, WebView antica: `removeItem` lancia. Il
    // logout deve uscire lo stesso — il passo è best-effort come tutti gli altri.
    for (const [chiave, grado] of GRADI) localStorage.setItem(chiave, grado)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('accesso negato', 'SecurityError')
    })

    await doLogout()

    expect(location.href).toBe('/auth/login')
  })
})
